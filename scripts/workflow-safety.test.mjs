import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const safety = await load("workflowSafety");
const { claudeChatFlags } = await load("claudeChat");
const { codexLaunch, turnOverrides } = await load("codexChat");
const { claudePlanningArgs, claudePlanningFlags, claudePlanningExitResponse, assertClaudePlanningMode,
  codexPlanningThread, assertCodexPlanningThread, codexPlanningTurn } = safety;

test("Claude planners remove repeated modes and both bypass flags, regardless of order or quoting", () => {
  for (const args of [
    '--permission-mode bypassPermissions --dangerously-skip-permissions --permission-mode=acceptEdits --allow-dangerously-skip-permissions',
    '--dangerously-skip-permissions --permission-mode "plan" "--permission-mode"=default --allow-dangerously-skip-permissions=true',
    "'--permission-mode=bypassPermissions' '--dangerously-skip-permissions' '--allow-dangerously-skip-permissions'",
  ]) {
    assert.equal(claudePlanningArgs(args, true), null);
    const flags = claudePlanningFlags(claudeChatFlags(args, "saved", { mode: "bypassPermissions" }));
    assert.deepEqual(flags.slice(-2), ["--permission-mode", "plan"]);
    assert.equal(flags.filter(flag => flag === "--permission-mode").length, 1);
    assert.ok(!flags.includes("--dangerously-skip-permissions"));
    assert.ok(!flags.includes("--allow-dangerously-skip-permissions"));
    assert.deepEqual(claudePlanningFlags(flags), flags);
  }
});

test("Claude argument normalization preserves unrelated arguments and their original quoting", () => {
  const keep = String.raw`--model 'claude-opus-5-5' --effort high --add-dir "C:\my work\project" --settings '{"x":"y z"}' --append-system-prompt 'keep --permission-mode bypassPermissions here' --agent ""`;
  const args = `--permission-mode=bypassPermissions ${keep} --dangerously-skip-permissions`;
  assert.equal(claudePlanningArgs(args, true), keep);
  assert.equal(claudePlanningArgs(keep, true), keep);
  assert.equal(claudePlanningArgs(null, true), null);
  assert.equal(claudePlanningArgs("  ", true), null);
  assert.equal(claudePlanningArgs('--append-system-prompt "--permission-mode" --permission-mode plan', true), '--append-system-prompt "--permission-mode"');
});

test("Claude normalization respects POSIX escaping as well as Windows literal backslashes", () => {
  const keep = String.raw`--append-system-prompt "say \"--permission-mode bypassPermissions\"" --add-dir '/tmp/a b'`;
  assert.equal(claudePlanningArgs(`${keep} --permission-mode default`, false), keep);
  const windows = String.raw`--add-dir "C:\one two\three" --model opus`;
  assert.equal(claudePlanningArgs(`${windows} --permission-mode default`, true), windows);
  assert.equal(claudePlanningArgs(String.raw`--permission\-mode bypassPermissions --model opus`, false), '--model opus');
});

test("Claude malformed arguments fail closed instead of silently changing their meaning", () => {
  for (const args of ['--model "unclosed', "--model 'unclosed", '--permission-mode', '--permission-mode --model opus', '-- --dangerously-skip-permissions']) {
    assert.throws(() => claudePlanningArgs(args, true), /comilla|Falta|después de --/);
  }
});

test("Claude resume and edit/reset keep safe options intact without reserializing Windows paths", () => {
  const keep = String.raw`--model opus --add-dir 'C:\one two\three' --append-system-prompt 'a "quoted" prompt'`;
  const args = `--resume old --permission-mode acceptEdits ${keep} --fork-session --session-id=other --resume-session-at before`;
  const resumed = claudePlanningArgs(args, true);
  assert.ok(resumed.startsWith('--resume old '));
  assert.ok(resumed.includes('--session-id=other'));
  assert.equal(claudePlanningArgs(args, true, true), keep);
  assert.equal(claudePlanningArgs(claudePlanningArgs(args, true, true), true, true), keep);
  const flags = claudePlanningFlags(claudeChatFlags(resumed, "saved", { model: "selected-model", effort: "high", mode: "plan" }));
  assert.deepEqual(flags.slice(-2), ['--permission-mode', 'plan']);
  assert.equal(flags[flags.indexOf('--model') + 1], 'selected-model');
  assert.equal(flags[flags.indexOf('--effort') + 1], 'high');
  assert.ok(!flags.includes('--resume'), 'el perfil sigue eligiendo la conversación al reanudar');
});

test("Claude generated flag normalization preserves flag-like system-prompt values", () => {
  const flags = ['--append-system-prompt', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', 'acceptEdits'];
  const snapshot = [...flags];
  assert.deepEqual(claudePlanningFlags(flags), ['--append-system-prompt', '--dangerously-skip-permissions', '--permission-mode', 'plan']);
  assert.deepEqual(flags, snapshot);
  const restricted = claudePlanningArgs('--restricted --permission-mode bypassPermissions', true);
  assert.ok(!claudePlanningFlags(claudeChatFlags(restricted, null)).includes('--allow-dangerously-skip-permissions'));
});

test("Claude must confirm its actual plan mode, even if the UI requested plan", () => {
  assert.doesNotThrow(() => assertClaudePlanningMode('plan'));
  for (const mode of [null, undefined, 'default', 'acceptEdits', 'bypassPermissions']) {
    assert.throws(() => assertClaudePlanningMode(mode), /no confirmó el modo plan/);
  }
});

test("ExitPlanMode is refused without interrupting and asks for the final tagged automatic handoff", () => {
  const line = JSON.parse(claudePlanningExitResponse('request-42'));
  assert.equal(line.type, 'control_response');
  assert.equal(line.response.subtype, 'success');
  assert.equal(line.response.request_id, 'request-42');
  const response = line.response.response;
  assert.equal(response.behavior, 'deny');
  assert.match(response.message, /handed automatically to a separate executor/);
  assert.match(response.message, /<trex_plan> and <\/trex_plan>/);
  assert.match(response.message, /final response/);
  assert.equal(response.interrupt, undefined);
  assert.equal(response.updatedPermissions, undefined);
});

test("Codex thread planning settings override unsafe profiles and preserve model, cwd and MCP config", () => {
  const unsafe = codexLaunch('--yolo -m custom-model').thread;
  const original = { ...unsafe, cwd: 'D:/project', developerInstructions: 'Existing instructions',
    config: { sandbox_mode: 'danger-full-access', approval_policy: 'never', include_collaboration_mode_instructions: false,
      mcp_servers: { inbox: { command: 'reader' } }, model_reasoning_effort: 'high' } };
  const snapshot = structuredClone(original);
  const safe = codexPlanningThread(original);
  assert.equal(safe.sandbox, 'read-only');
  assert.equal(safe.approvalPolicy, 'on-request');
  assert.equal(safe.model, 'custom-model');
  assert.equal(safe.cwd, 'D:/project');
  assert.equal(safe.config.sandbox_mode, 'read-only');
  assert.equal(safe.config.approval_policy, 'on-request');
  assert.equal(safe.config.include_collaboration_mode_instructions, true);
  assert.deepEqual(safe.config.mcp_servers, original.config.mcp_servers);
  assert.equal(safe.config.model_reasoning_effort, 'high');
  assert.ok(safe.developerInstructions.startsWith('Existing instructions\n\n'));
  assert.match(safe.developerInstructions, /<trex_plan>/);
  assert.deepEqual(codexPlanningThread(safe), safe);
  assert.deepEqual(original, snapshot);
});

test("Codex rejects thread responses that ignored planning permission overrides", () => {
  assert.doesNotThrow(() => assertCodexPlanningThread({ sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request' }));
  assert.doesNotThrow(() => assertCodexPlanningThread({ sandbox: 'read-only', approvalPolicy: 'on-request' }));
  assert.doesNotThrow(() => assertCodexPlanningThread({ sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'on-request' }));
  for (const response of [{}, { sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' },
    { sandbox: { type: 'readOnly' }, approvalPolicy: 'never' }]) {
    assert.throws(() => assertCodexPlanningThread(response), /no confirmó sandbox/);
  }
});

test("Codex planning turns repair the existing writable plan defaults and preserve selected model/effort/speed", () => {
  const selected = { mode: 'plan', model: 'selected-custom-model', effort: 'high', fast: true };
  const overrides = turnOverrides(selected, { model: 'different-default', effort: 'low', fastTier: 'priority' });
  assert.equal(overrides.sandboxPolicy.type, 'workspaceWrite');
  const snapshot = structuredClone(overrides);
  const safe = codexPlanningTurn(overrides, selected.model, selected.effort);
  assert.deepEqual(safe.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(safe.approvalPolicy, 'on-request');
  assert.equal(safe.serviceTier, 'priority');
  assert.equal(safe.model, 'selected-custom-model');
  assert.equal(safe.effort, 'high');
  assert.deepEqual(safe.collaborationMode, { mode: 'plan', settings: {
    model: 'selected-custom-model', reasoning_effort: 'high', developer_instructions: null,
  } });
  assert.deepEqual(overrides, snapshot);
});

test("Codex cannot silently run a planning turn without knowing its model", () => {
  for (const model of [null, '', ' ', 'two models', '\n', 'm'.repeat(257)]) {
    assert.throws(() => codexPlanningTurn({}, model, null), /No se conoce el modelo/);
  }
  const overrides = turnOverrides({ mode: 'plan', model: null, effort: null }, { model: null, effort: null });
  assert.equal(overrides.collaborationMode, undefined);
  const safe = codexPlanningTurn(overrides, 'server-resolved-model', null);
  assert.equal(safe.collaborationMode.mode, 'plan');
  assert.equal(safe.collaborationMode.settings.model, 'server-resolved-model');
  assert.equal(safe.collaborationMode.settings.reasoning_effort, null);
});
