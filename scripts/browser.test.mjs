import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

// Pure production helpers: tool modes, WSL paths and the files tools return. No native
// process, browser, provider, network connection, or build is started here.
const browser = await load("browser");
const { browserMode, browserConfigForShell, chromeChatLabel,
  browserArtifacts, browserResultArtifacts, browserToolResultText } = browser;
const { claudeProfilePermissionMode } = await load("workflowSafety");
const offlineTest = (name, fn) => test(name, { timeout: 10000 }, fn);

const nativeConfig = Object.freeze({ command: "C:\\Program Files\\Trex\\trex.exe",
  args: Object.freeze(["mcp", "--cwd", "D:\\work\\with spaces", "--mode", "full", "literal;$() --flag"]) });

offlineTest("chat labels for Your browser respect UTF-8 limits without splitting Unicode characters", () => {
  assert.equal(chromeChatLabel("🦖".repeat(100)), "🦖".repeat(25));
  assert.equal(new TextEncoder().encode(chromeChatLabel("🦖".repeat(100))).length, 100);
  assert.equal(chromeChatLabel("Claude Code ·\n  Revisar\tla web "), "Claude Code · Revisar la web");
  for (const empty of ["", "\n\r", null, undefined]) assert.equal(chromeChatLabel(empty), undefined, JSON.stringify(empty));
});
const sha256 = "0123456789abcdef".repeat(4);
const core = Object.freeze({ artifactId: "A0b1c2d3-1234-4567-8910-AbCdEf012345", sha256,
  mimeType: "image/png", bytes: 2048, width: 640, height: 480, kind: "screenshot",
  projectId: "project-1", profile: "BROWSER27", createdAt: "2026-10-24T12:00:00Z" });
const expectedCore = { id: core.artifactId, sha256, mimeType: "image/png", sizeBytes: 2048,
  width: 640, height: 480, kind: "screenshot", storage: "broker",
  provenance: { projectId: "project-1", profile: "BROWSER27" } };
const cli = Object.freeze({ id: "local-content-hash", sha256, mimeType: "image/png", sizeBytes: 2048,
  width: 640, height: 480, kind: "image", storage: "local",
  provenance: Object.freeze({ brokerArtifactId: core.artifactId, projectId: "project-1", profile: "BROWSER27",
    tool: Object.freeze({ name: "browser_take_screenshot", operationId: "op-original" }) }) });

offlineTest("permission modes map to trusted browser modes, with planning always observe", () => {
  for (const [mode, expected] of [
    ["plan", "observe"], ["read-only", "observe"], ["full", "full"], ["bypassPermissions", "full"],
    ["default", "qa"], ["acceptEdits", "qa"], ["dontAsk", "qa"], ["workspace-write", "qa"],
    ["qa", "qa"], ["unknown-mode", "qa"], ["", "qa"], [null, "qa"], [undefined, "qa"],
  ]) {
    assert.equal(browserMode(mode), expected, String(mode));
    assert.equal(browserMode(mode, true), "observe", `planning: ${mode}`);
  }
});

offlineTest("Claude profile permission flags use separate and equals arguments on native and POSIX shells", () => {
  for (const windows of [true, false]) {
    for (const [args, expected] of [
      ["--permission-mode plan", "plan"], ["--permission-mode=plan", "plan"],
      ['--model "model with spaces" --permission-mode "plan"', "plan"],
      ["--permission-mode bypassPermissions", "bypassPermissions"],
      ["--permission-mode=bypassPermissions", "bypassPermissions"],
      ["--permission-mode acceptEdits", "acceptEdits"], ["--permission-mode=default", "default"],
    ]) assert.equal(claudeProfilePermissionMode(args, windows), expected, `${windows}: ${args}`);
  }
});

offlineTest("Claude dangerous permission activation is distinct from merely allowing the flag", () => {
  for (const windows of [true, false]) {
    for (const args of ["--dangerously-skip-permissions",
      "--permission-mode plan --dangerously-skip-permissions",
      "--dangerously-skip-permissions --permission-mode=plan"]) {
      assert.equal(claudeProfilePermissionMode(args, windows), "bypassPermissions", `${windows}: ${args}`);
    }
    assert.equal(claudeProfilePermissionMode("--allow-dangerously-skip-permissions", windows), null);
    assert.equal(claudeProfilePermissionMode("--allow-dangerously-skip-permissions --permission-mode plan", windows), "plan");
  }
});

offlineTest("quoted permission names in Claude prompt and configuration values are ordinary values", () => {
  for (const windows of [true, false]) {
    for (const flag of ["--system-prompt", "--append-system-prompt", "--settings", "--mcp-config"]) {
      for (const quote of ['"', "'"]) {
        for (const value of ["--permission-mode plan", "--permission-mode=plan",
          "--permission-mode=bypassPermissions", "--dangerously-skip-permissions"]) {
          const args = `${flag} ${quote}${value}${quote}`;
          assert.equal(claudeProfilePermissionMode(args, windows), null, `${windows}: ${args}`);
        }
      }
    }
    assert.equal(claudeProfilePermissionMode('--system-prompt="--permission-mode=plan"', windows), null);
    assert.equal(claudeProfilePermissionMode('--append-system-prompt="--dangerously-skip-permissions"', windows), null);
  }
});

offlineTest("actual Claude permission flags win over misleading prompt text in either argument order", () => {
  for (const windows of [true, false]) {
    for (const [prompt, flag, expected] of [
      ['--system-prompt "--permission-mode plan"', "--permission-mode bypassPermissions", "bypassPermissions"],
      ['--append-system-prompt "--dangerously-skip-permissions"', "--permission-mode=plan", "plan"],
      ['--system-prompt "--permission-mode=bypassPermissions"', "--permission-mode plan", "plan"],
    ]) {
      for (const args of [`${prompt} ${flag}`, `${flag} ${prompt}`]) {
        assert.equal(claudeProfilePermissionMode(args, windows), expected, `${windows}: ${args}`);
      }
    }
  }
});

offlineTest("absent and invalid Claude profile permissions never invent a launch mode", () => {
  for (const windows of [true, false]) {
    for (const args of [null, "", " \t\n", "--model sonnet", "--permission-mode", "--permission-mode=",
      "--permission-mode unknown", "--permission-mode PLAN", '--system-prompt "Please discuss plan and bypassPermissions"']) {
      assert.equal(claudeProfilePermissionMode(args, windows), null, `${windows}: ${args}`);
    }
  }
});

offlineTest("Claude flags after the end-of-options marker are prompt arguments", () => {
  for (const windows of [true, false]) {
    assert.equal(claudeProfilePermissionMode("-- --permission-mode plan", windows), null);
    assert.equal(claudeProfilePermissionMode("--permission-mode plan -- --dangerously-skip-permissions", windows), "plan");
  }
});

offlineTest("WSL converts drive and verbatim executable paths without rewriting or splitting arguments", () => {
  for (const [command, expected] of [
    ["C:\\Program Files\\Trex\\trex.exe", "/mnt/c/Program Files/Trex/trex.exe"],
    ["D:/apps/Trex/browser.exe", "/mnt/d/apps/Trex/browser.exe"],
    ["\\\\?\\E:\\apps\\Trex Apps\\browser.exe", "/mnt/e/apps/Trex Apps/browser.exe"],
  ]) {
    const config = Object.freeze({ command, args: nativeConfig.args });
    assert.deepEqual(browserConfigForShell(config, "wsl"), { command: expected, args: nativeConfig.args });
    assert.equal(config.command, command);
  }
});

offlineTest("native shells, relative commands, POSIX paths and UNC commands retain their values", () => {
  for (const shell of ["default", "powershell", "cmd", "bash", "zsh"]) {
    assert.deepEqual(browserConfigForShell(nativeConfig, shell), nativeConfig);
  }
  for (const command of ["trex", "/usr/local/bin/trex", "C:relative.exe", "\\\\server\\share\\browser.exe"]) {
    const config = { command, args: nativeConfig.args };
    assert.deepEqual(browserConfigForShell(config, "wsl"), config);
  }
});

offlineTest("core artifact metadata is normalized without retaining image bytes or host paths", () => {
  assert.deepEqual(browserArtifacts([{ ...core, data: "private-image-payload", path: "C:/private/image.png", token: "private-token" }]), [expectedCore]);
  assert.deepEqual(browserArtifacts([{ ...core, bytes: 0 }]), [{ ...expectedCore, sizeBytes: 0 }]);
  assert.deepEqual(browserArtifacts([{ ...core, sha256: sha256.toUpperCase() }]), [{ ...expectedCore, sha256: sha256.toUpperCase() }]);
});

offlineTest("CLI artifact metadata preserves local storage and exact nested provenance", () => {
  assert.deepEqual(browserArtifacts([cli]), [cli]);
});

offlineTest("CLI opaque IDs containing colon and dot survive metadata unchanged", () => {
  const id = "broker:Capture.Mixed_CASE-01";
  assert.deepEqual(browserArtifacts([{ ...cli, id, storage: "broker", provenance: { brokerArtifactId: id } }]),
    [{ ...cli, id, storage: "broker", provenance: { brokerArtifactId: id } }]);
});

offlineTest("CLI metadata-only diagnostics with an absent checksum remain visible", () => {
  const metadata = { id: "cpu-profile-id", sha256: "", mimeType: "application/json", sizeBytes: 456,
    kind: "cpu-profile", storage: "broker", provenance: { brokerArtifactId: "cpu-profile-id" } };
  assert.deepEqual(browserArtifacts([metadata]), [metadata]);
});

// What the worker gives agents (forAgent/modelView): no checksum, no size, no provenance.
const lean = Object.freeze({ artifactId: core.artifactId, kind: "screenshot", mimeType: "image/png", width: 640, height: 480 });
const expectedLean = { id: core.artifactId, mimeType: "image/png", width: 640, height: 480, kind: "screenshot", storage: "broker",
  provenance: { projectId: undefined, profile: undefined } };

offlineTest("lean agent artifacts (no sha256, no size) are accepted", () => {
  assert.deepEqual(browserArtifacts([lean]), [expectedLean]);
  const [artifact] = browserArtifacts([lean]);
  assert.equal(Object.hasOwn(artifact, "sha256"), false);
  assert.equal(Object.hasOwn(artifact, "sizeBytes"), false);
  // Video and diagnostics carry no dimensions.
  assert.deepEqual(browserArtifacts([{ artifactId: "vid-1", kind: "video", mimeType: "video/webm" }]).map(item => [item.id, item.kind, item.mimeType]), [["vid-1", "video", "video/webm"]]);
  // A mix of lean and full shapes keeps both, in order.
  assert.deepEqual(browserArtifacts([lean, core]), [expectedLean, expectedCore]);
});

offlineTest("lean artifacts are found in every envelope the Claude, Codex and Antigravity adapters pass", () => {
  const view = { ok: true, tabs: 1, revision: 4, artifacts: [lean] };
  for (const raw of [
    { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view },    // Codex item.result / Antigravity rawOutput
    { content: [{ type: "text", text: JSON.stringify(view) }] },                              // Claude tool_result content
    { content: JSON.stringify(view) },                                                         // Claude tool_result with a plain string
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view }),
    { structuredContent: view },
  ]) {
    const found = browserResultArtifacts(raw);
    assert.deepEqual(found.map(item => item.id), [core.artifactId], JSON.stringify(raw).slice(0, 60));
  }
});

offlineTest("an artifact that omits the checksum or size is fine, one that sends them malformed is dropped", () => {
  assert.deepEqual(browserArtifacts([{ ...lean, sizeBytes: 12 }]), [{ ...expectedLean, sizeBytes: 12 }]);
  assert.deepEqual(browserArtifacts([{ ...lean, sha256 }]), [{ ...expectedLean, sha256 }]);
  for (const bad of [{ sha256: 42 }, { sha256: null }, { sha256: "g".repeat(64) }, { sizeBytes: -1 }, { sizeBytes: "12" }, { bytes: 1.5 }, { mimeType: undefined }, { artifactId: "../x" }]) {
    assert.deepEqual(browserArtifacts([{ ...lean, ...bad }]), [], JSON.stringify(bad));
  }
});

offlineTest("artifact parsing drops malformed required metadata while retaining valid siblings", () => {
  const invalid = [null, false, 123, "artifact", [], {},
    { ...cli, id: "" }, { ...cli, id: "../outside" }, { ...cli, id: "a/b" }, { ...cli, id: "a\\b" },
    { ...cli, id: "a b" }, { ...cli, id: "x".repeat(257) },
    { ...cli, sha256: "g".repeat(64) }, { ...cli, sha256: "a".repeat(63) }, { ...cli, sha256: 42 },
    { ...cli, mimeType: 42 }, { ...cli, mimeType: "x".repeat(129) },
    { ...cli, sizeBytes: -1 }, { ...cli, sizeBytes: 1.5 }, { ...cli, sizeBytes: "2048" },
    { ...cli, sizeBytes: Number.MAX_SAFE_INTEGER + 1 }, { ...cli, sizeBytes: NaN }, { ...cli, sizeBytes: Infinity }];
  for (const item of invalid) assert.deepEqual(browserArtifacts([item, cli]), [cli]);
  for (const value of [null, undefined, {}, "[]", 0, true]) assert.deepEqual(browserArtifacts(value), []);
});

offlineTest("empty and malformed MIME metadata is rejected", () => {
  for (const mimeType of ["", "image", "/png", "image/", "image/png\n", "image/ png", "text/plain;secret=value"]) {
    assert.deepEqual(browserArtifacts([{ ...cli, mimeType }]), [], JSON.stringify(mimeType));
  }
});

offlineTest("invalid optional dimensions do not become rendered artifact dimensions", () => {
  const { width, height, ...withoutDimensions } = cli;
  for (const dimension of [-1, 0, NaN, Infinity, 1.5, "640", null]) {
    assert.deepEqual(browserArtifacts([{ ...cli, width: dimension, height: dimension }]), [withoutDimensions], String(dimension));
  }
});

offlineTest("artifact parsing bounds metadata to the first 32 candidates", () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({ ...cli, id: `artifact-${index}` }));
  assert.deepEqual(browserArtifacts(candidates), candidates.slice(0, 32));
  assert.deepEqual(browserArtifacts([...Array(32).fill(null), cli]), []);
});

offlineTest("result metadata is read from core, CLI and JSON-text envelopes", () => {
  for (const raw of [
    { artifacts: [core] }, { structuredContent: { artifacts: [core] } },
    { content: [{ type: "text", text: JSON.stringify({ artifacts: [core] }) }] },
    { content: [{ type: "text", text: JSON.stringify({ structuredContent: { artifacts: [core] } }) }] },
  ]) assert.deepEqual(browserResultArtifacts(raw), [expectedCore]);
  assert.deepEqual(browserResultArtifacts({ text: "captured", artifacts: [cli], structuredContent: { artifacts: [core] } }), [cli]);
  assert.deepEqual(browserResultArtifacts({ artifacts: [{}], structuredContent: { artifacts: [core] } }), [expectedCore]);
});

offlineTest("JSON-text metadata remains discoverable when structured metadata is empty or invalid", () => {
  const content = [{ type: "text", text: JSON.stringify({ artifacts: [core] }) }];
  for (const structuredContent of [{}, { artifacts: [] }, { artifacts: [{}] }]) {
    assert.deepEqual(browserResultArtifacts({ structuredContent, content }), [expectedCore]);
  }
});

offlineTest("whole JSON-string tool results extract core, CLI, structuredContent and content metadata", () => {
  for (const [envelope, expected] of [
    [{ artifacts: [core] }, [expectedCore]],
    [{ artifacts: [cli] }, [cli]],
    [{ structuredContent: { artifacts: [core] } }, [expectedCore]],
    [{ structuredContent: { artifacts: [cli] } }, [cli]],
    [{ content: [{ type: "text", text: JSON.stringify({ artifacts: [core] }) }] }, [expectedCore]],
    [{ content: [{ type: "text", text: JSON.stringify({ structuredContent: { artifacts: [core] } }) }] }, [expectedCore]],
  ]) assert.deepEqual(browserResultArtifacts(JSON.stringify(envelope)), expected);
});

offlineTest("whole JSON-string envelopes preserve metadata precedence and fallback", () => {
  assert.deepEqual(browserResultArtifacts(JSON.stringify({
    artifacts: [cli], structuredContent: { artifacts: [core] },
  })), [cli]);
  for (const artifacts of [[], [{}]]) {
    assert.deepEqual(browserResultArtifacts(JSON.stringify({
      artifacts, structuredContent: { artifacts: [core] },
    })), [expectedCore]);
  }
  const content = [{ type: "text", text: JSON.stringify({ artifacts: [core] }) }];
  for (const structuredContent of [{}, { artifacts: [] }, { artifacts: [{}] }]) {
    assert.deepEqual(browserResultArtifacts(JSON.stringify({ structuredContent, content })), [expectedCore]);
  }
});

offlineTest("whole JSON-string parsing accepts the exact size bound and skips larger valid envelopes", () => {
  const emptyPadding = JSON.stringify({ artifacts: [core], padding: "" });
  const atBound = JSON.stringify({ artifacts: [core], padding: "x".repeat(262144 - emptyPadding.length) });
  const overBound = JSON.stringify({ artifacts: [core], padding: "x".repeat(262145 - emptyPadding.length) });
  assert.equal(atBound.length, 262144);
  assert.equal(overBound.length, 262145);
  assert.deepEqual(browserResultArtifacts(atBound), [expectedCore]);
  assert.deepEqual(browserResultArtifacts(overBound), []);
});

offlineTest("whole JSON-string parsing rejects malformed JSON and ordinary text", () => {
  const valid = JSON.stringify({ artifacts: [core] });
  for (const raw of ["", " \n\t", "ordinary browser text", "{broken JSON", valid.slice(0, -1),
    `${valid} trailing text`, `captured: ${valid}`, `\`\`\`json\n${valid}\n\`\`\``]) {
    assert.deepEqual(browserResultArtifacts(raw), [], JSON.stringify(raw));
  }
});

offlineTest("whole JSON-string primitives never synthesize artifact references", () => {
  for (const value of [null, true, false, 0, 42, "", "ordinary browser text"]) {
    assert.deepEqual(browserResultArtifacts(JSON.stringify(value)), [], JSON.stringify(value));
  }
});

offlineTest("whole JSON-string empty or invalid artifacts never synthesize references", () => {
  for (const envelope of [{}, [], core, [core], { artifacts: [] }, { artifacts: [{}] },
    { artifacts: [null, false, 42, "artifact"] }, { artifacts: [core.artifactId] },
    { artifacts: [{ ...core, artifactId: "../outside" }] },
    { artifacts: [{ ...core, sha256: "invalid" }] }, { artifacts: [{ ...core, bytes: -1 }] },
    { structuredContent: { artifacts: [] } }, { structuredContent: { artifacts: [{}] } },
    { content: [{ type: "text", text: JSON.stringify({ artifacts: [{}] }) }] },
    { content: [{ type: "image", data: "private-image-payload", mimeType: "image/png" }] },
  ]) assert.deepEqual(browserResultArtifacts(JSON.stringify(envelope)), []);
});

offlineTest("whole JSON-string envelopes return metadata without image bytes, host paths or credentials", () => {
  const privateFields = { data: "private-image-payload", path: "C:/private/image.png", token: "private-token" };
  for (const [artifact, expected] of [[core, expectedCore], [cli, cli]]) {
    const metadata = { artifacts: [{ ...artifact, ...privateFields }] };
    for (const envelope of [metadata, { structuredContent: metadata }, {
      content: [{ type: "image", data: privateFields.data, mimeType: "image/png" },
        { type: "text", text: JSON.stringify(metadata) }],
    }]) assert.deepEqual(browserResultArtifacts(JSON.stringify(envelope)), [expected]);
  }
});

offlineTest("rendered browser text scrubs MCP image bytes while retaining human text and artifact metadata", () => {
  const payload = "PRIVATE_MCP_IMAGE_PAYLOAD";
  const envelope = { content: [
    { type: "image", data: payload, mimeType: "image/png" },
    { type: "text", text: "Captured the checkout page; total is $42." },
  ], structuredContent: { artifacts: [core] }, isError: false };
  for (const raw of [envelope, JSON.stringify(envelope)]) {
    const rendered = browserToolResultText(raw);
    assert.equal(rendered.includes(payload), false);
    const parsed = JSON.parse(rendered);
    assert.equal(parsed.content[0].mimeType, "image/png");
    assert.equal(parsed.content[1].text, envelope.content[1].text);
    assert.deepEqual(parsed.structuredContent, envelope.structuredContent);
    assert.equal(parsed.isError, false);
    assert.deepEqual(browserResultArtifacts(rendered), [expectedCore]);
  }
  assert.equal(envelope.content[0].data, payload, "the input result must not be mutated");
});

offlineTest("rendered browser text scrubs serialized image envelopes inside MCP text blocks", () => {
  const payload = "PRIVATE_NESTED_IMAGE_PAYLOAD";
  const inner = { content: [{ type: "image", data: payload, mimeType: "image/jpeg" },
    { type: "text", text: "Nested screenshot completed" }], artifacts: [cli] };
  const content = [{ type: "text", text: "Screenshot details follow" },
    { type: "text", text: JSON.stringify(inner) }];
  for (const raw of [content, { content }, JSON.stringify({ content }),
    { content: JSON.stringify(inner) }]) {
    const rendered = browserToolResultText(raw);
    assert.equal(rendered.includes(payload), false);
    assert.ok(rendered.includes("Nested screenshot completed"));
    assert.ok(rendered.includes(cli.id));
    assert.ok(rendered.includes(cli.sha256));
    assert.ok(rendered.includes("image/jpeg"));
  }
});

offlineTest("rendered browser text removes nested image sources and MIME-identified image data", () => {
  const payload = "PRIVATE_IMAGE_SOURCE_PAYLOAD";
  for (const image of [
    { type: "image", source: { type: "base64", media_type: "image/png", data: payload } },
    { type: "base64", data: payload, mimeType: "image/webp" },
    { mimeType: "image/png", data: payload },
  ]) {
    const rendered = browserToolResultText(JSON.stringify({ structuredContent: { image },
      content: [{ type: "text", text: "Screenshot ready" }], artifacts: [cli] }));
    assert.equal(rendered.includes(payload), false);
    const parsed = JSON.parse(rendered);
    assert.equal(parsed.content[0].text, "Screenshot ready");
    assert.deepEqual(parsed.artifacts, [cli]);
  }
});

offlineTest("rendered browser text preserves ordinary text and non-image data fields", () => {
  for (const text of ["", "Browser ready", "Page title: \"Checkout\"\n2 buttons available",
    "{broken JSON", '[unfinished array',
    'The page documents {"type":"image","data":"example"} in a code sample.']) {
    assert.equal(browserToolResultText(text), text);
  }
  const envelope = { content: [{ type: "text", text: "data:image/png;base64 is documentation here" }],
    structuredContent: { data: "ordinary network response", mimeType: "application/json", status: 200 } };
  assert.deepEqual(JSON.parse(browserToolResultText(envelope)), envelope);
  assert.deepEqual(JSON.parse(browserToolResultText(JSON.stringify(envelope))), envelope);
});

offlineTest("serialized MCP image payloads above the text parsing bound never reach rendered output", () => {
  const marker = "PRIVATE_OVERSIZED_MCP_IMAGE";
  const envelope = JSON.stringify({ content: [
    { type: "image", data: marker + "A".repeat(8 * 1024 * 1024), mimeType: "image/png" },
    { type: "text", text: "Large screenshot completed" },
  ] });
  assert.equal(browserToolResultText(envelope).includes(marker), false);
});

offlineTest("oversized serialized image envelopes inside text blocks never reach rendered output", () => {
  const marker = "PRIVATE_OVERSIZED_NESTED_IMAGE";
  const text = JSON.stringify({ content: [
    { type: "image", data: marker + "A".repeat(8 * 1024 * 1024), mimeType: "image/png" },
  ] });
  assert.equal(browserToolResultText({ content: [{ type: "text", text }] }).includes(marker), false);
});

offlineTest("image bytes, malformed text and non-object result values never create artifacts", () => {
  for (const raw of [null, undefined, true, 123, "result", {},
    { content: [{ type: "image", data: "private-image-payload", mimeType: "image/png" }] },
    { content: [null, {}, { type: "text", text: "ordinary browser text" }, { type: "text", text: "{broken JSON" },
      { type: "text", text: "null" }, { type: "text", text: "42" }, { type: "text", text: {} }] },
  ]) assert.deepEqual(browserResultArtifacts(raw), []);
});

offlineTest("result text parsing skips oversized blocks and reads no more than 32 blocks", () => {
  const good = { type: "text", text: JSON.stringify({ artifacts: [core] }) };
  const oversized = { type: "text", text: JSON.stringify({ artifacts: [cli], padding: "x".repeat(262144) }) };
  assert.deepEqual(browserResultArtifacts({ content: [oversized, good] }), [expectedCore]);
  assert.deepEqual(browserResultArtifacts({ content: [...Array(32).fill({ type: "text", text: "ordinary" }), good] }), []);
});
