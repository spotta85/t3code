/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * Every built-in kind is an `AnyagentDriver`: sessions, snapshots and text
 * generation go through the one shared `anyagent serve`. Each kind keeps its
 * display name, settings schema and updater, so the UI is unchanged.
 * The `ProviderInstanceRegistry` iterates this array when resolving
 * `providerInstances` entries; anything not in the array surfaces as an
 * `"unavailable"` shadow snapshot at runtime (see
 * `buildUnavailableProviderSnapshot`).
 *
 * @module provider/builtInDrivers
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";

import { makeAnyagentDriver, type AnyagentDriverEnv } from "./anyagent/AnyagentDriver.ts";
import {
  CLAUDE_UPDATE,
  CURSOR_UPDATE,
  GROK_UPDATE,
  makeCodexMaintenanceResolver,
  OPENCODE_UPDATE,
} from "./anyagent/maintenance.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

/**
 * Infrastructure services required to construct any built-in driver. The
 * registry layer declares `R = BuiltInDriversEnv`; the runtime layer must
 * provide every service in it (`AnyagentRuntimeLive` among them).
 */
export type BuiltInDriversEnv = AnyagentDriverEnv;

/**
 * Ordered list of built-in drivers: T3 kind, anyagent agent, and what stays
 * per kind. Order matters only for tie-breaking in UI presentation.
 */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  makeAnyagentDriver(ProviderDriverKind.make("codex"), "codex", {
    displayName: "Codex",
    settings: CodexSettings,
    // anyagent runs codex with its default home, so updates target that one.
    update: makeCodexMaintenanceResolver(NodePath.join(NodeOS.homedir(), ".codex")),
  }),
  makeAnyagentDriver(ProviderDriverKind.make("claudeAgent"), "claude", {
    displayName: "Claude",
    settings: ClaudeSettings,
    update: CLAUDE_UPDATE,
  }),
  makeAnyagentDriver(ProviderDriverKind.make("cursor"), "cursor", {
    displayName: "Cursor",
    settings: CursorSettings,
    update: CURSOR_UPDATE,
  }),
  makeAnyagentDriver(ProviderDriverKind.make("grok"), "grok", {
    displayName: "Grok",
    settings: GrokSettings,
    update: GROK_UPDATE,
  }),
  makeAnyagentDriver(ProviderDriverKind.make("opencode"), "opencode", {
    displayName: "OpenCode",
    settings: OpenCodeSettings,
    update: OPENCODE_UPDATE,
  }),
  makeAnyagentDriver(ProviderDriverKind.make("antigravity"), "antigravity", {
    displayName: "Antigravity",
    settings: AntigravitySettings,
  }),
];
