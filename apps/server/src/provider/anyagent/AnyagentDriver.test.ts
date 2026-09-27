// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import type { AgentDetails, GenerateOptions, Runtime } from "anyagent-ts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderDriverError } from "../Errors.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeAnyagentDriver } from "./AnyagentDriver.ts";
import {
  AnyagentRuntime,
  AnyagentRuntimeLive,
  makeAnyagentRuntimeLayer,
} from "./AnyagentRuntime.ts";

// The anyagent checkout next to this one; its release binary is built with `--features mock`.
const ANYAGENT = NodePath.resolve(import.meta.dirname, "../../../../../../anyagent");
const BIN = NodePath.join(ANYAGENT, "target/release/anyagent");
const cwd = NodeOS.tmpdir();
const claude = makeAnyagentDriver(ProviderDriverKind.make("claudeAgent"), "mock", {
  displayName: "Claude",
  settings: ClaudeSettings,
});
const codex = makeAnyagentDriver(ProviderDriverKind.make("codex"), "mock", {
  displayName: "Codex",
  settings: CodexSettings,
});
const A = ThreadId.make("thread-a");
const B = ThreadId.make("thread-b");

describe("AnyagentDriver over the mock binary", () => {
  it.live("create probes once into the snapshot; a turn applies the picked model", () =>
    withRuntime("configure", () =>
      Effect.gen(function* () {
        const instance = yield* create(claude, "claudeAgent", yield* Scope.make());
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot).toMatchObject({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: true,
          installed: true,
          version: "mock",
          status: "ready",
          auth: { status: "authenticated", type: "api_key" },
        });
        expect(snapshot.models.map((m) => [m.slug, m.isDefault ?? false])).toEqual([
          ["sonnet", true],
          ["opus", false],
        ]);

        const seen = yield* collect(instance);
        yield* instance.adapter.startSession({ threadId: A, cwd, runtimeMode: "full-access" });
        const modelSelection = { instanceId: instance.instanceId, model: "opus" };
        const { turnId } = yield* instance.adapter.sendTurn({
          threadId: A,
          input: "hi",
          modelSelection,
        });
        yield* waitFor(seen, (e) => e.type === "turn.completed" && e.turnId === turnId);
        expect(seen.some((e) => e.type === "content.delta" && e.turnId === turnId)).toBe(true);
        const [session] = yield* instance.adapter.listSessions();
        expect(session?.model).toBe("opus");
      }),
    ),
  );

  it.live("a disabled instance is not probed and says so", () =>
    withRuntime("configure", () =>
      Effect.gen(function* () {
        const instance = yield* create(claude, "claudeAgent", yield* Scope.make(), false);
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          enabled: false,
          installed: false,
          status: "disabled",
        });
      }),
    ),
  );

  it.live("T3's reasoningEffort pick reaches anyagent's effort option", () =>
    withRuntime(effortScript(), () =>
      Effect.gen(function* () {
        const instance = yield* create(codex, "codex", yield* Scope.make());
        const [model] = (yield* instance.snapshot.getSnapshot).models;
        expect(model?.capabilities?.optionDescriptors?.map((d) => d.id)).toEqual([
          "reasoningEffort",
        ]);
        const seen = yield* collect(instance);
        yield* instance.adapter.startSession({ threadId: A, cwd, runtimeMode: "full-access" });
        const options = [{ id: "reasoningEffort", value: "low" }];
        yield* instance.adapter.sendTurn({
          threadId: A,
          input: "hi",
          modelSelection: { instanceId: instance.instanceId, model: "sonnet", options },
        });
        yield* waitFor(
          seen,
          (e) => e.type === "session.configured" && e.payload.config.effort === "low",
        );
      }),
    ),
  );

  // Review focus 5: two kinds share one `anyagent serve`; closing one leaves the other streaming.
  it.live("closing one kind's instance mid-turn of another: that turn still completes", () =>
    withRuntime("turn", () =>
      Effect.gen(function* () {
        const claudeScope = yield* Scope.make();
        const first = yield* create(claude, "claudeAgent", claudeScope);
        const second = yield* create(codex, "codex", yield* Scope.make());
        const secondSeen = yield* collect(second);
        yield* first.adapter.startSession({ threadId: A, cwd, runtimeMode: "approval-required" });
        yield* second.adapter.startSession({ threadId: B, cwd, runtimeMode: "approval-required" });
        const { turnId } = yield* second.adapter.sendTurn({ threadId: B, input: "hi" });
        yield* waitFor(secondSeen, (e) => e.type === "request.opened" && e.turnId === turnId);

        yield* Scope.close(claudeScope, Exit.void);
        expect(yield* first.adapter.hasSession(A)).toBe(false);
        expect(yield* second.adapter.hasSession(B)).toBe(true);
        yield* second.adapter.respondToRequest(B, ApprovalRequestId.make("r1"), "accept");
        yield* waitFor(secondSeen, (e) => e.type === "turn.completed" && e.turnId === turnId);
        expect(secondSeen.find((e) => e.type === "turn.completed")).toMatchObject({
          payload: { state: "completed" },
        });
        expect(secondSeen.every((e) => e.threadId === B && e.provider === "codex")).toBe(true);
      }),
    ),
  );

  it.live("a missing anyagent binary: the instance is built, in error naming the binary", () =>
    withRuntimeLayer(AnyagentRuntimeLive, () =>
      Effect.gen(function* () {
        const bin = "/nonexistent/anyagent";
        const previous = process.env.ANYAGENT_BIN;
        process.env.ANYAGENT_BIN = bin;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.ANYAGENT_BIN;
            else process.env.ANYAGENT_BIN = previous;
          }),
        );
        const instance = yield* create(claude, "claudeAgent", yield* Scope.make());
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot).toMatchObject({ status: "error", enabled: true });
        expect(snapshot.message).toContain(bin);
        expect(snapshot.message).toContain("set ANYAGENT_BIN");
        const error = yield* Effect.flip(
          instance.adapter.startSession({ threadId: A, cwd, runtimeMode: "full-access" }),
        );
        expect(error.message).toContain(bin);
      }),
    ),
  );

  it.live("anyagent serve exiting: the next refresh starts a new one", () =>
    withRuntime("configure", () =>
      Effect.gen(function* () {
        const { use } = yield* AnyagentRuntime;
        const instance = yield* create(claude, "claudeAgent", yield* Scope.make());
        const exited = yield* Effect.promise(() =>
          use(async (runtime) => {
            await runtime.close();
            return runtime.exited;
          }),
        );
        expect(exited).toBe(0);
        expect(yield* instance.snapshot.refresh).toMatchObject({ status: "ready" });
        yield* instance.adapter.startSession({ threadId: A, cwd, runtimeMode: "full-access" });
        expect(yield* instance.adapter.hasSession(A)).toBe(true);
      }),
    ),
  );

  it.live("capabilities follow the newest probe: a failed boot probe, then a good refresh", () => {
    let probes = 0;
    const details: AgentDetails = {
      version: "1",
      auth: "Unknown",
      capabilities: { features: ["Rollback", "Compact"], mcp_transports: [] },
      config_options: [],
      commands: [],
    };
    const runtime = { probe: async () => details } as unknown as Runtime;
    const flaky = Layer.succeed(AnyagentRuntime, {
      use: (f) => (probes++ === 0 ? Promise.reject(new Error("boot probe failed")) : f(runtime)),
    });
    return withRuntimeLayer(flaky, () =>
      Effect.gen(function* () {
        const instance = yield* create(claude, "claudeAgent", yield* Scope.make());
        expect(instance.adapter.capabilities.supportsConversationRollback).toBe(false);
        expect(instance.adapter.compaction).toBeUndefined();
        // One refresh may be the boot one, which reuses create's (failed) probe; the next probes.
        yield* instance.snapshot.refresh;
        expect(yield* instance.snapshot.refresh).toMatchObject({
          status: "ready",
          supportsConversationRollback: true,
        });
        expect(instance.adapter.capabilities.supportsConversationRollback).toBe(true);
        expect(instance.adapter.compaction?.type).toBe("native");
      }),
    );
  });

  it.live("text generation asks anyagent for one reply and decodes its JSON", () =>
    withRuntime(titleScript(), () =>
      Effect.gen(function* () {
        const instance = yield* create(claude, "claudeAgent", yield* Scope.make());
        const title = yield* instance.textGeneration.generateThreadTitle({
          cwd,
          message: "the login page crashes",
          modelSelection: { instanceId: instance.instanceId, model: "sonnet" },
        });
        expect(title).toEqual({ title: "Fix login crash" });
      }),
    ),
  );

  it.live("title and branch generation show the agent the image attachments' files", () => {
    const sent: GenerateOptions[] = [];
    const details: AgentDetails = {
      auth: "Unknown",
      capabilities: { features: ["Images"], mcp_transports: [] },
      config_options: [],
      commands: [],
    };
    const runtime = {
      probe: async () => details,
      generate: async (_agent: string, opts: GenerateOptions) => {
        sent.push(opts);
        return JSON.stringify({ title: "Fix login crash", branch: "fix-login-crash" });
      },
    } as unknown as Runtime;
    const fake = Layer.succeed(AnyagentRuntime, { use: (f) => f(runtime) });
    return withRuntimeLayer(fake, () =>
      Effect.gen(function* () {
        const instance = yield* create(claude, "claudeAgent", yield* Scope.make());
        const image = {
          type: "image" as const,
          id: "thread-a-00000000-0000-4000-8000-000000000001",
          name: "login.png",
          mimeType: "image/png",
          sizeBytes: 10,
        };
        const file = { ...image, type: "file" as const, name: "notes.txt", mimeType: "text/plain" };
        const input = {
          cwd,
          message: "the login page crashes",
          attachments: [image, file],
          modelSelection: { instanceId: instance.instanceId, model: "sonnet" },
        };
        yield* instance.textGeneration.generateThreadTitle(input);
        yield* instance.textGeneration.generateBranchName(input);

        // The image goes as its stored file; the text file stays a name in the prompt.
        const path = NodePath.join((yield* ServerConfig).attachmentsDir, `${image.id}.png`);
        expect(sent.map((o) => o.attachments)).toEqual([[path], [path]]);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------

/** Runs `body` with every service the driver needs, over `anyagent serve --mock <script>`. */
function withRuntime<A, E>(script: string, body: () => Effect.Effect<A, E, Env>) {
  const mock = script.endsWith(".json")
    ? script
    : NodePath.join(ANYAGENT, `packages/mock-scripts/${script}.json`);
  return withRuntimeLayer(makeAnyagentRuntimeLayer({ bin: BIN, mock }), body);
}

/** Runs `body` with every service the driver needs and `runtime` as the anyagent runtime. */
function withRuntimeLayer<A, E>(
  runtime: Layer.Layer<AnyagentRuntime>,
  body: () => Effect.Effect<A, E, Env>,
) {
  const layer = Layer.mergeAll(
    runtime,
    ServerConfig.layerTest(cwd, { prefix: "t3-anyagent-driver-" }),
    ServerSettingsService.layerTest(),
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    // Version advisories would ask npm; the enrichment logs this failure and moves on.
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("no network in unit tests")),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return body().pipe(Effect.provide(layer), Effect.scoped);
}

type Env = Effect.Services<ReturnType<typeof claude.create>> | Scope.Scope;

/** One instance of `driver` in `scope`, enabled unless told otherwise. */
function create(
  driver: typeof claude,
  id: string,
  scope: Scope.Closeable,
  enabled = true,
): Effect.Effect<ProviderInstance, ProviderDriverError, Env> {
  return driver
    .create({
      instanceId: ProviderInstanceId.make(id),
      displayName: undefined,
      environment: [],
      enabled,
      config: driver.defaultConfig(),
    })
    .pipe(Effect.provideService(Scope.Scope, scope));
}

/** Collects every event the instance's adapter emits. */
function collect(instance: ProviderInstance) {
  const events: ProviderRuntimeEvent[] = [];
  return Stream.runForEach(instance.adapter.streamEvents, (e) =>
    Effect.sync(() => events.push(e)),
  ).pipe(Effect.forkScoped, Effect.as(events));
}

/** Polls `events` for a match; after 5 s dies listing what arrived. */
function waitFor(events: ProviderRuntimeEvent[], match: (e: ProviderRuntimeEvent) => boolean) {
  return Effect.gen(function* () {
    for (let i = 0; i < 250; i++) {
      const found = events.find(match);
      if (found) return found;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error(`timed out; saw ${events.map((e) => e.type).join(", ")}`));
  });
}

/** A mock script whose one turn replies with a thread title as JSON. */
function titleScript(): string {
  const text = JSON.stringify({ title: "Fix login crash" });
  return writeScript("title", { turns: [textTurn(text)] });
}

/** A mock script advertising a `model` and an `effort` option, with one text turn. */
function effortScript(): string {
  const select = (id: string, values: string[]) => ({
    id,
    name: id,
    category: null,
    kind: {
      Select: { choices: values.map((value) => ({ value, label: value, description: null })) },
    },
    current: values[0],
    live: true,
  });
  return writeScript("effort", {
    options: [select("model", ["sonnet", "opus"]), select("effort", ["high", "low"])],
    turns: [textTurn("hi")],
  });
}

function textTurn(text: string) {
  return [
    { Emit: { TextDelta: { message_id: "m1", text } } },
    { End: { Completed: { source: "Protocol" } } },
  ];
}

function writeScript(name: string, script: object): string {
  const file = NodePath.join(NodeFS.mkdtempSync(NodePath.join(cwd, `t3-${name}-`)), `${name}.json`);
  NodeFS.writeFileSync(file, JSON.stringify(script));
  return file;
}
