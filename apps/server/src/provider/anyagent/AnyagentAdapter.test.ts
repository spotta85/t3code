// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { AnyagentAdapterError } from "./Errors.ts";
import { makeAnyagentAdapter } from "./AnyagentAdapter.ts";
import { makeAnyagentRuntimeLayer } from "./AnyagentRuntime.ts";

// The anyagent checkout next to this one; its release binary is built with `--features mock`.
const ANYAGENT = NodePath.resolve(import.meta.dirname, "../../../../../../anyagent");
const BIN = NodePath.join(ANYAGENT, "target/release/anyagent");
const KIND = ProviderDriverKind.make("claudeAgent");
const A = ThreadId.make("thread-a");
const B = ThreadId.make("thread-b");
const cwd = NodeOS.tmpdir();

type Adapter = ProviderAdapterShape<AnyagentAdapterError>;
type Seen = ReadonlyArray<ProviderRuntimeEvent>;

describe("AnyagentAdapter over the mock binary", () => {
  it.live("start, send a turn, answer the permission, see the turn complete", () =>
    run("turn", (adapter, waitFor, seen) =>
      Effect.gen(function* () {
        const session = yield* adapter.startSession({
          threadId: A,
          cwd,
          runtimeMode: "approval-required",
        });
        expect(session).toMatchObject({ provider: KIND, threadId: A, status: "ready", cwd });

        const { turnId } = yield* adapter.sendTurn({ threadId: A, input: "hi" });
        const opened = yield* waitFor((e) => e.type === "request.opened");
        expect(opened.turnId).toBe(turnId);
        yield* adapter.respondToRequest(A, ApprovalRequestId.make("r1"), "accept");
        yield* waitFor((e) => e.type === "turn.completed" && e.turnId === turnId);

        expect(summary(seen())).toEqual([
          "session.started",
          "turn.started",
          "content.delta:Let me check. ",
          "request.opened",
          "request.resolved:accept",
          "content.delta:Done.",
          "item.completed:assistant_message",
          "turn.completed:completed",
        ]);
        expect(
          seen()
            .filter((e) => e.type !== "session.started")
            .every((e) => e.turnId === turnId),
        ).toBe(true);
        const [listed] = yield* adapter.listSessions();
        expect(listed).toMatchObject({ threadId: A, status: "ready" });
        expect(listed?.activeTurnId).toBeUndefined();
        expect((yield* adapter.readThread(A)).turns.map((t) => t.id)).toEqual([turnId]);
      }),
    ),
  );

  it.live("interrupt ends the turn cancelled and resolves the open request", () =>
    run("turn", (adapter, waitFor) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const { turnId } = yield* adapter.sendTurn({ threadId: A, input: "hi" });
        yield* waitFor((e) => e.type === "request.opened");
        yield* adapter.interruptTurn(A, turnId);
        yield* waitFor((e) => e.type === "request.resolved");
        const done = yield* waitFor((e) => e.type === "turn.completed");
        expect(done).toMatchObject({ turnId, payload: { state: "cancelled" } });
      }),
    ),
  );

  it.live("stop closes the session: session.exited, and the thread is gone", () =>
    run("turn", (adapter, waitFor) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        yield* adapter.startSession({ threadId: B, cwd, runtimeMode: "approval-required" });
        yield* adapter.stopSession(A);
        expect(yield* adapter.hasSession(A)).toBe(false);
        const exited = yield* waitFor((e) => e.type === "session.exited");
        expect(exited).toMatchObject({ threadId: A, payload: { exitKind: "graceful" } });
        yield* adapter.stopAll();
        yield* waitFor((e) => e.type === "session.exited" && e.threadId === B);
        expect(yield* adapter.listSessions()).toEqual([]);
      }),
    ),
  );

  it.live("answers a question with the choice ids and free text T3 sends", () =>
    run("question", (adapter, waitFor) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        yield* adapter.sendTurn({ threadId: A, input: "ask me" });
        yield* waitFor((e) => e.type === "user-input.requested");
        const answers = { color: "Blue", name: "bob" };
        yield* adapter.respondToUserInput(A, ApprovalRequestId.make("q1"), answers);
        expect(yield* waitFor((e) => e.type === "user-input.resolved")).toMatchObject({
          payload: { answers },
        });
        expect(yield* waitFor((e) => e.type === "turn.completed")).toMatchObject({
          payload: { state: "completed" },
        });
      }),
    ),
  );

  // Review focus 1: the answer reaches the right session and the queued turn still runs.
  it.live(
    "a permission answered while a second prompt is queued: right session, queued turn runs",
    () =>
      run("queued", (adapter, waitFor, seen) =>
        Effect.gen(function* () {
          yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
          yield* adapter.startSession({ threadId: B, cwd, runtimeMode: "approval-required" });
          const first = (yield* adapter.sendTurn({ threadId: A, input: "one" })).turnId;
          yield* adapter.sendTurn({ threadId: B, input: "one" });
          yield* waitFor((e) => e.type === "request.opened" && e.threadId === A);
          yield* waitFor((e) => e.type === "request.opened" && e.threadId === B);
          const queued = (yield* adapter.sendTurn({ threadId: A, input: "two" })).turnId;
          expect(queued).not.toBe(first);

          yield* adapter.respondToRequest(A, ApprovalRequestId.make("r1"), "accept");
          const second = yield* waitFor((e) => e.type === "turn.completed" && e.turnId === queued);
          expect(second).toMatchObject({ threadId: A, payload: { state: "completed" } });
          expect(summary(seen().filter((e) => e.threadId === A && e.turnId === queued))).toEqual([
            "turn.started",
            "content.delta:second",
            "item.completed:assistant_message",
            "turn.completed:completed",
          ]);
          expect(seen().some((e) => e.threadId === B && e.type === "turn.completed")).toBe(false);

          yield* adapter.respondToRequest(B, ApprovalRequestId.make("r1"), "decline");
          yield* waitFor((e) => e.type === "turn.completed" && e.threadId === B);
        }),
      ),
  );

  // Review focus 2: the agent dies mid-turn; the turn ends failed and the thread stops.
  it.live("the agent dying mid-turn fails the turn and stops the thread", () =>
    run("die", (adapter, waitFor) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const { turnId } = yield* adapter.sendTurn({ threadId: A, input: "hi" });
        expect(yield* waitFor((e) => e.type === "turn.completed")).toMatchObject({
          turnId,
          payload: { state: "failed" },
        });
        expect(yield* waitFor((e) => e.type === "runtime.error")).toMatchObject({
          payload: { message: expect.stringContaining("ProcessExited") },
        });
        expect(yield* waitFor((e) => e.type === "session.exited")).toMatchObject({
          payload: { exitKind: "error" },
        });
        expect(yield* adapter.hasSession(A)).toBe(false);
      }),
    ),
  );

  // Review focus 3: an agent without rollback says so up front and fails typed.
  it.live("rollback on an agent without it: capability false, typed error, session intact", () =>
    run("turn", (adapter) =>
      Effect.gen(function* () {
        expect(adapter.capabilities.supportsConversationRollback).toBe(false);
        expect(adapter.compaction).toBeUndefined();
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const error = yield* Effect.flip(adapter.rollbackThread(A, 1));
        expect(error).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(error.message).toContain("UnsupportedFeature");
        expect(yield* adapter.hasSession(A)).toBe(true);
      }),
    ),
  );

  it.live("plan mode fails typed: anyagent has no plan mode (gaps.md)", () =>
    run("turn", (adapter) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const error = yield* Effect.flip(
          adapter.sendTurn({ threadId: A, input: "plan it", interactionMode: "plan" }),
        );
        expect(error).toMatchObject({ _tag: "ProviderAdapterValidationError" });
      }),
    ),
  );

  // Review focus 4: a stale resume token fails typed instead of opening a fresh session.
  it.live("a resume token anyagent no longer knows fails typed, not a silent fresh session", () =>
    run("resume", (adapter) =>
      Effect.gen(function* () {
        const session = yield* adapter.startSession({
          threadId: A,
          cwd,
          runtimeMode: "approval-required",
        });
        expect(session.resumeCursor).toBe("mock-token");
        yield* adapter.stopSession(A);

        const start = (resumeCursor: unknown) =>
          Effect.flip(
            adapter.startSession({
              threadId: A,
              cwd,
              runtimeMode: "approval-required",
              resumeCursor,
            }),
          );
        const stale = yield* start("mock-token");
        expect(stale).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(stale.message).toContain("ResumeFailed");
        const foreign = yield* start({ schemaVersion: 1, sessionId: "old-adapter" });
        expect(foreign).toMatchObject({ _tag: "ProviderAdapterValidationError" });
        expect(yield* adapter.hasSession(A)).toBe(false);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------

type WaitFor = (match: (e: ProviderRuntimeEvent) => boolean) => Effect.Effect<ProviderRuntimeEvent>;

/**
 * Runs `body` against an adapter over `anyagent serve --mock <script>.json`.
 * Every event the adapter emits is collected; `waitFor` polls them and, after
 * 5 s, dies listing what it saw.
 */
function run<A, E>(
  script: string,
  body: (adapter: Adapter, waitFor: WaitFor, seen: () => Seen) => Effect.Effect<A, E>,
) {
  const layer = Layer.mergeAll(
    makeAnyagentRuntimeLayer({
      bin: BIN,
      mock: NodePath.join(ANYAGENT, `packages/mock-scripts/${script}.json`),
    }),
    ServerConfig.layerTest(cwd, { prefix: "t3-anyagent-" }).pipe(Layer.provide(NodeServices.layer)),
  );
  return Effect.gen(function* () {
    const adapter = yield* makeAnyagentAdapter(KIND, "mock");
    const events: ProviderRuntimeEvent[] = [];
    yield* Stream.runForEach(adapter.streamEvents, (e) => Effect.sync(() => events.push(e))).pipe(
      Effect.forkScoped,
    );
    const waitFor: WaitFor = (match) =>
      Effect.gen(function* () {
        for (;;) {
          const found = events.find(match);
          if (found) return found;
          yield* Effect.sleep("10 millis");
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () =>
            Effect.die(new Error(`[${script}] timed out; saw: ${summary(events).join(" | ")}`)),
        }),
      );
    return yield* body(adapter, waitFor, () => events);
  }).pipe(Effect.scoped, Effect.provide(layer));
}

/** Each event as `type`, plus the detail a test pins: delta text, item type, decision, turn state. */
function summary(events: Seen): string[] {
  return events.map((e) => {
    switch (e.type) {
      case "content.delta":
        return `${e.type}:${e.payload.delta}`;
      case "item.completed":
        return `${e.type}:${e.payload.itemType}`;
      case "request.resolved":
        return `${e.type}:${e.payload.decision}`;
      case "turn.completed":
        return `${e.type}:${e.payload.state}`;
      default:
        return e.type;
    }
  });
}
