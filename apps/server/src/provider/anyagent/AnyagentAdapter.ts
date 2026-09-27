/**
 * AnyagentAdapter - T3's provider adapter over anyagent-ts: one implementation
 * for every agent anyagent drives.
 *
 * @module AnyagentAdapter
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type {
  AgentDetails,
  Delivery,
  Event,
  McpServer,
  Question,
  QuestionAnswer,
  Session,
} from "anyagent-ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  type OpenRequest,
  permissionChoice,
  prePortResumeWarning,
  sessionExitedEvents,
  sessionStartedEvent,
  toProviderRuntimeEvents,
} from "./AnyagentEvents.ts";
import { AnyagentRuntime } from "./AnyagentRuntime.ts";
import { openableOptions, selectedOptions } from "./AnyagentSnapshot.ts";
import { type AnyagentAdapterError, toAdapterError } from "./Errors.ts";

type Adapter = ProviderAdapterShape<AnyagentAdapterError>;

/**
 * The adapter for one T3 driver kind over anyagent `agent` ("claude", "codex", ...).
 * Each thread owns one anyagent session; a fiber per session pumps its events,
 * mapped by AnyagentEvents, into one queue that is `streamEvents`.
 * `latest` reads the driver's newest probe (`null`: none succeeded yet), so capabilities follow
 * snapshot refreshes; omitted, the adapter probes once itself.
 */
export const makeAnyagentAdapter = (
  kind: ProviderDriverKind,
  agent: string,
  latest?: () => AgentDetails | null,
): Effect.Effect<Adapter, never, AnyagentRuntime | ServerConfig | Scope.Scope> =>
  Effect.gen(function* () {
    const { use } = yield* AnyagentRuntime;
    const config = yield* ServerConfig;
    const scope = yield* Effect.scope;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const threads = new Map<ThreadId, Thread>();
    const own = latest ? null : yield* probeDetails(use, agent);
    const details = latest ?? (() => own);
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

    const startSession: Adapter["startSession"] = (input) =>
      Effect.gen(function* () {
        // A cursor from T3's pre-anyagent adapters (an object) cannot resume: open fresh and say so.
        const resume = typeof input.resumeCursor === "string" ? input.resumeCursor : undefined;
        const prePort = input.resumeCursor !== undefined && resume === undefined;
        yield* stopSession(input.threadId);
        const cwd = input.cwd ?? config.cwd;
        const configure = selectedOptions(kind, input.modelSelection, openableOptions(details()));
        const mcpServers = t3McpServers(input.threadId, details());
        const session = yield* call(input.threadId, "open", () =>
          use((runtime) =>
            runtime.open(agent, {
              dir: cwd,
              permission_mode: input.runtimeMode === "full-access" ? "AutoApprove" : "Ask",
              ...(resume !== undefined ? { resume } : {}),
              ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
              ...(Object.keys(configure).length > 0 ? { configure } : {}),
            }),
          ),
        );
        const now = yield* nowIso;
        const thread: Thread = {
          threadId: input.threadId,
          session,
          key: NodeCrypto.randomUUID(),
          runtimeMode: input.runtimeMode,
          cwd,
          createdAt: now,
          updatedAt: now,
          turns: new Map(),
          requests: new Map(),
          textMessages: new Set(),
          tools: new Set(),
          history: [],
          activeTurnId: undefined,
        };
        threads.set(input.threadId, thread);
        yield* Queue.offer(events, sessionStartedEvent(context(kind, thread), session.info, now));
        if (prePort) yield* Queue.offer(events, prePortResumeWarning(context(kind, thread), now));
        yield* pump(thread).pipe(Effect.forkIn(scope));
        return view(kind, thread);
      });

    const sendTurn: Adapter["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const t = yield* requireThread(input.threadId);
        if (input.interactionMode === "plan") {
          return yield* new ProviderAdapterValidationError({
            provider: kind,
            operation: "sendTurn",
            issue: "Plan mode is not available through anyagent.",
          });
        }
        const { details: live, configuration } = t.session.info;
        const advertised = new Set(live.config_options.map((o) => o.id));
        for (const [id, value] of Object.entries(
          selectedOptions(kind, input.modelSelection, advertised),
        )) {
          if (value === configuration.options[id]) continue;
          yield* call(t.threadId, "configure", () => t.session.configure(id, value));
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

    const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
      requireThread(threadId).pipe(
        Effect.flatMap((t) => call(threadId, "cancel", () => t.session.cancel())),
      );

    const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const t = yield* requireThread(threadId);
        const open = t.requests.get(requestId);
        if (!open || !("Permission" in open.request)) {
          return yield* unknownRequest(kind, "approval", requestId);
        }
        t.requests.set(requestId, { ...open, decision });
        const choice = permissionChoice(decision, open.request.Permission.options);
        yield* call(threadId, "answer", () => t.session.answer(requestId, { Permission: choice }));
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
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

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
  if ("TurnEnded" in k) t.activeTurnId = undefined;
  return out;
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

/**
 * T3's own `t3-code` MCP server (browser preview, devices, PR linking) for this thread, as
 * ProviderService issued it. Only for agents whose probe takes HTTP MCP servers: anyagent
 * refuses the others (opencode, antigravity) at open, see gaps.md.
 */
function t3McpServers(threadId: ThreadId, details: AgentDetails | null): McpServer[] {
  const mcp = McpProviderSession.readMcpProviderSession(threadId);
  if (!mcp || !details?.capabilities.mcp_transports.includes("Http")) return [];
  const headers = { Authorization: mcp.authorizationHeader };
  return [{ name: "t3-code", connection: { Http: { url: mcp.endpoint, headers } } }];
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
 * A plain next() so interrupting the pump abandons the read, where
 * Stream.fromAsyncIterable's return() would wait on it forever.
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

/** What the agent can do, probed once at build time; a failed probe is logged and offers nothing optional. */
function probeDetails(
  use: AnyagentRuntime["Service"]["use"],
  agent: string,
): Effect.Effect<AgentDetails | null> {
  return Effect.tryPromise(() => use((runtime) => runtime.probe(agent))).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`anyagent probe of '${agent}' failed; rollback and compaction stay off`, {
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
}
