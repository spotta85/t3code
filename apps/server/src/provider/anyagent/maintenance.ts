/**
 * How each built-in agent CLI updates itself (T3's "Update" button), moved here
 * from the per-agent drivers the port deleted. Antigravity has none.
 *
 * @module provider/anyagent/maintenance
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";

/** Claude: npm package, or `claude update` for the native installer. */
export const CLAUDE_UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: ProviderDriverKind.make("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

/**
 * Codex: npm package, or `codex update` for the standalone installer. That tree lives in the
 * shared home even with a shadow home, so the updater runs against `sharedHomePath`.
 */
export function makeCodexMaintenanceResolver(sharedHomePath: string) {
  return makePackageManagedProviderMaintenanceResolver({
    provider: ProviderDriverKind.make("codex"),
    npmPackageName: "@openai/codex",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isCodexStandaloneCommandPath,
      env: { CODEX_HOME: sharedHomePath },
    },
  });
}

/** Cursor: `cursor-agent update`; no executable means nothing to update. */
export const CURSOR_UPDATE = selfUpdating(ProviderDriverKind.make("cursor"), {
  packageName: null,
  lockKey: "cursor-agent",
  passEnv: false,
});

/**
 * Grok: `grok update` (npm `latest` tracks its stable channel). It installs
 * under `GROK_HOME`, so it runs with the instance's environment.
 */
export const GROK_UPDATE = selfUpdating(ProviderDriverKind.make("grok"), {
  packageName: "@xai-official/grok",
  lockKey: "grok",
  passEnv: true,
});

/** OpenCode: npm package, or `opencode upgrade` for the native installer. */
export const OPENCODE_UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: ProviderDriverKind.make("opencode"),
  npmPackageName: "opencode-ai",
  nativeUpdate: {
    args: ["upgrade"],
    isCommandPath: isOpenCodeNativeCommandPath,
  },
});

/** A CLI that is its own updater (`<exe> update`); manual-only when no executable resolves. */
function selfUpdating(
  provider: ProviderDriverKind,
  spec: { packageName: string | null; lockKey: string; passEnv: boolean },
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (context) =>
      Effect.succeed(
        context
          ? makeProviderMaintenanceCapabilities({
              provider,
              packageName: spec.packageName,
              updateExecutable: context.resolvedCommandPath,
              updateArgs: ["update"],
              updateLockKey: spec.lockKey,
              platform: context.platform,
              ...(spec.passEnv ? { env: context.env } : {}),
            })
          : makeManualOnlyProviderMaintenanceCapabilities({
              provider,
              packageName: spec.packageName,
            }),
      ),
  };
}

/** Claude's native installer paths. */
function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

/** The standalone installer lays out `<CODEX_HOME>/packages/standalone/…`. */
function isCodexStandaloneCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/packages/standalone/");
}

/** OpenCode's native installer paths. */
function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}
