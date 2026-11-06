import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { newTokens, newTokenParts, usageTotals, addUsageTotals, subtractUsageTotals, costLabel, claudeApiUsage, codexApiUsage, readApiUsage } = await load("tokenUsage");
const { modelTier, suggestModel, suggestEffort, closestEffort } = await load("modelTiers");
const { teamBudgetUse, budgetRefusal, budgetRemaining, budgetNote, raisedBudget, budgetExhausted } = await load("teamBudget");
const { accountQuota, observeUsage, compactionNeeded, requestCompaction, teamUsageReport, teamUsageView, accountGroups } = await load("teamUsage");
const { normalizeAgentTeam, teamBrowserDefault, teamMemberUsesBrowser, teamGitSnapshot, teamInstruction, TEAM_COORDINATOR_POLICY } = await load("agentTeam");

const agent = provider => ({ profileId: provider, profileName: provider + " cuenta", provider, model: null, effort: null, launch: { profileId: provider, profileName: provider + " cuenta", command: provider, args: null, shell: "powershell", launchMode: "arg", env: null } });
const member = (id, provider, role, canWrite = false) => ({ id, name: id, role, canWrite, instructions: "Do " + role, agent: agent(provider), conversationId: null });
const team = () => ({ id: "team-x", epoch: "epoch-1", phase: "running", master: member("principal", "claude", "coordinator"), workers: [member("impl", "codex", "implementation", true), member("rev", "claude", "review")], order: [], initial: null, error: null });
const usage = newTokens => ({ newTokens, cacheReadTokens: 0, outputTokens: 0, costUsd: null, requests: null });

test("new tokens exclude cache reads for every provider's counting convention", () => {
  // Anthropic: cache reads/writes are apart from input; writes are new work.
  assert.equal(newTokens(claudeApiUsage({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300 })), 330);
  // El desglose de lo nuevo suma lo mismo y separa la escritura de caché.
  assert.deepEqual(newTokenParts(claudeApiUsage({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300 })), { input: 10, cacheWrite: 300, output: 20 });
  assert.deepEqual(newTokenParts(readApiUsage({ inputTokens: 150, outputTokens: 30, totalTokens: 180, cachedReadTokens: 80 })), { input: 70, cacheWrite: 0, output: 30 }, "cache hits counted inside input are left out");
  assert.equal(newTokenParts(null), null);
  // Codex: the cached part is already removed from input.
  assert.equal(newTokens(codexApiUsage({ inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 300, totalTokens: 5300 })), 1300);
  // OpenAI-compatible (Trex CLI): cache hits are inside input and the total does not add them again.
  assert.equal(newTokens(readApiUsage({ inputTokens: 150, outputTokens: 30, totalTokens: 180, cachedReadTokens: 80 })), 100);
  // Gemini thoughts reported outside output still count as generated.
  assert.equal(newTokens(readApiUsage({ inputTokens: 13138, outputTokens: 6, thoughtTokens: 80, totalTokens: 13224, cachedReadTokens: 0 })), 13224);
  assert.equal(newTokens(readApiUsage({ totalTokens: 42 })), 42);
  assert.equal(newTokens(null), null);
});

test("usage totals add, subtract and never present a missing cost as free", () => {
  const a = usageTotals(claudeApiUsage({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000 }));
  assert.deepEqual(a, { newTokens: 30, cacheReadTokens: 1000, outputTokens: 20, costUsd: null, requests: null });
  const b = { ...a, costUsd: 0.5, requests: 2 };
  assert.deepEqual(addUsageTotals(a, b), { newTokens: 60, cacheReadTokens: 2000, outputTokens: 40, costUsd: 0.5, requests: 2 });
  assert.deepEqual(subtractUsageTotals(addUsageTotals(a, b), a), { newTokens: 30, cacheReadTokens: 1000, outputTokens: 20, costUsd: 0.5, requests: 2 });
  assert.equal(subtractUsageTotals(a, a), null);
  assert.equal(costLabel(null), null);
  assert.match(costLabel(0.0123), /0,0123/);
});

test("model tiers follow names, cheap words win and only featured models are suggested", () => {
  for (const [id, tier] of [["claude-haiku-4-5", "cheap"], ["gpt-5.1-codex-mini", "cheap"], ["o4-mini", "cheap"], ["gemini-2.5-flash-lite", "cheap"], ["grok-code-fast-1", "cheap"],
    ["opus", "strong"], ["gpt-5.1-codex-max", "strong"], ["gemini-2.5-pro", "strong"], ["fable", "strong"], ["deepseek-reasoner", "strong"],
    ["sonnet", "mid"], ["gpt-5.1-codex", "mid"], ["deepseek-chat", "mid"], ["gemini-2.5", "mid"]]) assert.equal(modelTier(id), tier, id);
  assert.equal(modelTier("x-1", "Claude Haiku"), "cheap");
  const model = (value, efforts, featured = true) => ({ value, resolvedModel: value, displayName: value, description: "", efforts, featured });
  const claude = [model("default", ["low", "medium", "high"]), model("fable", ["low", "medium", "high", "max"]), model("opus", ["low", "medium", "high", "max"]), model("sonnet", ["low", "medium", "high"]), model("haiku", []), model("tiny-preview", ["low"], false)];
  assert.equal(suggestModel(claude, "coordinator"), "fable");
  assert.equal(suggestModel(claude, "implementation"), "default");
  assert.equal(suggestModel(claude, "review"), "sonnet");
  assert.equal(suggestModel(claude, "research"), "haiku");
  assert.equal(suggestModel(claude, "custom"), "");
  assert.equal(suggestEffort(claude, "fable", "coordinator"), "high");
  assert.equal(suggestEffort(claude, "haiku", "research"), null);
  assert.equal(suggestEffort(claude, "sonnet", "fix"), "medium");
  assert.equal(suggestEffort(claude, null, "implementation"), null);
  const codex = [model("gpt-5.1-codex", ["low", "medium", "high"]), model("gpt-5.1-codex-max", ["medium", "high", "xhigh"]), model("gpt-5.1-codex-mini", ["medium", "high"])];
  assert.equal(suggestModel(codex, "implementation"), "");
  assert.equal(suggestModel(codex, "coordinator"), "gpt-5.1-codex-max");
  assert.equal(suggestModel(codex, "research"), "gpt-5.1-codex-mini");
  assert.equal(suggestEffort(codex, "gpt-5.1-codex-mini", "research"), "medium");
  assert.equal(closestEffort(["minimal", "high"], "medium"), "high");
  assert.equal(closestEffort(["low", "high"], "medium"), "low");
  assert.equal(closestEffort(["none", "high"], "low"), "high");
});

test("budgets count new tokens per team and member and refuse only when exhausted", () => {
  const t = { ...team(), budget: { teamTokens: 1000, memberTokens: 300 }, usage: { principal: usage(400), impl: usage(300) } };
  const use = teamBudgetUse(t);
  assert.deepEqual(use.team, { used: 700, limit: 1000, remaining: 300 });
  assert.deepEqual(use.members.principal, { used: 400, limit: null, remaining: null });
  assert.match(budgetRefusal(t, "impl"), /^Presupuesto agotado: impl/);
  assert.equal(budgetRefusal(t, "rev"), null);
  assert.equal(budgetRemaining(t, "rev"), 300);
  assert.match(budgetRefusal({ ...t, usage: { principal: usage(1200) } }, "rev"), /el equipo ha usado/);
  assert.equal(budgetRefusal(team(), "impl"), null);
  assert.equal(budgetNote(null), "");
  assert.match(budgetNote(12345), /12\.345 tokens; trabaja de forma económica/);
  assert.equal(raisedBudget(250000), 500000);
  assert.equal(raisedBudget(2000000), 4000000);
  assert.ok(budgetExhausted("Presupuesto agotado: x"));
});

test("account quotas use the general 5 h and weekly windows and block near the limit", () => {
  const plan = percent => ({ plan: "Max", windows: [{ id: "session", label: "Sesión (5 h)", percent, resetsAt: 1000, severity: "normal", headline: true },
    { id: "weekly_all", label: "Semana", percent: 40, resetsAt: null, severity: "normal", headline: false }, { id: "weekly_opus", label: "Semana · Opus", percent: 100, resetsAt: null, severity: "critical", headline: false }], extra: null, resetCredits: 0 });
  assert.deepEqual(accountQuota("k", "Cuenta", plan(80)), { key: "k", label: "Cuenta", fiveHour: { percent: 80, resetsAt: 1000 }, week: { percent: 40, resetsAt: null }, peak: 80, blocked: false });
  assert.equal(accountQuota("k", "Cuenta", plan(98)).blocked, true);
  assert.equal(accountQuota("k", "Cuenta", null), null);
  assert.deepEqual(accountGroups([{ id: "a", profileId: "p", profileName: "P" }, { id: "b", profileId: "q", profileName: "Q" }, { id: "c", profileId: "p", profileName: "P" }]).map(group => group.members.map(m => m.id)), [["a", "c"], ["b"]]);
});

test("usage observation charges only turns, never restored history", () => {
  const base = { apiUsage: null, pendingTurns: 0, turnStartedAt: null, historyCount: 0 };
  let seen = observeUsage(undefined, base).next;
  const history = { ...base, historyCount: 3, apiUsage: readApiUsage({ inputTokens: 50000, outputTokens: 1000, totalTokens: 51000 }) };
  let result = observeUsage(seen, history); assert.equal(result.delta, null); seen = result.next;
  result = observeUsage(seen, { ...history, pendingTurns: 1 }); seen = result.next; assert.equal(result.delta, null);
  result = observeUsage(seen, { ...history, pendingTurns: 0, apiUsage: readApiUsage({ inputTokens: 50400, outputTokens: 1100, totalTokens: 51500 }) });
  assert.equal(result.delta.newTokens, 500);
  // A fresh session without history counts from its first measurement.
  const fresh = observeUsage(observeUsage(undefined, { ...base, pendingTurns: 1 }).next, { ...base, pendingTurns: 1, apiUsage: readApiUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) });
  assert.equal(fresh.delta.newTokens, 15);
  // A restored conversation's first figure is history, even during a turn.
  const restored = observeUsage({ usage: null, active: true }, { ...base, historyCount: 2, pendingTurns: 1, apiUsage: readApiUsage({ inputTokens: 90000, outputTokens: 1, totalTokens: 90001 }) });
  assert.equal(restored.delta, null);
});

test("compaction is requested only for sessions with history and a large context", () => {
  const state = (used, window = 100000, historyCount = 1) => ({ usage: { used, window, parts: [], reserve: null, total: null }, historyCount, items: [] });
  assert.equal(compactionNeeded(state(40000)), null);
  assert.deepEqual(compactionNeeded(state(50000)), { percent: 50, tokens: 50000 });
  assert.deepEqual(compactionNeeded(state(130000, 1000000)), { percent: 13, tokens: 130000 });
  assert.equal(compactionNeeded(state(90000, 100000, 0)), null);
  const calls = [];
  const session = (provider, extra = {}) => ({ provider, runCommand: name => { calls.push([provider, name]); return provider !== "antigravity"; }, send: text => { calls.push([provider, "send", text]); return Promise.resolve(true); }, ...extra });
  assert.equal(requestCompaction(session("trex")), false);
  assert.equal(requestCompaction(session("trex", { supportsCompact: true })), true);
  assert.equal(requestCompaction(session("codex")), true);
  assert.equal(requestCompaction(session("claude")), true);
  assert.equal(requestCompaction(session("antigravity")), false);
  assert.deepEqual(calls, [["trex", "compact"], ["codex", "compact"], ["claude", "send", "/compact"]]);
});

test("browser access and Git context follow each role, with explicit overrides", () => {
  assert.equal(teamBrowserDefault("coordinator", true), false);
  assert.equal(teamBrowserDefault("research", false), true);
  assert.equal(teamBrowserDefault("implementation", true), true);
  assert.equal(teamBrowserDefault("fix", true), true);
  assert.equal(teamBrowserDefault("review", false), true);
  assert.equal(teamBrowserDefault("review", true), false);
  assert.equal(teamBrowserDefault("custom", false), false);
  assert.equal(teamBrowserDefault("custom", true), true);
  assert.equal(teamMemberUsesBrowser({ role: "research", canWrite: false, browser: false }), false);
  assert.equal(teamMemberUsesBrowser({ role: "coordinator", canWrite: false, browser: true }), true);
  assert.deepEqual(["research", "review", "implementation", "fix", "custom", "validation"].map(role => teamGitSnapshot({ role })), ["none", "stat", "status", "status", "status", "status"]);
});

test("saved teams keep budget, usage ledger and browser choices; older teams load unchanged", () => {
  const raw = { ...team(), budget: { teamTokens: 500000, memberTokens: null }, usage: { impl: usage(1200), ghost: usage(5) } };
  raw.workers[1].browser = false;
  const saved = normalizeAgentTeam(raw);
  assert.deepEqual(saved.budget, { teamTokens: 500000, memberTokens: null });
  assert.deepEqual(Object.keys(saved.usage), ["impl"]);
  assert.equal(saved.workers[1].browser, false);
  assert.deepEqual(normalizeAgentTeam(JSON.parse(JSON.stringify(saved))), saved);
  const old = normalizeAgentTeam(team());
  assert.equal("budget" in old, false); assert.equal("usage" in old, false); assert.equal("browser" in old.workers[0], false);
  assert.equal(normalizeAgentTeam({ ...team(), budget: { teamTokens: -5 } }).budget, null);
  const invalid = team(); invalid.workers[0].browser = "yes";
  assert.equal(normalizeAgentTeam(invalid), null);
});

test("coordinator guidance points to the trex_team tools, which forbid polling (rules said once)", () => {
  const text = teamInstruction(team());
  assert.match(text, /descripciones de las herramientas trex_team/);
  assert.doesNotMatch(text, /No consultes en bucle|waitMs/);
  assert.doesNotMatch(TEAM_COORDINATOR_POLICY, /poll|dependsOn|wait:false/);
  assert.match(TEAM_COORDINATOR_POLICY, /following their descriptions/);
});

test("the usage report for the coordinator tools carries budget, usage, context and quotas", () => {
  const t = { ...team(), budget: { teamTokens: 250000, memberTokens: null }, usage: { impl: usage(1200) } };
  const states = { impl: { usage: { used: 30000, window: 100000, parts: [], reserve: null, total: null }, plan: { plan: null, windows: [{ id: "codex:primary", label: "Sesión (5 h)", percent: 76, resetsAt: 5, severity: "warning", headline: true }], extra: null, resetCredits: 0 } } };
  const view = teamUsageView(t, states, {});
  assert.equal(view.total.newTokens, 1200);
  const report = teamUsageReport(t, view, true);
  assert.deepEqual(report.budget, { teamTokens: 250000 });
  const impl = report.members.find(entry => entry.memberId === "impl");
  assert.deepEqual(impl, { memberId: "impl", coordinator: false, usage: usage(1200), contextPercent: 30, browser: true,
    account: { key: "codex", label: "codex cuenta", fiveHour: { percent: 76, resetsAt: 5 }, blocked: false } });
  assert.equal(report.members[0].browser, false);
  assert.equal("browser" in teamUsageReport(t, view, false).members[1], false);
});
