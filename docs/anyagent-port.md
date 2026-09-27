# T3 Code on anyagent

T3 Code's server used to carry one adapter per agent (Claude SDK, Codex app-server, ACP for
Cursor/Grok/Antigravity, the OpenCode SDK). All six now go through one adapter over
[anyagent](https://github.com/spotta85/anyagent): one `anyagent serve` process per T3 server.

```
ProviderService ─► ProviderAdapterShape ─► AnyagentAdapter ─► anyagent-ts ─► anyagent serve
                                           (provider/anyagent/)                 │
                                                         claude · codex · cursor · grok · opencode · agy
```

| Before                                                                                           | Now                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `provider/Drivers/<Agent>Driver.ts`, `Layers/<Agent>Adapter.ts`, `Layers/<Agent>Provider.ts`     | `provider/anyagent/` (driver, adapter, snapshot, text generation, events) |
| `provider/acp/`, `packages/effect-acp`, `packages/effect-codex-app-server`, `opencodeRuntime.ts` | inside anyagent                                                           |
| `textGeneration/<Agent>TextGeneration.ts`                                                        | `anyagent/AnyagentTextGeneration.ts` (one-shot `generate`)                |
| per-driver update rules                                                                          | `anyagent/maintenance.ts`                                                 |

Features anyagent does not have yet are listed in anyagent's `docs/ports/t3-code/gaps.md`.

## Running it

The server needs two things from the anyagent repo: the `anyagent-ts` package (linked, not from
npm) and the `anyagent` binary. Clone anyagent next to this repo:

```
Projects/
├─ t3code/     this repo; apps/server links ../../../anyagent/packages/node/anyagent
└─ anyagent/
```

```bash
git clone https://github.com/spotta85/anyagent ../anyagent
(cd ../anyagent && cargo build --release --features mock)              # the binary (mock: for tests)
(cd ../anyagent/packages/node/anyagent && npm install && npm run build) # dist/ is not checked in
pnpm install
export ANYAGENT_BIN=$PWD/../anyagent/target/release/anyagent            # the binary the server runs
pnpm dev
```

Without `ANYAGENT_BIN` the server looks for anyagent-ts's prebuilt platform package; when neither
is there, every provider card shows an error that says to set `ANYAGENT_BIN`.

Checks: `cd apps/server && npx vp test run src/provider/anyagent/` (runs against the mock
binary), and the live check against real agents:
`node scripts/anyagent-port-check.ts --agents claude,codex [--rows open+stream,resume] [--dry-run]`
(logs go to `$PORT_CHECK_OUT`, default `<tmpdir>/anyagent-port-check`).

## What changes for you

| Area                                               | Before                                                                                                                                                                                           | Now                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Provider settings                                  | `binaryPath`, environment, `launchArgs`, codex home paths, claude `autoCompactWindow`, cursor `apiEndpoint`, antigravity `apiKey`/`authMethod`/GCP fields, opencode `serverUrl`/`serverPassword` | `binaryPath`, environment, claude and codex `launchArgs` and `homePath` reach the agent. The rest are ignored (no anyagent equivalent) |
| Usage limits and banked resets                     | Provider cards and the usage panel                                                                                                                                                               | Same, from anyagent's plan usage (claude, codex); redeeming a reset is not supported                                                   |
| Plan mode                                          | Plan toggle in the composer                                                                                                                                                                      | Same where the agent's `mode` offers `plan` (claude, codex); hidden elsewhere                                                          |
| Accept-edits mode                                  | Edits run without asking                                                                                                                                                                         | Same (anyagent's `AcceptEdits`)                                                                                                        |
| Skills picker                                      | Workspace skills listed                                                                                                                                                                          | Empty                                                                                                                                  |
| Session instructions                               | T3 added runtime info, PR linking and codex's mode prompt to every session                                                                                                                       | Runtime info and PR linking; codex also gets the browser and device tool guide. Codex uses its own plan-mode prompt                    |
| Antigravity                                        | T3 ran its managed install                                                                                                                                                                       | The managed install still downloads but is unused: anyagent runs its own `agy`                                                         |
| T3 MCP tools (browser, devices, PR linking)        | Every agent                                                                                                                                                                                      | claude, codex and opencode; antigravity runs without them                                                                              |
| Per-turn token usage                               | claude, codex, opencode                                                                                                                                                                          | Same, plus antigravity; cursor and grok report none                                                                                    |
| Tool denied (a rule refused a tool without asking) | claude                                                                                                                                                                                           | Same                                                                                                                                   |

Each row has a matching gaps.md row in the anyagent repo.

## Threads that cannot resume

The adapter opens a fresh session and adds one warning to the thread instead of failing every
turn:

| Stored cursor                                                              | Warning                                                                                      |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| From T3's pre-port adapters (an object anyagent cannot decode)             | "Provider session from before the anyagent port could not be resumed; started a new session" |
| A token anyagent reports `ResumeFailed` for (the agent forgot the session) | "Provider session could not be resumed; started a new session"                               |

The new session's cursor, when the agent has one, replaces the old one. The agent does not see
the earlier turns; the transcript stays readable in T3. Any other open failure still fails the
turn with a typed error.

## Dropped by the port

- **T3's own agent processes.** T3 no longer starts OpenCode servers (one per thread), Codex
  shadow homes, or private Antigravity profiles. anyagent runs each agent the way the agent's
  own CLI is set up.
- **Antigravity install check.** The managed install still downloads and checks size and sha256,
  but no longer launches the runtime to check its identity (that used T3's ACP client). anyagent
  runs `agy` from its own discovery, not T3's managed copy.
- **Antigravity sign-in inside T3.** The sign-in and sign-out flow ran over T3's ACP client.
  Sign in with `agy` itself.
- **Native provider log.** `ProviderEventLoggers.native` is no longer written. When it is on,
  anyagent records each thread's raw wire beside it instead: `events.<thread>.wire.log`, one
  `{"dir":"in"|"out","frame":…}` per line, unredacted. The canonical log is unchanged.

## T3's `t3-code` MCP server

Browser preview, devices and pull-request linking reach the agent through T3's own MCP server.
The adapter declares it at `open` (HTTP, with the thread's bearer header) for agents whose probe
takes HTTP MCP servers: claude, codex and opencode connect to it (codex gets the bearer token
through an environment variable, not its command line). Antigravity refuses client-declared MCP
servers in anyagent, so the adapter does not declare it there.
