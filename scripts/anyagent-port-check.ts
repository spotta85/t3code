// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off globalFetch:off preferSchemaOverJson:off - a plain Node script, no Effect runtime.
/**
 * anyagent-port-check - live feature check for T3 Code running on anyagent.
 *
 * Drives a T3 server over its WebSocket RPC (the same wire the web app uses) and
 * checks one feature per row, per agent. Rows read `orchestration.subscribeThread`
 * events, never raw provider events.
 *
 *   node scripts/anyagent-port-check.ts [--agents claude,codex] [--rows a,b] [--dry-run]
 *                                       [--url ws://127.0.0.1:3773/ws --token <bearer>]
 *
 * Without --url it starts `t3 serve` headless on a free port with a fresh base dir
 * (needs ANYAGENT_BIN or the default sibling checkout), issues a token, stops it at the end.
 * Every frame sent and received goes to `port-check-<agent>-<timestamp>.log` in the out dir
 * ($PORT_CHECK_OUT, else <os tmpdir>/anyagent-port-check).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Wire JSON, read field by field. */
type Obj = Record<string, any>;

const FORK = NodePath.resolve(import.meta.dirname, "..");
const OUT = process.env.PORT_CHECK_OUT ?? NodePath.join(NodeOS.tmpdir(), "anyagent-port-check");
const ANYAGENT_BIN =
  process.env.ANYAGENT_BIN ?? NodePath.resolve(FORK, "../anyagent/target/release/anyagent");

/** Per agent: T3 instance id, a cheap model for the rows, the model the switch row moves to, picked options. */
const AGENTS: Record<string, AgentSpec> = {
  claude: { instanceId: "claudeAgent", model: "haiku", switchTo: "sonnet", options: [] },
  codex: {
    instanceId: "codex",
    model: "gpt-5.6-luna",
    switchTo: "gpt-5.5",
    options: [{ id: "reasoningEffort", value: "low" }],
  },
};

const FILE = "port-check.txt";
const WRITE = `Create a file named ${FILE} containing exactly the word hello. Use your file tools. Do not verify afterwards.`;
const PONG = "Reply with the single word pong. No tools.";
const COUNT = "Count from 1 to 2000, one number per line. No other text. No tools.";

/** The rows in run order: id, timeout, what passing means (printed by --dry-run), and the check. */
const ROWS: Row[] = [
  {
    id: "discover",
    ms: 30_000,
    passes: "provider listed, installed, logged in, ready",
    run: discover,
  },
  {
    id: "open+stream",
    ms: 90_000,
    passes: "pong turn streams text containing pong, turn completes",
    run: openStream,
  },
  {
    id: "tool+diff",
    ms: 120_000,
    passes: `tool activity names ${FILE} (path or diff), file exists`,
    run: toolDiff,
  },
  {
    id: "permission",
    ms: 180_000,
    passes:
      "Ask mode: approval requested, approved, turn completes, file exists (2nd turn queued behind it)",
    run: permission,
  },
  {
    id: "deny",
    ms: 150_000,
    passes: "Ask mode: every approval declined, turn completes, file absent",
    run: deny,
  },
  {
    id: "question",
    ms: 150_000,
    passes: "user-input request appears, answered, resolved, turn completes",
    run: question,
  },
  {
    id: "model-switch",
    ms: 150_000,
    passes: "turn with a different model: the provider reports the new model",
    run: modelSwitch,
  },
  {
    id: "cancel",
    ms: 180_000,
    passes:
      "interrupt after the first delta ends the turn early as cancelled (2nd turn queued); next turn works",
    run: cancel,
  },
  {
    id: "resume",
    ms: 180_000,
    passes: `session stopped, restarted from resume cursor, recalls ${FILE}`,
    run: resume,
  },
  {
    id: "rollback",
    ms: 180_000,
    passes: "revert 1 turn: the rolled-back codeword is forgotten, the kept one is not",
    run: rollback,
  },
  {
    id: "usage",
    ms: 90_000,
    passes: "a context-window.updated activity with non-zero input tokens",
    run: usage,
  },
  {
    id: "generate",
    ms: 180_000,
    passes: "first turn on a 'New thread' gets a generated title (text generation)",
    run: generate,
  },
];

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

/** Parse flags, start or reach the server, run every row per agent, print the matrix. */
async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const rows = flags.rows ? ROWS.filter((r) => flags.rows!.includes(r.id)) : ROWS;
  if (flags.dryRun) {
    for (const row of rows)
      console.log(`${row.id.padEnd(13)} ${String(row.ms / 1000).padStart(4)}s  ${row.passes}`);
    console.log(`agents: ${flags.agents.join(", ")}`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  NodeFS.mkdirSync(NodePath.join(OUT, "port-check-dirs"), { recursive: true });
  const server = flags.url
    ? {
        url: flags.url,
        token: flags.token ?? "",
        logPath: null,
        baseDir: null,
        stop: async () => {},
      }
    : await startServer(stamp);
  const results: Array<{ agent: string; row: string; outcome: Outcome; reason: string }> = [];
  const logs: string[] = [];
  try {
    for (const agent of flags.agents) {
      const log = openLog(NodePath.join(OUT, `port-check-${agent}-${stamp}.log`));
      logs.push(log.path);
      log.line(
        `agent ${agent}; server ${server.url}; server log ${server.logPath ?? "(external server)"}; base dir ${server.baseDir ?? "(unknown)"}`,
      );
      const rpc = await connect(server.url, server.token, log);
      const ctx: Ctx = { agent, spec: specFor(agent), rpc, log, server, step: "" };
      const restore = await withTokenStreaming(ctx);
      for (const row of rows) {
        const { outcome, reason } = await runRow(row, ctx);
        results.push({ agent, row: row.id, outcome, reason });
        console.log(`${agent.padEnd(7)} ${row.id.padEnd(13)} ${outcome.padEnd(4)} ${reason}`);
      }
      await restore();
      rpc.close();
    }
  } finally {
    await server.stop();
  }
  printSummary(results, logs, server.logPath);
}

/** Runs one row under its timeout; a throw is FAIL, a Skip is SKIP, the reason is one line. */
async function runRow(row: Row, ctx: Ctx): Promise<{ outcome: Outcome; reason: string }> {
  ctx.log.line(`===== row ${row.id} (timeout ${row.ms / 1000}s)`);
  ctx.step = "start";
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout after ${row.ms / 1000}s at step "${ctx.step}"`)),
      row.ms,
    );
  });
  let result: { outcome: Outcome; reason: string };
  try {
    const reason = await Promise.race([row.run(ctx), timeout]);
    result = { outcome: "PASS", reason };
  } catch (error) {
    result =
      error instanceof Skip
        ? { outcome: "SKIP", reason: error.message }
        : { outcome: "FAIL", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  result.reason = `${result.reason.replace(/\s+/g, " ").trim()} (${secs}s)`;
  ctx.log.line(`===== row ${row.id}: ${result.outcome} ${result.reason}`);
  await cleanupRow(ctx);
  return result;
}

// ---------------------------------------------------------------------------
// ROWS
// ---------------------------------------------------------------------------

/** The agent's provider is listed, enabled, installed, logged in and ready. */
async function discover(ctx: Ctx): Promise<string> {
  const p = await provider(ctx);
  const problems = [
    !p.enabled && "not enabled",
    !p.installed && "not installed",
    p.auth?.status !== "authenticated" && `auth ${p.auth?.status}`,
    p.status !== "ready" && `status ${p.status}: ${p.message ?? ""}`,
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `v${p.version}, ${p.auth.type ?? "auth"} ${p.auth.label ?? ""}, ${p.models.length} models, rollback ${p.supportsConversationRollback === true}`;
}

/** A pong turn streams assistant text containing pong and completes. */
async function openStream(ctx: Ctx): Promise<string> {
  const t = await openThread(ctx, "open+stream");
  const turn = await runTurn(ctx, t, PONG);
  const deltas = messages(t, turn.turnId).filter(
    (e) => e.payload.streaming && e.payload.text,
  ).length;
  expect(turn.status === "ready", `turn ended ${turn.status}: ${turn.lastError}`);
  expect(/pong/i.test(turn.text), `reply has no pong: ${quote(turn.text)}`);
  expect(deltas > 0, "no streamed assistant delta");
  return `reply ${quote(turn.text)} in ${deltas} delta(s), session ready`;
}

/** A write turn shows a tool activity naming the file (path or diff) and the file lands. */
async function toolDiff(ctx: Ctx): Promise<string> {
  const t = await openThread(ctx, "tool+diff");
  const turn = await runTurn(ctx, t, WRITE);
  const tools = activities(t, turn.from).filter((a) => a.kind.startsWith("tool."));
  const naming = tools.filter((a) => JSON.stringify(a.payload).includes(FILE));
  const diffs = t.events.items
    .slice(turn.from)
    .filter((e) => e.type === "thread.turn-diff-completed")
    .flatMap((e) => e.payload.files.map((f: Obj) => f.path));
  expect(turn.status === "ready", `turn ended ${turn.status}: ${turn.lastError}`);
  expect(
    naming.length > 0,
    `no tool activity names ${FILE} (${tools.length} tool activities: ${tools.map((a) => a.summary).join(", ")})`,
  );
  expect(fileHas(t.dir, "hello"), `${FILE} missing or wrong after the turn`);
  return `${naming.length} tool activit(ies) name ${FILE} (${naming[0]!.kind} ${quote(naming[0]!.summary)}), file exists, turn diff files [${diffs.join(", ")}]`;
}

/**
 * Ask mode: the write asks, a second turn is queued behind the open request (lifecycle-guard check),
 * the script approves, both turns complete and the file lands.
 */
async function permission(ctx: Ctx): Promise<string> {
  const t = await openThread(ctx, "permission", { runtimeMode: "approval-required" });
  const from = await sendTurn(ctx, t, WRITE);
  const asked = await waitActivity(ctx, t, from, "approval.requested", 120_000);
  await sendTurn(ctx, t, "Now reply with the single word queued. No tools.");
  const end = await settle(ctx, t, from, {
    decision: "accept",
    done: (text) => /queued/i.test(text),
  });
  const errors = errorActivities(t, from);
  expect(fileHas(t.dir, "hello"), `${FILE} missing after approval`);
  expect(end.status === "ready", `thread settled ${end.status}: ${end.lastError}`);
  expect(/queued/i.test(end.text), `queued turn never answered (text: ${quote(end.text)})`);
  expect(errors.length === 0, `error activities: ${errors.join(" | ")}`);
  return `approval "${asked.a.summary}" accepted, file exists, queued turn answered, ${end.turns} turn(s) ${end.transitions}`;
}

/** Ask mode: every approval is declined; the turn completes and no file is written. */
async function deny(ctx: Ctx): Promise<string> {
  const t = await openThread(ctx, "deny", { runtimeMode: "approval-required" });
  const from = await sendTurn(ctx, t, WRITE);
  await waitActivity(ctx, t, from, "approval.requested", 120_000);
  const end = await settle(ctx, t, from, { decision: "decline" });
  expect(end.status === "ready", `turn ended ${end.status}: ${end.lastError}`);
  expect(!NodeFS.existsSync(NodePath.join(t.dir, FILE)), `${FILE} exists after deny`);
  return `${end.answered} approval(s) declined, turn completed, ${FILE} absent`;
}

/** The agent asks a question; the script answers with the first option; the turn completes. */
async function question(ctx: Ctx): Promise<string> {
  const t = await openThread(ctx, "question");
  const from = await sendTurn(
    ctx,
    t,
    "Ask me one yes/no question using your question tool (claude: AskUserQuestion; codex: request_user_input), wait for my answer, then reply with just my answer. No other tools.",
  );
  const asked = await waitActivity(ctx, t, from, "user-input.requested", 120_000);
  const q = asked.a.payload.questions[0] as Obj;
  const pick = q.options?.[0]?.label ?? "yes";
  ctx.step = "answer question";
  await dispatch(ctx, {
    type: "thread.user-input.respond",
    threadId: t.threadId,
    requestId: asked.a.payload.requestId,
    answers: { [q.id]: pick },
  });
  await waitActivity(ctx, t, asked.index, "user-input.resolved", 60_000);
  const turn = await waitTurnEnd(ctx, t, from, 120_000);
  expect(turn.status === "ready", `turn ended ${turn.status}: ${turn.lastError}`);
  return `asked ${quote(q.question)}, answered ${quote(pick)}, resolved, reply ${quote(turn.text)}`;
}

/**
 * A turn on model A, then a turn whose modelSelection names model B. T3's thread stream has no
 * provider model event, so the proof is the provider's own session.configured in T3's canonical
 * provider event log (needs the base dir: a server this script started).
 */
async function modelSwitch(ctx: Ctx): Promise<string> {
  if (!ctx.server.baseDir)
    throw new Skip("needs the server's base dir (T3's provider event log); run without --url");
  const t = await openThread(ctx, "model-switch");
  const first = await runTurn(ctx, t, PONG);
  expect(first.status === "ready", `first turn ended ${first.status}: ${first.lastError}`);
  const target =
    ctx.spec.switchTo ??
    (await provider(ctx)).models.find((m: Obj) => m.slug !== ctx.spec.model)?.slug;
  const second = await runTurn(ctx, t, PONG, { modelSelection: selection(ctx, target) });
  expect(second.status === "ready", `switched turn ended ${second.status}: ${second.lastError}`);
  const configured = (await flushedProviderEvents(ctx, t)).filter(
    (e) => e.type === "session.configured",
  );
  const models = configured.map((e) => e.payload?.config?.model).filter((m) => m !== undefined);
  expect(
    models.includes(target),
    `no session.configured with model ${target} (saw: [${models.join(", ")}])`,
  );
  return `${ctx.spec.model} -> ${target}: provider session.configured reports model ${target}; switched turn replied ${quote(second.text)}`;
}

/**
 * A long turn; after its first text delta a second turn is queued, then the first is interrupted.
 * It must end early (no "2000") as cancelled, and a fresh turn afterwards must still answer.
 * T3 settles a cancelled turn as session "ready", so "cancelled" is read from T3's provider log.
 */
async function cancel(ctx: Ctx): Promise<string> {
  const t = await openThread(ctx, "cancel");
  const from = await sendTurn(ctx, t, COUNT);
  const running = await waitSession(
    ctx,
    t,
    from,
    (s) => s.status === "running",
    60_000,
    "turn running",
  );
  const turnId = running.s.activeTurnId as string;
  ctx.step = "first text delta";
  await t.events.waitFor(
    (e) => isAssistant(e) && e.payload.text !== "",
    running.index,
    60_000,
    "first text delta",
  );
  await sendTurn(ctx, t, "Reply with the single word pear. No tools.");
  ctx.step = "interrupt";
  await dispatch(ctx, { type: "thread.turn.interrupt", threadId: t.threadId, turnId });
  const ended = await waitSession(ctx, t, running.index + 1, isIdle, 60_000, "cancelled turn end");
  const cancelled = textOf(t, turnId);
  const queued = await settle(ctx, t, from, { done: (text) => /pear/i.test(text), ms: 60_000 });
  const next = await runTurn(ctx, t, "Reply with the single word plum. No tools.");
  const errors = errorActivities(t, from);
  const state = ctx.server.baseDir
    ? ((await flushedProviderEvents(ctx, t)).find(
        (e) => e.type === "turn.completed" && e.turnId === turnId,
      )?.payload.state ?? "missing")
    : "not checked (--url: no provider log)";
  expect(!/\b2000\b/.test(cancelled), `cancelled turn ran to the end (${cancelled.length} chars)`);
  expect(
    state === "cancelled" || !ctx.server.baseDir,
    `provider turn.completed state ${state} for ${turnId}, want cancelled`,
  );
  expect(
    next.status === "ready" && /plum/i.test(next.text),
    `turn after cancel: ${next.status} ${quote(next.text)}`,
  );
  expect(errors.length === 0, `error activities: ${errors.join(" | ")}`);
  const pear = /pear/i.test(queued.text)
    ? "queued turn answered pear"
    : "queued prompt folded into the cancelled turn";
  return `turn ended ${ended.s.status} at ${cancelled.length} chars, provider state ${state} (${queued.transitions}); ${pear}; next turn replied ${quote(next.text)}`;
}

/** Stop the session, delete the file, then a new turn must restart from the resume cursor and recall it. */
async function resume(ctx: Ctx): Promise<string> {
  const t = await openThread(ctx, "resume");
  const first = await runTurn(ctx, t, WRITE);
  expect(
    first.status === "ready" && fileHas(t.dir, "hello"),
    `setup turn failed: ${first.status}, file ${fileHas(t.dir, "hello")}`,
  );
  NodeFS.rmSync(NodePath.join(t.dir, FILE));
  ctx.step = "stop session";
  const stopFrom = t.events.items.length;
  await dispatch(ctx, { type: "thread.session.stop", threadId: t.threadId });
  await waitSession(ctx, t, stopFrom, (s) => s.status === "stopped", 30_000, "session stopped");
  const recall = await runTurn(
    ctx,
    t,
    "What file did you create earlier in this conversation? Answer from memory with just the file name. Do not use any tools.",
  );
  expect(recall.status === "ready", `recall turn ended ${recall.status}: ${recall.lastError}`);
  expect(recall.text.includes(FILE), `recall does not name ${FILE}: ${quote(recall.text)}`);
  return `stopped, restarted, recall ${quote(recall.text)}`;
}

/** Two codeword turns, revert to 1 turn, then the agent must list only the first codeword. */
async function rollback(ctx: Ctx): Promise<string> {
  const p = await provider(ctx);
  if (p.supportsConversationRollback !== true)
    throw new Skip("provider reports supportsConversationRollback false");
  const t = await openThread(ctx, "rollback");
  for (const text of [
    "Remember this codeword: ALPHA9. Just confirm. No tools.",
    "Remember a second codeword: ZULU7. Just confirm. No tools.",
  ]) {
    const turn = await runTurn(ctx, t, text);
    expect(turn.status === "ready", `codeword turn ended ${turn.status}: ${turn.lastError}`);
  }
  ctx.step = "revert to turn 1";
  const revertFrom = t.events.items.length;
  await dispatch(ctx, { type: "thread.conversation.revert", threadId: t.threadId, turnCount: 1 });
  await t.events
    .waitFor(
      (e) =>
        e.type === "thread.reverted" ||
        (isActivity(e) &&
          /revert/i.test(e.payload.activity.kind) &&
          e.payload.activity.tone === "error"),
      revertFrom,
      60_000,
      "thread.reverted",
    )
    .then(({ e }) =>
      expect(
        e.type === "thread.reverted",
        `revert failed: ${JSON.stringify(e.payload.activity?.payload)}`,
      ),
    );
  const recall = await runTurn(
    ctx,
    t,
    "List every codeword I told you, comma separated, nothing else. No tools.",
  );
  expect(recall.status === "ready", `recall turn ended ${recall.status}: ${recall.lastError}`);
  expect(recall.text.includes("ALPHA9"), `kept codeword forgotten: ${quote(recall.text)}`);
  expect(!recall.text.includes("ZULU7"), `rolled-back codeword recalled: ${quote(recall.text)}`);
  return `reverted to turn 1, recall ${quote(recall.text)}`;
}

/** After a turn, a context-window.updated activity must carry non-zero input tokens. */
async function usage(ctx: Ctx): Promise<string> {
  const t = await openThread(ctx, "usage");
  const turn = await runTurn(ctx, t, PONG);
  await sleep(2000);
  const windows = activities(t, turn.from)
    .filter((a) => a.kind === "context-window.updated")
    .map((a) => a.payload as Obj);
  const input = windows.find((u) => (u.inputTokens ?? u.lastInputTokens ?? 0) > 0);
  if (!input) {
    const used = windows.map((u) => u.usedTokens).join(", ");
    throw new Error(
      `no input token count: ${windows.length} context-window.updated (usedTokens [${used}], fields [${[...new Set(windows.flatMap(Object.keys))].join(",")}]); gaps row "Per-turn token usage"`,
    );
  }
  return `inputTokens ${input.inputTokens ?? input.lastInputTokens}, usedTokens ${input.usedTokens}`;
}

/** Text generation: the first turn of a "New thread" gets a title generated by this agent. */
async function generate(ctx: Ctx): Promise<string> {
  ctx.step = "read settings";
  const settings = (await ctx.rpc.call("server.getSettings", {})) as Obj;
  const before = settings.textGenerationModelSelection;
  ctx.log.line(`textGenerationModelSelection before: ${JSON.stringify(before)}`);
  await ctx.rpc.call("server.updateSettings", {
    patch: { textGenerationModelSelection: selection(ctx) },
  });
  try {
    const t = await openThread(ctx, "generate", { title: "New thread" });
    await sendTurn(ctx, t, "How do I rename a git branch? Reply in one short sentence. No tools.");
    ctx.step = "generated title (polling the thread over HTTP; titles ride the shell stream)";
    const deadline = Date.now() + 150_000; // inside the row timeout, so `finally` restores in time
    while (Date.now() < deadline) {
      const { thread } = (await httpGet(ctx, `/api/orchestration/threads/${t.threadId}`)) as Obj;
      if (thread.title !== "New thread")
        return `title ${quote(thread.title)} (titleState ${JSON.stringify(thread.titleState)})`;
      await sleep(1000);
    }
    throw new Error("no generated title after 150s");
  } finally {
    await ctx.rpc
      .call("server.updateSettings", { patch: { textGenerationModelSelection: before } })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// THREAD HELPERS
// ---------------------------------------------------------------------------

/** A fresh git project dir, a project, a thread on the agent, and its event subscription. */
async function openThread(
  ctx: Ctx,
  row: string,
  opts: { runtimeMode?: string; title?: string } = {},
): Promise<Thread> {
  ctx.step = "open thread";
  const dir = NodeFS.mkdtempSync(
    NodePath.join(OUT, "port-check-dirs", `${ctx.agent}-${row.replace(/\W/g, "")}-`),
  );
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=port-check",
      "-c",
      "user.email=port-check@local",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: dir },
  );
  const projectId = NodeCrypto.randomUUID();
  const threadId = NodeCrypto.randomUUID();
  const runtimeMode = opts.runtimeMode ?? "full-access";
  ctx.log.line(
    `row dir ${dir}; project ${projectId}; thread ${threadId}; runtimeMode ${runtimeMode}`,
  );
  await dispatch(ctx, {
    type: "project.create",
    projectId,
    title: `port-check ${row}`,
    workspaceRoot: dir,
  });
  await dispatch(ctx, {
    type: "thread.create",
    threadId,
    projectId,
    title: opts.title ?? `port-check ${row}`,
    modelSelection: selection(ctx),
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  const events = ctx.rpc.stream("orchestration.subscribeThread", { threadId });
  const thread = { dir, threadId, runtimeMode, events };
  ctx.thread = thread;
  return thread;
}

/** Dispatches one user turn; returns the stream index it was sent at. */
async function sendTurn(ctx: Ctx, t: Thread, text: string, extra: Obj = {}): Promise<number> {
  ctx.step = `send turn ${quote(text)}`;
  const from = t.events.items.length;
  await dispatch(ctx, {
    type: "thread.turn.start",
    threadId: t.threadId,
    message: { messageId: NodeCrypto.randomUUID(), role: "user", text, attachments: [] },
    runtimeMode: t.runtimeMode,
    interactionMode: "default",
    ...extra,
  });
  return from;
}

/** Sends a turn and waits for it to end; returns its id, final status and text. */
async function runTurn(ctx: Ctx, t: Thread, text: string, extra: Obj = {}): Promise<TurnEnd> {
  const from = await sendTurn(ctx, t, text, extra);
  return waitTurnEnd(ctx, t, from, 120_000);
}

/** Waits for the session to go running after `from`, then to leave running; collects the turn's text. */
async function waitTurnEnd(ctx: Ctx, t: Thread, from: number, ms: number): Promise<TurnEnd> {
  const running = await waitSession(
    ctx,
    t,
    from,
    (s) => s.status === "running" && s.activeTurnId,
    ms,
    "turn running",
  );
  const ended = await waitSession(ctx, t, running.index + 1, isIdle, ms, "turn end");
  await sleep(300); // trailing coalesced deltas
  const turnId = running.s.activeTurnId as string;
  const text = textOf(t, turnId);
  ctx.log.line(`turn ${turnId} ended ${ended.s.status}; text ${quote(text)}`);
  return { from, turnId, status: ended.s.status, lastError: ended.s.lastError, text };
}

/**
 * Polls until the thread is idle and `done(text)` holds, or it has stayed idle 8s; answers every
 * approval that opens after `from` with `decision` on the way. Returns the final session, all
 * assistant text since `from`, and the session statuses seen (the lifecycle-guard evidence).
 */
async function settle(
  ctx: Ctx,
  t: Thread,
  from: number,
  opts: { decision?: string; done?: (text: string) => boolean; ms?: number },
): Promise<Settled> {
  const answered = new Set<string>();
  const deadline = Date.now() + (opts.ms ?? 120_000);
  let idleSince = 0;
  for (;;) {
    for (const a of activities(t, from)) {
      if (!opts.decision || a.kind !== "approval.requested" || answered.has(a.payload.requestId))
        continue;
      answered.add(a.payload.requestId);
      ctx.step = `${opts.decision} approval ${a.payload.requestId}`;
      await dispatch(ctx, {
        type: "thread.approval.respond",
        threadId: t.threadId,
        requestId: a.payload.requestId,
        decision: opts.decision,
      });
    }
    ctx.step = "thread settles";
    const sessions = t.events.items
      .slice(from)
      .filter(isSessionSet)
      .map((e) => e.payload.session as Obj);
    const last = sessions.at(-1);
    const text = textAfter(t, from);
    idleSince = last && isIdle(last) ? idleSince || Date.now() : 0;
    if (last && idleSince && ((opts.done ?? (() => true))(text) || Date.now() - idleSince > 8000)) {
      const turns = new Set(sessions.map((s) => s.activeTurnId).filter(Boolean)).size;
      const transitions = sessions.map((s) => s.status).join(">");
      ctx.log.line(`settled ${last.status}; transitions ${transitions}; text ${quote(text)}`);
      return {
        status: last.status,
        lastError: last.lastError,
        text,
        turns,
        transitions,
        answered: answered.size,
      };
    }
    if (Date.now() > deadline)
      throw new Error(`thread never settled (last session ${JSON.stringify(last)})`);
    await sleep(250);
  }
}

/** The first session-set after `from` whose session matches. */
async function waitSession(
  ctx: Ctx,
  t: Thread,
  from: number,
  pred: (s: Obj) => unknown,
  ms: number,
  what: string,
): Promise<{ s: Obj; index: number }> {
  ctx.step = what;
  const { e, index } = await t.events.waitFor(
    (e) => isSessionSet(e) && Boolean(pred(e.payload.session)),
    from,
    ms,
    what,
  );
  return { s: e.payload.session, index };
}

/** The first activity of `kind` after `from`; fails fast (with the reply) when a turn ends without it. */
async function waitActivity(
  ctx: Ctx,
  t: Thread,
  from: number,
  kind: string,
  ms: number,
): Promise<{ a: Obj; index: number }> {
  ctx.step = `activity ${kind}`;
  let running = false;
  const { e, index } = await t.events.waitFor(
    (e) => {
      if (isActivity(e)) return e.payload.activity.kind === kind;
      if (!isSessionSet(e)) return false;
      running ||= e.payload.session.status === "running";
      return running && isIdle(e.payload.session);
    },
    from,
    ms,
    `activity ${kind}`,
  );
  if (!isActivity(e))
    throw new Error(
      `turn ended ${e.payload.session.status} without ${kind}; reply ${quote(textAfter(t, from))}`,
    );
  return { a: e.payload.activity, index };
}

/** Stops the row's session and ends its subscription; dumps T3's canonical provider events for the thread. */
async function cleanupRow(ctx: Ctx): Promise<void> {
  const t = ctx.thread;
  ctx.thread = undefined;
  if (!t) return;
  await dispatch(ctx, { type: "thread.session.stop", threadId: t.threadId }).catch((e: Error) =>
    ctx.log.line(`cleanup stop failed: ${e.message}`),
  );
  t.events.close();
  for (const e of await flushedProviderEvents(ctx, t))
    ctx.log.line(`provider-event ${JSON.stringify(e)}`);
}

// ---------------------------------------------------------------------------
// EVENT READERS
// ---------------------------------------------------------------------------

/** Assistant text for one turn, joined across streamed chunks. */
function textOf(t: Thread, turnId: string): string {
  return messages(t, turnId)
    .map((e) => e.payload.text)
    .join("");
}

/** Every assistant text after stream index `from`. */
function textAfter(t: Thread, from: number): string {
  return t.events.items
    .slice(from)
    .filter(isAssistant)
    .map((e) => e.payload.text)
    .join("");
}

/** Assistant message events of one turn. */
function messages(t: Thread, turnId: string): Obj[] {
  return t.events.items.filter((e) => isAssistant(e) && e.payload.turnId === turnId);
}

/** Activities appended after stream index `from`. */
function activities(t: Thread, from: number): Obj[] {
  return t.events.items
    .slice(from)
    .filter(isActivity)
    .map((e) => e.payload.activity);
}

/** Error-toned activities after `from`, as "kind: summary" lines. */
function errorActivities(t: Thread, from: number): string[] {
  return activities(t, from)
    .filter((a) => a.tone === "error")
    .map((a) => `${a.kind}: ${a.summary} ${JSON.stringify(a.payload).slice(0, 200)}`);
}

/** T3's canonical provider events for the thread, from its provider log dir (empty without a base dir). */
function providerEvents(ctx: Ctx, t: Thread): Obj[] {
  if (!ctx.server.baseDir) return [];
  const dir = NodePath.join(ctx.server.baseDir, "userdata", "logs", "provider");
  if (!NodeFS.existsSync(dir)) return [];
  const out: Obj[] = [];
  for (const name of NodeFS.readdirSync(dir)) {
    if (!name.includes(t.threadId)) continue;
    for (const line of NodeFS.readFileSync(NodePath.join(dir, name), "utf8").split("\n")) {
      if (!line.includes("] CANON: {")) continue;
      try {
        out.push(JSON.parse(line.slice(line.indexOf("{"))) as Obj);
      } catch {
        // not an event line
      }
    }
  }
  return out;
}

/** providerEvents after T3's event log has flushed (it writes in 1s batches). */
async function flushedProviderEvents(ctx: Ctx, t: Thread): Promise<Obj[]> {
  await sleep(1500);
  return providerEvents(ctx, t);
}

const isSessionSet = (e: Obj) => e.type === "thread.session-set";
const isActivity = (e: Obj) => e.type === "thread.activity-appended";
const isIdle = (s: Obj) => s.status !== "running" && s.status !== "starting";
const isAssistant = (e: Obj) => e.type === "thread.message-sent" && e.payload.role === "assistant";

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

/** The agent's provider entry from server.getConfig. */
async function provider(ctx: Ctx): Promise<Obj> {
  ctx.step = "server.getConfig";
  const config = (await ctx.rpc.call("server.getConfig", {})) as Obj;
  const p = (config.providers as Obj[]).find((x) => x.instanceId === ctx.spec.instanceId);
  if (!p) throw new Error(`instance ${ctx.spec.instanceId} not in server.getConfig providers`);
  return p;
}

/** The thread's model selection: the agent's row model (or `model`) plus its picked options. */
function selection(ctx: Ctx, model = ctx.spec.model): Obj {
  return {
    instanceId: ctx.spec.instanceId,
    model,
    ...(ctx.spec.options.length > 0 ? { options: ctx.spec.options } : {}),
  };
}

/** One orchestration command with a fresh commandId and createdAt. */
async function dispatch(ctx: Ctx, command: Obj): Promise<unknown> {
  return ctx.rpc.call("orchestration.dispatchCommand", {
    commandId: NodeCrypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...command,
  });
}

/** GET a T3 HTTP endpoint with the bearer token; the JSON body. */
async function httpGet(ctx: Ctx, route: string): Promise<unknown> {
  const url = ctx.server.url.replace(/^ws/, "http").replace(/\/ws$/, route);
  ctx.log.line(`http GET ${url}`);
  const res = await fetch(url, { headers: { authorization: `Bearer ${ctx.server.token}` } });
  const body = await res.text();
  ctx.log.line(`http ${res.status} ${body.slice(0, 2000)}`);
  if (!res.ok) throw new Error(`GET ${route} -> ${res.status}`);
  return JSON.parse(body);
}

/** Switches T3 to token streaming (default "paragraph" holds text back) so deltas arrive as they stream; returns the undo. */
async function withTokenStreaming(ctx: Ctx): Promise<() => Promise<void>> {
  const before = ((await ctx.rpc.call("server.getSettings", {})) as Obj).responseStreamingMode;
  ctx.log.line(`responseStreamingMode ${before} -> token`);
  await ctx.rpc.call("server.updateSettings", { patch: { responseStreamingMode: "token" } });
  return async () => {
    await ctx.rpc.call("server.updateSettings", { patch: { responseStreamingMode: before } });
  };
}

/** The spec for `agent`; an agent not in AGENTS uses its own name as instance id and the default model. */
function specFor(agent: string): AgentSpec {
  return AGENTS[agent] ?? { instanceId: agent, model: "default", switchTo: undefined, options: [] };
}

/** True when the row's file exists and contains `word`. */
function fileHas(dir: string, word: string): boolean {
  const file = NodePath.join(dir, FILE);
  return NodeFS.existsSync(file) && NodeFS.readFileSync(file, "utf8").includes(word);
}

/** Throws the reason unless `ok`. */
function expect(ok: boolean, reason: string): void {
  if (!ok) throw new Error(reason);
}

/** A short quoted preview of a reply. */
function quote(text: string | undefined): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Prints the matrix (rows x agents), counts, and log paths. */
function printSummary(
  results: Array<{ agent: string; row: string; outcome: Outcome; reason: string }>,
  logs: string[],
  serverLog: string | null,
): void {
  console.log("\nsummary");
  for (const agent of new Set(results.map((r) => r.agent))) {
    const mine = results.filter((r) => r.agent === agent);
    const count = (o: Outcome) => mine.filter((r) => r.outcome === o).length;
    const fails = mine.filter((r) => r.outcome === "FAIL").map((r) => r.row);
    console.log(
      `  ${agent}: ${count("PASS")} PASS, ${count("FAIL")} FAIL${fails.length ? ` (${fails.join(", ")})` : ""}, ${count("SKIP")} SKIP`,
    );
  }
  for (const log of logs) console.log(`log: ${log}`);
  if (serverLog) console.log(`server log: ${serverLog}`);
}

/** --agents, --rows, --url, --token, --dry-run. */
function parseFlags(argv: string[]): Flags {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (s: string | undefined) =>
    s
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const rows = list(value("--rows"));
  const unknown = rows?.filter((r) => !ROWS.some((row) => row.id === r)) ?? [];
  if (unknown.length > 0)
    throw new Error(
      `unknown rows: ${unknown.join(", ")} (rows: ${ROWS.map((r) => r.id).join(", ")})`,
    );
  return {
    agents: list(value("--agents")) ?? ["claude", "codex"],
    rows,
    url: value("--url"),
    token: value("--token"),
    dryRun: argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// SERVER + LOG
// ---------------------------------------------------------------------------

/** Starts `t3 serve` on a free port with a fresh base dir; resolves once it listens and a token is issued. */
async function startServer(stamp: string): Promise<Server> {
  const baseDir = NodePath.join(OUT, `port-check-home-${stamp}`);
  const logPath = NodePath.join(OUT, `port-check-server-${stamp}.log`);
  const port = await freePort();
  const env = agentEnv();
  const bin = NodePath.join(FORK, "apps/server/src/bin.ts");
  console.log(`starting t3 serve on :${port} (base dir ${baseDir}, log ${logPath})`);
  const out = NodeFS.openSync(logPath, "a");
  const child: NodeChildProcess.ChildProcess = NodeChildProcess.spawn(
    process.execPath,
    [bin, "serve", "--base-dir", baseDir, "--port", String(port)],
    {
      cwd: FORK,
      env,
      stdio: ["ignore", out, out],
    },
  );
  const deadline = Date.now() + 90_000;
  while (!NodeFS.readFileSync(logPath, "utf8").includes(`Listening on http://127.0.0.1:${port}`)) {
    if (child.exitCode !== null)
      throw new Error(`t3 serve exited ${child.exitCode}; see ${logPath}`);
    if (Date.now() > deadline) throw new Error(`t3 serve not listening after 90s; see ${logPath}`);
    await sleep(250);
  }
  const token = NodeChildProcess.execFileSync(
    process.execPath,
    [bin, "auth", "session", "issue", "--base-dir", baseDir, "--token-only"],
    { cwd: FORK, env, encoding: "utf8" },
  ).trim();
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGINT");
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { url: `ws://127.0.0.1:${port}/ws`, token, logPath, baseDir, stop };
}

/** The server's env: harness vars (ANTHROPIC_*, CLAUDE*) stripped so a child claude uses its own login. */
function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ANYAGENT_BIN };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE)/.test(key)) delete env[key];
  env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  return env;
}

/** A free TCP port on loopback. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = NodeNet.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as NodeNet.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** An append-only log file with timestamped lines (sync writes: nothing lost on a crash). */
function openLog(file: string): Log {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  return {
    path: file,
    line: (msg: string) => NodeFS.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`),
  };
}

// ---------------------------------------------------------------------------
// WS RPC CLIENT (Effect RPC, JSON serialization)
// ---------------------------------------------------------------------------

/** Opens the WS with the bearer token; returns call (one reply) and stream (chunks until closed). */
async function connect(url: string, token: string, log: Log): Promise<Rpc> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as never);
  await new Promise<void>((ok, bad) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => bad(new Error(`ws connect to ${url} failed`)));
  });
  log.line(`ws open ${url}`);
  let nextId = 0;
  const calls = new Map<
    string,
    { ok: (v: unknown) => void; bad: (e: Error) => void; tag: string }
  >();
  const streams = new Map<string, EventStream>();
  const send = (frame: Obj) => {
    const raw = JSON.stringify(frame);
    log.line(`send ${raw}`);
    ws.send(raw);
  };
  ws.addEventListener("close", () => {
    log.line("ws closed");
    for (const c of calls.values()) c.bad(new Error("ws closed"));
  });
  ws.addEventListener("message", (ev) => {
    for (const raw of String(ev.data).split("\n").filter(Boolean)) {
      log.line(
        `recv ${raw.length > 20_000 ? `${raw.slice(0, 20_000)}...(${raw.length} chars)` : raw}`,
      );
      const m = JSON.parse(raw) as Obj;
      if (m._tag === "Ping") {
        send({ _tag: "Pong" });
        continue;
      }
      const id = String(m.requestId);
      if (m._tag === "Chunk") {
        send({ _tag: "Ack", requestId: m.requestId });
        streams.get(id)?.push(m.values as Obj[]);
      } else if (m._tag === "Exit") {
        const call = calls.get(id);
        calls.delete(id);
        if (call && m.exit._tag === "Success") call.ok(m.exit.value);
        else if (call)
          call.bad(new Error(`${call.tag} failed: ${JSON.stringify(m.exit.cause).slice(0, 400)}`));
        streams
          .get(id)
          ?.end(
            m.exit._tag === "Success"
              ? "stream ended"
              : `stream failed: ${JSON.stringify(m.exit.cause).slice(0, 300)}`,
          );
      }
    }
  });
  const call = (tag: string, payload: unknown) =>
    new Promise<unknown>((ok, bad) => {
      const id = String(++nextId);
      const timer = setTimeout(() => {
        calls.delete(id);
        bad(new Error(`${tag}: no reply in 60s`));
      }, 60_000);
      const settled =
        <A>(f: (a: A) => void) =>
        (a: A) => {
          clearTimeout(timer);
          f(a);
        };
      calls.set(id, { ok: settled(ok), bad: settled(bad), tag });
      send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  const stream = (tag: string, payload: unknown) => {
    const id = String(++nextId);
    const s = eventStream(() => send({ _tag: "Interrupt", requestId: id }));
    streams.set(id, s);
    send({ _tag: "Request", id, tag, payload, headers: [] });
    return s;
  };
  return { call, stream, close: () => ws.close() };
}

/**
 * The orchestration events of one subscription, in arrival order, with a waiter:
 * waitFor(pred, from) resolves on the first matching item at index >= from.
 */
function eventStream(interrupt: () => void): EventStream {
  const items: Obj[] = [];
  const waiters = new Set<() => void>();
  let ended: string | null = null;
  const wake = () => {
    for (const w of waiters) w();
  };
  return {
    items,
    push: (values) => {
      for (const v of values) if (v.kind === "event") items.push(v.event as Obj);
      wake();
    },
    end: (why) => {
      ended = why;
      wake();
    },
    close: () => {
      if (ended === null) interrupt();
      ended = "closed";
    },
    waitFor: (pred, from, ms, what) =>
      new Promise((resolve, reject) => {
        let i = from;
        const check = () => {
          for (; i < items.length; i++) {
            if (pred(items[i]!)) {
              cleanup();
              resolve({ e: items[i]!, index: i });
              return;
            }
          }
          if (ended !== null) {
            cleanup();
            reject(new Error(`${what}: ${ended}`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out after ${ms / 1000}s waiting for ${what}`));
        }, ms);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      }),
  };
}

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

type Outcome = "PASS" | "FAIL" | "SKIP";

/** A row outcome that is neither pass nor fail (feature not offered, or cannot be checked here). */
class Skip extends Error {}

interface AgentSpec {
  readonly instanceId: string;
  readonly model: string;
  readonly switchTo: string | undefined;
  readonly options: ReadonlyArray<{ id: string; value: unknown }>;
}

interface Row {
  readonly id: string;
  readonly ms: number;
  readonly passes: string;
  readonly run: (ctx: Ctx) => Promise<string>;
}

interface Ctx {
  readonly agent: string;
  readonly spec: AgentSpec;
  readonly rpc: Rpc;
  readonly log: Log;
  readonly server: Server;
  /** The step in progress, named in a timeout reason. */
  step: string;
  /** The row's thread, cleaned up after the row. */
  thread?: Thread | undefined;
}

interface Thread {
  readonly dir: string;
  readonly threadId: string;
  readonly runtimeMode: string;
  readonly events: EventStream;
}

interface Settled {
  readonly status: string;
  readonly lastError: string | null;
  readonly text: string;
  readonly turns: number;
  readonly transitions: string;
  readonly answered: number;
}

interface TurnEnd {
  readonly from: number;
  readonly turnId: string;
  readonly status: string;
  readonly lastError: string | null;
  readonly text: string;
}

interface EventStream {
  readonly items: Obj[];
  push(values: Obj[]): void;
  end(why: string): void;
  close(): void;
  waitFor(
    pred: (e: Obj) => boolean,
    from: number,
    ms: number,
    what: string,
  ): Promise<{ e: Obj; index: number }>;
}

interface Rpc {
  call(tag: string, payload: unknown): Promise<unknown>;
  stream(tag: string, payload: unknown): EventStream;
  close(): void;
}

interface Log {
  readonly path: string;
  line(msg: string): void;
}

interface Server {
  readonly url: string;
  readonly token: string;
  readonly logPath: string | null;
  readonly baseDir: string | null;
  stop(): Promise<void>;
}

interface Flags {
  readonly agents: string[];
  readonly rows: string[] | undefined;
  readonly url: string | undefined;
  readonly token: string | undefined;
  readonly dryRun: boolean;
}

await main();
