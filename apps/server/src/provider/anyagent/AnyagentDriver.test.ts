// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
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

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderDriverError } from "../Errors.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeAnyagentDriver } from "./AnyagentDriver.ts";
import { makeAnyagentRuntimeLayer } from "./AnyagentRuntime.ts";

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

  // Review focus 5: two kinds share one `anyagent serve`; closing one leaves the other streaming.
  it.live("two kinds on one runtime: closing one instance leaves the other streaming", () =>
    withRuntime("configure", () =>
      Effect.gen(function* () {
        const claudeScope = yield* Scope.make();
        const first = yield* create(claude, "claudeAgent", claudeScope);
        const second = yield* create(codex, "codex", yield* Scope.make());
        const firstSeen = yield* collect(first);
        const secondSeen = yield* collect(second);
        yield* first.adapter.startSession({ threadId: A, cwd, runtimeMode: "full-access" });
        yield* second.adapter.startSession({ threadId: B, cwd, runtimeMode: "full-access" });
        yield* first.adapter.sendTurn({ threadId: A, input: "hi" });
        yield* waitFor(firstSeen, (e) => e.type === "turn.completed");

        yield* Scope.close(claudeScope, Exit.void);
        expect(yield* second.adapter.hasSession(B)).toBe(true);
        const { turnId } = yield* second.adapter.sendTurn({ threadId: B, input: "hi" });
        yield* waitFor(secondSeen, (e) => e.type === "turn.completed" && e.turnId === turnId);
        expect(secondSeen.every((e) => e.threadId === B && e.provider === "codex")).toBe(true);
        expect(firstSeen.every((e) => e.threadId === A && e.provider === "claudeAgent")).toBe(true);
      }),
    ),
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
});

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------

/** Runs `body` with every service the driver needs, over `anyagent serve --mock <script>`. */
function withRuntime<A, E>(script: string, body: () => Effect.Effect<A, E, Env>) {
  const mock = script.endsWith(".json")
    ? script
    : NodePath.join(ANYAGENT, `packages/mock-scripts/${script}.json`);
  const layer = Layer.mergeAll(
    makeAnyagentRuntimeLayer({ bin: BIN, mock }),
    ServerConfig.layerTest(cwd, { prefix: "t3-anyagent-driver-" }),
    ServerSettingsService.layerTest(),
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
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
  const file = NodePath.join(NodeFS.mkdtempSync(NodePath.join(cwd, "t3-title-")), "title.json");
  const text = JSON.stringify({ title: "Fix login crash" });
  const turn = [
    { Emit: { TextDelta: { message_id: "m1", text } } },
    { End: { Completed: { source: "Protocol" } } },
  ];
  NodeFS.writeFileSync(file, JSON.stringify({ turns: [turn] }));
  return file;
}
