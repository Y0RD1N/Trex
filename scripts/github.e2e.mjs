// End-to-end check of the GitHub tools with the REAL gh (not part of `npm test`).
//
//   node scripts/github.e2e.mjs        (TREX_AGENT overrides the trex-agent binary; GH_E2E_REPO the public repo to read)
//
// Starts `trex-agent apps-mcp --apps github` like Claude, Codex and Antigravity do and drives the tools over MCP
// with the user's own gh login. It only READS from a public repository. The two writes it tries are ones GitHub
// refuses without any effect (merging an already merged PR, commenting on an issue that does not exist): they
// prove the failure is explained and not treated as uncertain. Skipped when gh is missing or not logged in.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = process.env.TREX_AGENT ?? path.join(root, "trex-cli/target/debug/trex-agent");
const repo = process.env.GH_E2E_REPO ?? "cli/cli";
const loggedIn = spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0;
if (!existsSync(agent) || !loggedIn) {
  console.log(`skipped: needs a built trex-agent (${agent}) and a logged-in gh`);
  process.exit(0);
}
const workspace = mkdtempSync(path.join(tmpdir(), "trex-github-e2e-"));

class Server {
  constructor(mode) {
    this.child = spawn(agent, ["apps-mcp", "--mode", mode, "--cwd", workspace, "--apps", "github"], { stdio: ["pipe", "pipe", "inherit"] });
    this.pending = new Map();
    this.n = 0;
    let buffer = "";
    this.child.stdout.on("data", chunk => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        this.pending.get(message.id)?.(message);
      }
    });
  }
  rpc(method, params = {}) {
    const id = ++this.n;
    return new Promise(resolve => { this.pending.set(id, resolve); this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  }
  async tool(name, args = {}) {
    const response = await this.rpc("tools/call", { name, arguments: args });
    assert.ok(response.result, `${name}: ${JSON.stringify(response.error)}`);
    const { content = [], isError = false, structuredContent, manualReview } = response.result;
    return { isError, structured: structuredContent, manualReview, text: content.filter(c => c.type === "text").map(c => c.text).join("\n") };
  }
  async init() { await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } }); return this; }
  close() { this.child.stdin.end(); }
}
const step = async (label, run) => { const t = Date.now(); await run(); console.log(`ok  ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`); };

let full = null, plan = null, mergedPr = null, failedRun = null, firstIssue = null;
try {
  full = await new Server("full").init();
  await step("the catalog has the ten GitHub tools and nothing from other apps", async () => {
    const names = (await full.rpc("tools/list")).result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ["github_api", "github_comment", "github_issues", "github_pr_checks", "github_pr_create", "github_pr_merge", "github_pr_view", "github_prs", "github_repos", "github_runs"]);
  });
  await step("github_repos lists an owner's repositories", async () => {
    const reply = await full.tool("github_repos", { owner: repo.split("/")[0], limit: 3 });
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, new RegExp(`${repo.split("/")[0]}/`));
  });
  await step("github_prs lists merged pull requests", async () => {
    const reply = await full.tool("github_prs", { repository: repo, state: "merged", limit: 3 });
    assert.equal(reply.isError, false, reply.text);
    mergedPr = reply.structured.pullRequests[0].number;
    assert.ok(mergedPr > 0);
  });
  await step("github_pr_view gives the head SHA and flags other people's text as untrusted", async () => {
    const reply = await full.tool("github_pr_view", { repository: repo, number: mergedPr, comments: true, files: true });
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, /^\(Text below was written by other people/);
    assert.match(reply.text, /SHA [0-9a-f]{40}/);
    assert.match(reply.text, /Checks: \d+ passing, \d+ failing, \d+ pending/);
    assert.ok(reply.structured.checks);
  });
  await step("github_pr_checks reports the CI of that pull request", async () => {
    const reply = await full.tool("github_pr_checks", { repository: repo, number: mergedPr });
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, /^Checks: \d+ passing, \d+ failing, \d+ pending/);
  });
  await step("github_issues lists and reads an issue", async () => {
    const list = await full.tool("github_issues", { repository: repo, state: "all", limit: 3 });
    assert.equal(list.isError, false, list.text);
    firstIssue = list.structured.issues[0].number;
    const issue = await full.tool("github_issues", { repository: repo, number: firstIssue, comments: true });
    assert.equal(issue.isError, false, issue.text);
    assert.match(issue.text, /^\(Text below/);
  });
  await step("github_runs lists CI runs, opens one and asks for its failed-step log", async () => {
    const list = await full.tool("github_runs", { repository: repo, status: "failure", limit: 3 });
    assert.equal(list.isError, false, list.text);
    failedRun = list.structured.runs[0]?.databaseId;
    if (!failedRun) return console.log("    (no failed runs to open right now)");
    const view = await full.tool("github_runs", { repository: repo, runId: failedRun });
    assert.equal(view.isError, false, view.text);
    assert.match(view.text, /job \d+|No job ran/);
    const log = await full.tool("github_runs", { repository: repo, runId: failedRun, log: true });
    // Logs expire: either the end of a real log, or an explanation of why there is none.
    assert.ok(!log.isError ? /^\(Text below/.test(log.text) : /failed-step output|not found|expired|Not found/i.test(log.text), log.text.slice(0, 300));
  });
  await step("github_api reads any GET and keeps only the requested fields", async () => {
    const reply = await full.tool("github_api", { endpoint: `repos/${repo}/commits?per_page=2`, fields: ["sha"] });
    assert.equal(reply.isError, false, reply.text);
    const rows = reply.structured.data;
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]), ["sha"]);
    assert.equal((await full.tool("github_api", { endpoint: "graphql" })).isError, true);
    assert.equal((await full.tool("github_api", { endpoint: `repos/${repo}/../../user` })).isError, true);
  });
  await step("a missing repository is explained, not just reported as a failure", async () => {
    const reply = await full.tool("github_pr_view", { repository: `${repo.split("/")[0]}/trex-does-not-exist-xyz`, number: 1 });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Not found/);
  });
  await step("a merge is confirmed by reading the state back: gh exits 0 on 'already merged' and merges nothing", async () => {
    const merge = await full.tool("github_pr_merge", { repository: repo, number: mergedPr, headSha: "a".repeat(40), strategy: "squash" });
    assert.equal(merge.isError, false, merge.text);
    assert.match(merge.text, /^Nothing was done: pull request #\d+ was already merged/, "never claims a merge that did not happen");
    assert.equal(merge.structured.alreadyMerged, true);
  });
  await step("a write GitHub refuses is a clear refusal, not an 'uncertain' alarm, and has no effect", async () => {
    const comment = await full.tool("github_comment", { repository: repo, kind: "issue", number: 999999999, body: "must never be posted" });
    assert.equal(comment.isError, true);
    assert.ok(!comment.manualReview, comment.text);
    assert.match(comment.text, /Not found|Could not resolve|permission/i);
  });
  await step("a planning server offers only the seven reads and refuses writes", async () => {
    plan = await new Server("plan").init();
    assert.deepEqual((await plan.rpc("tools/list")).result.tools.map(t => t.name).sort(), ["github_api", "github_issues", "github_pr_checks", "github_pr_view", "github_prs", "github_repos", "github_runs"]);
    assert.equal((await plan.tool("github_comment", { repository: repo, kind: "issue", number: 1, body: "x" })).isError, true);
    assert.equal((await plan.tool("github_prs", { repository: repo, limit: 1 })).isError, false);
  });
  console.log("\nAll GitHub checks passed.");
} finally {
  plan?.close();
  full?.close();
  rmSync(workspace, { recursive: true, force: true });
}
