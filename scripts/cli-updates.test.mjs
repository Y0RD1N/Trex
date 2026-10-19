import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { parseVersion, compareVersions, isNewer, versionForChannel } = await load("cliUpdates");

test("la versión instalada se lee de la salida de --version", () => {
  assert.equal(parseVersion("2.1.303 (Claude Code)"), "2.1.303");
  assert.equal(parseVersion("codex-cli 0.163.0"), "0.163.0");
  assert.equal(parseVersion("codex-cli 0.164.0-alpha.5"), "0.164.0-alpha.5");
  assert.equal(parseVersion("sin versión"), null);
  assert.equal(parseVersion(null), null);
});

test("las versiones se comparan por número, no como texto", () => {
  assert.ok(compareVersions("2.1.304", "2.1.303") > 0);
  assert.ok(compareVersions("0.163.0", "0.99.9") > 0);
  assert.ok(compareVersions("2.10.0", "2.9.9") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-beta") > 0);
  assert.ok(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.9") > 0);
});

test("solo se ofrece actualizar a una versión más nueva", () => {
  assert.equal(isNewer("2.1.304", "2.1.303"), true);
  assert.equal(isNewer("2.1.303", "2.1.303"), false);
  // Quien va por delante del canal estable no debe volver atrás.
  assert.equal(isNewer("2.1.292", "2.1.303"), false);
  assert.equal(isNewer(null, "2.1.303"), false);
  assert.equal(isNewer("2.1.304", null), false);
});

test("se usa la etiqueta de npm del canal elegido", () => {
  const tags = { stable: "2.1.292", latest: "2.1.303", next: "2.1.304" };
  assert.equal(versionForChannel(tags, "stable"), "2.1.292");
  assert.equal(versionForChannel(tags, "latest"), "2.1.303");
  assert.equal(versionForChannel({ latest: "0.163.0" }, "stable"), "0.163.0");
  assert.equal(versionForChannel(null, "latest"), null);
});
