/**
 * AnyagentAdapter - T3's provider adapter over anyagent-ts: one implementation
 * for every agent anyagent drives.
 *
 * @module AnyagentAdapter
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  type AgentDetails,
  AnyagentError,
  type ConfigValue,
  type Delivery,
  type Event,
  type PermissionMode,
  type PermissionRequest,
  type Question,
  type QuestionAnswer,
  type Session,
} from "anyagent-ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { toolInstructions } from "../CodexDeveloperInstructions.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  providerLogPath,
  providerLogPrefix,
  resolveThreadSegment,
} from "../Layers/EventNdjsonLogger.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  freshSessionWarning,
  type OpenRequest,
  permissionAnswer,
  permissionChoice,
  PRE_PORT_RESUME_WARNING,
  RESUME_FAILED_WARNING,
  sessionExitedEvents,
  sessionStartedEvent,
  toProviderRuntimeEvents,
} from "./AnyagentEvents.ts";
import { AnyagentRuntime, type Launch } from "./AnyagentRuntime.ts";
import { offersPlan, selectedOptions } from "./AnyagentSnapshot.ts";
import { type AnyagentAdapterError, toAdapterError } from "./Errors.ts";

type Adapter = ProviderAdapterShape<AnyagentAdapterError>;

/**
 * The adapter for T3 kind `kind` over the agent `launch` names: one session per thread, its events pumped into `streamEvents`.
 * `details` reads the driver's newest probe (`null`: none yet).
 */
export const makeAnyagentAdapter = (
  kind: ProviderDriverKind,
  launch: Launch,
  details: () => AgentDetails | null,
): Effect.Effect<
  Adapter,
  never,
  AnyagentRuntime | ServerConfig | ProviderEventLoggers | Scope.Scope
> =>
  Effect.gen(function* () {
    const { use } = yield* AnyagentRuntime;
    const config = yield* ServerConfig;
    const { native } = yield* ProviderEventLoggers;
    const scope = yield* Effect.scope;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const threads = new Map<ThreadId, Thread>();
    const features = () => details()?.capabilities.features ?? [];

    /** Runs one anyagent-ts call; a rejection becomes T3's adapter error. */
    const call = <A>(threadId: ThreadId, method: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => toAdapterError(kind, threadId, method, cause),
      });

    /** The thread's live session, or T3's not-found error. */
    const requireThread = (
      threadId: ThreadId,
    ): Effect.Effect<Thread, ProviderAdapterSessionNotFoundError> => {
      const thread = threads.get(threadId);
      return thread
        ? Effect.succeed(thread)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: kind, threadId }));
    };

    /** Feeds a session's events to T3 until its stream ends, then reports the exit unless a newer session took the thread. */
    const pump = (t: Thread) =>
      Effect.gen(function* () {
        const stream = t.session.events();
        let read = yield* nextEvent(stream);
        for (; !read.done; read = yield* nextEvent(stream)) {
          // claude asks to leave plan mode right after its plan: T3 keeps the plan and waits for "Implement plan".
          const exit = planExitRequest(t, read.value);
          if (exit && (yield* declined(t, exit))) continue;
          yield* Queue.offerAll(events, onEvent(kind, t, read.value));
        }
        const current = threads.get(t.threadId);
        if (current !== undefined && current !== t) return;
        threads.delete(t.threadId);
        yield* Queue.offerAll(
          events,
          sessionExitedEvents(context(kind, t), read.error, yield* nowIso),
        );
      });

    /** Declines the agent's exit-plan request; false when it offers no decline or the answer fails, so T3 shows it. */
    const declined = (t: Thread, request: PermissionRequest) => {
      const choice = permissionChoice("decline", request.options);
      if (!request.options.includes(choice)) return Effect.succeed(false);
      return call(t.threadId, "answer", () =>
        t.session.answer(request.id, { Permission: choice }),
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    };

    /** Sets the session's `mode` and waits for it; a change the agent rejects never shows, so fail after 10 s. */
    const setMode = (t: Thread, mode: ConfigValue) =>
      call(t.threadId, "configure", () => t.session.configure("mode", mode)).pipe(
        Effect.andThen(applied(t, "mode", mode)),
        Effect.flatMap((ok) =>
          ok
            ? Effect.void
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: kind,
                  method: "configure",
                  detail: `The agent did not apply mode '${mode}'.`,
                }),
              ),
        ),
      );

    const startSession: Adapter["startSession"] = (input) =>
      Effect.gen(function* () {
        // A cursor from T3's pre-anyagent adapters (an object) cannot resume: open fresh and say so.
        // null is "no cursor": the session directory stores it when none was ever set.
        const resume = typeof input.resumeCursor === "string" ? input.resumeCursor : undefined;
        const prePort = typeof input.resumeCursor === "object" && input.resumeCursor !== null;
        let warning = prePort ? PRE_PORT_RESUME_WARNING : undefined;
        yield* stopSession(input.threadId);
        const cwd = input.cwd ?? config.cwd;
        const configure = selectedOptions(kind, input.modelSelection, details());
        const mcp = t3Mcp(input.threadId, details());
        const wire = native && wireLogPath(native.filePath, input.threadId);
        // T3's `t3-code` MCP server: HTTP, with the thread's bearer header.
        const server = mcp && {
          name: "t3-code",
          connection: {
            Http: { url: mcp.endpoint, headers: { Authorization: mcp.authorizationHeader } },
          },
        };
        const open = (token: string | undefined) =>
          call(input.threadId, "open", () =>
            use((runtime) =>
              runtime.open(launch.agent, {
                ...withDeviceShim(launch.options, mcp),
                dir: cwd,
                permission_mode: PERMISSION_MODE[input.runtimeMode],
                instructions: sessionInstructions(kind, mcp),
                ...(token !== undefined ? { resume: token } : {}),
                ...(server ? { mcp_servers: [server] } : {}),
                ...(Object.keys(configure).length > 0 ? { configure } : {}),
                ...(wire ? { record_wire: wire } : {}),
              }),
            ),
          );
        // A token anyagent cannot resume would fail every later turn too: open fresh and say so.
        const session = yield* open(resume).pipe(
          Effect.catch((error) => {
            if (!(error.cause instanceof AnyagentError && error.cause.kind === "ResumeFailed"))
              return Effect.fail(error);
            warning = RESUME_FAILED_WARNING;
            return open(undefined);
          }),
        );
        const now = yield* nowIso;
        const thread: Thread = {
          threadId: input.threadId,
          session,
          key: NodeCrypto.randomUUID(),
          runtimeMode: input.runtimeMode,
          openMode: session.info.configuration.options.mode,
          cwd,
          createdAt: now,
          updatedAt: now,
          turns: new Map(),
          requests: new Map(),
          textMessages: new Set(),
          tools: new Set(),
          history: [],
          activeTurnId: undefined,
          planProposed: false,
        };
        threads.set(input.threadId, thread);
        yield* Queue.offer(events, sessionStartedEvent(context(kind, thread), session.info, now));
        if (warning) {
          yield* Queue.offer(events, freshSessionWarning(context(kind, thread), warning, now));
        }
        yield* pump(thread).pipe(Effect.forkIn(scope));
        return view(kind, thread);
      });

    const sendTurn: Adapter["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const t = yield* requireThread(input.threadId);
        const plan = input.interactionMode === "plan";
        if (plan && !offersPlan(t.session.info.details.config_options)) {
          return yield* new ProviderAdapterValidationError({
            provider: kind,
            operation: "sendTurn",
            issue: "Plan mode is not available for this agent.",
          });
        }
        // A plan turn switches `mode` to plan; the next default turn switches it back (see defaultMode).
        const current = t.session.info.configuration.options.mode;
        const mode = plan ? "plan" : current === "plan" ? defaultMode(t) : undefined;
        if (mode !== undefined && mode !== current) yield* setMode(t, mode);
        const picks = selectedOptions(kind, input.modelSelection, t.session.info.details);
        for (const [id, value] of Object.entries(picks)) {
          // After a model switch the session lists that model's options; a pick it lacks is dropped.
          const { details: live, configuration } = t.session.info;
          if (value === configuration.options[id]) continue;
          if (!live.config_options.some((o) => o.id === id)) continue;
          yield* call(t.threadId, "configure", () => t.session.configure(id, value));
          // The model goes first: its own options (effort, fast) exist once it applies. A refused switch sends anyway.
          if (id === "model" && Object.keys(picks).length > 1) yield* applied(t, id, value);
        }
        const attachments: string[] = [];
        for (const attachment of input.attachments ?? []) {
          const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
          if (!path) {
            return yield* new ProviderAdapterRequestError({
              provider: kind,
              method: "prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          attachments.push(path);
        }
        const delivery = yield* call(t.threadId, "prompt", () =>
          t.session.prompt(input.input ?? "", attachments),
        );
        return { threadId: t.threadId, turnId: deliveredTurnId(t, delivery), ...resumeCursor(t) };
      });

    const interruptTurn: Adapter["interruptTurn"] = (threadId, turnId) =>
      requireThread(threadId).pipe(
        Effect.flatMap((t) => {
          // Only that turn when T3 names one we know, so a stale interrupt cannot stop the next turn.
          const turn = [...t.turns].find(([, id]) => id === turnId)?.[0];
          return call(threadId, "cancel", () => t.session.cancel(false, turn));
        }),
      );

    const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const t = yield* requireThread(threadId);
        const open = t.requests.get(requestId);
        if (!open || !("Permission" in open.request)) {
          return yield* unknownRequest(kind, "approval", requestId);
        }
        t.requests.set(requestId, { ...open, decision });
        const answer = permissionAnswer(decision, open.request.Permission.options);
        yield* call(threadId, "answer", () => t.session.answer(requestId, answer));
      });

    const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
      Effect.gen(function* () {
        const t = yield* requireThread(threadId);
        const open = t.requests.get(requestId);
        if (!open || !("Question" in open.request)) {
          return yield* unknownRequest(kind, "user-input", requestId);
        }
        t.requests.set(requestId, { ...open, answers });
        const questions = open.request.Question.questions;
        const answer = { Question: questions.map((q) => questionAnswer(q, answers[q.id])) };
        yield* call(threadId, "answer", () => t.session.answer(requestId, answer));
      });

    const stopSession: Adapter["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const t = threads.get(threadId);
        if (!t) return;
        threads.delete(threadId);
        yield* Effect.ignore(call(threadId, "close", () => t.session.close()));
      });

    const stopAll: Adapter["stopAll"] = () =>
      Effect.forEach([...threads.keys()], stopSession, { discard: true });

    const rollbackThread: Adapter["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const t = yield* requireThread(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: kind,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        yield* call(threadId, "rollback", () => t.session.rollback(numTurns, "Conversation"));
        t.history.splice(-numTurns);
        return snapshot(t);
      });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(Effect.andThen(Queue.shutdown(events))),
    );

    const compaction = {
      type: "native" as const,
      start: (threadId: ThreadId) =>
        requireThread(threadId).pipe(
          Effect.flatMap((t) => call(threadId, "compact", () => t.session.compact())),
        ),
    };

    // Getters: ProviderService reads these per call, and a snapshot refresh can change them.
    const adapter: Adapter = {
      provider: kind,
      get capabilities() {
        return {
          sessionModelSwitch: "in-session" as const,
          supportsConversationRollback: features().includes("Rollback"),
        };
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopAll,
      listSessions: () => Effect.sync(() => Array.from(threads.values(), (t) => view(kind, t))),
      hasSession: (threadId) => Effect.sync(() => threads.has(threadId)),
      readThread: (threadId) => requireThread(threadId).pipe(Effect.map(snapshot)),
      rollbackThread,
      streamEvents: Stream.fromQueue(events),
    };
    Object.defineProperty(adapter, "compaction", {
      enumerable: true,
      get: () => (features().includes("Compact") ? compaction : undefined),
    });
    return adapter;
  });

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** One T3 thread's anyagent session and the bookkeeping its events need. */
interface Thread {
  readonly threadId: ThreadId;
  readonly session: Session;
  /** Unique per session: prefixes T3 turn and event ids. */
  readonly key: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  /** The session's `mode` right after open; a default turn after a plan turn returns to it, unless it is plan. */
  readonly openMode: ConfigValue | undefined;
  readonly cwd: string;
  readonly createdAt: string;
  updatedAt: string;
  /** anyagent turn id -> T3 turn id. */
  readonly turns: Map<string, TurnId>;
  readonly requests: Map<string, OpenRequest>;
  readonly textMessages: Set<string>;
  readonly tools: Set<string>;
  /** T3 turn ids in start order, for readThread and rollback. */
  readonly history: TurnId[];
  activeTurnId: TurnId | undefined;
  /** A plan arrived in the running turn; its next request (a permission: the agent asking to leave plan mode) clears it. */
  planProposed: boolean;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** anyagent's permission mode for each T3 runtime mode. */
const PERMISSION_MODE: Record<ProviderSession["runtimeMode"], PermissionMode> = {
  "approval-required": "Ask",
  "auto-accept-edits": "AcceptEdits",
  auto: "Ask",
  "full-access": "AutoApprove",
};

/** Maps one event for T3, then updates the thread's bookkeeping from it. */
function onEvent(
  kind: ProviderDriverKind,
  t: Thread,
  ev: Event,
): ReadonlyArray<ProviderRuntimeEvent> {
  const turnId = turnIdOf(t, ev);
  const ctx = {
    ...context(kind, t),
    turnId,
    requests: t.requests,
    textMessages: t.textMessages,
    tools: t.tools,
  };
  const out = toProviderRuntimeEvents(ctx, ev);
  const k = ev.kind;
  if (out[0]) t.updatedAt = out[0].createdAt;
  if (typeof k !== "object") return out;
  if ("TextDelta" in k) t.textMessages.add(k.TextDelta.message_id);
  if ("MessageEnded" in k) t.textMessages.delete(k.MessageEnded.message_id);
  if ("ToolUpdated" in k) t.tools.add(k.ToolUpdated.id);
  if ("RequestOpened" in k) {
    const request = k.RequestOpened;
    t.requests.set("Permission" in request ? request.Permission.id : request.Question.id, {
      request,
    });
  }
  if ("RequestClosed" in k) t.requests.delete(k.RequestClosed.request_id);
  if ("TurnStarted" in k && turnId) {
    t.activeTurnId = turnId;
    t.history.push(turnId);
  }
  if ("PlanProposed" in k) t.planProposed = true;
  if ("TurnEnded" in k) {
    t.activeTurnId = undefined;
    t.planProposed = false;
  }
  return out;
}

/** Waits until the session's info shows option `id` at `value`, up to 10 s; false when it never does. */
function applied(t: Thread, id: string, value: ConfigValue): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    while (t.session.info.configuration.options[id] !== value) yield* Effect.sleep("20 millis");
  }).pipe(
    Effect.as(true),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
  );
}

/** The mode a default turn returns to: the open-time one, or the first non-plan choice when the session opened in plan. */
function defaultMode(t: Thread): ConfigValue | undefined {
  if (t.openMode !== "plan") return t.openMode;
  const mode = t.session.info.details.config_options.find((o) => o.id === "mode");
  if (!mode || mode.kind === "Boolean") return undefined;
  return mode.kind.Select.choices.find((c) => c.value !== "plan")?.value;
}

/**
 * The permission request that follows the turn's plan (claude's ExitPlanMode). Like anyagent's engine, the first
 * request after a plan is the plan's own: it clears the flag, and only a permission is returned.
 */
function planExitRequest(t: Thread, ev: Event): PermissionRequest | undefined {
  const k = ev.kind;
  if (!t.planProposed || typeof k !== "object" || !("RequestOpened" in k)) return undefined;
  t.planProposed = false;
  return "Permission" in k.RequestOpened ? k.RequestOpened.Permission : undefined;
}

/** T3's id for the event's turn; a TurnStarted for a prompt binds anyagent's turn id to that prompt's T3 id. */
function turnIdOf(t: Thread, ev: Event): TurnId | undefined {
  const id = ev.turn_info?.id;
  if (!id) return undefined;
  const k = ev.kind;
  if (typeof k === "object" && "TurnStarted" in k && typeof k.TurnStarted.origin === "object") {
    t.turns.set(id, TurnId.make(`${t.key}:${k.TurnStarted.origin.Prompt}`));
  }
  return t.turns.get(id) ?? TurnId.make(`${t.key}:${id}`);
}

/** T3's id for the turn a prompt landed in: the running turn when steered, else the prompt's own (a queued one starts later). */
function deliveredTurnId(t: Thread, delivery: Delivery): TurnId {
  const k = delivery.kind;
  if ("Steered" in k)
    return t.turns.get(k.Steered.turn_id) ?? TurnId.make(`${t.key}:${k.Steered.turn_id}`);
  const turnId = TurnId.make(`${t.key}:${delivery.prompt_id}`);
  if ("Started" in k) t.turns.set(k.Started.turn_id, turnId);
  return turnId;
}

/** T3's answer to one question (option labels or free text) in anyagent's shape: choice ids when every value names a choice, else text. */
function questionAnswer(q: Question, value: unknown): QuestionAnswer {
  const values = (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const ids = values.flatMap((v) =>
    q.choices.filter((c) => c.label === v || c.id === v).map((c) => c.id),
  );
  return values.length > 0 && ids.length === values.length
    ? { Choices: ids }
    : { Text: values.join("\n") };
}

/** The thread as T3's ProviderSession. */
function view(kind: ProviderDriverKind, t: Thread): ProviderSession {
  const model = t.session.info.configuration.options.model;
  return {
    provider: kind,
    status: t.activeTurnId ? "running" : "ready",
    runtimeMode: t.runtimeMode,
    cwd: t.cwd,
    ...(typeof model === "string" ? { model } : {}),
    threadId: t.threadId,
    ...resumeCursor(t),
    ...(t.activeTurnId ? { activeTurnId: t.activeTurnId } : {}),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** The session's resume token as T3's resume cursor, when the agent has one. */
function resumeCursor(t: Thread): { resumeCursor?: string } {
  const token = t.session.info.resume_token;
  return token ? { resumeCursor: token } : {};
}

/** The turns seen so far; T3 keeps the transcript itself, so items stay empty. */
function snapshot(t: Thread): ProviderThreadSnapshot {
  return { threadId: t.threadId, turns: t.history.map((id) => ({ id, items: [] })) };
}

/** The thread's `t3-code` MCP session, only for agents whose probe takes HTTP MCP servers. */
function t3Mcp(threadId: ThreadId, details: AgentDetails | null) {
  const mcp = McpProviderSession.readMcpProviderSession(threadId);
  return mcp && details?.capabilities.mcp_transports.includes("Http") ? mcp : undefined;
}

/** T3's instructions for every session: runtime info and PR linking; codex also gets the guide to the T3 tools it has. */
function sessionInstructions(
  kind: ProviderDriverKind,
  mcp: McpProviderSession.McpProviderSessionConfig | undefined,
): string {
  const runtime = buildRuntimeInstructions(PROVIDER_DISPLAY_NAMES[kind] ?? kind);
  const has = (capability: string) => mcp?.capabilities.has(capability) ?? false;
  const tools =
    kind === "codex" ? toolInstructions({ browser: has("preview"), device: has("device") }) : "";
  return tools ? `${runtime}\n\n${tools}` : runtime;
}

/** The launch options, with the `agent-device` shim ahead of the server's PATH when the thread may drive devices. */
function withDeviceShim(
  options: Launch["options"],
  mcp: McpProviderSession.McpProviderSessionConfig | undefined,
): Launch["options"] {
  if (!mcp?.agentDeviceEnvironment) return options;
  // Every value is a string: the shim sets PATH, the rest come from `env` and the shim's own map.
  const base = { PATH: process.env.PATH, ...options.env };
  const env = McpProviderSession.withAgentDeviceEnvironment(base, mcp) as Record<string, string>;
  return { ...options, env };
}

/** The file anyagent records a thread's raw wire to: the log store's own file for the thread, as `.wire`. */
function wireLogPath(nativeLog: string, threadId: ThreadId): string {
  const segment = `${resolveThreadSegment(threadId)}.wire`;
  return providerLogPath(NodePath.dirname(nativeLog), providerLogPrefix(nativeLog), segment);
}

/** The session-level fields every mapped event carries. */
function context(kind: ProviderDriverKind, t: Thread) {
  return { provider: kind, threadId: t.threadId, sessionKey: t.key };
}

/** The error T3's reactor reads as a stale request (its detail wording is matched there). */
function unknownRequest(kind: ProviderDriverKind, label: string, requestId: string) {
  return new ProviderAdapterRequestError({
    provider: kind,
    method: "answer",
    detail: `Unknown pending ${label} request: ${requestId}`,
  });
}

/**
 * The next read of a session stream; a session error ends it with `error` set.
 * A plain next(), so interrupting the pump abandons it (Stream.fromAsyncIterable's return() hangs).
 */
function nextEvent(
  stream: AsyncGenerator<Event>,
): Effect.Effect<{ done: false; value: Event } | { done: true; error?: unknown }> {
  return Effect.promise(() =>
    stream.next().then(
      (r) => (r.done ? { done: true as const } : { done: false as const, value: r.value }),
      (error: unknown) => ({ done: true as const, error }),
    ),
  );
}
