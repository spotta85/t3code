/**
 * AnyagentSnapshot - what anyagent's `probe` learned about an agent, as the
 * provider snapshot T3's settings page and model picker read.
 *
 * @module AnyagentSnapshot
 */
import type {
  CustomModelSetting,
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionDescriptor,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSlashCommand,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  type AgentDetails,
  AnyagentError,
  type AuthStatus,
  type ConfigOption,
  type ConfigValue,
  type PlanUsage,
} from "anyagent-ts";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";
import { planUsageLimits } from "./AnyagentEvents.ts";

/** What the driver learned about the agent: its details and plan usage (or why that read failed), or why the probe failed. */
export type AgentProbe =
  | { readonly details: AgentDetails; readonly usage?: PlanUsage | Error }
  | { readonly error: string; readonly installHint?: string };

/** The instance settings the snapshot reflects. */
export interface SnapshotSettings {
  readonly displayName: string;
  readonly enabled: boolean;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
}

/**
 * The provider snapshot for one probe (`undefined`: disabled, not probed). Models come from the agent's `model`
 * option; every other option T3 does not own becomes a model option descriptor; plan usage becomes the usage limits.
 */
export function toServerProviderSnapshot(
  kind: ProviderDriverKind,
  probe: AgentProbe | undefined,
  settings: SnapshotSettings,
  checkedAt: string,
): ServerProviderDraft {
  const details = probe && "details" in probe ? probe.details : undefined;
  const options = details?.config_options ?? [];
  const capabilities = createModelCapabilities({
    optionDescriptors: optionDescriptors(kind, options),
  });
  return buildServerProvider({
    driver: kind,
    presentation: {
      displayName: settings.displayName,
      supportsConversationRollback: details?.capabilities.features.includes("Rollback") ?? false,
      showInteractionModeToggle: offersPlan(options),
    },
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(
      agentModels(kind, options),
      settings.customModels,
      capabilities,
    ),
    slashCommands: (details?.commands ?? []).map(slashCommand),
    probe: probeResult(settings, probe, checkedAt),
  });
}

/**
 * T3's old id for anyagent's `effort` per kind, so stored picks keep working (the web drops picks
 * whose id no descriptor has). Other kinds, claude included, keep `effort`.
 */
const EFFORT_ID: Readonly<Record<string, string>> = {
  codex: "reasoningEffort",
  grok: "reasoningEffort",
  cursor: "reasoning",
  opencode: "variant",
};

/** T3's id for each renamed anyagent option id of `kind`; unlisted ids pass through. */
function renamed(kind: ProviderDriverKind): Readonly<Record<string, string>> {
  return { fast: "fastMode", effort: EFFORT_ID[kind] ?? "effort" };
}

/** The anyagent option id behind a T3 model option id of `kind`. */
export function anyagentOptionId(kind: ProviderDriverKind, t3Id: string): string {
  return Object.entries(renamed(kind)).find(([, t3]) => t3 === t3Id)?.[0] ?? t3Id;
}

/** The anyagent options a T3 model selection sets (its model, then each picked option), kept to `advertised` ids. */
export function selectedOptions(
  kind: ProviderDriverKind,
  selection: ModelSelection | undefined,
  advertised: ReadonlySet<string>,
): Record<string, ConfigValue> {
  if (!selection) return {};
  const picked: Array<[string, ConfigValue]> = [
    ["model", selection.model],
    ...(selection.options ?? []).map((o): [string, ConfigValue] => [
      anyagentOptionId(kind, o.id),
      o.value,
    ]),
  ];
  return Object.fromEntries(picked.filter(([id]) => advertised.has(id)));
}

/** Option ids `open` and `generate` may set: the probed ones, or just the model when the probe failed. */
export function openableOptions(details: AgentDetails | null): ReadonlySet<string> {
  return new Set(details ? details.config_options.map((o) => o.id) : ["model"]);
}

/** Whether the agent's live `mode` option offers `plan`: T3's plan turns switch to it. */
export function offersPlan(options: ReadonlyArray<ConfigOption>): boolean {
  const mode = options.find((o) => o.id === "mode");
  if (!mode?.live || mode.kind === "Boolean") return false;
  return mode.kind.Select.choices.some((c) => c.value === "plan");
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Options T3 controls itself: the model picker, runtime mode (permissions), and plan mode. */
const T3_OWNED = new Set(["model", "mode", "sandbox"]);

/** Installed / version / status / auth / message / usage limits for the snapshot. */
function probeResult(
  settings: SnapshotSettings,
  probe: AgentProbe | undefined,
  checkedAt: string,
): ProviderProbeResult {
  const name = settings.displayName;
  if (!settings.enabled || !probe) {
    return {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: `${name} is disabled in T3 Code settings.`,
    };
  }
  if ("error" in probe) {
    return {
      installed: probe.installHint === undefined,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: probe.installHint ?? `${name} probe failed: ${probe.error}`,
    };
  }
  const auth = probe.details.auth;
  const login = loginHint(auth);
  return {
    installed: true,
    version: probe.details.version ?? null,
    status: login === undefined ? "ready" : "error",
    auth: toAuth(auth),
    ...(login !== undefined ? { message: `${name} is not logged in. ${login}` } : {}),
    ...(probe.usage ? { usageLimits: usageLimits(probe.usage, checkedAt) } : {}),
  };
}

/** Plan usage as T3's usage limits; a refusal (`UnsupportedFeature`) is `unsupported`, any other failure `probeFailed`. */
function usageLimits(usage: PlanUsage | Error, checkedAt: string): ServerProviderUsageLimits {
  if (!(usage instanceof Error)) return planUsageLimits(usage);
  const unsupported = usage instanceof AnyagentError && usage.kind === "UnsupportedFeature";
  const reason = unsupported ? "unsupported" : "probeFailed";
  return makeUnavailableUsageLimits({ checkedAt, reason, message: usage.message.trim() });
}

/** anyagent's login state as T3's: kind as a snake_case type, the plan as label. */
function toAuth(auth: AuthStatus): ServerProviderAuth {
  if (auth === "Unknown") return { status: "unknown" };
  if ("Unauthenticated" in auth) return { status: "unauthenticated" };
  const { kind, account } = auth.Authenticated;
  const type =
    typeof kind === "string" ? kind.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase() : kind.Other;
  return {
    status: "authenticated",
    ...(nonEmpty(type) ? { type: type.trim() } : {}),
    ...(nonEmpty(account?.plan) ? { label: account.plan.trim() } : {}),
    ...(nonEmpty(account?.email) ? { email: account.email.trim() } : {}),
  };
}

/** How to log in when the agent is logged out: its first terminal command or env var. */
function loginHint(auth: AuthStatus): string | undefined {
  if (auth === "Unknown" || !("Unauthenticated" in auth)) return undefined;
  const method = auth.Unauthenticated.login[0];
  if (!method) return "Log in with the agent's CLI.";
  return "Terminal" in method
    ? `Run \`${method.Terminal.command.join(" ")}\`.`
    : `Set ${method.EnvVar.name}.`;
}

/** The choices of the agent's `model` option as T3 models, the current one marked default, each with its own options. */
function agentModels(
  kind: ProviderDriverKind,
  options: ReadonlyArray<ConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const model = options.find((o) => o.id === "model");
  if (!model || model.kind === "Boolean") return [];
  const choices = model.kind.Select.choices;
  // An option some model carries itself (effort, fast) is per model; the session's others apply to every model.
  const perModel = new Set(choices.flatMap((c) => (c.options ?? []).map((o) => o.id)));
  const shared = options.filter((o) => !perModel.has(o.id));
  return choices.map((choice) => ({
    slug: choice.value,
    name: choice.label.trim() || choice.value,
    isCustom: false,
    ...(choice.value === model.current ? { isDefault: true } : {}),
    capabilities: createModelCapabilities({
      optionDescriptors: optionDescriptors(kind, [...(choice.options ?? []), ...shared]),
    }),
  }));
}

/** anyagent's options T3 does not own, as model option descriptors (select or boolean). */
function optionDescriptors(
  kind: ProviderDriverKind,
  options: ReadonlyArray<ConfigOption>,
): ProviderOptionDescriptor[] {
  const rename = renamed(kind);
  return options
    .filter((o) => !T3_OWNED.has(o.id))
    .map((o) => {
      const id = rename[o.id] ?? o.id;
      const label = o.name.trim() || o.id;
      if (o.kind === "Boolean") {
        return buildBooleanOptionDescriptor({
          id,
          label,
          ...(typeof o.current === "boolean" ? { currentValue: o.current } : {}),
        });
      }
      return buildSelectOptionDescriptor({
        id,
        label,
        options: o.kind.Select.choices.map((c) => ({
          value: c.value,
          label: c.label.trim() || c.value,
          ...(nonEmpty(c.description) ? { description: c.description.trim() } : {}),
          ...(c.value === o.current ? { isDefault: true } : {}),
        })),
      });
    });
}

/** One agent slash command in T3's shape; empty descriptions and hints are left out. */
function slashCommand(command: AgentDetails["commands"][number]): ServerProviderSlashCommand {
  return {
    name: command.name,
    ...(nonEmpty(command.description) ? { description: command.description.trim() } : {}),
    ...(nonEmpty(command.input_hint) ? { input: { hint: command.input_hint.trim() } } : {}),
  };
}

/** True for a string with non-whitespace content. */
function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}
