import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { accountUsageWindows, parseClaudeUsage, claudeRateLimitUsage, parseCodexUsage } = await load("planUsage");

test("el visor de Claude conserva el uso general aunque un modelo tenga un límite mayor", () => {
  const usage = parseClaudeUsage({ rate_limits: { limits: [
    { kind: "session", percent: 33 }, { kind: "weekly_all", percent: 71 },
    { kind: "weekly_scoped", group: "weekly", scope: { label: "Opus" }, percent: 92, severity: "critical" },
  ] } });
  const { session, weekly } = accountUsageWindows(usage);
  assert.equal(session.percent, 33);
  assert.equal(weekly.percent, 71);
  assert.equal(usage.windows.find(window => window.percent === 92).severity, "critical");
});

test("los eventos de Claude actualizan los valores visibles antes que los aliases anteriores", () => {
  const usage = parseClaudeUsage({ rate_limits: { limits: [
    { kind: "five_hour", percent: 10 }, { kind: "seven_day", percent: 20 },
  ] } });
  const updated = claudeRateLimitUsage(usage, { unifiedWindows: {
    five_hour: { utilization: 0.35 }, seven_day: { utilization: 0.8 },
  } });
  assert.equal(accountUsageWindows(updated).session.percent, 35);
  assert.equal(accountUsageWindows(updated).weekly.percent, 80);
});

test("las ventanas de Codex se identifican por duración aunque cambien de slot", () => {
  const usage = parseCodexUsage({ rateLimits: { limitId: "codex",
    primary: { usedPercent: 24, windowDurationMins: 10080 },
    secondary: { usedPercent: 80, windowDurationMins: 300 },
  } });
  assert.equal(accountUsageWindows(usage).session.percent, 80);
  assert.equal(accountUsageWindows(usage).weekly.percent, 24);
});

test("un límite de modelo o una duración desconocida no se presenta como uso general", () => {
  const unknown = parseCodexUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 27 } } });
  assert.deepEqual(accountUsageWindows(unknown), { session: null, weekly: null });
  const model = parseCodexUsage({ rateLimits: { limitId: "model-bucket",
    primary: { usedPercent: 92, windowDurationMins: 300 }, secondary: { usedPercent: 98, windowDurationMins: 10080 },
  } });
  assert.deepEqual(accountUsageWindows(model), { session: null, weekly: null });
  assert.deepEqual(accountUsageWindows(null), { session: null, weekly: null });
});
