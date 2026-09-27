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
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import type { Answer, McpTransport, OpenOptions, Runtime } from "anyagent-ts";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { AnyagentAdapterError } from "./Errors.ts";
import { makeAnyagentAdapter } from "./AnyagentAdapter.ts";
import { PRE_PORT_RESUME_WARNING, RESUME_FAILED_WARNING } from "./AnyagentEvents.ts";
import { AnyagentRuntime, type Launch, makeAnyagentRuntimeLayer } from "./AnyagentRuntime.ts";

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

  it.live("interrupt with a finished turn's id leaves the running turn alone", () =>
    run("chatter", (adapter, waitFor, seen) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const send = (input: string) =>
          adapter.sendTurn({ threadId: A, input }).pipe(Effect.map((r) => r.turnId));
        const first = yield* send("one");
        yield* waitFor((e) => e.type === "turn.completed" && e.turnId === first);
        const second = yield* send("two");
        yield* waitFor((e) => e.type === "turn.completed" && e.turnId === second);
        // The script has no third turn: it runs until cancelled.
        const running = yield* send("three");
        yield* waitFor((e) => e.type === "turn.started" && e.turnId === running);

        yield* adapter.interruptTurn(A, first);
        yield* Effect.sleep("100 millis");
        expect(seen().some((e) => e.type === "turn.completed" && e.turnId === running)).toBe(false);
        yield* adapter.interruptTurn(A);
        expect(
          yield* waitFor((e) => e.type === "turn.completed" && e.turnId === running),
        ).toMatchObject({ payload: { state: "cancelled" } });
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

  it.live("a rollback the agent refuses fails typed with its reason and keeps the turns", () =>
    run("rollback-refused", (adapter, waitFor) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const { turnId } = yield* adapter.sendTurn({ threadId: A, input: "hi" });
        yield* waitFor((e) => e.type === "turn.completed");
        const error = yield* Effect.flip(adapter.rollbackThread(A, 1));
        expect(error).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(error.message).toContain("nothing to rewind past the compaction");
        expect((yield* adapter.readThread(A)).turns.map((t) => t.id)).toEqual([turnId]);
      }),
    ),
  );

  it.live("runtime modes open as Ask, AcceptEdits (auto-accept-edits), AutoApprove", () =>
    run("turn", (adapter, _waitFor, _seen, opened) =>
      Effect.gen(function* () {
        const modes = ["approval-required", "auto-accept-edits", "full-access"] as const;
        for (const runtimeMode of modes) {
          yield* adapter.startSession({ threadId: A, cwd, runtimeMode });
        }
        const expected = ["Ask", "AcceptEdits", "AutoApprove"];
        expect(opened().map((o) => o.permission_mode)).toEqual(expected);
      }),
    ),
  );

  it.live("an attachment that cannot be resolved fails the turn instead of being dropped", () =>
    run("turn", (adapter, _waitFor, seen) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const attachment = {
          type: "video",
          id: "clip-1",
          name: "clip.mp4",
          mimeType: "video/mp4",
          sizeBytes: 10,
        };
        const error = yield* Effect.flip(
          adapter.sendTurn({ threadId: A, input: "look", attachments: [attachment] }),
        );
        expect(error).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(error.message).toContain("clip-1");
        expect(seen().some((e) => e.type === "turn.started")).toBe(false);
      }),
    ),
  );

  it.live("rollback of 0 turns fails typed and keeps the history", () =>
    run("chatter", (adapter, waitFor) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const { turnId } = yield* adapter.sendTurn({ threadId: A, input: "hi" });
        yield* waitFor((e) => e.type === "turn.completed");
        const error = yield* Effect.flip(adapter.rollbackThread(A, 0));
        expect(error).toMatchObject({ _tag: "ProviderAdapterValidationError" });
        expect((yield* adapter.readThread(A)).turns.map((t) => t.id)).toEqual([turnId]);
      }),
    ),
  );

  it.live("a plan turn switches mode to plan first; the next default turn switches back", () =>
    run("plan", (adapter, waitFor, seen) =>
      Effect.gen(function* () {
        yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        const plan = yield* adapter.sendTurn({
          threadId: A,
          input: "plan",
          interactionMode: "plan",
        });
        yield* waitFor((e) => e.type === "turn.completed" && e.turnId === plan.turnId);
        const next = yield* adapter.sendTurn({ threadId: A, input: "go" });
        yield* waitFor((e) => e.type === "turn.completed" && e.turnId === next.turnId);

        expect(summary(seen())).toEqual([
          "session.started",
          "session.configured:plan",
          "turn.started",
          "turn.proposed.completed",
          "turn.completed:completed",
          "session.configured:default",
          "turn.started",
          "content.delta:Done.",
          "item.completed:assistant_message",
          "turn.completed:completed",
        ]);
        expect(seen().find((e) => e.type === "turn.proposed.completed")).toMatchObject({
          turnId: plan.turnId,
          payload: { planMarkdown: "1. Add a README" },
        });
      }),
    ),
  );

  it.live(
    "the permission request after a plan is declined by the adapter; a later one is surfaced",
    () =>
      run("plan-exit", (adapter, waitFor, seen, _opened, answered) =>
        Effect.gen(function* () {
          yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
          const plan = yield* adapter.sendTurn({
            threadId: A,
            input: "plan",
            interactionMode: "plan",
          });
          yield* waitFor((e) => e.type === "turn.completed" && e.turnId === plan.turnId);
          expect(answered()).toEqual([{ request: "exit-1", answer: { Permission: "DenyOnce" } }]);
          expect(summary(seen().filter((e) => e.turnId === plan.turnId))).toEqual([
            "turn.started",
            "turn.proposed.completed",
            "content.delta:Kept the plan.",
            "item.completed:assistant_message",
            "turn.completed:completed",
          ]);

          // The turn ended, so the next turn's permission reaches T3 as usual.
          const next = yield* adapter.sendTurn({ threadId: A, input: "go" });
          yield* waitFor((e) => e.type === "request.opened" && e.turnId === next.turnId);
          yield* adapter.respondToRequest(A, ApprovalRequestId.make("r2"), "accept");
          yield* waitFor((e) => e.type === "turn.completed" && e.turnId === next.turnId);
          expect(answered().map((a) => a.request)).toEqual(["exit-1", "r2"]);
        }),
      ),
  );

  it.live(
    "a session opened in plan: a default turn switches to the first mode that is not plan",
    () =>
      run("plan-exit", (adapter, waitFor, seen) =>
        Effect.gen(function* () {
          yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
          const { turnId } = yield* adapter.sendTurn({ threadId: A, input: "go" });
          yield* waitFor((e) => e.type === "turn.started" && e.turnId === turnId);
          expect(summary(seen()).slice(0, 3)).toEqual([
            "session.started",
            "session.configured:default",
            "turn.started",
          ]);
        }),
      ),
  );

  it.live("a plan turn on an agent whose mode offers no plan fails typed", () =>
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

  // A stale token would fail every later turn: it opens fresh with one warning instead.
  it.live("a resume token anyagent no longer knows opens a fresh session with one warning", () =>
    run("resume", (adapter, waitFor, seen, opened) =>
      Effect.gen(function* () {
        const input = { threadId: A, cwd, runtimeMode: "approval-required" } as const;
        expect((yield* adapter.startSession(input)).resumeCursor).toBe("mock-token");
        yield* adapter.stopSession(A);

        const session = yield* adapter.startSession({ ...input, resumeCursor: "mock-token" });
        expect(session).toMatchObject({ threadId: A, status: "ready", resumeCursor: "mock-token" });
        expect(opened().map((o) => o.resume)).toEqual([undefined, "mock-token", undefined]);
        expect(yield* waitFor((e) => e.type === "runtime.warning")).toMatchObject({
          payload: { message: RESUME_FAILED_WARNING },
        });
        expect(seen().filter((e) => e.type === "runtime.warning")).toHaveLength(1);
        expect(yield* adapter.hasSession(A)).toBe(true);
      }),
    ),
  );

  it.live("an open failure other than ResumeFailed still fails typed", () =>
    run(
      "turn",
      (adapter) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" }),
          );
          expect(error).toMatchObject({ _tag: "ProviderAdapterRequestError" });
          expect(error.message).toContain("NotInstalled");
          expect(yield* adapter.hasSession(A)).toBe(false);
        }),
      { agent: "not-an-agent" },
    ),
  );

  it.live("a cursor from T3's pre-anyagent adapters opens a fresh session with one warning", () =>
    run("resume", (adapter, waitFor, seen, opened) =>
      Effect.gen(function* () {
        const session = yield* adapter.startSession({
          threadId: A,
          cwd,
          runtimeMode: "approval-required",
          resumeCursor: { schemaVersion: 1, sessionId: "old-adapter" },
        });
        expect(session).toMatchObject({ threadId: A, status: "ready", resumeCursor: "mock-token" });
        expect(opened()[0]?.resume).toBeUndefined();
        yield* waitFor((e) => e.type === "runtime.warning");
        expect(summary(seen())).toEqual(["session.started", "runtime.warning"]);
        expect(seen()[1]).toMatchObject({ payload: { message: PRE_PORT_RESUME_WARNING } });
        expect(yield* adapter.hasSession(A)).toBe(true);
      }),
    ),
  );

  it.live("a null cursor (none stored yet) opens a fresh session without a warning", () =>
    run("resume", (adapter, waitFor, seen, opened) =>
      Effect.gen(function* () {
        yield* adapter.startSession({
          threadId: A,
          cwd,
          runtimeMode: "approval-required",
          resumeCursor: null,
        });
        expect(opened()[0]?.resume).toBeUndefined();
        yield* waitFor((e) => e.type === "session.started");
        yield* Effect.sleep("100 millis");
        expect(summary(seen())).toEqual(["session.started"]);
      }),
    ),
  );

  it.live("attaches T3's t3-code MCP server when the agent takes HTTP MCP servers", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("env-1"),
        threadId: A,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer secret",
        capabilities: new Set(["preview"]),
      });
      const startBoth = (adapter: Adapter) =>
        Effect.gen(function* () {
          yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
          yield* adapter.startSession({ threadId: B, cwd, runtimeMode: "approval-required" });
        });
      // The mock advertises no MCP transports: nothing is declared, so open cannot be refused.
      yield* run("turn", (adapter, _waitFor, _seen, opened) =>
        Effect.gen(function* () {
          yield* startBoth(adapter);
          expect(opened().map((o) => o.mcp_servers)).toEqual([undefined, undefined]);
        }),
      );
      // An agent that takes HTTP servers gets the thread's server; a thread without one gets none.
      yield* run(
        "turn",
        (adapter, _waitFor, _seen, opened) =>
          Effect.gen(function* () {
            yield* startBoth(adapter);
            expect(opened().map((o) => o.mcp_servers)).toEqual([
              [
                {
                  name: "t3-code",
                  connection: {
                    Http: {
                      url: "http://127.0.0.1:3773/mcp",
                      headers: { Authorization: "Bearer secret" },
                    },
                  },
                },
              ],
              undefined,
            ]);
          }),
        { mcpTransports: ["Http"] },
      );
    }).pipe(Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(A)))),
  );

  it.live("every open sends T3's instructions; codex also gets the guide to its T3 tools", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("env-1"),
        threadId: A,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer secret",
        capabilities: new Set(["preview"]),
      });
      const sent = (opened: () => ReadonlyArray<OpenOptions>) =>
        opened().map((o) => o.instructions ?? "");
      // A new session, the resume attempt, and the fresh session after it: runtime info and PR linking.
      yield* run("resume", (adapter, _waitFor, _seen, opened) =>
        Effect.gen(function* () {
          const input = { threadId: A, cwd, runtimeMode: "approval-required" } as const;
          yield* adapter.startSession(input);
          yield* adapter.startSession({ ...input, resumeCursor: "mock-token" });
          expect(sent(opened)).toHaveLength(3);
          for (const text of sent(opened)) {
            expect(text).toContain("through the Claude harness");
            expect(text).toContain("<pull_request_linking>");
            expect(text).not.toContain("T3 Code collaborative browser");
          }
        }),
      );
      // Codex with the thread's MCP server gets the browser guide (no device grant, no device guide).
      yield* run(
        "turn",
        (adapter, _waitFor, _seen, opened) =>
          Effect.gen(function* () {
            yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
            yield* adapter.startSession({ threadId: B, cwd, runtimeMode: "approval-required" });
            const [withTools, without] = sent(opened);
            expect(withTools).toContain("through the Codex harness");
            expect(withTools).toContain("## T3 Code collaborative browser");
            expect(withTools).not.toContain("## T3 Code devices");
            expect(without).toContain("through the Codex harness");
            expect(without).not.toContain("## T3 Code collaborative browser");
          }),
        { kind: "codex", mcpTransports: ["Http"] },
      );
    }).pipe(Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(A)))),
  );

  it.live(
    "open carries the launch options; a device grant puts the agent-device shim on PATH",
    () =>
      Effect.gen(function* () {
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("env-1"),
          threadId: A,
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: "http://127.0.0.1:3773/mcp",
          authorizationHeader: "Bearer secret",
          capabilities: new Set(["preview", "device"]),
          agentDeviceEnvironment: { PATH: "/t3/shim", PATH_SEPARATOR: ":", AGENT_DEVICE_X: "1" },
        });
        const launch = { env: { FOO: "1" }, args: ["--verbose"], config_home: "/homes/work" };
        yield* run(
          "turn",
          (adapter, _waitFor, _seen, opened) =>
            Effect.gen(function* () {
              yield* adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
              yield* adapter.startSession({ threadId: B, cwd, runtimeMode: "approval-required" });
              const [withDevices, plain] = opened();
              expect(withDevices).toMatchObject({
                args: ["--verbose"],
                config_home: "/homes/work",
              });
              expect(withDevices?.env).toEqual({
                FOO: "1",
                AGENT_DEVICE_X: "1",
                PATH: `/t3/shim:${process.env.PATH}`,
              });
              expect(plain).toMatchObject({ args: ["--verbose"], config_home: "/homes/work" });
              expect(plain?.env).toEqual({ FOO: "1" });
            }),
          { kind: "codex", mcpTransports: ["Http"], launch },
        );
      }).pipe(Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(A)))),
  );

  it.live("with T3's native log on, each thread's wire is recorded beside it; off, none is", () =>
    Effect.gen(function* () {
      // A path only: the mock agent has no wire, so nothing is written there.
      const dir = "/t3-logs/provider";
      const start = (adapter: Adapter, threadId: ThreadId) =>
        adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
      yield* run(
        "turn",
        (adapter, _waitFor, _seen, opened) =>
          Effect.gen(function* () {
            yield* start(adapter, A);
            yield* start(adapter, B);
            expect(opened().map((o) => o.record_wire)).toEqual([
              NodePath.join(dir, "events.thread-a.wire.log"),
              NodePath.join(dir, "events.thread-b.wire.log"),
            ]);
          }),
        { nativeLog: NodePath.join(dir, "events.log") },
      );
      yield* run("turn", (adapter, _waitFor, _seen, opened) =>
        Effect.gen(function* () {
          yield* start(adapter, A);
          expect(opened()[0]?.record_wire).toBeUndefined();
        }),
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------

type WaitFor = (match: (e: ProviderRuntimeEvent) => boolean) => Effect.Effect<ProviderRuntimeEvent>;
type Answered = { readonly request: string; readonly answer: Answer };

/**
 * Runs `body` against an adapter over `anyagent serve --mock <script>.json`.
 * Every event the adapter emits is collected; `waitFor` polls them and, after
 * 5 s, dies listing what it saw. `opened` lists the options of every `open` sent, `answered` every answer.
 * `mcpTransports` overrides the mock's probe (it advertises none); `kind` replaces claudeAgent, `agent` the mock,
 * `launch` the instance's launch options (none by default).
 * `nativeLog` turns T3's native event log on at that path (off by default).
 */
function run<A, E>(
  script: string,
  body: (
    adapter: Adapter,
    waitFor: WaitFor,
    seen: () => Seen,
    opened: () => ReadonlyArray<OpenOptions>,
    answered: () => ReadonlyArray<Answered>,
  ) => Effect.Effect<A, E>,
  options: {
    readonly mcpTransports?: McpTransport[];
    readonly kind?: string;
    readonly agent?: string;
    readonly launch?: Launch["options"];
    readonly nativeLog?: string;
  } = {},
) {
  const opens: OpenOptions[] = [];
  const answers: Answered[] = [];
  const mock = makeAnyagentRuntimeLayer({
    bin: BIN,
    mock: NodePath.join(ANYAGENT, `packages/mock-scripts/${script}.json`),
  });
  const layer = Layer.mergeAll(
    Layer.effect(
      AnyagentRuntime,
      Effect.map(AnyagentRuntime, ({ use }) => ({
        use: <T>(f: (runtime: Runtime) => Promise<T>) =>
          use((runtime) => f(recording(runtime, opens, answers))),
      })),
    ).pipe(Layer.provide(mock)),
    ServerConfig.layerTest(cwd, { prefix: "t3-anyagent-" }).pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(ProviderEventLoggers, {
      native:
        options.nativeLog === undefined
          ? undefined
          : {
              filePath: options.nativeLog,
              write: () => Effect.void,
              close: () => Effect.void,
            },
      canonical: undefined,
    }),
  );
  return Effect.gen(function* () {
    const { use } = yield* AnyagentRuntime;
    const { mcpTransports } = options;
    const probed = mcpTransports
      ? yield* Effect.promise(() => use((runtime) => runtime.probe("mock")))
      : undefined;
    const details = probed && {
      ...probed,
      capabilities: { ...probed.capabilities, mcp_transports: mcpTransports! },
    };
    const kind = options.kind ? ProviderDriverKind.make(options.kind) : KIND;
    const adapter = yield* makeAnyagentAdapter(
      kind,
      { agent: options.agent ?? "mock", options: options.launch ?? {} },
      details && (() => details),
    );
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
    return yield* body(
      adapter,
      waitFor,
      () => events,
      () => opens,
      () => answers,
    );
  }).pipe(Effect.scoped, Effect.provide(layer));
}

/** `runtime` with every `open`'s options pushed to `opens`, and every answer its sessions send to `answers`. */
function recording(runtime: Runtime, opens: OpenOptions[], answers: Answered[]): Runtime {
  return new Proxy(runtime, {
    get: (target, key) => {
      if (key === "open")
        return async (agent: string, opts: OpenOptions) => {
          opens.push(opts);
          const session = await target.open(agent, opts);
          const answer = session.answer.bind(session);
          session.answer = (request, reply) => {
            answers.push({ request, answer: reply });
            return answer(request, reply);
          };
          return session;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Each event as `type`, plus the detail a test pins: delta text, item type, decision, turn state, mode. */
function summary(events: Seen): string[] {
  return events.map((e) => {
    switch (e.type) {
      case "session.configured":
        return `${e.type}:${String(e.payload.config.mode)}`;
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
