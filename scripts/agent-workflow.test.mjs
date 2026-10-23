import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { normalizeAgentWorkflow, restoreAgentWorkflow, extractWorkflowPlan, completedWorkflowPlan, workflowClarifications, planningContext, workflowPlanContext } = await load("agentWorkflow");
const { normalizeConfig } = await load("api");

const clone = value => structuredClone(value);
const bytes = value => Buffer.byteLength(value, "utf8");
const user = (id, text = "Plan this task.") => ({ kind: "user", id, text, images: 0, previews: [] });
const reply = (id, text, final = true) => ({ kind: "text", id, messageId: id, text, final });
const tool = (id, plan, status = "done", name = "ExitPlanMode") => ({ kind: "tool", id, name, input: { plan }, status, output: null, patch: null });
const marked = plan => `<trex_plan>\n${plan}\n</trex_plan>`;
const statuses = ["planning", "waiting", "transferring", "executing", "completed", "paused", "failed"];

test("a delivered user correction after a plan remains a boundary when completion attributes only assistant items", () => {
  const items = [user("initial"), tool("old-plan", "OLD"), user("correction", "Use SQLite instead."), reply("question", "What retention period?")];
  const completion = { id: "done", status: "completed", messageIds: ["initial"], itemIds: ["old-plan", "question"] };
  assert.equal(completedWorkflowPlan(items, completion), null);
  items.push(reply("updated", marked("Use SQLite with 30 day retention.")));
  assert.equal(completedWorkflowPlan(items, { ...completion, itemIds: [...completion.itemIds, "updated"] }), "Use SQLite with 30 day retention.");
});

test("a newer final question invalidates an earlier definitive plan in the same turn", () => {
  assert.equal(extractWorkflowPlan([user("initial"), tool("old", "OLD"), reply("withdraw", "Wait: which database should this use?")]), null);
  assert.equal(extractWorkflowPlan([user("initial"), reply("old", marked("OLD")), reply("withdraw", "I need one more answer before finalizing.")]), null);
});

test("structured answers are retained and establish a new boundary after an older plan", () => {
  const answer = { ...tool("answer", "", "done", "AskUserQuestion"), input: { questions: [{ id: "region", question: "¿Qué región?", header: "Región", options: [] }], answers: { "¿Qué región?": "Lima" } } };
  const items = [user("initial"), tool("old", "OLD"), answer];
  assert.equal(completedWorkflowPlan(items, { id: "done", status: "completed", messageIds: ["initial"], itemIds: ["old", "answer"] }), null);
  assert.match(workflowClarifications(items), /¿Qué región\?\nRespuesta del usuario: Lima/);
  items.push(reply("final", marked("Use the Lima region.")));
  assert.equal(extractWorkflowPlan(items), "Use the Lima region.");
});

test("secret structured answers never enter transferred clarification context", () => {
  const items = [{ ...tool("answer", "", "done", "AskUserQuestion"), input: { questions: [{ id: "password", question: "Contraseña", isSecret: true, options: [] }, { id: "region", question: "Región", options: [] }], answers: { Contraseña: "PRIVATE_VALUE", Región: "Lima" }, response: "PRIVATE_VALUE" } },
    { ...tool("masked", "", "done", "AskUserQuestion"), input: { answers: { Secret: "••••••" } } }];
  const text = workflowClarifications(items);
  assert.match(text, /Lima/);
  assert.doesNotMatch(text, /PRIVATE_VALUE|Contraseña|••••••/);
});

const source = Object.freeze({ sessionId: "t-source", provider: "claude", profileId: "planner-account", profileName: "Planificador personal", title: "Búsqueda 🦖", projectId: "p-trex", projectName: "TREX", cwd: "D:\\projects\\trex" });
const planner = {
  profileId: "planner-account", profileName: "Personal Claude", provider: "claude", model: "claude-opus-5-5",
  launch: { profileId: "planner-account", profileName: "Original planner name", command: "claude-personal", args: "--verbose", shell: "pwsh", launchMode: "arg", env: { CLAUDE_CONFIG_DIR: "D:\\accounts\\personal" } },
};
const executor = {
  profileId: "executor-account", profileName: "Work Codex", provider: "codex", model: "gpt-6.1-sol",
  launch: { profileId: "executor-account", profileName: "Original executor name", command: "codex-work", args: "--sandbox workspace-write", shell: "cmd", launchMode: "inject", env: { CODEX_HOME: "D:\\accounts\\work" } },
};
const workflow = (extra = {}) => ({ id: "workflow_01", role: "planner", status: "planning", planner: clone(planner), executor: clone(executor), peerTabId: "t-peer", plan: { id: "plan_01", sourceLabel: "Personal Claude", pending: true, instruction: "Implement the complete plan." }, error: null, ...extra });

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Spaced, non-secret text must survive sanitation; long base64-like runs do not.
function utf8Payload(size) {
  const unit = "漢🦖 á paso\n";
  const count = Math.floor((size - 1) / bytes(unit));
  return unit.repeat(count) + ".".repeat(size - count * bytes(unit));
}

test("normalization preserves independent accounts, models and original launch snapshots for either role", () => {
  for (const role of ["planner", "executor"]) {
    const raw = freeze(workflow({ role }));
    const normalized = normalizeAgentWorkflow(raw);
    assert.deepEqual(normalized, raw);
    assert.notEqual(normalized.planner.launch.command, normalized.executor.launch.command);
    assert.notEqual(normalized.planner.model, normalized.executor.model);
    assert.notStrictEqual(normalized.planner.launch, raw.planner.launch);
    assert.notStrictEqual(normalized.executor.launch.env, raw.executor.launch.env);
  }
});

test("two profiles of the same provider retain separate account launchers and model choices", () => {
  const raw = workflow();
  raw.executor.provider = "claude";
  raw.executor.model = "claude-sonnet-5-5";
  raw.executor.launch.command = "claude-work";
  raw.executor.launch.env = { CLAUDE_CONFIG_DIR: "D:\\accounts\\work" };
  const result = normalizeAgentWorkflow(raw);
  assert.deepEqual(result.planner, raw.planner);
  assert.deepEqual(result.executor, raw.executor);
  raw.planner.launch.env.CLAUDE_CONFIG_DIR = "D:\\accounts\\replacement";
  raw.executor.launch.command = "replacement-command";
  assert.equal(result.planner.launch.env.CLAUDE_CONFIG_DIR, "D:\\accounts\\personal");
  assert.equal(result.executor.launch.command, "claude-work");
});

test("models can use provider-qualified identifiers or provider defaults without cross-role fallback", () => {
  const raw = workflow();
  raw.planner.model = "  vendor/model:version-1  ";
  raw.executor.model = null;
  const result = normalizeAgentWorkflow(raw);
  assert.equal(result.planner.model, "vendor/model:version-1");
  assert.equal(result.executor.model, null);
  delete raw.executor.model;
  assert.equal(normalizeAgentWorkflow(raw).executor.model, null);
});

test("normalization persists local plan references, never inline plan bodies or arbitrary metadata", () => {
  const raw = workflow({ content: "WORKFLOW_INLINE_BODY", account: "ACCOUNT_METADATA" });
  raw.plan.content = "PLAN_INLINE_BODY";
  raw.plan.history = ["PLAN_HISTORY_BODY"];
  raw.planner.extra = "AGENT_METADATA";
  raw.executor.launch.extra = "LAUNCH_METADATA";
  const result = normalizeAgentWorkflow(raw);
  assert.deepEqual(result.plan, workflow().plan);
  assert.doesNotMatch(JSON.stringify(result), /WORKFLOW_INLINE_BODY|ACCOUNT_METADATA|PLAN_INLINE_BODY|PLAN_HISTORY_BODY|AGENT_METADATA|LAUNCH_METADATA/);
  assert.deepEqual(normalizeAgentWorkflow(JSON.parse(JSON.stringify(result))), result);
});

test("optional malformed peer and plan references are discarded without losing valid agents", () => {
  for (const peerTabId of [undefined, null, "", " ", "../peer", "peer\n", "x".repeat(101), 12, [], {}]) {
    const result = normalizeAgentWorkflow(workflow({ peerTabId }));
    assert.equal(result.peerTabId, null, JSON.stringify(peerTabId));
    assert.deepEqual(result.planner, planner);
  }
  for (const plan of [null, [], {}, { id: "../plan", sourceLabel: "Planner" }, { id: "plan", sourceLabel: " " }, { id: "plan", sourceLabel: "Planner", pending: "true" }, { id: "plan", sourceLabel: "Planner", instruction: {} }]) {
    assert.equal(normalizeAgentWorkflow(workflow({ plan })).plan, null, JSON.stringify(plan));
  }
  assert.equal(normalizeAgentWorkflow(workflow({ plan: { id: "local-plan", sourceLabel: "Planner" } })).plan.pending, false);
});

test("workflow ids and enum fields reject malformed persisted values", () => {
  for (const value of [undefined, null, false, 1, "", [], {}]) assert.equal(normalizeAgentWorkflow(value), null);
  for (const id of [undefined, null, 1, false, [], {}, "", " ", "../workflow", "w:f", "w.f", "w/f", "w\\f", "w\n", "w\0", "ñ", "x".repeat(101)]) {
    assert.equal(normalizeAgentWorkflow(workflow({ id })), null, `id ${JSON.stringify(id)}`);
  }
  for (const role of [undefined, null, "", "reviewer", "Planner", ["planner"]]) assert.equal(normalizeAgentWorkflow(workflow({ role })), null);
  for (const status of [undefined, null, 0, false, "", "running", "Planning", ["planning"], {}]) {
    assert.equal(normalizeAgentWorkflow(workflow({ status })), null, `status ${JSON.stringify(status)}`);
  }
  assert.equal(normalizeAgentWorkflow(workflow({ id: "a".repeat(100), peerTabId: "b".repeat(100) })).id.length, 100);
  for (const status of statuses) assert.equal(normalizeAgentWorkflow(workflow({ status })).status, status);
});

for (const role of ["planner", "executor"]) {
  test(`${role}: incomplete profiles and wrong provider identities are rejected`, () => {
    for (const value of [undefined, null, [], {}, "profile"]) assert.equal(normalizeAgentWorkflow(workflow({ [role]: value })), null);
    const invalid = [
      ["profileId", ""], ["profileId", "   "], ["profileId", null], ["profileId", 4], ["profileId", "x".repeat(201)],
      ["profileName", ""], ["profileName", " \t "], ["profileName", null], ["profileName", 4], ["profileName", "x".repeat(201)],
      ["provider", "shell"], ["provider", "other"], ["provider", null], ["provider", ["claude"]],
    ];
    for (const [key, value] of invalid) {
      const raw = workflow();
      raw[role][key] = value;
      if (key === "profileId") raw[role].launch.profileId = value;
      assert.equal(normalizeAgentWorkflow(raw), null, `${key}: ${JSON.stringify(value)}`);
    }
  });

  test(`${role}: malformed models fail closed instead of silently selecting another model`, () => {
    for (const model of ["", " ", "two models", "model\nargument", "model\targument", "model\0", "model\u007f", "x".repeat(257), 1, true, [], {}]) {
      const raw = workflow();
      raw[role].model = model;
      assert.equal(normalizeAgentWorkflow(raw), null, JSON.stringify(model));
    }
    const raw = workflow();
    raw[role].model = "m".repeat(256);
    assert.equal(normalizeAgentWorkflow(raw)[role].model, raw[role].model);
  });

  test(`${role}: missing or mismatched launch snapshots never fall back to another account`, () => {
    for (const launch of [undefined, null, [], {}, { shell: "pwsh" }, { shell: 1, command: "agent" }, { shell: "pwsh", command: " " }]) {
      const raw = workflow(); raw[role].launch = launch;
      assert.equal(normalizeAgentWorkflow(raw), null, JSON.stringify(launch));
    }
    for (const profileId of [null, undefined, "unrelated-account"]) {
      const raw = workflow(); raw[role].launch.profileId = profileId;
      assert.equal(normalizeAgentWorkflow(raw), null, JSON.stringify(profileId));
    }
  });
}

test("errors and reference labels are sanitized and bounded before persistence", () => {
  const result = normalizeAgentWorkflow(workflow({
    error: `Visible failure.\napi_key: ERROR_SECRET\n${"detalles 🦖 ".repeat(400)}`,
    plan: { id: "plan", sourceLabel: "Planner\npassword: LABEL_SECRET", pending: true, instruction: "Proceed.\naccess_token: INSTRUCTION_SECRET" },
  }));
  assert.ok(result.error.startsWith("Visible failure."));
  assert.ok([...result.error].length <= 1200);
  assert.doesNotMatch(JSON.stringify(result), /ERROR_SECRET|LABEL_SECRET|INSTRUCTION_SECRET/);
  assert.equal(normalizeAgentWorkflow(workflow({ error: { message: "not text" } })).error, null);
});

test("error length limits do not leave an invalid UTF-16 surrogate", () => {
  const result = normalizeAgentWorkflow(workflow({ error: "x" + "🦖".repeat(600) }));
  assert.equal(Buffer.from(result.error, "utf8").toString("utf8"), result.error);
  assert.ok([...result.error].length <= 1200);
});

test("JSON config round trips retain both launch snapshots after profiles are edited or removed", () => {
  const raw = { settings: { profiles: [{ id: "replacement", name: "Replacement account", provider: "codex", command: "other-codex", configDir: "D:\\accounts\\other" }], defaultProfileId: "replacement" },
    ui: { lastTabs: [
      { id: "t-planner", projectId: "p-trex", kind: "claude", chatModel: planner.model, workflow: workflow() },
      { id: "t-executor", projectId: "p-trex", kind: "codex", chatModel: executor.model, workflow: workflow({ role: "executor", status: "executing", peerTabId: "t-planner" }) },
      { id: "t-shell", projectId: "p-trex", kind: "shell", workflow: workflow() },
    ] } };
  const first = normalizeConfig(raw);
  const second = normalizeConfig(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(second.ui.lastTabs, first.ui.lastTabs);
  for (const tab of second.ui.lastTabs.slice(0, 2)) {
    assert.deepEqual(tab.workflow.planner, planner);
    assert.deepEqual(tab.workflow.executor, executor);
    assert.equal(restoreAgentWorkflow(tab.workflow).status, "paused");
  }
  assert.equal(second.ui.lastTabs[2].workflow, null);
});

for (const role of ["planner", "executor"]) {
  test(`${role}: restoration pauses every resumable state without mutating saved metadata or launching work`, () => {
    for (const status of statuses) {
      const saved = freeze(workflow({ role, status, error: "Saved error." }));
      const before = clone(saved);
      const result = restoreAgentWorkflow(saved);
      assert.deepEqual(saved, before);
      assert.equal(result.status, ["completed", "failed"].includes(status) ? status : "paused");
      assert.deepEqual(result.planner, saved.planner);
      assert.deepEqual(result.executor, saved.executor);
      assert.deepEqual(result.plan, saved.plan);
      assert.equal(result.peerTabId, saved.peerTabId);
      assert.equal(result.role, role);
      assert.equal(result.id, saved.id);
      if (["completed", "failed"].includes(status)) assert.equal(result.error, "Saved error.");
      else assert.ok(result.error && result.error !== "Saved error.");
    }
  });
}

test("restoration has no workflow to resume when persisted metadata is absent", () => {
  assert.equal(restoreAgentWorkflow(null), null);
  assert.equal(restoreAgentWorkflow(undefined), null);
});

test("extracts a complete final marked plan, preserving Markdown, code, and Unicode", () => {
  const plan = "# Objetivo 🦖\n\nRevisar src/search.ts.\n\n1. Mantener accesibilidad.\n2. Verificar teclado.\n\n```sh\nnpm test\n```\n\n## Validación\nSin regresiones.";
  assert.equal(extractWorkflowPlan([user("task"), reply("final", ` \r\n${marked(plan)}\r\n `)]), plan);
  assert.equal(extractWorkflowPlan([reply("completion-only", marked(plan))]), plan, "live completion subsets need no copied user item");
});

test("extracts a completed structured ExitPlanMode plan without requiring visible markup", () => {
  assert.equal(extractWorkflowPlan([user("task"), tool("final-plan", "  # Plan\n\nImplement and test.  ")]), "# Plan\n\nImplement and test.");
  assert.equal(extractWorkflowPlan([tool("completion-only", "Full structured plan.")]), "Full structured plan.");
});

test("only the current user turn can contribute a final plan", () => {
  const old = [user("old"), reply("old-markup", marked("OLD_MARKUP")), tool("old-structured", "OLD_STRUCTURED")];
  assert.equal(extractWorkflowPlan([...old, user("current")]), null);
  assert.equal(extractWorkflowPlan([...old, user("current"), reply("question", "Which database should we use?")]), null);
  assert.equal(extractWorkflowPlan([...old, user("current"), reply("new", marked("CURRENT_PLAN"))]), "CURRENT_PLAN");
  assert.equal(extractWorkflowPlan([...old, user("current"), tool("new", "CURRENT_STRUCTURED")]), "CURRENT_STRUCTURED");
});

test("thinking, user examples, notices, permission requests, and unrelated tool output cannot become plans", () => {
  const items = [user("task", marked("USER_EXAMPLE")),
    { ...reply("thought", marked("THINKING")), kind: "thinking" },
    { kind: "notice", id: "notice", tone: "info", text: marked("NOTICE") },
    { kind: "permission", id: "permission", toolName: "ExitPlanMode", toolUseId: "permission", input: { plan: "PENDING_PERMISSION" }, description: marked("PERMISSION"), suggestions: [], state: "pending" },
    { ...tool("read", "READ_INPUT", "done", "Read"), output: marked("READ_OUTPUT") },
  ];
  assert.equal(extractWorkflowPlan(items), null);
  assert.equal(extractWorkflowPlan([user("task"), reply("stream", marked("STILL_STREAMING"), false)]), null);
});

test("only successful, nonempty structured final plans qualify", () => {
  for (const status of ["running", "error"]) assert.equal(extractWorkflowPlan([user("task"), tool("not-done", "NOT_FINAL", status)]), null, status);
  for (const plan of [undefined, null, "", " \n\t ", 4, [], {}]) assert.equal(extractWorkflowPlan([tool("bad-plan", plan)]), null, JSON.stringify(plan));
  assert.equal(extractWorkflowPlan([]), null);
});

test("plan selection respects the newest definitive candidate across text and structured representations", () => {
  assert.equal(extractWorkflowPlan([tool("old-tool", "OLD"), reply("new-text", marked("NEW"))]), "NEW");
  assert.equal(extractWorkflowPlan([reply("old-text", marked("OLD")), tool("new-tool", "NEW")]), "NEW");
  assert.equal(extractWorkflowPlan([reply("old-text", marked("OLD")), reply("new-text", marked("NEW"))]), "NEW");
  assert.equal(extractWorkflowPlan([tool("old-tool", "OLD"), tool("new-tool", "NEW")]), "NEW");
});

test("incomplete, empty, nested or ambiguous markup is never a definitive plan", () => {
  for (const text of [
    "<trex_plan>unfinished", "unfinished</trex_plan>", "<trex_plan", "<trex_plan></trex_plan>", "<trex_plan> \n\t </trex_plan>",
    "<trex_plan>outer\n<trex_plan>inner</trex_plan>",
    "<trex_plan>outer\n<trex_plan>inner</trex_plan>\n</trex_plan>",
    `${marked("FIRST")}\n${marked("SECOND")}`,
  ]) assert.equal(extractWorkflowPlan([reply("bad-markup", text)]), null, JSON.stringify(text));
  assert.equal(extractWorkflowPlan([reply("start", "<trex_plan>partial"), reply("end", "rest</trex_plan>")]), null);
});

test("quoted examples and surrounding non-plan prose do not authorize automatic implementation", () => {
  for (const text of [
    `Example only:\n\`\`\`xml\n${marked("EXAMPLE")}\n\`\`\``,
    `~~~xml\n${marked("EXAMPLE")}\n~~~`,
    "`<trex_plan>EXAMPLE</trex_plan>`", "> <trex_plan>EXAMPLE</trex_plan>",
    "<!-- <trex_plan>COMMENT</trex_plan> -->", `<environment_context>${marked("ENV_EXAMPLE")}</environment_context>`,
    `Draft only; please answer my question.\n${marked("DRAFT")}`, `${marked("OLD")}\nWithdrawn: which database should we use?`,
  ]) assert.equal(extractWorkflowPlan([reply("example", text)]), null, JSON.stringify(text));
});

const sensitive = [
  "VISIBLE_START: mantener la navegación.",
  "<environment_context>ENVIRONMENT_LEAK</environment_context>",
  "<credentials>CREDENTIALS_LEAK</credentials>",
  "<permission_context>PERMISSION_LEAK</permission_context>",
  "<auth_info>AUTH_LEAK</auth_info>",
  "-----BEGIN PRIVATE KEY-----\nPRIVATE_MATERIAL_LEAK\n-----END PRIVATE KEY-----",
  "api_key: API_VALUE_LEAK", "authorization: Bearer BEARER_VALUE_LEAK", "password=PASSWORD_VALUE_LEAK",
  "curl --token CLI_VALUE_LEAK", "ACCOUNT_ENV=ENV_VALUE_LEAK",
  "Visit https://user:URL_PASSWORD_LEAK@example.test/path",
  "sk-ant-ABCDEFGHIJKLMN0123456789", "ghp_ABCDEFGHIJKLMNOPQRST0123456789",
  "data:image/png;base64,ATTACHMENT_LEAK", "AQID".repeat(100),
  "<!-- trex-handoff:old-context -->",
  "\u001b[31mVISIBLE_MIDDLE: revisar src/search.ts.\u001b[0m\0",
  "VISIBLE_END: ejecutar npm test. 🦖",
].join("\n");

function assertSanitized(content) {
  for (const sentinel of ["VISIBLE_START", "VISIBLE_MIDDLE", "VISIBLE_END", "src/search.ts", "npm test", "🦖"]) assert.ok(content.includes(sentinel), sentinel);
  assert.doesNotMatch(content, /ENVIRONMENT_LEAK|CREDENTIALS_LEAK|PERMISSION_LEAK|AUTH_LEAK|PRIVATE_MATERIAL_LEAK|API_VALUE_LEAK|BEARER_VALUE_LEAK|PASSWORD_VALUE_LEAK|CLI_VALUE_LEAK|ENV_VALUE_LEAK|URL_PASSWORD_LEAK|ATTACHMENT_LEAK|sk-ant-ABCDEFGHIJKLMN|ghp_ABCDEFGHIJKLMNOPQRST|AQIDAQIDAQID/);
  assert.doesNotMatch(content, /\u001b|\u0000|<!--\s*trex-handoff/);
  assert.equal(Buffer.from(content, "utf8").toString("utf8"), content);
}

test("both plan extraction formats sanitize sensitive text while retaining the usable complete plan", () => {
  assertSanitized(extractWorkflowPlan([reply("final", marked(sensitive))]));
  assertSanitized(extractWorkflowPlan([tool("final", sensitive)]));
});

test("planning and implementation contexts sanitize task, plan and original request independently", () => {
  assertSanitized(planningContext(sensitive, source).content);
  assertSanitized(workflowPlanContext(sensitive, "Original request.", source).content);
  assertSanitized(workflowPlanContext("A clean complete plan.", sensitive, source).content);
});

test("contexts preserve source metadata, creation time and honest completeness counters", () => {
  for (const from of [source, Object.freeze({ ...source, provider: "codex", profileId: null, profileName: "Codex account" })]) {
    const before = Date.now();
    const planning = planningContext("Revisar búsqueda.", from);
    const implementing = workflowPlanContext("1. Revisar.\n2. Probar.", "Revisar búsqueda.", from);
    const after = Date.now();
    for (const [result, messageCount] of [[planning, 1], [implementing, 2]]) {
      assert.deepEqual(result.source, from);
      assert.ok(Number.isSafeInteger(result.createdAt) && result.createdAt >= before && result.createdAt <= after);
      assert.equal(result.messageCount, messageCount);
      assert.equal(result.truncated, false);
      assert.equal(result.imagesOmitted, 0);
    }
    assert.match(planning.content, /Revisar búsqueda\./);
    assert.match(implementing.content, /1\. Revisar\.\n2\. Probar\./);
    assert.match(implementing.content, /Revisar búsqueda\./);
  }
});

test("tasks accept exactly 24 KiB of sanitized UTF-8 and reject larger multibyte input", () => {
  const task = utf8Payload(24 * 1024);
  assert.equal(bytes(task), 24 * 1024);
  assert.ok(task.length < bytes(task), "the fixture exercises bytes, not string length");
  const result = planningContext(task, source);
  assert.ok(result.content.endsWith(task));
  assert.equal(result.truncated, false);
  assert.throws(() => planningContext(task + ".", source), /24/);
  assert.throws(() => planningContext(task + "🦖", source), /24/);
  const smallerTask = utf8Payload(24 * 1024 - 100);
  assert.ok(planningContext(`${smallerTask}\n<credentials>${"hidden ".repeat(5000)}</credentials>`, source).content.includes(smallerTask), "redaction precedes the size check");
});

test("empty and control-only tasks or plans fail instead of producing runnable empty contexts", () => {
  for (const text of ["", " \r\n\t ", "\0\u0001", "\u001b[31m\u001b[0m"]) {
    assert.throws(() => planningContext(text, source));
    assert.throws(() => workflowPlanContext(text, "Original request.", source));
  }
});

test("the 64 KiB implementation limit includes the full original request and context envelope", () => {
  const original = "Solicitud original: mantener accesibilidad 🦖.";
  const envelope = bytes(workflowPlanContext("x", original, source).content) - bytes("x");
  const plan = utf8Payload(64 * 1024 - envelope);
  const result = workflowPlanContext(plan, original, source);
  assert.equal(bytes(result.content), 64 * 1024);
  assert.ok(result.content.includes(plan));
  assert.ok(result.content.endsWith(original));
  assert.equal(result.truncated, false);
  assert.throws(() => workflowPlanContext(plan + ".", original, source), /64/);
  assert.throws(() => workflowPlanContext(plan, original + "🦖", source), /64/);
  assert.throws(() => workflowPlanContext("A short plan.", utf8Payload(64 * 1024), source), /64/);
});

test("a large valid plan retains its beginning, middle and end instead of becoming an excerpt", () => {
  const plan = `BEGIN_COMPLETE_PLAN\n${utf8Payload(22000)}\nMIDDLE_COMPLETE_PLAN\n${utf8Payload(22000)}\nEND_COMPLETE_PLAN`;
  const extracted = extractWorkflowPlan([reply("full", marked(plan))]);
  assert.equal(extracted, plan);
  const result = workflowPlanContext(extracted, "Original task.", source);
  assert.ok(result.content.includes(plan));
  assert.equal(result.truncated, false);
  assert.doesNotMatch(result.content, /contenido anterior o intermedio omitido/);
  const oversized = `${plan}\n${utf8Payload(24000)}\nLAST_REQUIRED_STEP`;
  assert.equal(extractWorkflowPlan([tool("oversized", oversized)]), oversized, "extraction itself never silently clips a final plan");
  assert.throws(() => workflowPlanContext(oversized, "Original task.", source), /64/);
});

test("captured project state is excluded while the original user request stays complete", () => {
  const original = "Solicitud original completa.\n\nConservar todos los proyectos.";
  const captured = "\n\n---\n## Estado del proyecto capturado por TREX\nSTALE_PROJECT_CAPTURE";
  const result = workflowPlanContext("Complete implementation plan.", original + captured, source);
  assert.ok(result.content.includes(original));
  assert.doesNotMatch(result.content, /STALE_PROJECT_CAPTURE/);
  assert.equal(result.truncated, false);
});
