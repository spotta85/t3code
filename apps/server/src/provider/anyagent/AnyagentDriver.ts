/**
 * AnyagentDriver - one T3 `ProviderDriver` for every agent anyagent drives. The
 * kind keeps its display name, settings schema and updater; sessions, snapshot
 * and text generation all go through the shared `anyagent serve`.
 *
 * @module AnyagentDriver
 */
import type { CustomModelSetting, ProviderDriverKind } from "@t3tools/contracts";
import { AnyagentError, type Runtime } from "anyagent-ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import type * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import type { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { withInstanceIdentity } from "../Drivers/instanceIdentity.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
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
import { AnyagentRuntime } from "./AnyagentRuntime.ts";
import { type AgentProbe, openableOptions, toServerProviderSnapshot } from "./AnyagentSnapshot.ts";
import { makeAnyagentTextGeneration } from "./AnyagentTextGeneration.ts";

/** The settings fields every built-in kind shares; the rest of each kind's settings is ignored. */
export interface AnyagentSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
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
  | ServerConfig
  | ServerSettingsService;

/**
 * The driver for T3 kind `kind` over anyagent agent `agent`. `create` probes the
 * agent once (enabled instances only) and hands that probe to the snapshot and
 * the adapter; later snapshot refreshes probe again.
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
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const { runtime } = yield* AnyagentRuntime;
      const serverSettings = yield* ServerSettingsService;
      const httpClient = yield* HttpClient.HttpClient;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const probe: Effect.Effect<AgentProbe | undefined> = enabled
        ? Effect.promise(() => probeAgent(runtime, agent))
        : Effect.succeed(undefined);
      // Shared with the adapter; the boot refresh takes it instead of spawning the agent again.
      let pending = yield* probe;
      const details = pending && "details" in pending ? pending.details : null;

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
        adapter: yield* makeAnyagentAdapter(kind, agent, details),
        textGeneration: yield* makeAnyagentTextGeneration(agent, openableOptions(details)),
      } satisfies ProviderInstance;
    }),
});

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Probes the agent. A failure is a result: a missing agent carries anyagent's
 * install hint (from `discover`), anything else its error.
 */
async function probeAgent(runtime: Runtime, agent: string): Promise<AgentProbe> {
  try {
    return { details: await runtime.probe(agent) };
  } catch (cause) {
    const error =
      cause instanceof AnyagentError ? `${cause.kind}: ${cause.message}` : String(cause);
    if (!(cause instanceof AnyagentError && cause.kind === "NotInstalled")) return { error };
    const report = await runtime.discover().catch(() => undefined);
    const missing = report?.missing.find((m) => m.id === agent);
    return { error, installHint: missing?.install_hint ?? `${agent} is not installed.` };
  }
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
