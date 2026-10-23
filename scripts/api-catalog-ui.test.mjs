import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

// Execute the complete production TSX unchanged, as in queue-workflow-controls.
// React scheduling/JSX, DOM refs/observation, Select and native IPC are mocked.
// This is a deterministic form/IPC test, not browser or React scheduler coverage.
const source = await readFile(new URL("../src/components/TrexCliProfiles.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} });
const compiled = new Function("require", "exports", "MutationObserver", "document", "requestAnimationFrame", outputText);
const profiles = await load("profiles");
const flush = () => new Promise(resolve => setImmediate(resolve));
const noop = () => undefined;
const sameDeps = (one, two) => one && two && one.length === two.length && one.every((value, index) => Object.is(value, two[index]));
let currentHost, nextId = 0;
const react = Object.fromEntries(["useState", "useRef", "useCallback", "useEffect", "useId"]
  .map(name => [name, (...args) => currentHost[name](...args)]));
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
const Select = () => { throw new Error("Select descriptors must be operated through their public props"); };

function host(history) {
  const slots = [], effects = [], afterDispose = [];
  let cursor = 0, dirty = false, disposed = false;
  const record = (index, value) => history.push({ index, value: structuredClone(value) });
  const result = {
    afterDispose,
    get dirty() { return dirty; },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const value = typeof initial === "function" ? initial() : initial;
        slots[index] = { value }; record(index, value);
      }
      const slot = slots[index];
      slot.set ??= value => {
        const next = typeof value === "function" ? value(slot.value) : value;
        record(index, next);
        if (disposed) afterDispose.push(next);
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      };
      return [slot.value, slot.set];
    },
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useId() { return (slots[cursor++] ??= { id: `offline-catalog-${++nextId}` }).id; },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (!sameDeps(previous?.deps, deps)) effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { deps, cleanup: callback() };
      });
    },
    render(callback, commit = noop) {
      assert.equal(disposed, false);
      for (let count = 0; count < 30; count++) {
        dirty = false; cursor = 0;
        const previous = currentHost; currentHost = result;
        let tree;
        try { tree = callback(); } finally { currentHost = previous; }
        commit(tree); // In React the DOM and refs exist before passive effects.
        for (const run of effects.splice(0)) run();
        if (!dirty) return tree;
      }
      throw new Error("Form hook host did not settle");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const slot of slots) slot?.cleanup?.();
    },
  };
  return result;
}

function* elements(node) {
  if (Array.isArray(node)) { for (const child of node) yield* elements(child); }
  else if (node && typeof node === "object" && "props" in node) { yield node; yield* elements(node.props.children); }
}
function find(tree, predicate) {
  const matches = [...elements(tree)].filter(predicate);
  assert.equal(matches.length, 1, "expected one matching form control");
  return matches[0];
}
function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
const hasClass = (node, name) => node.props.className?.split(" ").includes(name);
const providers = [
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com" },
  { id: "minimax", label: "MiniMax", url: "https://api.minimax.io/v1" },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { id: "custom", label: "Personalizada", url: "https://offline-provider.invalid/v1" },
];
const connection = (name = "Account_A", provider = "deepseek", extra = {}) => ({
  name, provider, baseUrl: providers.find(item => item.id === provider).url,
  model: "saved/model", effort: "high", hasApiKey: true, ...extra,
});
const launcher = (name = "Account_A", extra = {}) => ({ id: `launcher-${name}`, name: `Display ${name}`, provider: "trex",
  command: "trex", args: profiles.trexProfileArgs(name), shell: "", launchMode: "arg", configDir: "", ...extra });
const catalog = (...ids) => ({ source: "remote", models: ids.map(id => ({ id, name: `Label ${id}` })) });

function harness(t, overrides = {}, { initiallyHidden = false } = {}) {
  const calls = [], stateHistory = [], saved = [], removed = [], busy = [], secrets = [], observers = new Set(), mounts = [];
  const focusRequests = [], animationFrames = [];
  let cancelled = 0, hidden = initiallyHidden, disposed = false, parentTree, formTree, formHost, formKey, formType, input;
  const panel = { hasAttribute: name => name === "hidden" && hidden };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) {
      assert.equal(target, panel); assert.deepEqual(options, { attributes: true, attributeFilter: ["hidden"] });
      observers.add(this);
    }
    disconnect() { observers.delete(this); }
  }
  const invoke = (command, args) => {
    assert.ok(["trex_cli_models", "trex_cli_save_profile", "trex_cli_remove_profile"].includes(command), `Unexpected IPC: ${command}`);
    if (command === "trex_cli_save_profile") assert.equal(input.value, "", "the DOM credential must already be cleared at the save IPC boundary");
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ command, args: structuredClone(args), resolve, reject });
    return promise;
  };
  const modules = {
    react, "react/jsx-runtime": jsxRuntime, "@tauri-apps/api/core": { invoke }, "../profiles": profiles,
    "./DialogProvider": { useDialog: () => ({ confirm: async () => false }) }, "./Select": { __esModule: true, default: Select },
    "./Icons": Object.fromEntries(["CheckIcon", "PlusIcon", "RotateIcon", "TrashIcon"].map(name => [name, `icon:${name}`])),
    "./TrexCliProfiles.css": {},
  };
  const exports = {};
  compiled(specifier => {
    assert.ok(Object.hasOwn(modules, specifier), `Unexpected dependency: ${specifier}`);
    return modules[specifier];
  }, exports, MutationObserver, { getElementById: id => {
    const node = [...elements(formTree)].find(node => node.props.id === id);
    return node ? { focus: () => focusRequests.push({ id, disabled: !!node.props.disabled }) } : null;
  } }, callback => animationFrames.push(callback));
  let props = { connections: [], launcherProfiles: [], onSaved: value => saved.push(structuredClone(value)),
    onRemoved: name => removed.push(name), onBusyChange: value => busy.push(value), onCancel: () => cancelled++, ...overrides };
  const parentHost = host(stateHistory);
  const render = () => {
    assert.equal(disposed, false);
    for (let count = 0; count < 20; count++) {
      parentTree = parentHost.render(() => exports.default(props));
      // The private form is taken from the real parent's output, never exported,
      // reimplemented, or extracted from source. Honor its React key on updates.
      const descriptor = find(parentTree, node => typeof node.type === "function");
      if (!formHost || descriptor.key !== formKey || descriptor.type !== formType) {
        formHost?.dispose();
        formHost = host(stateHistory); formKey = descriptor.key; formType = descriptor.type;
        input = { value: "", closest: selector => { assert.equal(selector, '[role="tabpanel"]'); return panel; } };
        mounts.push({ host: formHost, input, key: formKey });
      }
      formTree = formHost.render(() => descriptor.type(descriptor.props), tree => {
        const password = find(tree, node => node.type === "input" && node.props.type === "password");
        assert.equal(Object.hasOwn(password.props, "value"), false, "password must remain uncontrolled");
        assert.equal(Object.hasOwn(password.props, "defaultValue"), false, "password must not get a React default value");
        password.props.ref.current = input;
      });
      if (!parentHost.dirty) {
        // Focus runs after the committed descriptors reflect any state changes.
        // This observes the target's props, not real browser focus behavior.
        for (const callback of animationFrames.splice(0)) callback();
        return formTree;
      }
    }
    throw new Error("Parent/form reconciliation did not settle");
  };
  const field = name => find(formTree, node => node.props.id?.endsWith(`-${name}`));
  const button = name => find(formTree, node => node.type === "button" && hasClass(node, name));
  const click = node => { assert.equal(!!node.props.disabled, false, "control must be enabled"); node.props.onClick({ currentTarget: {} }); render(); };
  const assertNoSecrets = () => {
    const recorded = JSON.stringify({ stateHistory, saved, removed, busy });
    for (const secret of secrets) assert.equal(recorded.includes(JSON.stringify(secret).slice(1, -1)), false,
      "fixture credential entered React state or an outward callback");
  };
  const dispose = () => {
    if (disposed) return;
    formHost?.dispose(); parentHost.dispose(); disposed = true;
    assert.equal(observers.size, 0); assertNoSecrets();
  };
  t.after(dispose);
  render();
  return {
    calls, stateHistory, saved, removed, busy, mounts, focusRequests, render, field, dispose, assertNoSecrets,
    get input() { return input; }, get tree() { return formTree; }, get parentTree() { return parentTree; },
    get models() { return calls.filter(call => call.command === "trex_cli_models"); },
    get saves() { return calls.filter(call => call.command === "trex_cli_save_profile"); },
    get cancelled() { return cancelled; },
    get status() { return textOf(find(formTree, node => hasClass(node, "trex-catalog-status"))); },
    get refresh() { return button("trex-catalog-refresh"); },
    get options() { return field("model").props.options ?? []; },
    change(name, value) { field(name).props.onChange({ currentTarget: { value } }); render(); },
    typeKey(secret) {
      if (secret.trim()) secrets.push(secret.trim());
      input.value = secret; field("key").props.onChange({ currentTarget: input }); render(); assertNoSecrets();
    },
    blur() { field("key").props.onBlur(); render(); },
    query() { click(button("trex-catalog-refresh")); },
    chooseProvider(label) { click(find(formTree, node => node.type === "button" && hasClass(node, "trex-provider-option") && textOf(node).startsWith(label))); },
    chooseSaved(name) { click(find(parentTree, node => node.type === "button" && hasClass(node, "trex-connection-choice") && textOf(node).startsWith(name))); },
    createNew() { click(find(parentTree, node => node.type === "button" && hasClass(node, "trex-new-connection"))); },
    manual() { click(button("trex-model-fallback")); },
    selectModel(value) { const node = field("model"); assert.equal(node.type, Select); assert.equal(!!node.props.disabled, false); node.props.onChange(value); render(); },
    submit() { find(formTree, node => node.type === "form").props.onSubmit({ preventDefault: noop }); render(); },
    cancel() { click(find(formTree, node => node.type === "button" && textOf(node) === "Cancelar")); },
    remove() { click(button("trex-delete")); },
    update(next) { props = { ...props, ...next }; render(); },
    navigateHidden(value = true, { deliver = true } = {}) {
      hidden = value;
      if (deliver) for (const observer of observers) observer.callback([{ attributeName: "hidden" }]);
      render();
    },
    async pump() { await flush(); if (!disposed) render(); assertNoSecrets(); },
  };
}

for (const provider of providers) {
  test(`${provider.id}: fresh credentials query on blur before save, never enter state or select the first model`, async t => {
    const h = harness(t);
    if (provider.id !== "deepseek") h.chooseProvider(provider.label);
    if (provider.id === "custom") h.change("url", provider.url);
    assert.equal(h.models.length, 0);
    assert.equal(h.field("model").props.value, "");
    assert.equal(h.refresh.props.disabled, true);
    const secret = `fixture-${provider.id}-credential`;
    h.typeKey(secret.slice(0, 7)); h.typeKey(secret);
    h.change("name", `Fresh_${provider.id}`);
    assert.equal(h.input.value, secret, "ordinary parent/form renders must not clear the DOM password");
    assert.equal(h.models.length, 0, "typing credentials and editing the draft must not issue requests");
    h.blur();
    assert.deepEqual(h.models[0].args, { request: { provider: provider.id, baseUrl: provider.url, apiKey: secret } });
    assert.equal(h.saves.length, 0);
    h.blur();
    assert.equal(h.models.length, 1, "a second blur must not duplicate an outstanding request");
    h.models[0].resolve(catalog("first/model", "second/model")); await h.pump();
    assert.equal(h.field("model").props.value, "", "catalog results only supply choices");
    assert.deepEqual(h.options.map(option => option.value), ["first/model", "second/model"]);
    assert.equal(h.field("name").props.value, `Fresh_${provider.id}`);
    assert.equal(h.input.value, secret);
    h.selectModel("second/model"); h.submit();
    assert.equal(h.input.value, "", "save clears the uncontrolled password synchronously");
    assert.deepEqual(h.saves[0].args, { request: { name: `Fresh_${provider.id}`, provider: provider.id,
      baseUrl: provider.url, model: "second/model", effort: null, apiKey: secret } });
    assert.equal(h.models.length, 1, "saving is separate from discovering models");
    h.saves[0].resolve({ ...connection(`Fresh_${provider.id}`, provider.id, { model: "second/model" }), apiKey: secret });
    await h.pump();
    assert.equal(h.saved.length, 1);
    assert.equal(Object.hasOwn(h.saved[0], "apiKey"), false, "native save summaries must be stripped before callbacks");
    assert.deepEqual(h.models.at(-1).args, { request: { name: `Fresh_${provider.id}`, provider: provider.id, baseUrl: provider.url } },
      "post-save discovery uses only the stored identity after the input is cleared");
    h.assertNoSecrets();
  });
}

for (const provider of providers) {
  test(`${provider.id}: stored mount queries the bound account/provider/URL/config directory without a model or key`, async t => {
    const stored = connection("Bound_Account", provider.id);
    const profile = launcher(stored.name, { configDir: "D:/offline-config/catalog" });
    const h = harness(t, { profile, connections: [stored] });
    assert.deepEqual(h.models.map(call => call.args), [{ request: { name: stored.name, provider: provider.id,
      baseUrl: provider.url, configDir: profile.configDir } }]);
    h.render(); h.render();
    assert.equal(h.models.length, 1, "stable useCallback/effect dependencies must not requery on unchanged renders");
    h.models[0].resolve(catalog("new/model")); await h.pump();
    assert.equal(h.field("model").props.value, stored.model);
    assert.equal(h.options[0].value, stored.model);
    assert.match(h.options[0].label, /conservada/);
    assert.equal(h.input.value, "");
    assert.equal(h.saves.length, 0);
  });
}

test("an account without a stored credential waits for a fresh key and omits stored lookup identity", async t => {
  const stored = connection("No_Key", "minimax", { hasApiKey: false });
  const h = harness(t, { profile: launcher(stored.name), connections: [stored] });
  assert.equal(h.models.length, 0);
  h.typeKey("fixture-no-stored-key"); h.blur();
  assert.deepEqual(h.models[0].args, { request: { provider: stored.provider, baseUrl: stored.baseUrl, apiKey: "fixture-no-stored-key" } });
  h.models[0].resolve(catalog("available")); await h.pump();
  assert.equal(h.field("model").props.value, stored.model);
});

test("refresh, empty/error catalogs and explicit manual fallback preserve the draft/model and sanitize errors", async t => {
  const h = harness(t);
  h.change("name", "Draft_Account"); h.typeKey("fixture-refresh-key"); h.blur();
  h.models[0].resolve({ source: "remote", models: [
    { id: "chosen/model", name: "Chosen" }, { id: "chosen/model", name: "Duplicate" }, { id: "", name: "Invalid" },
  ] }); await h.pump();
  assert.equal(h.options.length, 1, "catalog IDs are deduplicated and empty IDs excluded");
  h.selectModel("chosen/model"); h.query();
  assert.equal(h.field("model").props.value, "chosen/model", "refresh must not clear the selected model while loading");
  h.models[1].resolve(catalog()); await h.pump();
  assert.match(h.status, /vacío/);
  assert.equal(h.field("name").props.value, "Draft_Account");
  assert.equal(h.field("model").props.value, "chosen/model");
  h.query(); h.models[2].reject(new Error("Provider echoed fixture-refresh-key with private diagnostics")); await h.pump();
  assert.match(h.status, /No se pudieron consultar/);
  assert.doesNotMatch(textOf(h.tree), /fixture-refresh-key|private diagnostics/);
  assert.equal(textOf(h.refresh), "Reintentar");
  assert.equal(h.field("model").props.value, "chosen/model");
  assert.equal(h.input.value, "fixture-refresh-key", "retry can reuse the still-mounted uncontrolled field");
  h.manual();
  assert.equal(h.field("model").type, "input", "manual fallback requires an explicit user action");
  h.change("model", "provider/manual-model"); h.manual();
  assert.equal(h.field("model").type, Select);
  assert.equal(h.field("model").props.value, "provider/manual-model");
  h.query(); h.models[3].resolve(catalog("other/model")); await h.pump();
  assert.equal(h.field("model").props.value, "provider/manual-model");
  h.manual(); h.submit();
  assert.deepEqual(h.saves[0].args, { request: { name: "Draft_Account", provider: "deepseek", baseUrl: providers[0].url,
    model: "provider/manual-model", effort: null, apiKey: "fixture-refresh-key" } });
  h.saves[0].resolve(connection("Draft_Account", "deepseek", { model: "provider/manual-model" })); await h.pump();
});

test("client validation keeps a pending fresh-key catalog alive until its choices arrive", async t => {
  const h = harness(t);
  const secret = "fixture-pending-client-correction";
  h.change("name", "Pending_Correction"); h.typeKey(secret); h.blur();
  const originalInput = h.input;
  h.submit();
  assert.equal(h.saves.length, 0);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.busy, []);
  assert.equal(h.input, originalInput);
  assert.equal(h.input.value, secret);
  assert.equal(h.field("name").props.value, "Pending_Correction");
  assert.equal(h.field("url").props.value, providers[0].url);
  assert.match(h.status, /Consultando/);
  assert.equal(h.models.length, 1);
  h.models[0].resolve(catalog("pending/choice")); await h.pump();
  assert.deepEqual(h.options.map(item => item.value), ["pending/choice"]);
  assert.equal(h.field("model").props.disabled, false);
  assert.equal(h.field("model").props.value, "");
  assert.equal(h.input.value, secret);
  h.assertNoSecrets();
});

for (const outcome of ["resolve", "reject"]) {
  test(`blank model retains the loaded catalog and credential for correction before a native save ${outcome}`, async t => {
    const h = harness(t);
    const secret = `fixture-loaded-client-correction-${outcome}`;
    h.change("name", "Catalog_Correction"); h.typeKey(secret); h.blur();
    assert.deepEqual(h.models[0].args, { request: { provider: "deepseek", baseUrl: providers[0].url, apiKey: secret } });
    h.models[0].resolve(catalog("catalog/first", "catalog/chosen")); await h.pump();
    const options = structuredClone(h.options), status = h.status, originalInput = h.input;
    assert.equal(h.field("model").props.value, "");
    h.submit();
    assert.equal(h.saves.length, 0, "a missing model must not reach native Save");
    assert.deepEqual(h.saved, []);
    assert.deepEqual(h.busy, [], "client validation must not enter a busy operation");
    assert.equal(h.models.length, 1, "client validation must not launch another catalog query");
    assert.equal(h.input, originalInput);
    assert.equal(h.input.value, secret);
    assert.equal(h.field("name").props.value, "Catalog_Correction");
    assert.equal(h.field("url").props.value, providers[0].url);
    assert.equal(h.field("model").type, Select);
    assert.equal(h.field("model").props.disabled, false);
    assert.equal(h.field("model").props["aria-invalid"], true);
    assert.deepEqual(h.options, options);
    assert.equal(h.status, status);
    assert.deepEqual(h.focusRequests, [{ id: h.field("model").props.id, disabled: false }]);
    h.assertNoSecrets();

    h.selectModel("catalog/chosen"); h.submit();
    assert.equal(h.input.value, "", "the corrected form must clear its credential synchronously at native Save");
    assert.equal(h.saves.length, 1);
    assert.deepEqual(h.saves[0].args, { request: { name: "Catalog_Correction", provider: "deepseek", baseUrl: providers[0].url,
      model: "catalog/chosen", effort: null, apiKey: secret } });
    assert.deepEqual(h.busy, [true]);
    assert.deepEqual(h.saved, [], "onSaved must wait for native Save success");
    const saved = connection("Catalog_Correction", "deepseek", { model: "catalog/chosen", effort: null });
    if (outcome === "resolve") h.saves[0].resolve({ ...saved, apiKey: secret });
    else h.saves[0].reject(new Error(`Native diagnostics echoed ${secret}`));
    await h.pump();
    assert.equal(h.input.value, "");
    assert.deepEqual(h.busy, [true, false]);
    assert.equal(h.field("model").props.value, "catalog/chosen");
    if (outcome === "resolve") {
      assert.deepEqual(h.saved, [saved]);
      assert.deepEqual(h.models[1].args, { request: { name: saved.name, provider: saved.provider, baseUrl: saved.baseUrl } });
      h.models[1].resolve(catalog("catalog/chosen")); await h.pump();
    } else {
      assert.deepEqual(h.saved, []);
      assert.equal(h.models.length, 1, "a rejected save must not query a stored credential");
      assert.match(textOf(h.field("error")), /No se pudo guardar la conexión/);
      assert.doesNotMatch(textOf(h.tree), /Native diagnostics|fixture-loaded-client-correction/);
      assert.deepEqual(h.focusRequests.at(-1), { id: h.field("save").props.id, disabled: false });
    }
    h.assertNoSecrets();
  });
}

test("a missing name keeps the selected catalog model and fresh credential available for correction", async t => {
  const h = harness(t);
  const secret = "fixture-missing-name-correction";
  h.change("name", ""); h.typeKey(secret); h.blur();
  h.models[0].resolve(catalog("catalog/name-choice")); await h.pump(); h.selectModel("catalog/name-choice");
  const options = structuredClone(h.options), status = h.status;
  h.submit();
  assert.equal(h.saves.length, 0);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.busy, []);
  assert.equal(h.models.length, 1);
  assert.equal(h.field("name").props.value, "");
  assert.equal(h.field("name").props["aria-invalid"], true);
  assert.equal(h.field("url").props.value, providers[0].url);
  assert.equal(h.field("model").props.value, "catalog/name-choice");
  assert.equal(h.field("model").props.disabled, false);
  assert.deepEqual(h.options, options);
  assert.equal(h.status, status);
  assert.equal(h.input.value, secret);
  assert.deepEqual(h.focusRequests, [{ id: h.field("name").props.id, disabled: false }]);
  h.change("name", "Name_Corrected"); h.submit();
  assert.equal(h.input.value, "");
  assert.deepEqual(h.saves[0].args, { request: { name: "Name_Corrected", provider: "deepseek", baseUrl: providers[0].url,
    model: "catalog/name-choice", effort: null, apiKey: secret } });
  h.saves[0].resolve(connection("Name_Corrected", "deepseek", { model: "catalog/name-choice", effort: null })); await h.pump();
  assert.equal(h.saved.length, 1);
  h.assertNoSecrets();
});

for (const secret of ["Bearer fixture-invalid-credential", "fixture-invalid\ncredential", "fixture-invalid\0credential"]) {
  test(`invalid credential format (${secret.startsWith("Bearer") ? "Bearer" : secret.includes("\n") ? "newline" : "NUL"}) still clears before any native save`, t => {
    const h = harness(t);
    h.manual(); h.change("model", "manual/model"); h.typeKey(secret); h.submit();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.saved, []);
    assert.deepEqual(h.busy, []);
    assert.equal(h.input.value, "");
    assert.equal(h.field("key").props["aria-invalid"], true);
    assert.deepEqual(h.focusRequests, [{ id: h.field("key").props.id, disabled: false }]);
    assert.match(textOf(h.field("error")), /sin el prefijo Bearer ni saltos de línea/);
    h.assertNoSecrets();
  });
}

for (const exit of ["provider", "URL", "hidden navigation", "cancel", "unmount", "failed save"]) {
  test(`${exit} clears a fresh DOM credential and invalidates its pending catalog`, async t => {
    const h = harness(t);
    h.typeKey(`fixture-clear-${exit.replaceAll(" ", "-")}`); h.blur();
    const originalInput = h.input, oldHost = h.mounts[0].host;
    if (exit === "provider") h.chooseProvider("MiniMax");
    if (exit === "URL") h.change("url", "https://changed.offline.invalid/v1");
    if (exit === "hidden navigation") h.navigateHidden();
    if (exit === "cancel") { h.cancel(); assert.equal(h.cancelled, 1); }
    if (exit === "unmount") h.dispose();
    if (exit === "failed save") {
      h.models[0].resolve(catalog("selected")); await h.pump(); h.selectModel("selected");
      h.query(); h.submit();
      assert.equal(h.saves.length, 1);
      h.saves[0].reject(new Error("fixture-clear-failed-save")); await h.pump();
      assert.doesNotMatch(textOf(h.tree), /fixture-clear-failed-save/);
    }
    assert.equal(originalInput.value, "");
    const late = h.models.at(-1);
    late.reject(new Error("obsolete catalog must be ignored")); await h.pump();
    assert.equal(oldHost.afterDispose.length, 0, "late requests cannot set state after unmount");
    if (exit !== "unmount") {
      assert.doesNotMatch(h.status, /No se pudieron consultar|obsolete/);
      assert.equal(h.field("model").props.value, exit === "failed save" ? "selected" : "");
    }
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`credential A-B-A ignores an old ${outcome} and its finally cannot unlock the newer request`, async t => {
    const h = harness(t);
    h.typeKey("fixture-key-A"); h.blur();
    h.typeKey("fixture-key-B"); h.blur();
    h.typeKey("fixture-key-A"); h.blur();
    assert.equal(h.models.length, 3);
    const [old, middle, latest] = h.models;
    if (outcome === "resolve") old.resolve(catalog("obsolete-A")); else old.reject(new Error("obsolete-A-error"));
    await h.pump();
    assert.match(h.status, /Consultando/);
    assert.deepEqual(h.options, []);
    h.blur();
    assert.equal(h.models.length, 3, "the old finally must preserve the latest request's duplicate guard");
    if (outcome === "resolve") middle.reject(new Error("obsolete-B-error")); else middle.resolve(catalog("obsolete-B"));
    await h.pump();
    assert.match(h.status, /Consultando/);
    h.blur();
    assert.equal(h.models.length, 3, "both superseded requests must leave the new request pending");
    latest.resolve(catalog("current-A")); await h.pump();
    assert.deepEqual(h.options.map(item => item.value), ["current-A"]);
    assert.match(h.status, /1 modelo/);
    assert.equal(h.field("model").props.value, "");
  });
}

for (const dimension of ["URL", "provider"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`${dimension} A-B-A ignores an old ${outcome} and protects the new stored request's finally`, async t => {
      const stored = connection();
      const h = harness(t, { profile: launcher(stored.name), connections: [stored] });
      const old = h.models[0];
      if (dimension === "URL") {
        h.change("url", "https://alternate.offline.invalid/v1");
        h.typeKey("fixture-alternate-url"); h.blur();
        assert.deepEqual(h.models[1].args, { request: { provider: stored.provider, baseUrl: "https://alternate.offline.invalid/v1", apiKey: "fixture-alternate-url" } });
        h.change("url", stored.baseUrl);
      } else {
        h.chooseProvider("MiniMax"); h.typeKey("fixture-alternate-provider"); h.blur();
        assert.equal(h.models[1].args.request.name, undefined, "changed providers cannot reuse a stored credential");
        h.chooseProvider("DeepSeek");
      }
      assert.equal(h.models.length, 3);
      const [ , middle, latest] = h.models;
      assert.deepEqual(latest.args, old.args, "returning to A uses a new generation even with identical request arguments");
      if (outcome === "resolve") old.resolve(catalog("obsolete")); else old.reject(new Error("obsolete"));
      await h.pump();
      assert.match(h.status, /Consultando/);
      assert.equal(h.options.some(item => item.value === "obsolete"), false);
      // Simulate a blur event with a DOM-injected replacement while A is pending.
      // It reaches the public onBlur handler without changing the generation.
      h.input.value = "fixture-duplicate-probe"; h.blur();
      assert.equal(h.models.length, 3, "obsolete finally cannot clear the current request marker");
      h.input.value = "";
      if (outcome === "resolve") middle.reject(new Error("obsolete middle")); else middle.resolve(catalog("obsolete middle"));
      await h.pump();
      assert.match(h.status, /Consultando/);
      latest.resolve(catalog("latest")); await h.pump();
      assert.equal(h.options.some(item => item.value === "latest"), true);
      assert.match(h.status, /1 modelo/);
    });
  }
}

test("the actual parent switches saved accounts A-B-A with fresh keyed forms, clears secrets and ignores old responses", async t => {
  const accountA = connection("Account_A"), accountB = connection("Account_B", "openrouter", { model: "b/saved" });
  const h = harness(t, { connections: [accountA, accountB] });
  assert.equal(h.models.length, 0, "create mode must not query an arbitrary saved account");
  h.typeKey("fixture-create-draft"); const createInput = h.input;
  h.chooseSaved(accountA.name);
  assert.equal(createInput.value, "");
  assert.deepEqual(h.models[0].args, { request: { name: accountA.name, provider: accountA.provider, baseUrl: accountA.baseUrl } });
  h.typeKey("fixture-account-A-replacement"); h.blur(); const firstAInput = h.input;
  assert.deepEqual(h.models[1].args, { request: { name: accountA.name, provider: accountA.provider,
    baseUrl: accountA.baseUrl, apiKey: "fixture-account-A-replacement" } });
  h.chooseSaved(accountB.name);
  assert.equal(firstAInput.value, "");
  assert.equal(h.field("name").props.value, accountB.name);
  assert.equal(h.field("model").props.value, accountB.model);
  assert.deepEqual(h.models[2].args, { request: { name: accountB.name, provider: accountB.provider, baseUrl: accountB.baseUrl } });
  h.typeKey("fixture-account-B-replacement"); const bInput = h.input;
  h.chooseSaved(accountA.name);
  assert.equal(bInput.value, "");
  assert.notEqual(h.input, firstAInput);
  assert.deepEqual(h.models[3].args, h.models[0].args);
  h.models[3].resolve(catalog("current-A")); await h.pump();
  h.models[0].resolve(catalog("stale-stored-A"));
  h.models[1].reject(new Error("stale-fresh-A")); h.models[2].reject(new Error("stale-B")); await h.pump();
  assert.deepEqual(h.options.map(item => item.value), [accountA.model, "current-A"]);
  assert.equal(h.field("model").props.value, accountA.model);
  assert.equal(h.input.value, "");
  assert.equal(h.mounts.length, 4);
  for (const mount of h.mounts.slice(0, -1)) assert.deepEqual(mount.host.afterDispose, []);
  h.typeKey("fixture-create-after-saved"); const lastAInput = h.input; h.createNew();
  assert.equal(lastAInput.value, "");
  assert.equal(h.field("model").props.value, "");
  assert.equal(h.models.length, 4);
});

test("launcher profile identity and config directory changes remount through the parent and invalidate old catalog work", async t => {
  const stored = connection();
  const first = launcher(stored.name, { id: "profile-one", configDir: "D:/offline-config/one" });
  const h = harness(t, { profile: first, connections: [stored] });
  h.typeKey("fixture-profile-change"); const firstInput = h.input;
  h.update({ profile: { ...first, id: "profile-two" } });
  assert.equal(firstInput.value, "");
  assert.equal(h.models.length, 2);
  h.typeKey("fixture-directory-change"); const secondInput = h.input;
  h.update({ profile: { ...first, id: "profile-two", configDir: "D:/offline-config/two" } });
  assert.equal(secondInput.value, "");
  assert.deepEqual(h.models[2].args, { request: { name: stored.name, provider: stored.provider,
    baseUrl: stored.baseUrl, configDir: "D:/offline-config/two" } });
  h.models[0].resolve(catalog("wrong-directory")); h.models[1].reject(new Error("old-profile")); await h.pump();
  assert.match(h.status, /Consultando/);
  h.models[2].resolve(catalog("right-directory")); await h.pump();
  assert.deepEqual(h.options.map(item => item.value), [stored.model, "right-directory"]);
  for (const mount of h.mounts.slice(0, -1)) assert.deepEqual(mount.host.afterDispose, []);
});

test("hidden navigation prevents queries until visible and invalidates both stored and fresh responses", async t => {
  const stored = connection();
  const h = harness(t, { profile: launcher(stored.name), connections: [stored] });
  h.navigateHidden();
  h.models[0].reject(new Error("late hidden stored failure")); await h.pump();
  assert.doesNotMatch(h.status, /No se pudieron consultar/);
  h.query();
  assert.equal(h.models.length, 1, "a mounted hidden panel cannot issue stored-key requests");
  h.navigateHidden(false);
  if (h.models.length === 1) h.query(); // A visible panel may also refresh automatically.
  assert.equal(h.models.length, 2);
  h.models[1].resolve(catalog("visible")); await h.pump();
  h.typeKey("fixture-hide-fresh"); h.blur(); h.navigateHidden();
  assert.equal(h.input.value, "");
  h.models[2].resolve(catalog("late-hidden-fresh")); await h.pump();
  assert.equal(h.options.some(item => item.value === "late-hidden-fresh"), false);
});

test("an initially hidden panel waits for reveal before automatically querying its saved account", async t => {
  const stored = connection();
  const h = harness(t, { profile: launcher(stored.name), connections: [stored] }, { initiallyHidden: true });
  assert.equal(h.models.length, 0);
  h.navigateHidden(false);
  assert.deepEqual(h.models.map(call => call.args), [{ request: { name: stored.name, provider: stored.provider, baseUrl: stored.baseUrl } }]);
  h.models[0].resolve(catalog("visible-model")); await h.pump();
  assert.equal(h.field("model").props.value, stored.model);
  const fresh = harness(t, {}, { initiallyHidden: true });
  fresh.navigateHidden(false);
  assert.equal(fresh.models.length, 0, "revealing a new connection must not use a stored account or issue an anonymous query");
});

for (const outcome of ["resolve", "reject"]) {
  test(`a ${outcome} while hidden is ignored even before navigation observer delivery`, async t => {
    const stored = connection();
    const h = harness(t, { profile: launcher(stored.name), connections: [stored] });
    h.navigateHidden(true, { deliver: false });
    if (outcome === "resolve") h.models[0].resolve(catalog("hidden-stale")); else h.models[0].reject("hidden-stale-error");
    await h.pump();
    assert.equal(h.options.some(item => item.value === "hidden-stale"), false);
    assert.doesNotMatch(h.status, /No se pudieron consultar/);
    h.navigateHidden(); // Explicitly deliver both observers after the settlement.
    h.navigateHidden(false);
    assert.equal(h.models.length, 2);
    h.models[1].resolve(catalog("visible-current")); await h.pump();
    assert.equal(h.options.some(item => item.value === "visible-current"), true);
  });
}

test("clearing a nonempty credential invalidates its pending response without querying an empty key", async t => {
  const h = harness(t);
  h.typeKey("fixture-key-to-clear"); h.blur(); h.typeKey(""); h.blur();
  assert.equal(h.models.length, 1);
  assert.equal(h.refresh.props.disabled, true);
  h.models[0].resolve(catalog("cleared-stale")); await h.pump();
  assert.deepEqual(h.options, []);
  assert.equal(h.field("model").props.value, "");
});

test("a cancelled removal clears a replacement credential without deleting the stored account", async t => {
  const stored = connection();
  const h = harness(t, { profile: launcher(stored.name), connections: [stored], launcherProfiles: [launcher("Other_Account")] });
  h.typeKey("fixture-remove-cancelled"); h.blur(); h.remove();
  assert.equal(h.input.value, "");
  await h.pump();
  assert.deepEqual(h.removed, []);
  assert.equal(h.calls.some(call => call.command === "trex_cli_remove_profile"), false);
  h.models[0].reject(new Error("obsolete stored lookup")); h.models[1].resolve(catalog("obsolete replacement")); await h.pump();
  assert.equal(h.options.some(item => item.value === "obsolete replacement"), false);
  assert.equal(h.field("model").props.value, stored.model);
});

test("raw native string/object errors cannot surface synthetic credentials in catalog text or state", async t => {
  const h = harness(t);
  const secret = "fixture-native-error-secret";
  h.typeKey(secret); h.blur();
  h.models[0].reject(`Remote diagnostics: ${secret}`); await h.pump();
  assert.match(h.status, /No se pudieron consultar/);
  h.query(); h.models[1].reject({ message: secret, response: { apiKey: secret } }); await h.pump();
  assert.match(h.status, /No se pudieron consultar/);
  assert.doesNotMatch(textOf(h.tree), /fixture-native-error-secret/);
  h.assertNoSecrets();
});

test("rotating a stored key with unchanged metadata refreshes by sanitized saved name and ignores the old fresh-key response", async t => {
  const stored = connection("Rotated_Account", "openrouter");
  const h = harness(t, { profile: launcher(stored.name), connections: [stored] });
  h.models[0].resolve(catalog(stored.model)); await h.pump();
  const secret = "fixture-key-rotation";
  h.typeKey(secret); h.blur();
  assert.deepEqual(h.models[1].args, { request: { name: stored.name, provider: stored.provider,
    baseUrl: stored.baseUrl, apiKey: secret } });
  h.submit();
  assert.equal(h.input.value, "");
  assert.deepEqual(h.saves[0].args, { request: { name: stored.name, provider: stored.provider,
    baseUrl: stored.baseUrl, model: stored.model, effort: stored.effort, apiKey: secret } });
  assert.equal(h.models.length, 2, "the stored-key refresh waits for successful save");
  // Intentionally retain the same connection props: metadata did not change,
  // so this refresh must follow save success rather than an effect dependency.
  h.saves[0].resolve({ ...stored, apiKey: secret }); await h.pump();
  assert.equal(h.models.length, 3);
  assert.deepEqual(h.models[2].args, { request: { name: stored.name, provider: stored.provider, baseUrl: stored.baseUrl } });
  assert.equal(h.input.value, "", "refresh does not require password reentry");
  assert.deepEqual(h.saved, [stored]);
  h.models[1].resolve(catalog("obsolete-fresh-key-model")); await h.pump();
  assert.match(h.status, /Consultando/);
  assert.equal(h.options.some(item => item.value === "obsolete-fresh-key-model"), false);
  h.models[2].resolve(catalog("new-key-model")); await h.pump();
  assert.equal(h.field("model").props.value, stored.model, "key rotation does not choose a new model");
  assert.deepEqual(h.options.map(item => item.value), [stored.model, "new-key-model"]);
  h.assertNoSecrets();
});

test("a new manual connection saved without password blur discovers models by saved name with no fresh key", async t => {
  const h = harness(t);
  h.chooseProvider("Personalizada");
  h.change("url", "https://manual.offline.invalid/v1"); h.change("name", "Manual_No_Blur");
  h.manual(); h.change("model", "provider/manual-preserved");
  const secret = "fixture-save-without-blur";
  h.typeKey(secret);
  assert.equal(h.models.length, 0);
  h.submit();
  assert.equal(h.input.value, "");
  assert.deepEqual(h.saves[0].args, { request: { name: "Manual_No_Blur", provider: "custom",
    baseUrl: "https://manual.offline.invalid/v1", model: "provider/manual-preserved", effort: null, apiKey: secret } });
  assert.equal(h.models.length, 0, "saving without blur must not send the fresh key to catalog discovery");
  const saved = connection("Manual_No_Blur", "custom", { baseUrl: "https://manual.offline.invalid/v1", model: "provider/manual-preserved", effort: null });
  h.saves[0].resolve({ ...saved, apiKey: secret }); await h.pump();
  assert.deepEqual(h.models.map(call => call.args), [{ request: { name: saved.name, provider: saved.provider, baseUrl: saved.baseUrl } }]);
  assert.deepEqual(h.saved, [saved]);
  assert.equal(h.input.value, "");
  h.models[0].resolve(catalog("remote-default")); await h.pump();
  assert.equal(h.field("model").props.value, saved.model);
  h.manual();
  assert.equal(h.field("model").type, Select);
  assert.equal(h.field("model").props.value, saved.model, "the returned catalog does not replace the explicit manual selection");
  assert.deepEqual(h.options.map(item => item.value), [saved.model, "remote-default"]);
  h.assertNoSecrets();
});

test("only complete whitelisted native error strings are shown; appended diagnostics and error objects are generic", async t => {
  const h = harness(t);
  const known = "La credencial no tiene acceso al catálogo de modelos. Puedes indicar un modelo manualmente.";
  const secret = "fixture-whitelist-error-key";
  h.typeKey(secret); h.blur(); h.models[0].reject(known); await h.pump();
  assert.equal(h.status, known);
  h.query(); h.models[1].reject(`${known} Diagnostics: ${secret}`); await h.pump();
  assert.match(h.status, /No se pudieron consultar/);
  h.query(); h.models[2].reject({ message: known }); await h.pump();
  assert.match(h.status, /No se pudieron consultar/);
  h.assertNoSecrets();
});
