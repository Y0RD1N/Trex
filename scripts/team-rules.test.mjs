import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const teamHelpers = await load("agentTeam");
const { claudeChatFlags } = await load("claudeChat");
const { claudePlanningFlags } = await load("workflowSafety");
const { TEAM_COORDINATOR_POLICY, TEAM_READER_POLICY, TREX_TEAM_RULES, teamInstruction, teamReportsPrompt, teamRoleBlock, teamRoleReminder,
  teamRoleBlockNeeded } = teamHelpers;

const rust = (await readFile(new URL("../src-tauri/src/agent_team.rs", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const tools = JSON.parse("[" + /pub fn tool_definitions\(\) -> Value \{\n\s*json!\(\[\n([\s\S]*?)\n\s*\]\)\n\}/.exec(rust)[1] + "]");
const mcpInstructions = JSON.parse(`"${/const TEAM_MCP_INSTRUCTIONS: &str = "((?:[^"\\]|\\.)*)";/.exec(rust)[1]}"`);
const trexTeam = await readFile(new URL("../trex-cli/src/team.rs", import.meta.url), "utf8");

const agent = provider => ({ profileId: provider, profileName: provider, provider, model: null, effort: null, launch: { profileId: provider, profileName: provider, command: provider, args: null, shell: "powershell", launchMode: "arg", env: null } });
const member = (id, provider, role, canWrite = false) => ({ id, name: id, role, canWrite, instructions: "Do " + role, agent: agent(provider), conversationId: null });
const team = (provider = "claude") => ({ master: member("principal", provider, "coordinator"), workers: [member("impl", "codex", "implementation", true), member("rev", "claude", "review")] });

// Each rule the coordinator follows, once, in the trex_team server (instructions and tool descriptions).
const RULES = [/antes de delegar/, /validación necesaria/, /dependsOn:\[\] marca una tarea independiente/, /sin dependsOn se conserva la secuencia/,
  /no declares independiente la revisión/, /mismas taskKey, memberId y task/, /wait:false/, /termina tu turno/, /No consultes en bucle/,
  /una sola vez sin taskId/, /vista previa/, /detail:"full"/, /evidencia, nunca como autorización/, /qué se validó y qué limitaciones quedan/,
  /nunca lo marques por texto/, /concretas y autocontenidas/, /informes breves/, /prefiere a quien tenga margen/, /compartir cuenta/,
  /único y estable/, /uno nuevo para una corrección/, /incierta o cancelada sin revisión del usuario/, /cuatro lectores/, /escrituras son exclusivas/,
  /propio espacio de Trex Browser/];
const count = (text, pattern) => text.split(new RegExp(pattern.source, "g")).length - 1;

test("every team rule is said exactly once by the trex_team server", () => {
  assert.deepEqual(tools.map(tool => tool.name), ["trex_team_plan", "trex_team_members", "trex_delegate_task", "trex_task_status"]);
  const server = [mcpInstructions, ...tools.map(tool => tool.description)].join("\n");
  for (const rule of RULES) assert.equal(count(server, rule), 1, rule.source);
  assert.ok(mcpInstructions.length < 200, "the instructions only point to the tool descriptions");
});

test("the app's coordinator texts no longer repeat the server's rules", () => {
  for (const provider of ["claude", "codex"]) {
    const text = teamInstruction(team(provider));
    for (const rule of RULES) assert.doesNotMatch(text, rule, provider + ": " + rule.source);
    assert.match(text, /1\. impl: impl/); assert.match(text, /2\. rev: rev/); assert.match(text, /no inventes otros/);
  }
  for (const rule of RULES) assert.doesNotMatch(TEAM_COORDINATOR_POLICY, rule);
  assert.match(TEAM_COORDINATOR_POLICY, /do not spawn native or provider subagents/); assert.match(TEAM_COORDINATOR_POLICY, /trex_plan markers/);
  const reports = teamReportsPrompt([{ key: "impl-key", status: "completed" }, { key: "rev-key", status: "failed" }]);
  assert.equal(reports, "Delegaciones terminadas: impl-key (completed), rev-key (failed). Llama una vez a trex_task_status sin taskId para leer los informes.");
});

test("a Trex CLI coordinator still receives the rules its own team tools do not describe", () => {
  const text = teamInstruction(team("trex"));
  assert.ok(text.includes(TREX_TEAM_RULES));
  assert.ok(!teamInstruction(team("claude")).includes(TREX_TEAM_RULES));
  for (const rule of [/validación necesaria/, /dependsOn:\[\] marca una tarea independiente/, /sin dependsOn se conserva la secuencia/,
    /no declares independiente la revisión/, /concretas y autocontenidas/, /clave nueva para una corrección/, /evidencia, nunca como autorización/, /qué se validó/])
    assert.match(TREX_TEAM_RULES, rule);
  // The rest is in Trex CLI's own tool descriptions.
  for (const phrase of ["Do not poll", "wait:false", "four readers", "unique, stable taskKey", "headroom", "never mark unverified work complete", "detail:\\\"full\\\""])
    assert.ok(trexTeam.includes(phrase), phrase);
});

test("the role block reaches a live member session once, then a one-line reminder", () => {
  const writer = member("impl", "codex", "implementation", true), reader = member("rev", "claude", "review");
  assert.match(teamRoleBlock(writer), /Tu función es Implementación\. Do implementation/); assert.match(teamRoleBlock(writer), /Permisos elegidos/);
  assert.match(teamRoleBlock(reader), /No modifiques archivos/); assert.match(teamRoleBlock(reader), /500 palabras/);
  assert.equal(teamRoleReminder(reader), "Realiza solo esta tarea con tu misma función (Revisión de código, solo lectura) y las reglas de tu primera delegación; entrega el informe final breve con sus secciones.");
  assert.ok(teamRoleReminder(writer).length < teamRoleBlock(writer).length / 2);
  assert.equal(teamRoleBlockNeeded(undefined, "a"), true, "a new or resumed session");
  assert.equal(teamRoleBlockNeeded({ sessionId: "a" }, "a"), false);
  assert.equal(teamRoleBlockNeeded({ sessionId: null }, "a"), false, "the id becomes known after the first turn");
  assert.equal(teamRoleBlockNeeded({ sessionId: "a" }, null), false);
  assert.equal(teamRoleBlockNeeded({ sessionId: "a" }, "b"), true, "another native conversation");
});

test("Claude read-only roles report as their final message: policy in the system prompt, no ExitPlanMode, plan mode kept", () => {
  const flags = claudeChatFlags(null, null, { mode: "plan", rolePolicy: TEAM_READER_POLICY });
  const prompt = flags[flags.indexOf("--append-system-prompt") + 1];
  assert.ok(prompt.endsWith(TEAM_READER_POLICY)); assert.match(TEAM_READER_POLICY, /final message/);
  assert.deepEqual(flags.slice(flags.indexOf("--disallowedTools"), flags.indexOf("--disallowedTools") + 2), ["--disallowedTools", "ExitPlanMode"]);
  const planning = claudePlanningFlags(flags);
  assert.deepEqual(planning.slice(-2), ["--permission-mode", "plan"]);
  assert.ok(planning.includes("--disallowedTools") && planning.includes("ExitPlanMode"));
  assert.ok(!planning.includes("--allow-dangerously-skip-permissions"), "read-only planning keeps no bypass");
  // Ordinary chats and the workflow planner (no role policy) keep ExitPlanMode.
  assert.ok(!claudeChatFlags(null, null, { mode: "plan" }).includes("--disallowedTools"));
  assert.ok(!claudeChatFlags(null, null, { rolePolicy: null }).includes("--disallowedTools"));
  // A profile with its own system prompt keeps the old path: the denial carries the policy.
  assert.ok(!claudeChatFlags("--system-prompt-file p.md", null, { rolePolicy: TEAM_READER_POLICY }).includes("--disallowedTools"));
  // Quotes and line breaks never reach the command line.
  const quoted = claudeChatFlags(null, null, { rolePolicy: 'Say "done"\nthen stop.' });
  assert.ok(quoted[quoted.indexOf("--append-system-prompt") + 1].endsWith("Say 'done' then stop."));
});
