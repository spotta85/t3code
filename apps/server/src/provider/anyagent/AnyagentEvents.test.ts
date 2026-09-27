import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderRuntimeEvent, ThreadId, TurnId } from "@t3tools/contracts";
import { AnyagentError, type Event, type EventKind, type Request } from "anyagent-ts";

import {
  type EventContext,
  type OpenRequest,
  sessionExitedEvents,
  sessionStartedEvent,
  toProviderRuntimeEvents,
} from "./AnyagentEvents.ts";

const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const AT = "2023-11-14T22:13:20.005Z";
const base = {
  provider: ProviderDriverKind.make("claudeAgent"),
  threadId: ThreadId.make("thread-1"),
  createdAt: AT,
  turnId: TurnId.make("k:p1"),
};
const permission: Request = {
  Permission: {
    id: "r1",
    tool: tool("Pending"),
    options: ["AllowOnce", "AllowAlways", "DenyOnce", "DenyAlways"],
    detail: "run the tests",
  },
};
const question: Request = {
  Question: {
    id: "q1",
    questions: [
      {
        id: "color",
        text: "Which color?",
        header: "Color",
        choices: [{ id: "c-red", label: "Red", description: "warm" }],
        multi_select: false,
        allows_free_text: true,
      },
    ],
  },
};

/** Maps one event, checking every result decodes as a T3 runtime event. */
function map(
  kind: EventKind,
  ctx: Partial<Pick<EventContext, "requests" | "textMessages" | "tools">> = {},
): ReadonlyArray<ProviderRuntimeEvent> {
  const out = toProviderRuntimeEvents(context(ctx), event(kind));
  for (const e of out) decode(e);
  return out;
}

describe("toProviderRuntimeEvents", () => {
  it("TurnStarted -> turn.started", () => {
    expect(map({ TurnStarted: { origin: { Prompt: "p1" } } })).toEqual([
      { ...base, eventId: "k:7:0", type: "turn.started", payload: {} },
    ]);
  });

  it("TextDelta -> assistant_text content.delta", () => {
    expect(map({ TextDelta: { message_id: "m1", text: "hi" } })).toEqual([
      {
        ...base,
        eventId: "k:7:0",
        type: "content.delta",
        itemId: "m1",
        payload: { streamKind: "assistant_text", delta: "hi" },
      },
    ]);
  });

  it("ReasoningDelta -> reasoning_text content.delta", () => {
    expect(map({ ReasoningDelta: { message_id: "m2", text: "hmm" } })).toMatchObject([
      {
        type: "content.delta",
        itemId: "m2",
        payload: { streamKind: "reasoning_text", delta: "hmm" },
      },
    ]);
  });

  it("MessageEnded -> item.completed, assistant_message for text and reasoning otherwise", () => {
    const ended: EventKind = { MessageEnded: { message_id: "m1" } };
    expect(map(ended, { textMessages: new Set(["m1"]) })).toMatchObject([
      {
        type: "item.completed",
        itemId: "m1",
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ]);
    expect(map(ended)).toMatchObject([
      {
        type: "item.completed",
        itemId: "m1",
        payload: { itemType: "reasoning", status: "completed" },
      },
    ]);
  });

  it("a subagent's text, reasoning and message end (parent_tool_id set) -> nothing", () => {
    const nested = (kind: EventKind) =>
      toProviderRuntimeEvents(context({ textMessages: new Set(["m9"]) }), {
        ...event(kind),
        turn_info: { id: "t1", parent_tool_id: "task-1" },
      });
    expect(nested({ TextDelta: { message_id: "m9", text: "sub says" } })).toEqual([]);
    expect(nested({ ReasoningDelta: { message_id: "m9", text: "sub thinks" } })).toEqual([]);
    expect(nested({ MessageEnded: { message_id: "m9" } })).toEqual([]);
  });

  it("UserMessage -> nothing (T3 records its own user messages)", () => {
    expect(map({ UserMessage: { message_id: "u1", text: "steer" } })).toEqual([]);
  });

  it("ToolUpdated -> item.started when first seen, item.updated after, item.completed when done", () => {
    expect(map({ ToolUpdated: tool("Pending") })).toEqual([
      {
        ...base,
        eventId: "k:7:0",
        type: "item.started",
        itemId: "tool-1",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "cargo test",
          detail: "cargo test",
          data: tool("Pending"),
        },
      },
    ]);
    const seen = { tools: new Set(["tool-1"]) };
    expect(map({ ToolUpdated: tool("Running") }, seen)).toMatchObject([
      { type: "item.updated", payload: { status: "inProgress" } },
    ]);
    expect(map({ ToolUpdated: tool("Completed") })).toMatchObject([
      { type: "item.completed", payload: { status: "completed" } },
    ]);
    expect(map({ ToolUpdated: tool("Failed") })).toMatchObject([
      { type: "item.completed", payload: { status: "failed" } },
    ]);
    expect(
      map({ ToolUpdated: { ...tool("Completed"), kind: "Edit", input: { Path: "a.rs" } } }),
    ).toMatchObject([{ payload: { itemType: "file_change", detail: "a.rs" } }]);
  });

  it("ToolUpdated first seen already Running (claude, codex) -> item.started", () => {
    expect(map({ ToolUpdated: tool("Running") })).toMatchObject([
      { type: "item.started", payload: { status: "inProgress" } },
    ]);
  });

  it("ToolUpdated repeated Pending snapshot -> item.updated, not a second item.started", () => {
    expect(map({ ToolUpdated: tool("Pending") }, { tools: new Set(["tool-1"]) })).toMatchObject([
      { type: "item.updated", payload: { status: "inProgress" } },
    ]);
  });

  it("ToolUpdated Subagent -> its item events plus task.started first seen, task.completed when done", () => {
    const sub = (status: "Running" | "Completed") => ({
      ...tool(status),
      kind: "Subagent" as const,
      title: "list the files",
      input: "None" as const,
    });
    const task = {
      taskId: "tool-1",
      taskType: "subagent",
      toolUseId: "tool-1",
      title: "list the files",
    };
    expect(map({ ToolUpdated: sub("Running") })).toMatchObject([
      { eventId: "k:7:0", type: "item.started", payload: { itemType: "collab_agent_tool_call" } },
      {
        eventId: "k:7:1",
        type: "task.started",
        payload: { ...task, description: "list the files" },
      },
    ]);
    expect(map({ ToolUpdated: sub("Completed") }, { tools: new Set(["tool-1"]) })).toMatchObject([
      { type: "item.completed" },
      { eventId: "k:7:2", type: "task.completed", payload: { ...task, status: "completed" } },
    ]);
  });

  it("ToolOutputDelta -> command_output content.delta", () => {
    expect(map({ ToolOutputDelta: { tool_id: "tool-1", text: "ok\n" } })).toMatchObject([
      {
        type: "content.delta",
        itemId: "tool-1",
        payload: { streamKind: "command_output", delta: "ok\n" },
      },
    ]);
  });

  it("PlanUpdated -> turn.plan.updated", () => {
    const entries = [
      { text: "read", status: "Completed" as const },
      { text: "write", status: "InProgress" as const },
      { text: "test", status: "Pending" as const },
    ];
    expect(map({ PlanUpdated: { entries } })).toMatchObject([
      {
        type: "turn.plan.updated",
        payload: {
          plan: [
            { step: "read", status: "completed" },
            { step: "write", status: "inProgress" },
            { step: "test", status: "pending" },
          ],
        },
      },
    ]);
  });

  it("RequestOpened Permission -> request.opened with T3 decisions for the offered choices", () => {
    expect(map({ RequestOpened: permission })).toEqual([
      {
        ...base,
        eventId: "k:7:0",
        type: "request.opened",
        requestId: "r1",
        payload: {
          requestType: "exec_command_approval",
          detail: "run the tests",
          options: [
            { decision: "accept", label: "Allow once" },
            { decision: "acceptForSession", label: "Always allow" },
            { decision: "decline", label: "Deny" },
          ],
          args: tool("Pending"),
        },
      },
    ]);
  });

  it("RequestOpened Question -> user-input.requested", () => {
    expect(map({ RequestOpened: question })).toMatchObject([
      {
        type: "user-input.requested",
        requestId: "q1",
        payload: {
          questions: [
            {
              id: "color",
              header: "Color",
              question: "Which color?",
              options: [{ label: "Red", description: "warm", value: "c-red" }],
              allowCustomAnswer: true,
              multiSelect: false,
            },
          ],
        },
      },
    ]);
  });

  it("RequestClosed -> request.resolved or user-input.resolved, with T3's answer", () => {
    const closed = (id: string): EventKind => ({ RequestClosed: { request_id: id } });
    const requests = new Map<string, OpenRequest>([
      ["r1", { request: permission, decision: "accept" }],
      ["q1", { request: question, answers: { color: "Red" } }],
    ]);
    expect(map(closed("r1"), { requests })).toMatchObject([
      {
        type: "request.resolved",
        requestId: "r1",
        payload: { requestType: "exec_command_approval", decision: "accept" },
      },
    ]);
    expect(map(closed("q1"), { requests })).toMatchObject([
      { type: "user-input.resolved", requestId: "q1", payload: { answers: { color: "Red" } } },
    ]);
    expect(map(closed("gone"), { requests })).toEqual([]);
  });

  it("SessionUpdated -> session.configured, plus thread.metadata.updated when the agent titled it", () => {
    const info = sessionInfo({ model: "opus", fast: true });
    expect(map({ SessionUpdated: info })).toMatchObject([
      { type: "session.configured", payload: { config: { model: "opus", fast: true } } },
    ]);
    expect(map({ SessionUpdated: { ...info, title: " Fix the build " } })).toMatchObject([
      { type: "session.configured" },
      { eventId: "k:7:1", type: "thread.metadata.updated", payload: { name: "Fix the build" } },
    ]);
  });

  it("StatusChanged -> nothing (T3 derives status from turn and request events)", () => {
    expect(map({ StatusChanged: "Working" })).toEqual([]);
  });

  it("ContextUsage -> thread.token-usage.updated", () => {
    expect(map({ ContextUsage: { used_tokens: 1200, window_tokens: 200000 } })).toMatchObject([
      {
        type: "thread.token-usage.updated",
        payload: { usage: { usedTokens: 1200, maxTokens: 200000 } },
      },
    ]);
  });

  it("ContextCompacted -> thread.state.changed compacted", () => {
    expect(map("ContextCompacted")).toMatchObject([
      { type: "thread.state.changed", payload: { state: "compacted" } },
    ]);
  });

  it("PlanUsageUpdated -> account.rate-limits.updated", () => {
    const usage = {
      windows: [
        {
          label: "Session",
          used_percent: 12.5,
          resets_at: { secs_since_epoch: 1_700_000_000, nanos_since_epoch: 5_000_000 },
        },
        { label: "Week", used_percent: 40 },
      ],
      fetched_at: { secs_since_epoch: 0, nanos_since_epoch: 0 },
    };
    expect(map({ PlanUsageUpdated: usage })).toMatchObject([
      {
        type: "account.rate-limits.updated",
        payload: {
          limits: {
            windows: [
              { id: "Session", kind: "session", label: "Session", usedPercent: 12.5, resetsAt: AT },
              { id: "Week", kind: "weekly", label: "Week", usedPercent: 40 },
            ],
          },
        },
      },
    ]);
  });

  it("Diagnostic -> runtime.warning, or runtime.error at level Error", () => {
    expect(
      map({ Diagnostic: { level: "Info", message: "the provider is retrying" } }),
    ).toMatchObject([
      { type: "runtime.warning", payload: { message: "the provider is retrying" } },
    ]);
    expect(map({ Diagnostic: { level: "Warning", message: "stalled" } })).toMatchObject([
      { type: "runtime.warning", payload: { message: "stalled" } },
    ]);
    expect(map({ Diagnostic: { level: "Error", message: "bad frame" } })).toMatchObject([
      { type: "runtime.error", payload: { message: "bad frame" } },
    ]);
  });

  it("an Info Diagnostic for an unmapped wire frame (a */raw_frame extension) -> nothing", () => {
    // codex sends dozens per turn: "unrecognized codex frame `hook/started`".
    const ev = {
      ...event({
        Diagnostic: { level: "Info", message: "unrecognized codex frame `hook/started`" },
      }),
      extensions: { "codex/raw_frame": { method: "hook/started" } },
    };
    expect(toProviderRuntimeEvents(context({}), ev)).toEqual([]);
  });

  it("TurnEnded -> turn.completed with the state its stop reason names", () => {
    const ended = (stop: Extract<EventKind, { TurnEnded: unknown }>["TurnEnded"]["stop"]) =>
      map({ TurnEnded: { stop, background: [] } });
    expect(ended({ Completed: { source: "Protocol" } })).toEqual([
      {
        ...base,
        eventId: "k:7:0",
        type: "turn.completed",
        payload: { state: "completed", stopReason: null },
      },
    ]);
    expect(ended({ Completed: { source: "Inferred" } })).toMatchObject([
      { payload: { state: "completed", stopReason: "inferred" } },
    ]);
    expect(ended("Cancelled")).toMatchObject([
      { payload: { state: "cancelled", stopReason: "cancelled" } },
    ]);
    expect(ended("Refused")).toMatchObject([
      { payload: { state: "completed", stopReason: "refusal" } },
    ]);
    expect(ended({ Failed: { message: "agent exited" } })).toMatchObject([
      { payload: { state: "failed", stopReason: "failed", errorMessage: "agent exited" } },
    ]);
  });
});

describe("session lifecycle events", () => {
  it("an opened session -> session.started with its resume token", () => {
    const e = sessionStartedEvent(context(), sessionInfo({}), AT);
    decode(e);
    expect(e).toEqual({
      eventId: "k:started",
      provider: base.provider,
      threadId: base.threadId,
      createdAt: AT,
      type: "session.started",
      payload: { resume: "tok-1" },
    });
  });

  it("a clean end -> session.exited graceful", () => {
    expect(sessionExitedEvents(context(), undefined, AT)).toMatchObject([
      { type: "session.exited", payload: { exitKind: "graceful" } },
    ]);
  });

  it("a session error -> runtime.error with the error body, then session.exited with the reason", () => {
    const error = new AnyagentError({
      kind: "ProcessExited",
      message: "agent died",
      status: "9",
      stderr: "",
    });
    const out = sessionExitedEvents(context(), error, AT);
    for (const e of out) decode(e);
    expect(out).toMatchObject([
      {
        type: "runtime.error",
        payload: { message: "ProcessExited: agent died", detail: { status: "9", stderr: "" } },
      },
      {
        type: "session.exited",
        payload: { reason: "ProcessExited: agent died", exitKind: "error", recoverable: false },
      },
    ]);
    const auth = new AnyagentError({ kind: "AuthRequired", message: "log in", login: [] });
    expect(sessionExitedEvents(context(), auth, AT)[1]).toMatchObject({
      payload: { recoverable: true },
    });
  });
});

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

/** An event context for thread-1, turn k:p1, session key k. */
function context(extra: Partial<EventContext> = {}): EventContext {
  return {
    provider: base.provider,
    threadId: base.threadId,
    turnId: base.turnId,
    sessionKey: "k",
    requests: new Map(),
    textMessages: new Set(),
    tools: new Set(),
    ...extra,
  };
}

/** One anyagent event: sequence 7, in turn t1, at AT. */
function event(kind: EventKind): Event {
  return {
    sequence: 7,
    occurred_at: { secs_since_epoch: 1_700_000_000, nanos_since_epoch: 5_000_000 },
    session_id: "s1",
    turn_info: { id: "t1" },
    kind,
    extensions: {},
  };
}

/** A `cargo test` Execute tool in the given state. */
function tool(status: "Pending" | "Running" | "Completed" | "Failed") {
  return {
    id: "tool-1",
    kind: "Execute" as const,
    title: "cargo test",
    status,
    input: { Command: { command: "cargo test", cwd: null } },
    output: null,
    diffs: [],
    locations: [],
    raw: null,
  };
}

/** A session snapshot with the given configuration and resume token tok-1. */
function sessionInfo(options: Record<string, string | boolean>) {
  return {
    id: "s1",
    agent: {
      id: "claude",
      name: "Claude",
      executable_path: "/bin/claude",
      source: "Path" as const,
    },
    details: {
      auth: "Unknown" as const,
      capabilities: { features: [], mcp_transports: [] },
      config_options: [],
      commands: [],
    },
    configuration: { options },
    resume_token: "tok-1",
  };
}
