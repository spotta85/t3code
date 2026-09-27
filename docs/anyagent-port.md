# T3 Code on anyagent

T3 Code's server used to carry one adapter per agent (Claude SDK, Codex app-server, ACP for
Cursor/Grok/Antigravity, the OpenCode SDK). All six now go through one adapter over
[anyagent](https://github.com/spotta85/anyagent): one `anyagent serve` process per T3 server.

```
ProviderService ─► ProviderAdapterShape ─► AnyagentAdapter ─► anyagent-ts ─► anyagent serve
                                           (provider/anyagent/)                 │
                                                         claude · codex · cursor · grok · opencode · agy
```

| Before                                                                                           | Now                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `provider/Drivers/<Agent>Driver.ts`, `Layers/<Agent>Adapter.ts`, `Layers/<Agent>Provider.ts`     | `provider/anyagent/` (driver, adapter, snapshot, text generation, events)                                   |
| `provider/acp/`, `packages/effect-acp`, `packages/effect-codex-app-server`, `opencodeRuntime.ts` | inside anyagent                                                                                             |
| `textGeneration/<Agent>TextGeneration.ts`                                                        | `anyagent/AnyagentTextGeneration.ts` (one-shot `generate`, with an output schema where the agent takes one) |
| per-driver update rules                                                                          | `anyagent/maintenance.ts`                                                                                   |

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
`node scripts/anyagent-port-check.ts --agents claude,codex,cursor,grok,opencode,antigravity [--rows open+stream,resume] [--dry-run]`
(logs go to `$PORT_CHECK_OUT`, default `<tmpdir>/anyagent-port-check`). The script turns a disabled
provider on for its run. The last run is under "Live check" below.

## What changes for you

| Area                                               | Before                                                                                                                                                                                           | Now                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider settings                                  | `binaryPath`, environment, `launchArgs`, codex home paths, claude `autoCompactWindow`, cursor `apiEndpoint`, antigravity `apiKey`/`authMethod`/GCP fields, opencode `serverUrl`/`serverPassword` | `binaryPath`, environment, claude and codex `launchArgs` and `homePath` reach the agent. The rest are ignored (no anyagent equivalent)                                                                                                                                                                                    |
| Usage limits and banked resets                     | Provider cards and the usage panel                                                                                                                                                               | Same, from anyagent's plan usage (claude, codex); redeeming a reset is not supported                                                                                                                                                                                                                                      |
| Plan mode                                          | Plan toggle in the composer                                                                                                                                                                      | The toggle shows for every agent whose `mode` option offers `plan` (claude, codex, cursor). claude and codex: the plan turn ends with the plan (T3 denies claude's exit-plan request with upstream T3's "stop here and wait" message); "Implement plan" runs it in a default turn                                         |
| Accept-edits mode                                  | Edits run without asking                                                                                                                                                                         | Same (anyagent's `AcceptEdits`)                                                                                                                                                                                                                                                                                           |
| Skills picker                                      | Workspace skills listed                                                                                                                                                                          | codex's skills, the workspace's included (a probe in the thread's folder; codex reads `.codex/skills` and `.agents/skills`). claude's skills stay in the `/` menu: its CLI names no SKILL.md, and `/name` runs them. opencode lists workspace skills as `/` commands; grok and antigravity read no workspace skill folder |
| Session instructions                               | T3 added runtime info, PR linking and codex's mode prompt to every session                                                                                                                       | Runtime info and PR linking; codex also gets the browser and device tool guide. Codex uses its own plan-mode prompt                                                                                                                                                                                                       |
| Antigravity                                        | T3 ran its managed install                                                                                                                                                                       | The managed install still downloads but is unused: anyagent runs its own `agy`                                                                                                                                                                                                                                            |
| T3 MCP tools (browser, devices, PR linking)        | Every agent                                                                                                                                                                                      | Same: all six take T3's server                                                                                                                                                                                                                                                                                            |
| Per-turn token usage                               | claude, codex, opencode                                                                                                                                                                          | Same, plus antigravity's native adapter; cursor, grok and antigravity's ACP server report none                                                                                                                                                                                                                            |
| Tool denied (a rule refused a tool without asking) | claude                                                                                                                                                                                           | Same                                                                                                                                                                                                                                                                                                                      |
| Subagent task rows                                 | claude: task rows with progress and usage                                                                                                                                                        | claude: role, model, progress and tokens on the task rows. codex: the spawn's task row carries the child's model and tokens (codex names no role). opencode: role and model, no tokens                                                                                                                                    |
| Cancel on an approval                              | claude denied the tool and the turn went on; codex ended the turn                                                                                                                                | API only (the UI offers no Cancel). claude, codex and grok end the turn as cancelled; opencode and antigravity refuse the tool and the turn goes on. No file is written either way                                                                                                                                        |
| cursor in approval-required threads                | cursor's read-only `ask` mode                                                                                                                                                                    | cursor writes files without asking: its ACP agent asks permission for commands, not for edits                                                                                                                                                                                                                             |

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
  `{"dir":"in"|"out","frame":…}` per line. It is unredacted except declared MCP servers' header
  and env values, which anyagent writes as `<redacted>`. Text generation (titles, branches,
  commits, PRs) records its wire the same way, all calls into one `events.generate.wire.log`. The
  canonical log is unchanged.

## T3's `t3-code` MCP server

Browser preview, devices and pull-request linking reach the agent through T3's own MCP server.
The adapter declares it at `open` (HTTP, with the thread's bearer header) for agents whose probe
takes HTTP MCP servers. All six do; claude, codex, opencode and antigravity called its
`list_thread_pull_requests` tool in the live check (codex gets the bearer token through an
environment variable, not its command line).

## Live check (2026-09-27)

All six kinds were installed and logged in. PASS unless the cell says otherwise; "quota" means
the agent's account was out, so the row is not proven there. The last five rows, and permission,
deny, subagent, generate and plan, are from a later run the same day (grok had quota again, cursor
did not).

| Row                       | claude               | codex                                | cursor                 | grok                  | opencode                      | antigravity           |
| ------------------------- | -------------------- | ------------------------------------ | ---------------------- | --------------------- | ----------------------------- | --------------------- |
| discover, usage-limits    | PASS                 | PASS                                 | PASS                   | PASS                  | PASS                          | PASS                  |
| open+stream               | PASS                 | PASS                                 | PASS¹                  | PASS¹                 | PASS                          | PASS                  |
| tool+diff                 | PASS                 | PASS                                 | PASS¹                  | PASS                  | PASS                          | PASS                  |
| permission                | PASS                 | PASS                                 | SKIP: edits unasked¹ ³ | PASS                  | FAIL (agent)⁴                 | PASS                  |
| deny                      | PASS                 | PASS                                 | quota                  | PASS                  | PASS                          | PASS                  |
| question                  | PASS                 | PASS                                 | quota                  | PASS¹                 | PASS                          | PASS                  |
| subagent                  | PASS                 | SKIP: claude only                    | SKIP: claude only      | SKIP: claude only     | SKIP: claude only             | SKIP: claude only     |
| model-switch              | PASS                 | PASS                                 | PASS²                  | SKIP: one model       | PASS                          | PASS                  |
| cancel                    | PASS                 | PASS                                 | quota                  | PASS¹                 | PASS                          | PASS                  |
| resume                    | PASS                 | PASS                                 | quota                  | PASS                  | PASS                          | PASS                  |
| rollback                  | PASS                 | PASS                                 | SKIP: no rollback      | SKIP: no rollback     | PASS                          | SKIP: no rollback     |
| usage (per-turn tokens)   | PASS                 | PASS                                 | SKIP: ACP              | quota                 | PASS                          | SKIP: ACP             |
| generate (T3's own title) | PASS                 | PASS                                 | quota                  | PASS                  | PASS                          | PASS                  |
| instructions              | PASS                 | PASS                                 | PASS²                  | quota                 | PASS                          | PASS                  |
| plan                      | PASS                 | PASS                                 | quota                  | SKIP: no plan mode    | SKIP: no plan mode            | SKIP: no plan mode    |
| accept-edits              | PASS                 | SKIP: sandbox runs the shell unasked | quota                  | quota                 | PASS                          | PASS                  |
| mcp-tool                  | PASS                 | PASS                                 | quota                  | quota                 | PASS                          | PASS                  |
| turn-diff                 | SKIP: not codex      | PASS                                 | quota                  | SKIP: not codex       | SKIP: not codex               | SKIP: not codex       |
| subagent-info             | PASS: role, tokens   | PASS: model, tokens; no role⁵        | quota                  | SKIP: no subagent     | PASS: role, model; no tokens⁶ | SKIP: no subagent     |
| cancel-request            | PASS: turn cancelled | PASS: turn cancelled                 | quota                  | PASS: turn cancelled  | PASS: turn goes on            | PASS: turn goes on    |
| skills                    | PASS: `/` command    | PASS: skill with path                | quota                  | SKIP: no skill folder | PASS: `/` command             | SKIP: no skill folder |
| schema-generate           | PASS                 | PASS                                 | quota                  | SKIP: free text       | SKIP: free text               | SKIP: free text       |

¹ Passed (or, for the SKIPs, was seen on the wire) in the first run, before the account's quota
ran out: cursor's free plan ("Upgrade your plan to continue"), grok's free usage (429,
`subscription:free-usage-exhausted`, a rolling 24-hour window).
² Ran with cursor's quota already out; the check reads the session's config event or the outgoing
wire, not the reply.
³ cursor's agent mode edits with no ACP `session/request_permission`, so Ask mode cannot stop it.
⁴ opencode's free model answered "hello" to the queued "reply with the single word queued"; the
wire shows the prompt reached opencode. It failed in 4 of 5 runs, always with "hello".
⁵ The row passes when a task row names a role or a model, and the cell lists what arrived.
codex's wire names no role; the row passed on the child's model (`gpt-5.6-luna`) and its tokens. The
first run failed: anyagent did not link children spawned by `collabAgentToolCall`, fixed since.
⁶ opencode's wire carries a role and a model, and no token count for the child. The first run failed: anyagent read neither,
fixed since.

"SKIP: ACP" is decided from the wire: the session spoke ACP (`session/prompt`) and its turn carried
no token counts; antigravity here is its ACP server (its native adapter over `agy` reports them).
`usage-limits` shows windows on claude and codex (codex also `resetCredits`) and `unsupported` on
the others. `instructions` found T3's text in claude's `initialize` (`appendSystemPrompt`),
codex's `thread/start` (`developerInstructions`), opencode's prompt `system`, and the first prompt
of the ACP agents.

The five newest rows decide their SKIPs from facts too. `turn-diff`: no `turn.diff.updated` came
and the wire is not codex's app-server protocol (no `turn/start`). `subagent-info`: the agent
started no subagent task. `skills`: a folder without the skill lists the same commands as the one
with it. `schema-generate`: the generate wire shows no schema (the agent does not advertise
`OutputSchema`, so T3 uses the free-text path the `generate` row proves); claude's schema shows as
the `StructuredOutput` tool in its `system init` frame (`--json-schema` is argv, not wire), codex's
as `outputSchema` in `turn/start`. `cancel-request` requires a cancelled turn when the answer on
the wire interrupts (claude's `"interrupt":true`, codex's `"decision":"cancel"`); grok's ACP agent
also ended its turn. `generate` SKIPs when the agent titles the session before T3's generation
lands, since T3 then keeps the agent's title.
