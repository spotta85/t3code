/**
 * AnyagentDriver - one T3 `ProviderDriver` for every agent anyagent drives. The
 * kind keeps its display name, settings schema and updater; sessions, snapshot
 * and text generation all go through the shared `anyagent serve`.
 *
 * @module AnyagentDriver
 */
import type {
  CustomModelSetting,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { type AgentDetails, AnyagentError } from "anyagent-ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import type * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import type { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { withInstanceIdentity } from "../Drivers/instanceIdentity.ts";
import { ProviderDriverError } from "../Errors.ts";
import type { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "../providerUpdateSettings.ts";
import { makeAnyagentAdapter } from "./AnyagentAdapter.ts";
import { AnyagentRuntime, type Launch } from "./AnyagentRuntime.ts";
import { type AgentProbe, openableOptions, toServerProviderSnapshot } from "./AnyagentSnapshot.ts";
import { makeAnyagentTextGeneration } from "./AnyagentTextGeneration.ts";

/** The settings fields the driver reads (`homePath`, `launchArgs`: some kinds only); the rest are ignored. */
export interface AnyagentSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
  readonly homePath?: string;
  readonly launchArgs?: string;
}

/** What stays per kind: the name, the settings form, and how the agent CLI updates. */
export interface AnyagentDriverSpec {
  readonly displayName: string;
  readonly settings: Schema.Codec<AnyagentSettings, unknown>;
  /** Omitted: update manually (no package T3 knows how to update). */
  readonly update?: ProviderMaintenanceCapabilitiesResolver;
}

export type AnyagentDriverEnv =
  | AnyagentRuntime
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * The driver for T3 kind `kind` over anyagent `agent`: `create` probes once for the snapshot and adapter;
 * each snapshot refresh probes again, and the adapter reads the newest good probe.
 */
export const makeAnyagentDriver = (
  kind: ProviderDriverKind,
  agent: string,
  spec: AnyagentDriverSpec,
): ProviderDriver<AnyagentSettings, AnyagentDriverEnv> => ({
  driverKind: kind,
  metadata: { displayName: spec.displayName, supportsMultipleInstances: true },
  configSchema: spec.settings,
  defaultConfig: () => decodeDefaults(spec.settings),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const { use } = yield* AnyagentRuntime;
      const serverSettings = yield* ServerSettingsService;
      const httpClient = yield* HttpClient.HttpClient;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const launch = launchOf(agent, config, decodeDefaults(spec.settings).binaryPath, environment);
      // The newest successful probe: the adapter's capabilities and the options `open` may set.
      let latest: AgentDetails | null = null;
      const probe: Effect.Effect<AgentProbe | undefined> = enabled
        ? Effect.promise(() => probeAgent(use, agent, launch)).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if ("details" in result) latest = result.details;
              }),
            ),
          )
        : Effect.succeed(undefined);
      // The boot refresh takes this probe instead of spawning the agent again.
      let pending = yield* probe;

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: kind,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: kind,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const snapshotSettings = {
        displayName: spec.displayName,
        enabled,
        customModels: config.customModels,
      };
      const snapshotOf = (result: AgentProbe | undefined) =>
        Effect.map(DateTime.now, (now) =>
          stamp(toServerProviderSnapshot(kind, result, snapshotSettings, DateTime.formatIso(now))),
        );
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(spec.update ?? manualUpdate(kind), {
          binaryPath: config.binaryPath,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const settingsSource = makeProviderSnapshotSettingsSource(
        { ...config, enabled },
        serverSettings,
      );

      const snapshot = yield* makeManagedServerProvider({
        resolveMaintenance,
        getSettings: settingsSource.getSettings,
        streamSettings: settingsSource.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => snapshotOf(pending),
        checkProvider: Effect.suspend(() => {
          const first = pending;
          pending = undefined;
          return first ? Effect.succeed(first) : probe;
        }).pipe(Effect.flatMap(snapshotOf)),
        enrichSnapshot: ({ settings, snapshot: current, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenance) =>
              enrichProviderSnapshotWithVersionAdvisory(current, maintenance, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: kind,
              instanceId,
              detail: `Failed to build the ${spec.displayName} snapshot: ${cause.message}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: kind,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: yield* makeAnyagentAdapter(kind, launch, () => latest),
        textGeneration: yield* makeAnyagentTextGeneration(kind, launch, () =>
          openableOptions(latest),
        ),
      } satisfies ProviderInstance;
    }),
});

/**
 * What an instance's settings give every call: the agent at `binaryPath` when that is not the kind's
 * default command, the instance's environment, `launchArgs` split like a shell, and `homePath`.
 */
export function launchOf(
  agent: string,
  config: AnyagentSettings,
  defaultBinary: string,
  environment: ProviderInstanceEnvironment,
): Launch {
  const binary = config.binaryPath.trim();
  // Only the instance's own variables: the agent inherits the server's environment already.
  const env = mergeProviderInstanceEnvironment(environment, {}) as Record<string, string>;
  const args = tokenizeCliArgs(config.launchArgs);
  const home = expandHomePath(config.homePath?.trim() ?? "");
  return {
    agent: binary && binary !== defaultBinary ? { id: agent, path: expandHomePath(binary) } : agent,
    options: {
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(args.length > 0 ? { args: [...args] } : {}),
      ...(home ? { config_home: home } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Appended when the anyagent binary itself is missing. */
const ANYAGENT_BIN_HINT =
  " (anyagent binary not found: set ANYAGENT_BIN to it, see docs/anyagent-port.md)";

/** Probes the agent, then reads its plan usage. A failure is a result; a missing agent carries an install hint. */
async function probeAgent(
  use: AnyagentRuntime["Service"]["use"],
  agent: string,
  { agent: ref, options }: Launch,
): Promise<AgentProbe> {
  try {
    const details = await use((runtime) => runtime.probe(ref, options));
    const usage = await use((runtime) => runtime.planUsage(ref, options)).catch(asError);
    return { details, usage };
  } catch (cause) {
    // A plain Error here is `anyagent serve` failing to start (missing binary, spawn error).
    const error =
      cause instanceof AnyagentError
        ? `${cause.kind}: ${cause.message}`
        : cause instanceof Error
          ? cause.message +
            ((cause as NodeJS.ErrnoException).code === "ENOENT" ? ANYAGENT_BIN_HINT : "")
          : String(cause);
    // The agent at the instance's `binaryPath` would not start: that path has no agent.
    if (cause instanceof AnyagentError && cause.kind === "SpawnFailed")
      return { error, installHint: `${agent} is not installed: ${cause.message}` };
    if (!(cause instanceof AnyagentError && cause.kind === "NotInstalled")) return { error };
    const report = await use((runtime) => runtime.discover()).catch(() => undefined);
    const missing = report?.missing.find((m) => m.id === agent);
    return { error, installHint: missing?.install_hint ?? `${agent} is not installed.` };
  }
}

/** A rejection as an Error, so a failed plan-usage read is a value the snapshot shows. */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** The kind's settings with every default applied. */
function decodeDefaults(settings: AnyagentDriverSpec["settings"]): AnyagentSettings {
  return Schema.decodeSync(settings)({});
}

/** Update resolver for a kind with no package T3 can update: manual only. */
function manualUpdate(kind: ProviderDriverKind): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({ provider: kind, packageName: null }),
      ),
  };
}
