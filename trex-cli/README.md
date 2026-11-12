# Trex Agent

Standalone Rust API coding agent for named DeepSeek, MiniMax, OpenRouter,
Anthropic, and custom OpenAI-compatible profiles. It is independent of the desktop
app.

Build and test from the repository root:

```powershell
cargo build --locked --release --manifest-path trex-cli/Cargo.toml
cargo test --locked --manifest-path trex-cli/Cargo.toml
```

Save a profile using JSON on stdin (`apiKey` may be included there, never in
command arguments). Example without a key:

```powershell
'{"name":"TREX1","provider":"deepseek","model":"deepseek-v4-pro"}' | .\trex-cli\target\release\trex-agent.exe profiles save --stdin-json
.\trex-cli\target\release\trex-agent.exe profiles list --json
.\trex-cli\target\release\trex-agent.exe --profile TREX1 chat --mode ask
```

Use `TREX_HOME` to isolate configuration, encrypted credentials, and conversation
history. Real providers require a stored key; only loopback mock servers can run
without one. Windows uses DPAPI, macOS Keychain, Linux persistent Secret Service.
Unavailable secure storage is an error.

`/usage` in interactive chat reads the conversation's measured context and API
consumption without sending a model prompt. The app-server exposes the same
read-only snapshot through `session/usage`, and sends `usage/updated` after each
provider response. Input, output, cache, reasoning, request counts and any reported
USD cost are persisted with the turn and restored as absolute conversation totals.
Cache and reasoning details are not added to token totals a second time. Missing
counters or prices stay unavailable; partial costs are marked as partial. These
are the calls recorded in this conversation, not the API account's balance or bill.

Discover a connection's models without supplying a model ID:

```powershell
'{"provider":"minimax","name":"MY-MINIMAX"}' | .\trex-cli\target\release\trex-agent.exe models list --json --stdin-json
```

`name` reuses a stored key only when the provider and canonical endpoint match
the saved profile. New or rotated keys can be passed as `apiKey` on stdin; that
key is used transiently and never saved by discovery. Do not put a key in command
arguments or a script file. Custom endpoints also require `baseUrl`.

Strict discovery calls the provider's actual `/models` endpoint and returns
`{models:[...],source:"remote"}`. Missing discovery support, denied credentials,
and empty catalogs return a safe error code and a nonzero exit status. A static
or configured model list is never reported as remote discovery. The catalog
does not guarantee that the key can invoke every returned model.

MiniMax uses `https://api.minimax.io/v1` with `Authorization: Bearer <key>`.
Pay-as-you-go API keys and M-Plan subscription keys belong to separate products;
both use this Bearer format for the OpenAI-compatible interface. Discovery can
still be denied or unsupported for a particular product or credential. See the
[MiniMax OpenAI-compatible API](https://platform.minimax.io/docs/api-reference/text-openai-api)
and [M-Plan integration guide](https://platform.minimax.io/docs/coding-plan/other-tools).

Keys are absent from profile metadata, launcher arguments, and command output.
Windows credentials are encrypted with user-scoped DPAPI; the CLI restricts new
storage to the current user. Existing shared homes or profile files are rejected
without changing permissions on an unrelated user-selected directory. Symbolic
links, junctions, and hard-linked storage files are rejected as well. Changing a
provider or endpoint requires explicitly replacing or deleting its key.

Use a dedicated private directory for `TREX_HOME`, not a shared project folder.
These protections do not defend against a compromised OS account or administrator,
and permission checks do not provide an OS sandbox against hostile parent-path
changes. Never paste credentials into chat or project files; recognizable secrets
are removed from handoff packages, but redaction cannot identify every secret.

Ask mode prompts before each write or shell command. Plan is enforced read-only;
full allows autonomous mutations and unrestricted shell. Interactive commands:
`/history`, `/recover`, `/exit`. Ctrl+C interrupts a running turn. Resume with
`chat --conversation UUID`; discover conversations with `sessions list --json`.

Desktop integrations launch `trex-agent --profile NAME app-server`. See
[PROTOCOL.md](PROTOCOL.md) for the complete version 1 JSON-RPC wire contract,
image/inbox receipts, profile management, recovery, and tool boundaries.

Trex API exposes structured GitHub CLI tools to list repositories and pull
requests, inspect a PR, create a PR and merge a specified PR. Creating or
merging follows the session's mutation permissions; merge requires the reviewed
head SHA. Interrupted or uncertain writes require review before continuing.
The user's existing `gh` authentication is used and credentials are not printed.

Blender: `blender_open`, `blender_scene`, `blender_view`, `blender_exec`, `blender_render`
and `blender_undo` see and drive a Blender the user has open through Trex's own bridge
add-on (images come back to the model; the user can pause from Blender's status bar), and
`blender_run` executes a workspace Python script in a new background Blender process. The
same tools reach Claude Code, Codex and Antigravity through `trex-agent apps-mcp`.
HyperFrames: `hyperframes_project`, `hyperframes_docs`, `hyperframes_doctor`,
`hyperframes_check`, `hyperframes_snapshot` (frames come back as images), `hyperframes_render`,
`hyperframes_preview` and `hyperframes_init` run the installed HyperFrames CLI directly with
telemetry, update checks and automatic installs switched off; Trex never installs or updates
it and exposes no cloud, publish or sign-in command. Planning mode keeps only the read-only
tools (`blender_scene/view/render`, `hyperframes_project/docs/doctor/check`); everything else
follows the session's mutation permissions. Check the returned results and files.

Desktop access is separately opt-in: `session/start` accepts `desktopEnabled:true`.
The grant lasts only for that live session, and reopening without the flag revokes
it. Capture is available in planning mode; clicks, drag, scrolling, text and key
shortcuts follow normal mutation permissions and require confirmed model vision
and a fresh, one-use screenshot observation. The X11 implementation is tested
in an isolated virtual display. Wayland uses XDG ScreenCast/RemoteDesktop portals,
PipeWire and GStreamer, with consent from the system dialog. It never falls back
to XWayland input. Planning requests screen capture only; control requests keyboard
and pointer access. Grants are not persisted and closing a session revokes them.
Windows capture
and input use a scoped per-monitor DPI context and physical virtual-desktop
coordinates. `desktop_monitors` lists selectable screens; `desktop_screenshot`
accepts their `monitor` ID. Real input with multiple physical monitors remains
experimental. Elevated windows and secure desktops cannot be controlled.
Screenshots are private artifacts and are sent to the model provider when vision
is confirmed. Close active sessions to revoke their existing desktop access.

Claude Code and Codex can use a separate MCP process (`desktop-mcp --mode plan`
or `--mode full`). Its mode is fixed at startup; the app reconnects it when the
permission class changes. Planning advertises only screenshot, status, monitors
and bounded wait tools. Input tools use the host agent's approval policy. MCP request IDs are
deduplicated for the lifetime of the process; screenshot bytes are not retained
in the replay cache. MCP cancellation and owner EOF are handled during active
operations, without replay. A fresh screenshot is required after each input and
observations expire after 30 seconds; keyboard input also verifies foreground focus.
`desktop_move`, `desktop_click({clicks:2,...})`, horizontal scroll (`axis:"horizontal"`)
and gradual drag are supported. `desktop_wait` uses milliseconds, up to 10000.
`desktop-doctor --json` checks availability without a profile, capture or input;
the desktop app displays this diagnostic in Settings → Integrations.

Optional Trex Browser integration is explicitly enabled per app-server session:
`session/start` accepts `browser:{enabled:true,profile:"BROWSER1",clientId:"stable-tab-or-room-id"}`.
Omission keeps browser tools off, including after restore. The CLI discovers a
compatible fixed sibling executable or the per-user standalone installation;
it never searches `PATH`, installs components, starts a browser during probing,
or changes models automatically. Native tools continue working when the optional
component is absent. Plan, ask, and full map to broker observe, QA, and full
policy respectively, with existing approval and recovery rules preserved.

Screenshot results retain private artifact references in conversation history.
Only a selected model whose catalog metadata or exact documented official
MiniMax capability accepts image input gets verified image bytes in its outgoing
request. Unknown and text-only models get
DOM/log tools and artifact metadata with an explicit omission note. Restoring or
switching models reprojects the saved references; missing images never cause
the tool to repeat. Videos remain opaque broker artifact references. See the
protocol for artifact/event fields and operation cancellation semantics.

The model reads one lean copy of each browser/MCP result: Trex Browser
envelopes become the same agent view MCP clients get (`ok`, the result data,
`revision`, `error`) plus compact artifact references, and a text block that only
repeats `structuredContent` is dropped. Receipts, operation/project IDs, hashes
and provenance stay in the journal, `tool/result` events and the UI. Results over
48 KiB keep their head and tail. Agent screenshots default to JPEG quality 70
unless the model asks for `type`. Advanced browser tools are grouped
(`browser_devtools`: evaluate, mocking, emulation, frames, bodies, hover, drag,
mouse, uploads; `browser_capture`: video, traces, profiles, heap, artifacts;
`browser_session`: pause, takeover, cancel) and are only advertised after the
model calls `enable_tools({group})`. Enabled groups are appended to the end of
the tool list, persisted in the conversation and restored with it; deferred
tools remain callable within the session policy.

Servers and watches can use `shell({command,background:true})`. They remain
available between model turns; `process_list`, `process_output`, and
`process_stop` inspect or stop individual owned terminals. The desktop exposes
their count, recent output and stop control in the chat, including team members.
Closing this CLI stops its managed terminals. Restore does not restart them.

All tests use temporary workspaces and loopback mock providers. No real API key
or paid completion is needed. Windows binary and offline transport behavior are
tested here; Linux/macOS secure-storage runtime behavior requires their native
OS services and has not been exercised on Windows.


## API agent configuration and limits

`trex-agent config show` prints user-owned settings. `--profile NAME config show`
prints the merged settings for that profile. Pipe a document to `config set
--stdin-json` to validate and save it atomically in the private CLI home. This
file contains settings, never API keys. Project files cannot configure MCP
executables, shell authority, or desktop access. A session can override settings
with `session/start.settings`; standalone chat/exec accept `--settings FILE`.
See [settings.example.json](settings.example.json) for a partial document.
Unspecified fields keep their defaults. `profiles` contains partial overrides.

Default guards are 64 rounds, 64 HTTP attempts, 256 tool calls, 1,000,000 processed
turn tokens and one hour per turn. `limits.maxTurnTokens` counts tokens the
provider processed anew: uncached input plus output (prompt-cache hits re-read on
every tool round are not counted again); the next request is still reserved in
full. `maxConversationTokens` keeps counting total tokens. Configure `limits` to
change them, including
conversation token and estimated USD reservations. `provider.maxOutputTokens`
reserves and caps output; context metadata can reduce it. USD checks require
configured `provider.pricing` or catalog prices. A missing price does not mean
free. Reservations and context counts are approximate, not billing guarantees;
set a provider-side spending cap when an exact financial ceiling is required.
Token reservations persist across process restarts, including requests whose API
omits usage. Unmeasured legacy history or unpriced prior requests cannot silently
count as zero when a newly enabled conversation budget needs those values.

`provider.pricing` takes `inputUsdPerMillion` and `outputUsdPerMillion` plus the
optional `cachedInputUsdPerMillion` and `cacheWriteUsdPerMillion` (both default to
the input price; OpenRouter catalog cache prices are used when present). When a
provider reports no `usage.cost` (DeepSeek, MiniMax, most custom APIs) the cost is
computed locally from these prices, billing prompt-cache hits at the cached price,
and the usage is marked `costEstimated: true`. Session usage also includes
`byModel`, the measured totals per model.

Anthropic (`"provider":"anthropic"`, default base URL `https://api.anthropic.com/v1`)
talks to the native Messages API with an `sk-ant-…` API key sent as `x-api-key`,
so spend and credits are those of the key's organization. The CLI keeps its
OpenAI-shaped history and translates only at the transport: system prompt,
tool definitions and results, images, streamed text, summarized adaptive
thinking and `output_config.effort` (only the levels the model catalog
declares). Automatic caching plus a system-prompt breakpoint are always on, and
usage is reported as input + cache reads + cache writes, so the usage panel and
budgets see the real figures. Thinking blocks are shown but never sent back (the
history is edited between turns, which Anthropic would reject), `temperature` and
`top_p` are refused, and a stream that ends without `message_stop`, a refusal or an
output limit never executes tools. Built-in prices are listed only for models with
a single flat rate; for any other model set `provider.pricing`.

Prompt caching: DeepSeek, OpenAI, Gemini 2.5+, Grok and similar providers cache
prompt prefixes automatically, so nothing is added. For OpenRouter `anthropic/*`
models the request adds top-level automatic `cache_control` (the breakpoint moves
with the conversation) and a breakpoint on the system prompt, two of Anthropic's
four. OpenRouter requests also carry the conversation ID as `x-session-id`, so
OpenRouter keeps the conversation on one upstream provider (and its cache) from the
first request, even after a compaction rewrites the opening messages. Unknown
fields are never sent to other providers. The system prompt, tool list and
history projection are kept stable within a turn so caches survive the tool loop;
across user turns the only deliberate change is archiving old tool results (over
1 KiB), done in batches (`archiveAboveTokens`). A test checks that every other
request only appends to the previous one. Measured with a simulated provider over
8 turns against archiving at every turn: batches cost 30% less input on DeepSeek
Flash and 19% less on Anthropic 5.5 in light sessions (no cache break at all), and
17% / 10% less with heavy tool use (2 breaks instead of 6). Never archiving matches
batches in light sessions but costs 44–60% more with heavy tool use, because the
context reaches `maxActiveTokens` and compaction rewrites the prompt every turn.
Providers that bill a cache hit at 10% (MiniMax, OpenAI up to GPT-5.5) pay 4–6%
more with batches; `"archiveAboveTokens": null` restores per-turn archiving.
Against DeepSeek itself, a 5-turn session kept 98.5% of the prompt cached at each
new user turn without archiving, versus 41% when archiving every turn.

Measuring the cache: every provider request stores a sample (prompt tokens, hit,
miss and write counters, hit rate) in the conversation journal.
`trex-agent sessions cache UUID [--json]` prints the series and the hit rate
overall, for the first request of each user turn (where the history projection is
rebuilt) and inside tool loops. It is read-only and works while the conversation is
open. `continuity` is the share of the previous request's prompt that this one read
from the cache, so it drops when something early in the prompt changed. Counters a
provider does not report stay empty, never zero, and requests without a cache counter
are left out of every hit rate. The app shows the same rate in the usage menu and in
each response's token breakdown. DeepSeek's `prompt_cache_hit_tokens` and
`prompt_cache_miss_tokens` are read directly. `metrics --json` (with diagnostics on)
adds `cacheHit`, `cacheMiss` and `cacheWrite` per request and a `cache` summary.

Context preflight reserves output and headroom. Automatic extractive compaction
archives complete tool batches, keeps recent work and records its cutoff. It
makes no extra paid summarization call. `/compact` and the app's context menu
also compact while idle. Original messages, artifacts and task state stay on
disk; `history_search` and `task_state` recover details omitted from the extract.
The UI shows measured provider usage separately from internal estimates.

Context settings that bound what is re-sent on every request:

- `context.maxActiveTokens` (default 128000; `null` disables): compaction starts
  when the estimated request exceeds it, even for 1M-token or unknown windows,
  in addition to `thresholdPercent` of a known window. When recent turns alone
  exceed it, older completed tool batches of the current turn are summarized too.
- `context.fallbackWindow` (default 128000): the window assumed for models whose
  window is not in the catalog or documentation. An explicit `null` keeps it
  unknown (no window preflight; `maxActiveTokens` still applies).
- `context.clearToolResultsAfterTurns` (default 2; `null` disables): at the start
  of a user turn, tool results from turns older than this and larger than 1 KiB are
  replaced in the request by a short placeholder with a preview and their
  `messageIndex`. Call/result pairing is unchanged, the journal keeps the result,
  and `history_search({messageIndex, offset})` pages it back. Within a turn the
  projection never changes, so prompt caches hold during the tool loop.
- `context.archiveAboveTokens` (default 64000, capped at half of
  `maxActiveTokens`; `null` archives at every turn): archiving moves in batches.
  While the history stays under it nothing more is archived, so each user turn
  only appends to the cached prefix; above it, every result older than
  `clearToolResultsAfterTurns` is archived at once. The boundary is kept in the
  conversation journal and never moves back.
- `context.maxHistoryImages` (default 3, max 16): screenshots and attachments
  re-sent from earlier turns, chosen once per user turn. Images produced in the
  current turn keep between that many and two more: the oldest leave three at a
  time, so a new screenshot does not rewrite the prompt cache on every request.
  Older images become a short text note.

Model-facing output caps (journal, UI and `history_search` keep the stored text):
shell stdout+stderr 32 KiB, `process_output` 32 KiB (tail-biased), `git_diff`
48 KiB, browser/MCP results 48 KiB and any other result 64 KiB, each keeping head
and tail with a marker of the omitted bytes. Shell and Git capture keep the first
quarter and the last three quarters of 64 KiB per stream, so failures at the end
of build/test output are never lost. `read_file`, `list_files` and `search` cap
each page at 64 KiB and keep their paging.

Explicit HTTP 429/503 responses can retry before any successful stream, honoring
numeric or HTTP-date Retry-After with a bounded delay. Partial streams, ambiguous
transport failures and tool executions never retry automatically. Failures expose
finite `errorDetails` codes and keep any measured usage. Timed-out or interrupted
mutations require review and `/recover`; restoring a conversation never reruns
those tools. Streaming deltas use a recoverable sidecar journal; durable checkpoints
are written at operation boundaries instead of rewriting all history per fragment.

For custom compatible APIs, enable optional usage frames with
`provider.customStreamUsage`, choose `customOutputParameter` (`max_tokens` or
`max_completion_tokens`), and explicitly map effort using `customEffortParameter`
(`reasoning_effort` or `reasoning.effort`). No unsupported mapping is guessed.
Temperature and top-p are optional; unsupported adapter parameters fail clearly.
Model catalogs keep tool support and pricing when provided and filter explicitly
non-text OpenRouter models. Standalone chat/exec load metadata before starting.

## Workspace instructions, files and checkpoints

Root/ancestor `AGENTS.md` files are loaded in full each turn (32 KiB each, 64 KiB
total). Nested `AGENTS.md` files that pass the privacy policy are only listed by
relative path (up to 32 paths / 4 KiB, sorted); the agent reads the relevant one
with `read_file` before working in that directory, where it takes precedence.
Reasoning (`reasoning_content`/`reasoning_details`) of earlier turns is still sent
back unchanged: DeepSeek documents that requests with tools must pass back the
reasoning of all previous turns (a 400 error otherwise), and MiniMax asks for the
complete assistant message in tool-call history. Native file tools respect
`.gitignore`, `.trexignore`, sensitive-file defaults and link/path checks. `.env`,
private keys and common credential locations are excluded. `privacy.allowPaths`
allows an exact workspace-relative file explicitly; `allowSensitiveFiles` and
`respectGitignore` are user configuration choices. Git diffs filter private paths,
including tracked environment files. Full shell and trusted external MCP servers
are not an OS sandbox and can access anything available to the operating user.

`edit_file` replaces exactly one matching fragment, preserving the rest of the
file and its line endings; optional `expectedHash` guards an earlier read.
`make_directory`, `rename_file` and `remove_file` handle explicit native file
operations. Renames refuse to overwrite another destination. `git_status` and
`git_diff` inspect Git without external diff/text conversion or optional locks.
Independent read-only native batches can run in parallel, with a configured bound.
Unavailable or disabled optional GitHub/Blender/HyperFrames integrations are omitted.

Native text edits, writes, patches, renames and removals create private checkpoints
by default. Review them through `checkpoint_list`, `checkpoint_diff`, or:

```
trex-agent changes list --cwd PATH
trex-agent changes diff UUID --cwd PATH
trex-agent changes restore UUID --cwd PATH
```

Restoration checks every recorded destination first and refuses later changes.
An interrupted partial restoration requires inspection. Checkpoints cover native
UTF-8 file tools, not shell/Git changes or directories, and are bounded to 8 MiB.

## Interactive CLI, automation and session management

Chat has command completion, multiline input (a trailing backslash continues),
and bounded private input history. `/model`, `/effort`, `/mode`, `/models`, `/usage`,
`/compact`, `/history`, `/recover`, `/processes`, `/output ID`, `/stop ID` and
`/send ID TEXT` work without restarting the executable. Changing permission mode
reopens the session and stops its owned background jobs. `/attach PATH` queues a
UTF-8 file or PNG/JPEG/GIF/WebP image for the next message; `/clear-attachments`
removes pending attachments. `--attach PATH` can be repeated for chat or exec.
Image delivery still requires model vision support. PDFs need text/image conversion.

```
trex-agent --profile NAME exec "Review the project" --mode plan --json
trex-agent --profile NAME exec --file task.txt --mode full --settings limits.json
trex-agent --profile NAME chat --browser --browser-profile BROWSER1 --desktop
```

`exec` also accepts piped text. JSON emits newline-delimited protocol events.
Exit codes: 0 success, 2 failed, 3 approval required, 4 interrupted, 5 uncertain
execution requiring review, 6 budget reached. Automation never silently approves
ask-mode mutations. `full` must be selected explicitly for unattended mutations.

Background shell supports `interactive:true` for piped input and `pty:true` for a
real PTY (ConPTY on Windows). `process_write`, `process_resize` and incremental
`process_output({id,after})` use session-owned opaque IDs. Output is bounded to
64 KiB, offsets do not split valid UTF-8, and activity notifications are throttled.
Only that CLI's process trees can be stopped. The app's terminal panel supports
input for interactive Trex terminals. Shell output/input is UTF-8 on Windows.
Minimal child environments omit provider credentials by default; choose explicit
`shell.forwardEnv` names or an intentional `environment:"inherit"` when needed.

```
trex-agent sessions export UUID --format markdown --output conversation.md
trex-agent sessions fork UUID
trex-agent sessions remove UUID
trex-agent sessions restore UUID
trex-agent artifacts gc
trex-agent artifacts gc --apply
```

Close a conversation before managing it. Remove moves it to recoverable private
trash. Artifact cleanup is a dry run unless `--apply`; it refuses active storage
and preserves references in both live journals and trash. Forks keep history and
recovery requirements without replaying actions. Exports contain conversation
content and should be stored in a suitable private location.

## MCP and diagnostics

`mcp add --stdin-json` accepts a server object with a name, absolute executable,
args, environment variable **names** and optional `readOnlyTools`. `mcp list` and
`mcp remove NAME` manage defaults; per-profile overrides use the config document.
Only explicitly configured servers launch. No command is read from project files.
Stdio MCP supports initialization, bounded pagination, tool calls, roots and
shutdown. Sampling, elicitation, arbitrary callbacks and HTTP MCP are unavailable.
Planning requires both a user read-only whitelist and the server's readOnlyHint;
annotations alone grant no permission. Ask prompts for other calls. Credentials
forwarded through configured env names are redacted from results. These are trusted
local executables, not a sandbox against a malicious MCP server.

Initialization, schemas, response sizes and calls are bounded. Cancellation or an
uncertain result closes the connection, stops its owned tree and blocks automatic
replay. A failed optional server leaves native tools usable and appears in the
session's `unavailableMcpServers` list.

`doctor --json` checks configuration, binaries and desktop prerequisites without
paid completions. `--profile NAME doctor --connect --json` also fetches models.
Wayland diagnostics probe portal interfaces and GStreamer plugins without asking
for capture/input consent. `diagnostics:true` enables bounded, local-only request
metrics; `metrics --json` shows durations, state and numeric usage, without prompts,
headers, tool output or credentials. No telemetry is sent.

## Repeatable provider evaluations

```
trex-agent --profile NAME eval --suite examples/evaluation.json --mode full --output results.json
```

This explicit command calls the chosen provider and can incur API charges.
Tests use a loopback provider; no real paid evaluation is run during development.
Each case gets a fresh temporary workspace, initial files, exact expected files
and expected answer fragments. Reports include pass/fail, timing, usage, errors
and durable conversation IDs. Optional external tools and desktop/browser grants
are disabled for evaluations; normal profile limits still apply per case. Shell
in full mode remains unrestricted by the OS, so use trusted suites. Cases are
sequential and never rerun automatically. Compare reports from the same suite and
model configuration; mock transport tests do not establish real-model task quality.
