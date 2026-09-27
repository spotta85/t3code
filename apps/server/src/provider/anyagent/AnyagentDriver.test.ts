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
import { type AgentDetails, AnyagentError, type GenerateOptions, type Runtime } from "anyagent-ts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderDriverError } from "../Errors.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { launchOf, makeAnyagentDriver } from "./AnyagentDriver.ts";
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
    const runtime = {
      probe: async () => details,
      planUsage: async () => Promise.reject(new Error("no plan usage")),
    } as unknown as Runtime;
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

  it.live("a workspace snapshot probes in that directory: its skills fill the picker", () => {
    const probes: Array<Obj> = [];
    let usageReads = 0;
    const skill = { Skill: { path: "/w/.agents/skills/deploy/SKILL.md", scope: "repo" } };
    const runtime = {
      probe: async (_agent: string, opts: Obj) => {
        probes.push(opts);
        const commands = opts.dir ? [{ name: "deploy", description: "", source: skill }] : [];
        return { ...details(), commands };
      },
      planUsage: async () => {
        usageReads++;
        return Promise.reject(new Error("no plan usage"));
      },
    } as unknown as Runtime;
    const fake = Layer.succeed(AnyagentRuntime, { use: (f) => f(runtime) });
    return withRuntimeLayer(fake, () =>
      Effect.gen(function* () {
        const instance = yield* create(codex, "codex", yield* Scope.make());
        expect((yield* instance.snapshot.getSnapshot).skills).toEqual([]);
        const workspace = yield* instance.snapshotForCwd!("/w");
        expect(workspace.skills).toEqual([
          {
            name: "deploy",
            path: "/w/.agents/skills/deploy/SKILL.md",
            enabled: true,
            scope: "repo",
          },
        ]);
        expect(probes.map((o) => o.dir)).toEqual([undefined, "/w"]);
        // Plan usage is the machine's: the workspace probe does not read it again.
        expect(usageReads).toBe(1);
      }),
    );
  });

  it("launchOf: each setting becomes its launch option; default settings give the plain agent id", () => {
    const defaults = { enabled: true, binaryPath: "codex", customModels: [] };
    expect(launchOf("codex", defaults, "codex", [])).toEqual({ agent: "codex", options: {} });
    const home = NodeOS.homedir();
    const environment = [
      { name: "OPENAI_API_KEY", value: "sk-1", sensitive: true },
      { name: "CODEX_HOME", value: "~/.codex-env", sensitive: false },
    ];
    const settings = {
      ...defaults,
      binaryPath: "/opt/codex/bin/codex",
      launchArgs: `-c model="o3" --name 'two words'`,
      homePath: "~/.codex-work",
    };
    expect(launchOf("codex", settings, "codex", environment)).toEqual({
      agent: { id: "codex", path: "/opt/codex/bin/codex" },
      options: {
        env: { OPENAI_API_KEY: "sk-1", CODEX_HOME: NodePath.join(home, ".codex-env") },
        args: ["-c", "model=o3", "--name", "two words"],
        config_home: NodePath.join(home, ".codex-work"),
      },
    });
    // A command other than the kind's default is an agent at that path too.
    expect(launchOf("codex", { ...defaults, binaryPath: "codex-beta" }, "codex", []).agent).toEqual(
      {
        id: "codex",
        path: "codex-beta",
      },
    );
  });

  it.live("an instance's launch options reach probe, plan usage, open and generate", () => {
    const calls: Array<{ method: string; agent: unknown; options: unknown }> = [];
    const recorded = new Set(["probe", "planUsage", "open", "generate"]);
    const recording = Layer.effect(
      AnyagentRuntime,
      Effect.map(AnyagentRuntime, ({ use }) => ({
        use: <T>(f: (runtime: Runtime) => Promise<T>) =>
          use((runtime) =>
            f(
              new Proxy(runtime, {
                get: (target, key) => {
                  const value = Reflect.get(target, key);
                  if (typeof value !== "function") return value;
                  return (...args: unknown[]) => {
                    if (recorded.has(String(key)))
                      calls.push({ method: String(key), agent: args[0], options: args[1] });
                    return value.apply(target, args);
                  };
                },
              }),
            ),
          ),
      })),
    ).pipe(Layer.provide(makeAnyagentRuntimeLayer({ bin: BIN, mock: titleScript() })));
    return withRuntimeLayer(recording, () =>
      Effect.gen(function* () {
        const config = {
          ...claude.defaultConfig(),
          binaryPath: "/opt/claude-cli",
          homePath: "/homes/work",
          launchArgs: "--verbose",
        };
        const environment = [{ name: "FOO", value: "1", sensitive: false }];
        const instance = yield* create(claude, "claudeAgent", yield* Scope.make(), true, {
          config,
          environment,
        });
        yield* instance.adapter.startSession({ threadId: A, cwd, runtimeMode: "full-access" });
        yield* instance.textGeneration.generateThreadTitle({
          cwd,
          message: "the login page crashes",
          modelSelection: { instanceId: instance.instanceId, model: "sonnet" },
        });

        const launch = { env: { FOO: "1" }, args: ["--verbose"], config_home: "/homes/work" };
        expect(calls.map((c) => c.method).toSorted()).toEqual(
          ["generate", "open", "planUsage", "probe"].toSorted(),
        );
        for (const call of calls) {
          expect(call.agent).toEqual({ id: "mock", path: "/opt/claude-cli" });
          expect(call.options).toMatchObject(launch);
        }
        // The mock has no plan usage: anyagent says so, and the snapshot shows it as unsupported.
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot.usageLimits?.unavailable?.reason).toBe("unsupported");
      }),
    );
  });

  it.live("an agent that fails to start is not installed only at a custom binaryPath", () => {
    const spawnFailed = new AnyagentError({
      kind: "SpawnFailed",
      message: "could not start agent: /opt/claude: permission denied",
    });
    const runtime = { probe: () => Promise.reject(spawnFailed) } as unknown as Runtime;
    const failing = Layer.succeed(AnyagentRuntime, { use: (f) => f(runtime) });
    return withRuntimeLayer(failing, () =>
      Effect.gen(function* () {
        // The discovered agent is installed; it just would not start.
        const found = yield* create(claude, "claudeAgent", yield* Scope.make());
        expect(yield* found.snapshot.getSnapshot).toMatchObject({
          installed: true,
          status: "error",
          message: expect.stringContaining("probe failed: SpawnFailed"),
        });
        const config = { ...claude.defaultConfig(), binaryPath: "/opt/claude" };
        const pinned = yield* create(claude, "claude2", yield* Scope.make(), true, { config });
        expect(yield* pinned.snapshot.getSnapshot).toMatchObject({
          installed: false,
          status: "error",
          message: expect.stringContaining("is not installed"),
        });
      }),
    );
  });

  it.live(
    "a turn that switches to a model carrying fast applies the model, then the fast pick",
    () => {
      const fast = {
        id: "fast",
        name: "Fast",
        kind: "Boolean" as const,
        current: false,
        live: true,
      };
      const choices = [
        { value: "small", label: "Small" },
        { value: "big", label: "Big", options: [fast] },
      ];
      const model = { id: "model", name: "Model", kind: { Select: { choices } }, live: true };
      // The session runs `small`: its options have no `fast` until `big` applies.
      const details: AgentDetails = {
        auth: "Unknown",
        capabilities: { features: [], mcp_transports: [] },
        config_options: [{ ...model, current: "small" }],
        commands: [],
      };
      const configured: Array<[string, unknown]> = [];
      let info = { id: "s1", details, configuration: { options: { model: "small" } as Obj } };
      const session = {
        id: "s1",
        get info() {
          return info;
        },
        // No events: the pump waits on a read that never settles.
        events: () => ({ next: () => new Promise(() => {}) }),
        // Like a real agent, a change applies a moment later; `big` brings its own `fast`.
        configure: async (id: string, value: unknown) => {
          configured.push([id, value]);
          // @effect-diagnostics-next-line globalTimers:off - a plain fake of the agent's delay
          setTimeout(() => {
            const options = { ...info.configuration.options, [id]: value };
            const own = options.model === "big" ? [fast] : [];
            const config_options = [{ ...model, current: options.model as string }, ...own];
            info = {
              ...info,
              details: { ...info.details, config_options },
              configuration: { options },
            };
          }, 50);
        },
        prompt: async () => ({ prompt_id: "p1", kind: { Queued: { position: 0 } } }),
        close: async () => {},
      };
      const runtime = {
        probe: async () => details,
        planUsage: async () => Promise.reject(new Error("no plan usage")),
        open: async () => session,
      } as unknown as Runtime;
      const fake = Layer.succeed(AnyagentRuntime, { use: (f) => f(runtime) });
      return withRuntimeLayer(fake, () =>
        Effect.gen(function* () {
          const instance = yield* create(claude, "claudeAgent", yield* Scope.make());
          yield* instance.adapter.startSession({ threadId: A, cwd, runtimeMode: "full-access" });
          const options = [{ id: "fastMode", value: true }];
          yield* instance.adapter.sendTurn({
            threadId: A,
            input: "hi",
            modelSelection: { instanceId: instance.instanceId, model: "big", options },
          });
          expect(configured).toEqual([
            ["model", "big"],
            ["fast", true],
          ]);
        }),
      );
    },
  );

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

  it.live("text generation sends a strict output schema where the agent takes one", () => {
    const sent: GenerateOptions[] = [];
    // One reply that decodes for every operation's schema.
    const reply = { subject: "Fix login", body: "b", branch: "fix-login", title: "Fix login" };
    let features: AgentDetails["capabilities"]["features"] = ["OutputSchema"];
    const runtime = {
      probe: async () => ({ ...details(), capabilities: { features, mcp_transports: [] } }),
      planUsage: async () => Promise.reject(new Error("no plan usage")),
      generate: async (_agent: string, opts: GenerateOptions) => {
        sent.push(opts);
        const json = JSON.stringify(reply);
        return opts.output_schema ? json : `Here you go:\n${json}\nDone.`;
      },
    } as unknown as Runtime;
    const fake = Layer.succeed(AnyagentRuntime, { use: (f) => f(runtime) });
    return withRuntimeLayer(fake, () =>
      Effect.gen(function* () {
        const instance = yield* create(codex, "codex", yield* Scope.make());
        const gen = instance.textGeneration;
        const modelSelection = { instanceId: instance.instanceId, model: "gpt-5.5" };
        const common = { cwd, modelSelection };
        yield* gen.generateThreadTitle({ ...common, message: "the login page crashes" });
        yield* gen.generateBranchName({ ...common, message: "the login page crashes" });
        const commit = { ...common, branch: null, stagedSummary: "M a", stagedPatch: "+a" };
        yield* gen.generateCommitMessage({ ...commit, includeBranch: true });
        yield* gen.generatePrContent({
          ...common,
          baseBranch: "main",
          headBranch: "fix-login",
          commitSummary: "Fix login",
          diffSummary: "M a",
          diffPatch: "+a",
        });
        // codex's rule: every object closed, every property required.
        for (const opts of sent) expect(strictObjects(opts.output_schema)).toBe(true);
        expect(sent.map((o) => Object.keys(o.output_schema?.properties ?? {}))).toEqual([
          ["title", "needsRefinement"],
          ["branch"],
          ["subject", "body", "branch"],
          ["title", "body"],
        ]);

        // Without the capability: no schema, and the JSON is dug out of the reply's text.
        features = [];
        yield* instance.snapshot.refresh;
        yield* instance.snapshot.refresh;
        const title = yield* gen.generateThreadTitle({
          ...common,
          message: "the login page crashes",
        });
        expect(sent.at(-1)?.output_schema).toBeUndefined();
        expect(title).toEqual({ title: "Fix login" });
      }),
    );
  });

  it.live("with T3's native log on, text generation records its wire beside it", () => {
    const sent: GenerateOptions[] = [];
    const runtime = {
      probe: async () => details(),
      planUsage: async () => Promise.reject(new Error("no plan usage")),
      generate: async (_agent: string, opts: GenerateOptions) => {
        sent.push(opts);
        return JSON.stringify({ title: "Fix login" });
      },
    } as unknown as Runtime;
    const fake = Layer.succeed(AnyagentRuntime, { use: (f) => f(runtime) });
    const title = Effect.gen(function* () {
      const instance = yield* create(codex, "codex", yield* Scope.make());
      const modelSelection = { instanceId: instance.instanceId, model: "gpt-5.5" };
      yield* instance.textGeneration.generateThreadTitle({ cwd, modelSelection, message: "x" });
      expect(sent[0]?.record_wire).toBe("/t3-logs/events.generate.wire.log");
    });
    return withRuntimeLayer(fake, () => title, "/t3-logs/events.log");
  });

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

type Obj = Record<string, unknown>;

/** True when every object in a JSON schema is closed and requires all its properties. */
function strictObjects(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return true;
  const node = schema as Obj;
  const keys = Object.keys((node.properties as Obj | undefined) ?? {});
  if (node.type === "object") {
    const required = (node.required as string[] | undefined) ?? [];
    if (node.additionalProperties !== false || keys.some((k) => !required.includes(k)))
      return false;
  }
  return Object.values(node).every(strictObjects);
}

/** Probe details with no options and no commands. */
function details(): AgentDetails {
  return {
    auth: "Unknown",
    capabilities: { features: [], mcp_transports: [] },
    config_options: [],
    commands: [],
  };
}

/** Runs `body` with every service the driver needs, over `anyagent serve --mock <script>`. */
function withRuntime<A, E>(script: string, body: () => Effect.Effect<A, E, Env>) {
  const mock = script.endsWith(".json")
    ? script
    : NodePath.join(ANYAGENT, `packages/mock-scripts/${script}.json`);
  return withRuntimeLayer(makeAnyagentRuntimeLayer({ bin: BIN, mock }), body);
}

/** Runs `body` with every service the driver needs and `runtime` as the anyagent runtime; `nativeLog` turns T3's log on. */
function withRuntimeLayer<A, E>(
  runtime: Layer.Layer<AnyagentRuntime>,
  body: () => Effect.Effect<A, E, Env>,
  nativeLog?: string,
) {
  const native = nativeLog && {
    filePath: nativeLog,
    write: () => Effect.void,
    close: () => Effect.void,
  };
  const loggers = native ? { native, canonical: undefined } : NoOpProviderEventLoggers;
  const layer = Layer.mergeAll(
    runtime,
    ServerConfig.layerTest(cwd, { prefix: "t3-anyagent-driver-" }),
    ServerSettingsService.layerTest(),
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
    Layer.succeed(ProviderEventLoggers, loggers),
    // Version advisories would ask npm; the enrichment logs this failure and moves on.
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("no network in unit tests")),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return body().pipe(Effect.provide(layer), Effect.scoped);
}

type Env = Effect.Services<ReturnType<typeof claude.create>> | Scope.Scope;

/** One instance of `driver` in `scope`, enabled unless told otherwise, with the kind's default settings unless given. */
function create(
  driver: typeof claude,
  id: string,
  scope: Scope.Closeable,
  enabled = true,
  settings: Partial<Pick<Parameters<typeof driver.create>[0], "config" | "environment">> = {},
): Effect.Effect<ProviderInstance, ProviderDriverError, Env> {
  return driver
    .create({
      instanceId: ProviderInstanceId.make(id),
      displayName: undefined,
      environment: settings.environment ?? [],
      enabled,
      config: settings.config ?? driver.defaultConfig(),
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
