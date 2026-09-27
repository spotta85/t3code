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

## Threads created before the port

They cannot resume their provider session. The old adapters stored an object-shaped resume
cursor, which anyagent cannot decode. On the next turn the adapter opens a fresh session instead
and adds one warning to the thread: "Provider session from before the anyagent port could not be
resumed; started a new session". The new session's cursor, when the agent has one, replaces the
old one. The agent does not see the earlier turns; the transcript stays readable in T3. A cursor
anyagent recognizes but no longer knows (`ResumeFailed`) still fails the turn with a typed
error.

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
takes HTTP MCP servers: claude, codex, and ACP agents that advertise HTTP. Claude connects to it.
Codex does not yet: anyagent passes the declaration where `codex app-server` ignores it (gaps row
"Codex ignores declared MCP servers"). OpenCode and Antigravity refuse client-declared MCP servers
in anyagent, so the adapter does not declare it for them.
