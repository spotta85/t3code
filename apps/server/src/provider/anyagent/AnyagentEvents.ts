/**
 * AnyagentEvents - anyagent session events as T3 runtime events.
 *
 * @module AnyagentEvents
 */
import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  AnyagentError,
  type Event,
  type PermissionChoice,
  type PlanUsage,
  type Question,
  type Request,
  type SessionInfo,
  type StopReason,
  type SystemTime,
  type ToolInput,
  type ToolKind,
  type ToolUpdate,
  type TurnUsage,
} from "anyagent-ts";

import { clampPercent, makeUsageLimits } from "../providerUsageLimits.ts";

/** What the mapping needs besides the event; the adapter keeps it per session. */
export interface EventContext {
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  /** T3's id for the turn the event belongs to. */
  readonly turnId: TurnId | undefined;
  /** Unique per adapter session; prefixes event ids. */
  readonly sessionKey: string;
  /** Open requests and T3's answers to them; read by RequestClosed. */
  readonly requests: ReadonlyMap<string, OpenRequest>;
  /** Messages that carried assistant text; read by MessageEnded. */
  readonly textMessages: ReadonlySet<string>;
  /** Tool ids already reported; read by ToolUpdated. */
  readonly tools: ReadonlySet<string>;
}

/** An open anyagent request, plus T3's answer once it gives one. */
export interface OpenRequest {
  readonly request: Request;
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: ProviderUserInputAnswers;
}

type SessionContext = Pick<EventContext, "provider" | "threadId" | "sessionKey">;

/** How each anyagent permission choice appears in T3's approval UI. */
const CHOICES: Record<PermissionChoice, ProviderApprovalOption> = {
  AllowOnce: { decision: "accept", label: "Allow once" },
  AllowAlways: { decision: "acceptForSession", label: "Always allow" },
  DenyOnce: { decision: "decline", label: "Deny" },
  DenyAlways: { decision: "decline", label: "Always deny" },
};

/**
 * Maps one anyagent event to the T3 runtime events it stands for.
 *
 * | anyagent EventKind       | T3 ProviderRuntimeEvent                                   |
 * |--------------------------|-----------------------------------------------------------|
 * | TurnStarted              | turn.started                                              |
 * | TextDelta                | content.delta (assistant_text)                            |
 * | ReasoningDelta           | content.delta (reasoning_text)                            |
 * | MessageEnded             | item.completed (assistant_message, or reasoning)          |
 * | the three above in a     | none: a subagent's narration stays out of the parent chat |
 * | subagent (parent_tool_id)|                                                           |
 * | UserMessage              | none: T3 records its own user messages                    |
 * | ToolUpdated              | item.started (first seen), item.updated, item.completed (done) |
 * | ToolUpdated Subagent     | also task.started (first seen), task.completed (done)     |
 * | ToolUpdated Denied       | also tool.denied, the reason from its output              |
 * | ToolOutputDelta          | content.delta (command_output)                            |
 * | PlanUpdated              | turn.plan.updated                                         |
 * | PlanProposed             | turn.proposed.completed                                   |
 * | RequestOpened Permission | request.opened, options = offered choices as T3 decisions |
 * | RequestOpened Question   | user-input.requested                                      |
 * | RequestClosed            | request.resolved / user-input.resolved, with T3's answer  |
 * | SessionUpdated           | session.configured; thread.metadata.updated when titled   |
 * | StatusChanged            | none: T3 derives status from turn and request events      |
 * | ContextUsage             | thread.token-usage.updated                                |
 * | ContextCompacted         | thread.state.changed (compacted)                          |
 * | PlanUsageUpdated         | account.rate-limits.updated                               |
 * | Diagnostic               | runtime.warning; runtime.error at Error; none for an Info |
 * |                          | whose extensions carry a raw frame (unmapped wire frame)  |
 * | TurnEnded                | turn.completed, state from the stop reason, tokenUsage    |
 * |                          | from its usage (claude, codex, opencode, pi, antigravity) |
 * | session error / end      | runtime.error + session.exited (sessionExitedEvents)      |
 * | (no source in anyagent)  | task.progress, turn.diff.updated, tool.progress,          |
 * |                          | model.rerouted: gaps.md rows                              |
 */
export function toProviderRuntimeEvents(
  ctx: EventContext,
  ev: Event,
): ReadonlyArray<ProviderRuntimeEvent> {
  const base = {
    eventId: EventId.make(`${ctx.sessionKey}:${ev.sequence}:0`),
    provider: ctx.provider,
    threadId: ctx.threadId,
    createdAt: isoTime(ev.occurred_at),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
  };
  const k = ev.kind;
  if (k === "ContextCompacted") {
    return [{ ...base, type: "thread.state.changed", payload: { state: "compacted" } }];
  }
  // A subagent's own text belongs to its tool, not the parent chat (the old claude adapter dropped it too).
  const nested = ev.turn_info?.parent_tool_id;
  if (nested && ("TextDelta" in k || "ReasoningDelta" in k || "MessageEnded" in k)) return [];
  if ("TurnStarted" in k) return [{ ...base, type: "turn.started", payload: {} }];
  if ("TextDelta" in k)
    return [delta(base, k.TextDelta.message_id, "assistant_text", k.TextDelta.text)];
  if ("ReasoningDelta" in k) {
    return [delta(base, k.ReasoningDelta.message_id, "reasoning_text", k.ReasoningDelta.text)];
  }
  if ("ToolOutputDelta" in k) {
    return [delta(base, k.ToolOutputDelta.tool_id, "command_output", k.ToolOutputDelta.text)];
  }
  if ("MessageEnded" in k) {
    const id = k.MessageEnded.message_id;
    const itemType = ctx.textMessages.has(id) ? "assistant_message" : "reasoning";
    return [
      {
        ...base,
        type: "item.completed",
        itemId: RuntimeItemId.make(id),
        payload: { itemType, status: "completed" },
      },
    ];
  }
  if ("ToolUpdated" in k) {
    const tool = k.ToolUpdated;
    const seen = ctx.tools.has(tool.id);
    const item = toolEvent(base, tool, seen, ev.turn_info?.parent_tool_id);
    const tasks = tool.kind === "Subagent" ? taskEvents(base, tool, seen) : [];
    const denied = tool.status === "Denied" ? [toolDenied(extra(base, 3), tool)] : [];
    return [item, ...tasks, ...denied];
  }
  if ("PlanUpdated" in k) {
    const plan = k.PlanUpdated.entries.map((e) => ({
      step: e.text,
      status: PLAN_STATUS[e.status],
    }));
    return [{ ...base, type: "turn.plan.updated", payload: { plan } }];
  }
  if ("PlanProposed" in k) {
    const planMarkdown = k.PlanProposed.markdown.trim();
    return planMarkdown
      ? [{ ...base, type: "turn.proposed.completed", payload: { planMarkdown } }]
      : [];
  }
  if ("RequestOpened" in k) return [requestOpened(base, k.RequestOpened)];
  if ("RequestClosed" in k)
    return requestClosed(base, ctx.requests.get(k.RequestClosed.request_id));
  if ("SessionUpdated" in k) {
    const config = { ...k.SessionUpdated.configuration.options };
    const name = k.SessionUpdated.title?.trim();
    return [
      { ...base, type: "session.configured", payload: { config } },
      ...(name
        ? [{ ...extra(base, 1), type: "thread.metadata.updated" as const, payload: { name } }]
        : []),
    ];
  }
  if ("ContextUsage" in k) {
    const { used_tokens, window_tokens } = k.ContextUsage;
    const usage = {
      usedTokens: Math.max(0, Math.round(used_tokens)),
      ...(window_tokens ? { maxTokens: window_tokens } : {}),
    };
    return [{ ...base, type: "thread.token-usage.updated", payload: { usage } }];
  }
  if ("PlanUsageUpdated" in k) {
    const limits = { windows: k.PlanUsageUpdated.windows.map(usageWindow) };
    return [{ ...base, type: "account.rate-limits.updated", payload: { limits } }];
  }
  if ("Diagnostic" in k) {
    const { level, message } = k.Diagnostic;
    // An unmapped wire frame ("unrecognized codex frame `hook/started`"): debug chatter, not news.
    if (level === "Info" && Object.keys(ev.extensions).some((key) => key.endsWith("raw_frame")))
      return [];
    const type = level === "Error" ? "runtime.error" : "runtime.warning";
    return [{ ...base, type, payload: { message } }];
  }
  if ("TurnEnded" in k)
    return [
      {
        ...base,
        type: "turn.completed",
        payload: { ...turnEnd(k.TurnEnded.stop), ...tokenUsage(k.TurnEnded.usage) },
      },
    ];
  return []; // UserMessage, StatusChanged
}

/** T3's session.started for a freshly opened session. */
export function sessionStartedEvent(
  ctx: SessionContext,
  info: SessionInfo,
  at: string,
): ProviderRuntimeEvent {
  return {
    ...sessionBase(ctx, "started", at),
    type: "session.started",
    payload: info.resume_token ? { resume: info.resume_token } : {},
  };
}

/** Shown when a thread's stored cursor came from T3's pre-anyagent adapters. */
export const PRE_PORT_RESUME_WARNING =
  "Provider session from before the anyagent port could not be resumed; started a new session";

/** Shown when anyagent could not resume a thread's stored cursor (`ResumeFailed`). */
export const RESUME_FAILED_WARNING = "Provider session could not be resumed; started a new session";

/** The one warning a thread gets when its stored cursor was dropped for a fresh session. */
export function freshSessionWarning(
  ctx: SessionContext,
  message: string,
  at: string,
): ProviderRuntimeEvent {
  return {
    ...sessionBase(ctx, "fresh-session", at),
    type: "runtime.warning",
    payload: { message },
  };
}

/** A session stream ending: graceful on close; on a session error a runtime.error, then session.exited. */
export function sessionExitedEvents(
  ctx: SessionContext,
  error: unknown,
  at: string,
): ReadonlyArray<ProviderRuntimeEvent> {
  const exited = sessionBase(ctx, "exited", at);
  if (error === undefined) {
    return [{ ...exited, type: "session.exited", payload: { exitKind: "graceful" } }];
  }
  const kind = error instanceof AnyagentError ? error.kind : "Error";
  const reason = `${kind}: ${error instanceof Error ? error.message : String(error)}`;
  const detail = error instanceof AnyagentError ? { detail: error.data } : {};
  return [
    {
      ...sessionBase(ctx, "error", at),
      type: "runtime.error",
      payload: { message: reason, ...detail },
    },
    {
      ...exited,
      type: "session.exited",
      payload: { reason, exitKind: "error", recoverable: kind === "AuthRequired" },
    },
  ];
}

/** The offered choice that carries T3's decision; "always" falls back to once when not offered. */
export function permissionChoice(
  decision: ProviderApprovalDecision,
  offered: ReadonlyArray<PermissionChoice>,
): PermissionChoice {
  const wanted =
    decision === "acceptAlways" ? "acceptForSession" : decision === "cancel" ? "decline" : decision;
  const found = offered.find((choice) => CHOICES[choice].decision === wanted);
  return found ?? (wanted === "decline" ? "DenyOnce" : "AllowOnce");
}

/** A full plan-usage report as T3's usage limits: its windows, banked resets when reported, and when it was read. */
export function planUsageLimits(plan: PlanUsage): ServerProviderUsageLimits {
  const credits = plan.reset_credits;
  const expires = credits?.next_expires_at;
  const limits = makeUsageLimits({
    checkedAt: isoTime(plan.fetched_at),
    windows: plan.windows.map(usageWindow),
  });
  if (!credits) return limits;
  const resetCredits = {
    availableCount: credits.available,
    ...(expires ? { nextExpiresAt: isoTime(expires) } : {}),
  };
  return { ...limits, resetCredits };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

type Base = {
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly turnId?: TurnId;
};

const PLAN_STATUS = {
  Pending: "pending",
  InProgress: "inProgress",
  Completed: "completed",
} as const;
const TASK_STATUS = {
  Completed: "completed",
  Failed: "failed",
  Cancelled: "stopped",
  Denied: "failed",
} as const;
const TOOL_STATUS = {
  Pending: "inProgress",
  Running: "inProgress",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "failed",
  Denied: "declined",
} as const;

/** One streamed chunk of a message or a command's output. */
function delta(
  base: Base,
  itemId: string,
  streamKind: "assistant_text" | "reasoning_text" | "command_output",
  text: string,
): ProviderRuntimeEvent {
  return {
    ...base,
    type: "content.delta",
    itemId: RuntimeItemId.make(itemId),
    payload: { streamKind, delta: text },
  };
}

/** A tool snapshot as a T3 item: started when first seen, updated after, completed once it finishes. */
function toolEvent(
  base: Base,
  tool: ToolUpdate,
  seen: boolean,
  parent: string | null | undefined,
): ProviderRuntimeEvent {
  const running = tool.status === "Pending" || tool.status === "Running";
  const type = !running ? "item.completed" : seen ? "item.updated" : "item.started";
  const title = tool.title.trim();
  const detail = inputText(tool.input);
  return {
    ...base,
    type,
    itemId: RuntimeItemId.make(tool.id),
    payload: {
      itemType: itemType(tool.kind),
      status: TOOL_STATUS[tool.status],
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      data: tool,
      ...(parent ? { parentToolUseId: parent } : {}),
    },
  };
}

/** A subagent tool's T3 task: started when first seen, completed once it finishes (ids after the item's). */
function taskEvents(base: Base, tool: ToolUpdate, seen: boolean): ProviderRuntimeEvent[] {
  const title = tool.title.trim();
  const task = {
    taskId: RuntimeTaskId.make(tool.id),
    taskType: "subagent",
    toolUseId: tool.id,
    ...(title ? { title } : {}),
  };
  const out: ProviderRuntimeEvent[] = [];
  if (!seen) {
    const payload = { ...task, ...(title ? { description: title } : {}) };
    out.push({ ...extra(base, 1), type: "task.started", payload });
  }
  if (tool.status !== "Pending" && tool.status !== "Running") {
    const status = TASK_STATUS[tool.status];
    out.push({ ...extra(base, 2), type: "task.completed", payload: { ...task, status } });
  }
  return out;
}

/** A tool the agent's rules or mode refused without asking, as T3's tool.denied; the reason is its output. */
function toolDenied(base: Base, tool: ToolUpdate): ProviderRuntimeEvent {
  const reason = tool.output?.trim();
  return {
    ...base,
    type: "tool.denied",
    payload: {
      toolName: tool.raw?.name.trim() || tool.title.trim() || kindName(tool.kind),
      toolUseId: tool.id,
      ...(reason ? { reason } : {}),
    },
  };
}

/** A tool kind's name: "Execute", or an MCP tool's own name. */
function kindName(kind: ToolKind): string {
  return typeof kind === "string" ? kind : kind.Mcp.tool;
}

/** `base` for the i-th extra T3 event one anyagent event maps to. */
function extra(base: Base, i: number): Base {
  return { ...base, eventId: EventId.make(`${base.eventId.slice(0, -2)}:${i}`) };
}

/** A permission as an approval request, a question as a user-input request. */
function requestOpened(base: Base, request: Request): ProviderRuntimeEvent {
  if ("Question" in request) {
    const { id, questions } = request.Question;
    return {
      ...base,
      type: "user-input.requested",
      requestId: RuntimeRequestId.make(id),
      payload: { questions: questions.map(userInputQuestion) },
    };
  }
  const { id, tool, options, detail } = request.Permission;
  const offered = options.map((choice) => CHOICES[choice]);
  const text = detail?.trim() || tool.title.trim();
  return {
    ...base,
    type: "request.opened",
    requestId: RuntimeRequestId.make(id),
    payload: {
      requestType: requestType(tool.kind),
      ...(text ? { detail: text } : {}),
      options: offered.filter((o, i) => offered.findIndex((x) => x.decision === o.decision) === i),
      args: tool,
    },
  };
}

/** The resolved counterpart of an open request, carrying T3's answer; unknown ids map to nothing. */
function requestClosed(
  base: Base,
  open: OpenRequest | undefined,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (!open) return [];
  if ("Question" in open.request) {
    const requestId = RuntimeRequestId.make(open.request.Question.id);
    return [
      { ...base, type: "user-input.resolved", requestId, payload: { answers: open.answers ?? {} } },
    ];
  }
  const { id, tool } = open.request.Permission;
  return [
    {
      ...base,
      type: "request.resolved",
      requestId: RuntimeRequestId.make(id),
      payload: {
        requestType: requestType(tool.kind),
        ...(open.decision ? { decision: open.decision } : {}),
      },
    },
  ];
}

/** One anyagent question in T3's shape; choice ids ride as option values. */
function userInputQuestion(q: Question) {
  return {
    id: q.id,
    header: q.header?.trim() || "Question",
    question: q.text,
    options: q.choices.map((c) => ({
      label: c.label,
      description: c.description ?? "",
      value: c.id,
    })),
    allowCustomAnswer: q.allows_free_text,
    multiSelect: q.multi_select,
  };
}

/** turn.completed's payload for an anyagent stop reason. */
function turnEnd(stop: StopReason) {
  if (stop === "Cancelled") return { state: "cancelled", stopReason: "cancelled" } as const;
  if (stop === "Refused") return { state: "completed", stopReason: "refusal" } as const;
  if ("Failed" in stop) {
    return { state: "failed", stopReason: "failed", errorMessage: stop.Failed.message } as const;
  }
  return {
    state: "completed",
    stopReason: stop.Completed.source === "Inferred" ? "inferred" : null,
  } as const;
}

/** The turn's token counts in T3's shape; nothing when the agent reported none. */
function tokenUsage(usage: TurnUsage | null | undefined) {
  if (!usage) return {};
  return {
    tokenUsage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      outputTokens: usage.output_tokens,
    } as const,
  };
}

/** T3's window id and kind for anyagent's well-known window labels. */
const WINDOWS: Record<string, readonly [string, ServerProviderUsageWindow["kind"]]> = {
  Session: ["five_hour", "session"],
  Week: ["seven_day", "weekly"],
  Month: ["monthly", "monthly"],
};

/** One plan-quota window in T3's usage-limit shape; another label ("Week (Opus)") gets an id made from it, or itself. */
function usageWindow(w: PlanUsage["windows"][number]): ServerProviderUsageWindow {
  const slug = w.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const [id, kind] = WINDOWS[w.label] ?? [slug || w.label, "other"];
  return {
    id,
    kind,
    label: w.label,
    usedPercent: clampPercent(w.used_percent),
    ...(w.resets_at ? { resetsAt: isoTime(w.resets_at) } : {}),
  };
}

/** T3's item type for an anyagent tool kind. */
function itemType(kind: ToolKind): CanonicalItemType {
  if (typeof kind === "object") return "mcp_tool_call";
  switch (kind) {
    case "Execute":
      return "command_execution";
    case "Edit":
    case "Delete":
    case "Move":
      return "file_change";
    case "Search":
    case "Fetch":
      return "web_search";
    case "Subagent":
      return "collab_agent_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

/** T3's approval type for the tool a permission guards. */
function requestType(kind: ToolKind): CanonicalRequestType {
  switch (kind) {
    case "Execute":
      return "exec_command_approval";
    case "Read":
      return "file_read_approval";
    case "Edit":
    case "Delete":
    case "Move":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

/** The one-line summary of a tool's input: its command, path, pattern, url, query or text. */
function inputText(input: ToolInput): string | undefined {
  if (input === "None") return undefined;
  const value = "Command" in input ? input.Command.command : Object.values(input)[0];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Base fields for an adapter-made session event; `tag` keeps its id unique. */
function sessionBase(ctx: SessionContext, tag: string, at: string) {
  return {
    eventId: EventId.make(`${ctx.sessionKey}:${tag}`),
    provider: ctx.provider,
    threadId: ctx.threadId,
    createdAt: at,
  };
}

/** An anyagent wall-clock time as ISO; a missing one reads as the epoch, as anyagent documents. */
function isoTime(t: SystemTime | undefined): string {
  const ms = t ? t.secs_since_epoch * 1000 + Math.floor(t.nanos_since_epoch / 1e6) : 0;
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}
