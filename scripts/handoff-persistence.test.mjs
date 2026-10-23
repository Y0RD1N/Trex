import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

const helpers = { ...await load("handoff"), ...await load("agentWorkflow"), ...await load("agentRoom") };
const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Exercise the actual creation/save boundaries without mounting native sessions.
function initializer(name, values) {
  let expression;
  function visit(node) {
    if (!expression && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression, `${name} is present`);
  const { outputText } = ts.transpileModule(`const result = ${expression.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const scope = { ...helpers, ...values };
  return new Function(...Object.keys(scope), `${outputText}\nreturn result;`)(...Object.values(scope));
}

test("new handoff references redact next-step credentials before entering tab state", () => {
  const reference = initializer("reference", {
    handoffDialog: { prepared: { id: "handoff-audit", sourceLabel: "Claude 1" } },
    instruction: "Conserva el buscador.\napi_key=AUDIT_FAKE_ONLY\nValida el teclado.",
  });
  assert.equal(reference.pending, true);
  assert.equal(reference.id, "handoff-audit");
  assert.match(reference.instruction, /Conserva el buscador/);
  assert.match(reference.instruction, /Valida el teclado/);
  assert.doesNotMatch(JSON.stringify(reference), /AUDIT_FAKE_ONLY/);
});

test("escaped nested JSON credentials are redacted before creating a handoff reference", () => {
  for (let depth = 0; depth < 4; depth++) {
    let credential = { api_key: "AUDIT_ESCAPED_FAKE" };
    for (let index = 0; index <= depth; index++) credential = JSON.stringify(credential);
    const reference = initializer("reference", {
      handoffDialog: { prepared: { id: "handoff-escaped", sourceLabel: "TREX1" } },
      instruction: `Conserva la validación.\n${credential}\nVerifica el resultado.`,
    });
    assert.doesNotMatch(JSON.stringify(reference), /AUDIT_ESCAPED_FAKE/);
    assert.match(reference.instruction, /Verifica el resultado/);
  }
});

test("tab persistence redacts pending and consumed handoff references without dropping their identity", () => {
  const tabs = [true, false].map((pending, index) => ({
    id: `tab-${index}`, projectId: "project", kind: "claude", subtitle: "Chat",
    handoff: { id: `handoff-${index}`, sourceLabel: "Claude 1", pending,
      instruction: "Continúa la tarea.\npassword=AUDIT_PERSISTED_FAKE\nComprueba los cambios.",
      content: "UNEXPECTED_TRANSCRIPT", apiKey: "UNEXPECTED_CREDENTIAL_FIELD" },
    env: {},
  }));
  const saved = initializer("persistedTabsKey", { tabs });
  assert.doesNotMatch(saved, /AUDIT_PERSISTED_FAKE|UNEXPECTED_TRANSCRIPT|UNEXPECTED_CREDENTIAL_FIELD/);
  const parsed = JSON.parse(saved);
  assert.deepEqual(parsed.map(tab => tab.handoff.pending), [true, false]);
  assert.deepEqual(parsed.map(tab => tab.handoff.id), ["handoff-0", "handoff-1"]);
  assert.match(parsed[0].handoff.instruction, /Continúa la tarea/);
  assert.match(parsed[0].handoff.instruction, /Comprueba los cambios/);
});

test("multiline assignments and escaped URL credentials are redacted at both tab boundaries", () => {
  for (const secret of [
    '{"api_key":\n "AUDIT_MULTILINE_FAKE"}',
    '+  "api_key":\r\n+    "AUDIT_MULTILINE_FAKE"',
    '+  "api_key":\n+  \n+    "AUDIT_MULTILINE_FAKE"',
    '   "api_key":\n-    "AUDIT_MULTILINE_FAKE_OLD",\n+    "AUDIT_MULTILINE_FAKE_NEW",',
    'password:\n  AUDIT_MULTILINE_FAKE',
    String.raw`{"url":"https:\/\/user:AUDIT_URL_FAKE@example.test/"}`,
    String.raw`{"url":"https:\\\/\\\/user:AUDIT_URL_FAKE@example.test/"}`,
  ]) {
    const instruction = `Mantén la tarea.\n${secret}\nNO_BORRAR_DATOS`;
    const reference = initializer("reference", {
      handoffDialog: { prepared: { id: "handoff-variants", sourceLabel: "TREX1" } }, instruction,
    });
    assert.doesNotMatch(JSON.stringify(reference), /AUDIT_MULTILINE_FAKE|AUDIT_URL_FAKE/);
    assert.match(reference.instruction, /NO_BORRAR_DATOS/);
    const saved = initializer("persistedTabsKey", { tabs: [true, false].map(pending => ({
      id: "tab", projectId: "project", kind: "trex", env: {},
      handoff: { id: "handoff-variants", sourceLabel: "TREX1", pending, instruction },
    })) });
    assert.doesNotMatch(saved, /AUDIT_MULTILINE_FAKE|AUDIT_URL_FAKE/);
    assert.ok(JSON.parse(saved).every(tab => tab.handoff.instruction.endsWith("NO_BORRAR_DATOS")));
  }
});

test("redaction cannot displace safe instructions and instruction caps keep Unicode intact", () => {
  const instruction = 'ABC=x\n'.repeat(150) + 'Paso seguro. '.repeat(200) + 'NO_BORRAR_DATOS';
  assert.ok(Buffer.byteLength(instruction) < 4000);
  const makeReference = instruction => initializer("reference", {
    handoffDialog: { prepared: { id: "handoff-bounds", sourceLabel: "TREX1" } }, instruction,
  });
  const reference = makeReference(instruction);
  assert.ok(reference.instruction.endsWith("NO_BORRAR_DATOS"));
  assert.ok(Buffer.byteLength(reference.instruction) <= Buffer.byteLength(instruction));
  for (const input of ["a".repeat(3999) + "🦖", "漢😀".repeat(2000)]) {
    const bounded = makeReference(input).instruction;
    assert.equal(bounded, Buffer.from(bounded, "utf8").toString("utf8"));
    assert.ok(Buffer.byteLength(bounded) <= 4000);
  }
});

test("workflow and room errors are sanitized on save while identities and live phases survive", () => {
  const agent = (provider, profileId) => ({ profileId, profileName: profileId, provider, model: "selected", effort: "high",
    launch: { profileId, profileName: profileId, command: provider, args: "", shell: "pwsh", launchMode: "arg", env: {} } });
  const planner = agent("claude", "planner"), executor = agent("codex", "executor");
  const workflow = { id: "workflow-safe", role: "planner", status: "planning", planner, executor, error: "api_key=AUDIT_WORKFLOW_FAKE" };
  const agentRoom = { id: "room-safe", active: "executor", phase: "executing", cycle: 2, order: ["planner::first", "executor::second"],
    planner: { agent: planner, conversationId: null, mode: "plan" },
    executor: { agent: executor, conversationId: "22222222-2222-4222-8222-222222222222", mode: "auto" },
    error: "password=AUDIT_ROOM_FAKE" };
  const saved = initializer("persistedTabsKey", { tabs: [{ id: "tab", projectId: "project", kind: "claude", env: {}, workflow, agentRoom }] });
  assert.doesNotMatch(saved, /AUDIT_WORKFLOW_FAKE|AUDIT_ROOM_FAKE/);
  const tab = JSON.parse(saved)[0];
  assert.equal(tab.workflow.id, "workflow-safe");
  assert.equal(tab.workflow.status, "planning");
  assert.equal(tab.agentRoom.phase, "executing");
  assert.equal(tab.agentRoom.executor.conversationId, agentRoom.executor.conversationId);
  assert.deepEqual(tab.agentRoom.order, agentRoom.order);
});
