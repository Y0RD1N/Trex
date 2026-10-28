import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

// Execute production modules; only the Tauri IPC boundary is replaced. No native
// process, browser, provider, network connection, or build is started here.
const browser = await load("browser");
const { browserMode, validBrowserProfile, browserOptions, browserConfigForShell,
  browserArtifacts, browserResultArtifacts, browserToolResultText, brokerArtifactId, OBSERVE_BROWSER_TOOLS } = browser;
const { claudeProfilePermissionMode } = await load("workflowSafety");
const offlineTest = (name, fn) => test(name, { timeout: 10000 }, fn);

async function compile(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } });
  return { run: new Function("require", "exports", outputText),
    imports: [...new Set([...outputText.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]))] };
}

const [compiledApi, compiledConnection] = await Promise.all([compile("api"), compile("browserConnection")]);
const apiDependencies = Object.fromEntries(await Promise.all(compiledApi.imports
  .filter(name => name.startsWith("./"))
  .map(async name => [name, name === "./browser" ? browser : await load(name.slice(2))])));

function instantiate(compiled, dependencies) {
  const exports = {};
  compiled.run(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected production dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

function nativeHarness(respond = command => assert.fail(`Unexpected native command: ${command}`)) {
  const calls = [], warnings = [];
  const api = instantiate(compiledApi, {
    ...apiDependencies,
    "@tauri-apps/api/core": { isTauri: () => true, invoke: async (command, args) => {
      calls.push({ command, args });
      return respond(command, args);
    } },
    "@tauri-apps/api/event": { listen: () => assert.fail("Unexpected native event listener") },
  });
  const { connectBrowser } = instantiate(compiledConnection, { "./api": api, "./browser": browser });
  return { api, calls, warnings, connect: (options, { cwd = "D:/work/with spaces", mode = "default",
    planningOnly = false, shell = "powershell" } = {}) =>
    connectBrowser(options, cwd, mode, planningOnly, shell, message => warnings.push(message)) };
}

const options = Object.freeze({ enabled: true, profile: "BROWSER27", clientId: "chat-client_42" });
const ready = Object.freeze({ installed: true, ready: true, compatible: true });
const nativeConfig = Object.freeze({ command: "C:\\Program Files\\Trex\\trex-browser.exe",
  args: Object.freeze(["mcp", "--cwd", "D:\\work\\with spaces", "--profile", "BROWSER27", "literal;$() --flag"]) });

offlineTest("ordinary chats allocate a private persistent profile before constructing the native MCP grant", async () => {
  const h = nativeHarness((command,args) => {
    if(command === "trex_browser_status") return {...ready,capabilities:{spaces:true}};
    if(command === "trex_browser_spaces") return {spaces:[{...args.members[0],profile:args.members[0].clientId === "first" ? "BROWSER2" : "BROWSER3"}]};
    assert.equal(command,"trex_browser_mcp_config");return {command:"browser.exe",args:["--profile",args.profile]};
  });
  for(const clientId of ["first","second"]) {
    const requested=browserOptions({browserEnabled:true,browserProfile:"BROWSER1"},clientId,"Codex · "+clientId);
    const config=await h.connect(requested);
    assert.deepEqual(config.args,["--profile",clientId === "first" ? "BROWSER2" : "BROWSER3"]);
  }
  assert.equal(h.calls.filter(call=>call.command==="trex_browser_spaces").length,2);
  assert.ok(h.calls.every(call=>call.command!=="trex_browser_call"));
});

offlineTest("failed or foreign automatic bindings never fall back to a shared profile or take control", async () => {
  for(const response of [null,{spaces:[]},{spaces:[{clientId:"foreign",profile:"BROWSER2"}]},{spaces:[{clientId:"own",profile:"BROWSER1"}]}]) {
    const h=nativeHarness(command=>command==="trex_browser_status"?{...ready,capabilities:{spaces:true}}:response);
    await assert.rejects(h.connect(browserOptions({browserEnabled:true,browserProfile:"BROWSER1"},"own")));
    assert.ok(!h.calls.some(call=>call.command==="trex_browser_mcp_config"||call.command==="trex_browser_call"));
  }
});

offlineTest("automatic space labels respect native UTF-8 limits without splitting Unicode characters",()=>{
  const value=browserOptions({browserEnabled:true,browserProfile:"BROWSER1"},"own","🦖".repeat(100));
  assert.equal(value.label,"🦖".repeat(25));assert.equal(new TextEncoder().encode(value.label).length,100);
  assert.equal(browserOptions({browserEnabled:true,browserProfile:"BROWSER1"},"own","\n\r").label,"Agente");
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

offlineTest("the observe allowlist matches the published contract and excludes mutation tools", async () => {
  const [all, observe] = await Promise.all(["tools", "observe-tools"].map(async name =>
    JSON.parse(await readFile(new URL(`../trex-browser/docs/${name}.json`, import.meta.url), "utf8")).tools));
  assert.deepEqual([...OBSERVE_BROWSER_TOOLS].sort(), observe.map(tool => tool.name).sort());
  for (const tool of all) {
    assert.equal(OBSERVE_BROWSER_TOOLS.has(tool.name), observe.some(item => item.name === tool.name), tool.name);
    if (OBSERVE_BROWSER_TOOLS.has(tool.name)) {
      assert.equal(observe.find(item=>item.name===tool.name).annotations.readOnlyHint,true,tool.name);
      // A full-mode batch can contain input; only its observe grant is read-only.
      assert.equal(tool.annotations.readOnlyHint,tool.name!=="browser_batch",tool.name);
    }
  }
  assert.equal(OBSERVE_BROWSER_TOOLS.has("browser_evaluate"), false);
  assert.equal(OBSERVE_BROWSER_TOOLS.has("browser_file_upload"), false);
});

offlineTest("only canonical BROWSER1 through BROWSER99 profile names are accepted", () => {
  for (let number = 1; number <= 99; number++) assert.equal(validBrowserProfile(`BROWSER${number}`), true);
  for (const value of ["", "BROWSER", "BROWSER0", "BROWSER00", "BROWSER01", "BROWSER100", "BROWSER999",
    "browser1", "Browser1", " BROWSER1", "BROWSER1 ", "BROWSER1\n", "BROWSER1\r", "BROWSER1\0",
    "BROWSER-1", "BROWSER1.0", "BROWSER+1", "BROWSER１", "../BROWSER1"]) {
    assert.equal(validBrowserProfile(value), false, JSON.stringify(value));
  }
});

offlineTest("browser options retain the client and enabled flag while normalizing invalid profiles", () => {
  for (const enabled of [true, false]) {
    for (const profile of ["BROWSER1", "BROWSER27", "BROWSER99"]) {
      assert.deepEqual(browserOptions({ browserEnabled: enabled, browserProfile: profile }, "client-original"),
        { enabled, profile, clientId: "client-original", automatic:true, label:"Agente" });
    }
    for (const profile of ["", "BROWSER0", "BROWSER01", "BROWSER100", "browser2", "BROWSER2\n"]) {
      assert.deepEqual(browserOptions({ browserEnabled: enabled, browserProfile: profile }, "client-original"),
        { enabled, profile: "BROWSER1", clientId: "client-original", automatic:true, label:"Agente" });
    }
  }
});

offlineTest("WSL converts drive and verbatim executable paths without rewriting or splitting arguments", () => {
  for (const [command, expected] of [
    ["C:\\Program Files\\Trex\\trex-browser.exe", "/mnt/c/Program Files/Trex/trex-browser.exe"],
    ["D:/apps/Trex/browser.exe", "/mnt/d/apps/Trex/browser.exe"],
    ["\\\\?\\E:\\apps\\Trex Browser\\browser.exe", "/mnt/e/apps/Trex Browser/browser.exe"],
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
  for (const command of ["trex-browser", "/usr/local/bin/trex-browser", "C:relative.exe", "\\\\server\\share\\browser.exe"]) {
    const config = { command, args: nativeConfig.args };
    assert.deepEqual(browserConfigForShell(config, "wsl"), config);
  }
});

offlineTest("core artifact metadata is normalized without retaining image bytes or host paths", () => {
  assert.deepEqual(browserArtifacts([{ ...core, data: "private-image-payload", path: "C:/private/image.png", token: "private-token" }]), [expectedCore]);
  assert.deepEqual(browserArtifacts([{ ...core, bytes: 0 }]), [{ ...expectedCore, sizeBytes: 0 }]);
  assert.deepEqual(browserArtifacts([{ ...core, sha256: sha256.toUpperCase() }]), [{ ...expectedCore, sha256: sha256.toUpperCase() }]);
});

offlineTest("CLI artifact metadata preserves local storage and exact nested broker provenance", () => {
  const [artifact] = browserArtifacts([cli]);
  assert.deepEqual(artifact, cli);
  assert.equal(brokerArtifactId(artifact), core.artifactId);
  assert.notEqual(brokerArtifactId(artifact), cli.id);
});

offlineTest("broker identity comes from provenance before fallback and is never synthesized from a local hash", () => {
  assert.equal(brokerArtifactId({ ...cli, provenance: { brokerArtifactId: "Exact_Opaque-ID_AbC123" } }), "Exact_Opaque-ID_AbC123");
  assert.equal(brokerArtifactId({ ...cli, provenance: {} }), null);
  assert.equal(brokerArtifactId({ ...cli, provenance: "not-provenance" }), null);
  assert.equal(brokerArtifactId({ ...expectedCore, provenance: {} }), core.artifactId);
  for (const invalid of ["", "../outside", "C:\\private\\image.png", "https://example.invalid/file", "id with space", 42, {}]) {
    assert.equal(brokerArtifactId({ ...expectedCore, provenance: { brokerArtifactId: invalid } }), null, JSON.stringify(invalid));
  }
});

offlineTest("CLI opaque IDs containing colon and dot survive metadata unchanged", () => {
  const id = "broker:Capture.Mixed_CASE-01";
  assert.deepEqual(browserArtifacts([{ ...cli, id, storage: "broker", provenance: { brokerArtifactId: id } }]),
    [{ ...cli, id, storage: "broker", provenance: { brokerArtifactId: id } }]);
});

offlineTest("broker provenance forwards opaque colon and dot IDs exactly", () => {
  const id = "broker:Capture.Mixed_CASE-01";
  assert.equal(brokerArtifactId({ ...cli, provenance: { brokerArtifactId: id } }), id);
  assert.equal(brokerArtifactId({ ...expectedCore, id, provenance: {} }), id);
});

offlineTest("CLI metadata-only diagnostics with an absent checksum remain visible", () => {
  const metadata = { id: "cpu-profile-id", sha256: "", mimeType: "application/json", sizeBytes: 456,
    kind: "cpu-profile", storage: "broker", provenance: { brokerArtifactId: "cpu-profile-id" } };
  assert.deepEqual(browserArtifacts([metadata]), [metadata]);
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

offlineTest("disabled or missing browser options perform no native discovery or configuration", async () => {
  const h = nativeHarness();
  for (const value of [undefined, { ...options, enabled: false }]) assert.equal(await h.connect(value), null);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.warnings, []);
});

offlineTest("an uninstalled companion quietly skips configuration", async () => {
  const h = nativeHarness(command => {
    assert.equal(command, "trex_browser_status");
    return { installed: false, ready: false, compatible: false };
  });
  assert.equal(await h.connect(options), null);
  assert.deepEqual(h.calls, [{ command: "trex_browser_status", args: undefined }]);
  assert.deepEqual(h.warnings, []);
});

offlineTest("a ready companion receives the exact trusted context and mapped permissions", async () => {
  for (const [mode, planningOnly, expected] of [["plan", false, "observe"], ["read-only", false, "observe"],
    ["full", false, "full"], ["bypassPermissions", false, "full"], ["default", false, "qa"], ["full", true, "observe"]]) {
    const h = nativeHarness(command => command === "trex_browser_status" ? ready : nativeConfig);
    assert.deepEqual(await h.connect(options, { mode, planningOnly }), nativeConfig);
    assert.deepEqual(h.calls, [
      { command: "trex_browser_status", args: undefined },
      { command: "trex_browser_mcp_config", args: { cwd: "D:/work/with spaces", mode: expected, clientId: options.clientId, profile: options.profile } },
    ]);
    assert.deepEqual(h.warnings, []);
  }
});

offlineTest("connection applies WSL conversion to the native executable while preserving all arguments", async () => {
  const h = nativeHarness(command => command === "trex_browser_status" ? ready : nativeConfig);
  assert.deepEqual(await h.connect(options, { shell: "wsl" }), {
    command: "/mnt/c/Program Files/Trex/trex-browser.exe", args: nativeConfig.args,
  });
  assert.deepEqual(h.calls[1].args, { cwd: "D:/work/with spaces", mode: "qa", clientId: options.clientId, profile: options.profile });
});

offlineTest("not-ready or incompatible native status warns once without asking for configuration", async () => {
  for (const status of [{ ...ready, ready: false }, { ...ready, compatible: false },
    { ...ready, ready: false, error: { code: "BROKEN", message: "private native diagnostic" } }]) {
    const h = nativeHarness(command => {
      assert.equal(command, "trex_browser_status");
      return status;
    });
    assert.equal(await h.connect(options), null);
    assert.equal(h.calls.length, 1);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /Trex Browser.*no está disponible/);
    assert.equal(h.warnings[0].includes("private native diagnostic"), false);
  }
});

offlineTest("native status rejection and malformed status degrade to one warning", async () => {
  for (const failure of ["status rejection", "null status", "undefined status"]) {
    const h = nativeHarness(command => {
      if (command === "trex_browser_status") {
        if (failure === "status rejection") throw new Error("native status unavailable");
        if (failure === "null status") return null;
        if (failure === "undefined status") return undefined;
        return ready;
      }
      assert.equal(command, "trex_browser_mcp_config");
      throw new Error("native config unavailable");
    });
    assert.equal(await h.connect(options), null, failure);
    assert.equal(h.calls.length, 1, failure);
    assert.equal(h.warnings.length, 1, failure);
    assert.match(h.warnings[0], /Trex Browser.*no está disponible/);
  }
});
offlineTest("a ready installed component cannot silently disappear when app-side preparation fails",async()=>{
  const h=nativeHarness(command=>{if(command==="trex_browser_status")return ready;throw new Error("private native preparation diagnostic");});
  await assert.rejects(h.connect(options),error=>error.message.includes("no se pudo preparar")&&!error.message.includes("private native preparation diagnostic"));
  assert.equal(h.calls.length,2);assert.deepEqual(h.warnings,[]);
});

offlineTest("API native bridge forwards browser commands and trusted arguments without rewriting", async () => {
  const response = { content: [{ type: "text", text: "done" }], isError: false };
  const h = nativeHarness(() => response);
  const cwd = "D:/work/with spaces", mode = "observe", clientId = "Exact_Client-1", profile = "BROWSER99";
  const request = Object.freeze({ name: "browser_take_screenshot", arguments: Object.freeze({ fullPage: true }),
    cwd, mode, clientId, profile, operationId: "op-original", timeoutMs: 1500 });
  for (const result of [await h.api.trexBrowserStatus(), await h.api.trexBrowserMcpConfig(cwd, mode, clientId, profile),
    await h.api.trexBrowserCall(request), await h.api.trexBrowserOpenArtifact(core.artifactId, cwd, mode, clientId, profile),
    await h.api.trexBrowserProfiles(cwd), await h.api.trexBrowserCreateProfile(cwd, profile)]) assert.equal(result, response);
  assert.deepEqual(h.calls, [
    { command: "trex_browser_status", args: undefined },
    { command: "trex_browser_mcp_config", args: { cwd, mode, clientId, profile } },
    { command: "trex_browser_call", args: { request } },
    { command: "trex_browser_open_artifact", args: { id: core.artifactId, cwd, mode, clientId, profile } },
    { command: "trex_browser_profiles", args: { cwd } },
    { command: "trex_browser_create_profile", args: { cwd, profile } },
  ]);
  assert.equal(h.calls[2].args.request, request);
});

offlineTest("API bridge preserves undefined optional profiles and native rejection identity", async () => {
  const error = new Error("mock native rejection");
  const h = nativeHarness(() => { throw error; });
  await assert.rejects(h.api.trexBrowserMcpConfig("D:/work", "qa", "client"), value => value === error);
  await assert.rejects(h.api.trexBrowserOpenArtifact(core.artifactId, "D:/work", "full", "client"), value => value === error);
  assert.deepEqual(h.calls, [
    { command: "trex_browser_mcp_config", args: { cwd: "D:/work", mode: "qa", clientId: "client", profile: undefined } },
    { command: "trex_browser_open_artifact", args: { id: core.artifactId, cwd: "D:/work", mode: "full", clientId: "client", profile: undefined } },
  ]);
});
