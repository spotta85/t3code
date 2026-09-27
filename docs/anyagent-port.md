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

| Area                                        | Before                                                                                                                                                                                           | Now                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Provider settings                           | `binaryPath`, environment, `launchArgs`, codex home paths, claude `autoCompactWindow`, cursor `apiEndpoint`, antigravity `apiKey`/`authMethod`/GCP fields, opencode `serverUrl`/`serverPassword` | Ignored. anyagent runs the agent it finds on `PATH` with the server's environment. `binaryPath` only feeds the Update button |
| Plan mode                                   | Plan toggle in the composer                                                                                                                                                                      | Hidden; a plan turn fails                                                                                                    |
| Accept-edits mode                           | Edits run without asking                                                                                                                                                                         | Same as Ask: edits prompt too                                                                                                |
| Skills picker                               | Workspace skills listed                                                                                                                                                                          | Empty                                                                                                                        |
| Session instructions                        | T3 added runtime info, PR linking and codex's mode prompt to every session                                                                                                                       | None sent                                                                                                                    |
| Antigravity                                 | T3 ran its managed install                                                                                                                                                                       | The managed install still downloads but is unused: anyagent runs its own `agy`                                               |
| T3 MCP tools (browser, devices, PR linking) | Every agent                                                                                                                                                                                      | claude only; codex, opencode and antigravity run without them                                                                |

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
- **Native provider log.** `ProviderEventLoggers.native` (raw agent frames per thread) is no
  longer written. The canonical log is unchanged.

## Not wired yet (anyagent has it, the adapter does not use it)

- **Usage limits on provider cards.** anyagent-ts has `planUsage`; the snapshot does not read it.

## T3's `t3-code` MCP server

Browser preview, devices and pull-request linking reach the agent through T3's own MCP server.
The adapter declares it at `open` (HTTP, with the thread's bearer header) for agents whose probe
takes HTTP MCP servers; claude connects to it. Codex is skipped for now: anyagent would put the
bearer token in codex's command line, and `codex app-server` ignores the server anyway (gaps row
"Codex ignores declared MCP servers"). OpenCode and Antigravity refuse client-declared MCP servers
in anyagent, so the adapter does not declare it for them either.
