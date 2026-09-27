/**
 * AnyagentEvents - anyagent session events as T3 runtime events.
 *
 * @module AnyagentEvents
 */
import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
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
} from "anyagent-ts";

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
 * | UserMessage              | none: T3 records its own user messages                    |
 * | ToolUpdated              | item.started (first seen), item.updated, item.completed (done) |
 * | ToolOutputDelta          | content.delta (command_output)                            |
 * | PlanUpdated              | turn.plan.updated                                         |
 * | RequestOpened Permission | request.opened, options = offered choices as T3 decisions |
 * | RequestOpened Question   | user-input.requested                                      |
 * | RequestClosed            | request.resolved / user-input.resolved, with T3's answer  |
 * | SessionUpdated           | session.configured                                        |
 * | StatusChanged            | none: T3 derives status from turn and request events      |
 * | ContextUsage             | thread.token-usage.updated                                |
 * | ContextCompacted         | thread.state.changed (compacted)                          |
 * | PlanUsageUpdated         | account.rate-limits.updated                               |
 * | Diagnostic               | runtime.warning; runtime.error at Error; none at Info     |
 * | TurnEnded                | turn.completed, state from the stop reason                |
 * | session error / end      | runtime.error + session.exited (sessionExitedEvents)      |
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
    return [toolEvent(base, tool, ctx.tools.has(tool.id), ev.turn_info?.parent_tool_id)];
  }
  if ("PlanUpdated" in k) {
    const plan = k.PlanUpdated.entries.map((e) => ({
      step: e.text,
      status: PLAN_STATUS[e.status],
    }));
    return [{ ...base, type: "turn.plan.updated", payload: { plan } }];
  }
  if ("RequestOpened" in k) return [requestOpened(base, k.RequestOpened)];
  if ("RequestClosed" in k)
    return requestClosed(base, ctx.requests.get(k.RequestClosed.request_id));
  if ("SessionUpdated" in k) {
    const config = { ...k.SessionUpdated.configuration.options };
    return [{ ...base, type: "session.configured", payload: { config } }];
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
    if (level === "Info") return []; // adapter chatter, e.g. codex frames anyagent does not map
    const type = level === "Error" ? "runtime.error" : "runtime.warning";
    return [{ ...base, type, payload: { message } }];
  }
  if ("TurnEnded" in k)
    return [{ ...base, type: "turn.completed", payload: turnEnd(k.TurnEnded.stop) }];
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

/**
 * T3's view of a session stream ending: graceful on close; on a session error
 * (AuthRequired, ProcessExited, ...) a runtime.error with the error body, then
 * session.exited with the reason.
 */
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
const TOOL_STATUS = {
  Pending: "inProgress",
  Running: "inProgress",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "failed",
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

/** One plan-quota window in T3's usage-limit shape. */
function usageWindow(w: PlanUsage["windows"][number]): ServerProviderUsageWindow {
  const kind = w.label === "Session" ? "session" : w.label === "Week" ? "weekly" : "other";
  return {
    id: w.label,
    kind,
    label: w.label,
    usedPercent: Math.min(100, Math.max(0, w.used_percent)),
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
