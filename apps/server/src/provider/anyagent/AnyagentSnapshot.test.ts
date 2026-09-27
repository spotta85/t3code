import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { AgentDetails } from "anyagent-ts";

import { anyagentOptionId, selectedOptions, toServerProviderSnapshot } from "./AnyagentSnapshot.ts";

const KIND = ProviderDriverKind.make("claudeAgent");
const AT = "2026-09-26T00:00:00.000Z";
const settings = { displayName: "Claude", enabled: true, customModels: [] };
const decode = Schema.decodeUnknownSync(ServerProvider);

// Trimmed from a real `probe("claude")`.
const claude: AgentDetails = {
  version: "2.1.281",
  auth: {
    Authenticated: { kind: "Subscription", account: { email: "me@x.dev", plan: "Claude Max" } },
  },
  capabilities: { features: ["Images", "Resume", "Rollback", "Compact"], mcp_transports: [] },
  config_options: [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      kind: { Select: { choices: [{ value: "default", label: "default" }] } },
      current: "default",
      live: true,
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      kind: {
        Select: {
          choices: [
            { value: "default", label: "Default (recommended)", description: "Opus 5.5" },
            { value: "haiku", label: "Haiku", description: null },
          ],
        },
      },
      current: "default",
      live: true,
    },
    { id: "fast", name: "Fast mode", kind: "Boolean", current: false, live: true },
    {
      id: "effort",
      name: "Reasoning effort",
      kind: {
        Select: {
          choices: [
            { value: "low", label: "low" },
            { value: "high", label: "high" },
          ],
        },
      },
      current: null,
      live: true,
    },
    {
      id: "sandbox",
      name: "Sandbox",
      kind: { Select: { choices: [{ value: "read-only", label: "read-only" }] } },
      current: "read-only",
      live: true,
    },
  ],
  commands: [
    { name: "review", description: "Review a diff", input_hint: "[base]" },
    { name: "init", description: "", input_hint: null },
  ],
};

const loggedOut: AgentDetails = {
  ...claude,
  auth: {
    Unauthenticated: {
      login: [{ Terminal: { command: ["claude", "/login"], env: {}, description: "Log in" } }],
    },
  },
};

describe("toServerProviderSnapshot", () => {
  it("maps a logged-in probe: version, auth, models, options, rollback, commands", () => {
    const snapshot = toServerProviderSnapshot(KIND, { details: claude }, settings, AT);
    expect(snapshot).toMatchObject({
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: "2.1.281",
      status: "ready",
      checkedAt: AT,
      auth: {
        status: "authenticated",
        type: "subscription",
        label: "Claude Max",
        email: "me@x.dev",
      },
      supportsConversationRollback: true,
      showInteractionModeToggle: false,
      skills: [],
      slashCommands: [
        { name: "review", description: "Review a diff", input: { hint: "[base]" } },
        { name: "init" },
      ],
    });
    expect(snapshot.message).toBeUndefined();
    const descriptors = [
      { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: false },
      {
        id: "effort",
        label: "Reasoning effort",
        type: "select",
        options: [
          { id: "low", label: "low" },
          { id: "high", label: "high" },
        ],
      },
    ];
    expect(snapshot.models).toEqual([
      {
        slug: "default",
        name: "Default (recommended)",
        isCustom: false,
        isDefault: true,
        capabilities: { optionDescriptors: descriptors },
      },
      {
        slug: "haiku",
        name: "Haiku",
        isCustom: false,
        capabilities: { optionDescriptors: descriptors },
      },
    ]);
    expect(() => decode(stamp(snapshot))).not.toThrow();
  });

  it("a logged-out agent is an error with its login command", () => {
    const snapshot = toServerProviderSnapshot(KIND, { details: loggedOut }, settings, AT);
    expect(snapshot).toMatchObject({
      installed: true,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not logged in. Run `claude /login`.",
    });
    expect(() => decode(stamp(snapshot))).not.toThrow();
  });

  it("unknown auth stays ready with auth unknown; no rollback without the feature", () => {
    const details: AgentDetails = {
      ...claude,
      auth: "Unknown",
      capabilities: { features: [], mcp_transports: [] },
    };
    const snapshot = toServerProviderSnapshot(KIND, { details }, settings, AT);
    expect(snapshot).toMatchObject({
      status: "ready",
      auth: { status: "unknown" },
      supportsConversationRollback: false,
    });
  });

  it("the plan toggle shows only when the live `mode` option offers `plan`", () => {
    const withModes = (values: string[], live = true): AgentDetails => ({
      ...claude,
      config_options: [
        {
          id: "mode",
          name: "Mode",
          kind: { Select: { choices: values.map((value) => ({ value, label: value })) } },
          current: "default",
          live,
        },
      ],
    });
    const toggle = (details: AgentDetails) =>
      toServerProviderSnapshot(KIND, { details }, settings, AT).showInteractionModeToggle;
    expect(toggle(withModes(["default", "plan"]))).toBe(true);
    expect(toggle(withModes(["default", "acceptEdits"]))).toBe(false);
    expect(toggle(withModes(["default", "plan"], false))).toBe(false);
    expect(toggle({ ...claude, config_options: [] })).toBe(false);
  });

  it("a missing agent is not installed, with anyagent's install hint", () => {
    const hint = "install Antigravity from https://antigravity.google, then run `agy install`";
    const probe = { error: "NotInstalled: agent not installed: antigravity", installHint: hint };
    const snapshot = toServerProviderSnapshot(KIND, probe, settings, AT);
    expect(snapshot).toMatchObject({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: hint,
      models: [],
    });
    expect(() => decode(stamp(snapshot))).not.toThrow();
  });

  it("any other probe failure is installed but in error, with the failure as message", () => {
    const probe = { error: "HandshakeTimeout: agent did not answer" };
    expect(toServerProviderSnapshot(KIND, probe, settings, AT)).toMatchObject({
      installed: true,
      status: "error",
      message: "Claude probe failed: HandshakeTimeout: agent did not answer",
    });
  });

  it("disabled: no probe needed, status disabled", () => {
    const snapshot = toServerProviderSnapshot(KIND, undefined, { ...settings, enabled: false }, AT);
    expect(snapshot).toMatchObject({
      enabled: false,
      installed: false,
      status: "disabled",
      message: "Claude is disabled in T3 Code settings.",
    });
    expect(() => decode(stamp(snapshot))).not.toThrow();
  });

  it("custom models follow the agent's, with the agent's options", () => {
    const customModels = [{ slug: "opus[1m]", name: "Opus 1M" }];
    const snapshot = toServerProviderSnapshot(
      KIND,
      { details: claude },
      { ...settings, customModels },
      AT,
    );
    expect(snapshot.models.map((m) => [m.slug, m.isCustom])).toEqual([
      ["default", false],
      ["haiku", false],
      ["opus[1m]", true],
    ]);
    expect(snapshot.models[2]?.capabilities?.optionDescriptors?.map((d) => d.id)).toEqual([
      "fastMode",
      "effort",
    ]);
  });

  it("effort keeps the id T3's own descriptors used for each kind", () => {
    const effortId = (kind: string) =>
      toServerProviderSnapshot(
        ProviderDriverKind.make(kind),
        { details: claude },
        settings,
        AT,
      ).models[0]?.capabilities?.optionDescriptors?.map((d) => d.id);
    expect(effortId("claudeAgent")).toEqual(["fastMode", "effort"]);
    expect(effortId("codex")).toEqual(["fastMode", "reasoningEffort"]);
    expect(effortId("grok")).toEqual(["fastMode", "reasoningEffort"]);
    expect(effortId("cursor")).toEqual(["fastMode", "reasoning"]);
    expect(effortId("opencode")).toEqual(["fastMode", "variant"]);
    expect(effortId("antigravity")).toEqual(["fastMode", "effort"]);
  });

  it("T3 option ids map back to anyagent's per kind", () => {
    const codex = ProviderDriverKind.make("codex");
    expect(anyagentOptionId(KIND, "fastMode")).toBe("fast");
    expect(anyagentOptionId(KIND, "effort")).toBe("effort");
    expect(anyagentOptionId(codex, "reasoningEffort")).toBe("effort");
    expect(anyagentOptionId(ProviderDriverKind.make("cursor"), "reasoning")).toBe("effort");
    expect(anyagentOptionId(codex, "serviceTier")).toBe("serviceTier");
  });

  it("a stored claude `effort: max` pick matches claude's descriptor and reaches anyagent as effort", () => {
    const snapshot = toServerProviderSnapshot(KIND, { details: claude }, settings, AT);
    const ids = snapshot.models[0]?.capabilities?.optionDescriptors?.map((d) => d.id) ?? [];
    const selection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "default",
      options: [{ id: "effort", value: "max" }],
    };
    // The web keeps only picks whose id a descriptor has.
    expect(selection.options.every((o) => ids.includes(o.id))).toBe(true);
    expect(selectedOptions(KIND, selection, new Set(["model", "effort"]))).toEqual({
      model: "default",
      effort: "max",
    });
  });

  it("T3's default text-generation effort (reasoningEffort: low) is selected as effort", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: false },
        { id: "contextWindow", value: "1m" },
      ],
    };
    const codex = ProviderDriverKind.make("codex");
    expect(selectedOptions(codex, selection, new Set(["model", "effort", "fast"]))).toEqual({
      model: "gpt-5.6-sol",
      effort: "low",
      fast: false,
    });
  });
});

/** The snapshot with the identity fields the driver stamps, so it decodes as T3's ServerProvider. */
function stamp(snapshot: object) {
  return { ...snapshot, instanceId: ProviderInstanceId.make("claudeAgent"), driver: KIND };
}
