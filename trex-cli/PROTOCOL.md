# Trex Agent protocol 1

`trex-agent --profile NAME app-server` speaks JSON-RPC 2.0 over stdin/stdout.
Each UTF-8 JSON value occupies one line; stdout contains protocol frames only.
Maximum frame size is 32 MiB. A request has `jsonrpc`, `id`, `method`, and an
object `params`. Responses contain `result` or `error`. Notifications omit `id`.
IDs may be strings or numbers. Reusing a live request ID with different input is
an error. The connection caches up to 16,384 request results; completed entries
can expire. Durable turn deduplication uses `sessionId` + `messageId` across
connections and process restarts, independent of the connection request cache.

## Management commands

```
trex-agent --version
trex-agent profiles list --json
trex-agent profiles save --stdin-json
trex-agent profiles remove NAME
trex-agent --profile NAME models list --json
trex-agent models list --json --stdin-json
trex-agent [--profile NAME] sessions list --json
trex-agent --profile NAME chat [--mode ask|plan|full] [--cwd PATH]
trex-agent --profile NAME chat --conversation UUID
```

`--profile` is global and can appear after the command. Profile save reads one
JSON object from stdin and prints a summary object:

```json
{"name":"TREX1","provider":"deepseek","model":"deepseek-v4-pro","effort":"high"}
```

Supported providers: `deepseek`, `minimax`, `openrouter`, and `custom`. Optional
`baseUrl` overrides the standard provider endpoint; custom requires it. HTTPS
is required except for loopback HTTP mock servers. URLs cannot include embedded
credentials, queries, or fragments. Optional `apiKey` is accepted **only on
stdin**: omitted retains the current key, empty string deletes it, a nonempty
string replaces it. No key is ever returned by a management command. Names are
case sensitive, with case-insensitive collisions rejected.

Profile summaries are `{name,provider,baseUrl,model,effort?,hasApiKey:boolean}`.
`profiles list --json` returns an array. `models list --json` returns `{models}`.
`sessions list --json` returns an array of
`{id,title,cwd,updatedAt,provider:"trex",messageCount,profile}`; `updatedAt` is
Unix milliseconds.

### Strict remote model discovery

`models list --json --stdin-json` reads one JSON object, limited to 1 MiB:

```json
{"name":"TREX1","provider":"deepseek","baseUrl":"https://api.deepseek.com"}
```

`provider` is required. `name`, `baseUrl`, and `apiKey` are optional; no model is
required or accepted. Present fields must be strings; null and other fields are
rejected. A custom provider requires
`baseUrl`; other providers use their standard endpoint when it is omitted or
empty. The same URL security rules as profile saving apply. `--profile` cannot
be combined with `--stdin-json`.

When `apiKey` is omitted, `name` selects a stored credential only after the
requested provider and canonical model endpoint match that saved profile.
Canonical matching accounts for URL host casing, default ports, and trailing
slashes. An explicit `apiKey` is transient, overrides any stored key, and does
not read or modify stored credentials or profile metadata. An explicit empty
string sends no key. Non-loopback endpoints require a key.

The command performs an actual authenticated `GET /models` and returns:

```json
{"models":[{"id":"returned-model-id","name":"Returned model name"}],"source":"remote"}
```

Model entries use the same normalized fields as `models/list` below. OpenRouter
entries whose explicit `architecture.output_modalities` excludes `text` are
filtered out. Unknown capabilities remain omitted. Neither an unsupported
endpoint nor an empty catalog produces a configured or static model fallback.
A returned catalog describes provider metadata; it does not establish that a
credential is entitled to invoke each model.

The request has a 10-second deadline, a 5-second connection limit, and a 4 MiB
response limit. Normalized stdout is limited to 1 MiB. Redirects and automatic
retries are disabled. Invalid responses, including credential echoes in returned
model fields, are rejected without printing upstream content.

On failure the command exits with status 1 and emits only this safe stdout form:

```json
{"error":{"code":"unauthorized"}}
```

The finite codes are `unauthorized` (HTTP 401), `forbidden` (403), `unsupported`
(redirects, 404, 405, or 501), `unavailable` (transport failure, deadline, secure
credential read failure, or other unsuccessful HTTP status), `invalid_request`
(input, URL, saved profile binding, or missing credential), and `invalid_response`
(malformed, oversized, empty, or unusable catalog). Error envelopes contain no
provider body, supplied value, credential, URL, or free-form error message.
The older saved-profile command and app-server `models/list` retain their
compatibility behavior, including the configured-model fallback for a custom
provider without a discovery endpoint.

`TREX_HOME` overrides the data directory (default OS application data directory
`trex-agent`). Profile metadata contains no key. Windows keys use current-user
DPAPI; macOS uses Keychain; Linux uses persistent Secret Service and requires a
working OS secret service. Storage failures are errors; there is no plaintext
or ephemeral fallback. Conversation journals contain prompts, image data,
provider reasoning, file/tool results, and rendered history; protect that data
directory as private conversation data.

## Requests

`initialize {protocolVersion?:1}` returns
`{protocolVersion:1,profile,models,capabilities}`. It does not issue HTTP requests.
Its initial models array contains the configured model, including a known
context limit and `contextWindowSource` without discovery; call `models/list`
for provider metadata. Capabilities include streaming, tools, permissions,
interrupt, history, inbox, images, sessionRecovery, and supported modes.

`models/list {}` returns `{models:[{id,name,contextWindow?,contextWindowSource?,efforts?:string[],inputModalities?:string[]}]}`.
Only actual provider metadata or documented capabilities of exact known model
IDs are advertised. Unknown capabilities are omitted. Custom providers without
a model endpoint fall back to the configured ID without inferred capabilities.
Remote context metadata takes priority. Missing context is filled only for exact
documented model IDs on their verified official provider endpoint: MiniMax
`MiniMax-M3.1-Flash` and `MiniMax-M3` use exactly 1,000,000 tokens at
`https://api.minimax.io/v1` (including the default endpoint). Proxies, custom
providers, OpenRouter IDs, and similar model names do not inherit this limit.
`contextWindowSource:"documented"` identifies that fallback; an absent source
on a discovered context limit means remote metadata. OpenRouter uses the lower
of root context capacity and `top_provider.context_length`, when both exist;
`max_completion_tokens` is never a context limit. Successful catalogs are cached
for session summaries; a failed refresh preserves the previous cache.

The same official endpoint and exact MiniMax IDs use documented
`inputModalities:["text","image","video"]` only when the catalog omits input
modalities. Explicit remote modalities, including text-only, take priority.
This fallback is verified against the official
[OpenAI-compatible multimodal input documentation](https://platform.minimax.io/docs/api-reference/text-openai-api).
Proxies, custom providers, OpenRouter IDs, and similarly named models receive
no inferred image support.

`session/start {cwd,mode,model?,effort?,conversationId?,instructions?}` returns
`{sessionId,conversationId,model,effort,mode,items,recoveryRequired,contextWindow,contextWindowSource,usage?,instructionsApplied}`. `cwd` must
exist. Modes: `plan`, `ask`, `full`; `auto` and `default` alias `ask`. `items` is a
normalized ChatItem array with durable stable IDs. A live session has a fixed
workspace and mode. A fresh process can explicitly select another mode while
restoring the same conversation. A conversation is bound to its original
profile name, provider, base URL, and canonical workspace; mismatches fail.
Rotating a key or changing a profile's default model does not change that binding.
Optional `instructions` supplies nonempty client guidance (maximum 32 KiB UTF-8,
no NUL). It is inserted into the actual provider's system message for every
request; `instructionsApplied:true` acknowledges that binding. It cannot change
while the session is live and cannot alter tool permissions. It is not persisted
in the conversation journal: a restoring client must explicitly send current
guidance again. Omission returns `instructionsApplied:false`. The desktop app
requires a positive acknowledgement before sending user work.
`contextWindow:number|null` and
`contextWindowSource:"remote"|"documented"|null` describe the selected model,
using cached metadata and the documented fallback without another HTTP request.
Nonempty histories also return
`usage:{contextTokens?:number,contextWindow?:number,contextModel:string,totalTokens:number}`.
The latest turn's valid measurement is selected using durable completion-event
order, with timestamps/history as a fallback. A later unknown measurement clears
an earlier one. Missing/invalid counters remain unknown: `contextTokens` is
omitted, rather than reported as zero. `totalTokens` sums each durable turn's
valid input/output counts once. `contextModel` and any usage `contextWindow`
belong to the measured model and can differ from the selected model on restore.
`usage.byModel?:{[model]:ApiUsage}` adds the measured totals per recorded model.
`apiUsage.costEstimated?:true` marks a `costUsd` computed locally from
`provider.pricing`/catalog prices because the provider reported no cost; it is
not a provider bill.
Existing version-1 journals remain loadable; historical missing counts are not
estimated.

`imageSupport:true|false|null` describes the selected model using cached
`inputModalities` or exact documented official MiniMax capabilities; unknown
support stays unknown. These checks never invoke a
model or switch the selected model.

### The person's own browser (optional)

The tool registry combines `NativeToolProvider` with an optional
`ChromeProvider`: the Trex extension in the person's Chrome, Brave or Edge,
reached through the app's local bridge, an MCP server over HTTP with JSON
responses. The app enables it per process with two environment variables:
`TREX_CHROME_URL` (exactly `http://127.0.0.1:<port>/mcp`, port 1024 or above) and
`TREX_CHROME_TOKEN` (the chat's token, 16 to 512 header-safe characters). Without
both there are no browser tools and no request is made. If they are set but
unusable, or the bridge does not answer `initialize` and `tools/list` within 10
seconds when a session starts, the summary returns `chromeEnabled:false` and
`unavailableMcpServers` contains `trex_chrome`; native tools keep working.
Otherwise it returns `chromeEnabled:true` (also when reattaching). Restoring a
conversation in a process without the variables restores no browser access.
Evaluation suites never inherit it.

The client sends `initialize` (protocol `2025-11-25`; the bridge may answer
`2024-11-05`, `2025-03-26`, `2025-06-18` or `2025-11-25`),
`notifications/initialized` and `tools/list` (up to 64 tools, 8 pages, 256 KiB of
schemas). Every request is a `POST` with `Content-Type: application/json`,
`MCP-Protocol-Version` and `Authorization: Bearer <token>`, and no `Origin`. The
token never travels in a body, URL, error, event, journal or model request; a
token echoed in a result is replaced with `[redacted credential]`. Environment
proxies and redirects are not used. Shell commands (and inherit-mode PTYs) never
receive `TREX_CHROME_TOKEN`.

Each bridge tool `NAME` is advertised to the model as `browser_NAME`
(`browser_tabs_list`, `browser_read_page`, `browser_screenshot`,
`browser_navigate`, `browser_click`…) with its own schema; names outside
`[a-z][a-z0-9_]*` or schemas that are not objects are left out. The bridge's
`instructions` are added to the system guidance. A tool only reads when it is in
the fixed list `tabs_list`, `read_page`, `screenshot`, `wait_for` and the bridge
marks it `readOnlyHint:true`. Plan mode advertises and accepts only those; ask mode uses
the ordinary permission flow for every other browser tool; full mode runs them.
The bridge enforces the chat's mode again on its side.

`tools/call` has 90 seconds (the bridge answers by itself after 60). A result
must be `{content:[{type:"text",text}|{type:"image",mimeType,data}],isError?}`;
`isError:true` (for example, the extension is not connected) is an ordinary
tool error and the turn continues. Not reaching the bridge, HTTP 401 (expired or
revoked chat token), any other HTTP status and JSON-RPC errors are ordinary
errors too: nothing reached the browser. A timeout, a broken connection, invalid
JSON or an invalid result after the request left are ordinary errors for the
reading tools, but for any other tool they stop the turn and require explicit
recovery acknowledgement, like a cancelled action: it is never replayed.

MCP tool results normalize to
`{text,structuredContent?,artifacts:ArtifactRef[],isError?}`. A text block whose
JSON equals `structuredContent` (the MCP convention) is not stored again, so
`text` may be empty. The model receives a lean projection only: structured
results become `{result}`, plus `text` (remaining text and artifact notes), compact
`artifacts:[{artifactId,kind,mimeType,width?,height?}]` and `isError`. Operation
IDs, hashes and provenance stay in `tool/result` events and the journal. Native
tool JSON retains its existing shape. An artifact reference is
`{id,sha256,mimeType,sizeBytes,width?,height?,kind,storage:"local",provenance}`;
only typed image content becomes one.
`tool/result` includes a top-level `artifacts` array, and projected tool history
items expose the same metadata. Image bytes are stored in the private
`TREX_HOME/artifacts` content-addressed store. Screenshot base64 and data URLs
never enter normalized tool results, journal messages, or events. Artifact
references contain no host paths.
Local images must pass MIME-matched pixel decoding before storage and on each
rehydration. PNG validation also checks chunk CRCs, complete image data and the
zlib stream ending. A malformed image leaves an explicit unavailable-artifact
note and is never projected into an outgoing provider image.
A reference with any other `storage` (older journals) is reported as
unavailable and never fetched.

Immediately before a provider request, the CLI rehydrates verified local image
references only when the selected model is explicitly known to accept images.
Every tool result remains text in role `tool`; a separate user observation with
the tool call and artifact IDs (provenance stays in the journal) follows the entire
consecutive tool-result batch.
Image replay selects the newest evidence within a shared 16-image/16-MiB
request budget while retaining original message and tool-result order. Earlier
turns keep `context.maxHistoryImages` images, fixed for the whole turn. In the
current turn the oldest images leave three at a time (between `maxHistoryImages`
and `maxHistoryImages + 2` are kept), so a new screenshot does not change the
projected prefix and its prompt cache on every request.
Text-only and unknown models receive artifact metadata and an explicit image
omission note, so they cannot claim pixel inspection. Model changes reproject
the original durable history without another tool call. Missing/corrupt/unsafe
artifacts produce an explicit unavailable-evidence note and never repeat the
originating tool.

On restore, omitted/null model and effort retain the persisted selection. New
sessions use the profile defaults. An explicit model change resets the previous
model's effort unless a non-null effort is also supplied. An explicit unsupported
effort fails rather than being silently translated. `null` means no new override.

`turn/start {sessionId,messageId,text,display?,images?,model?,effort?}` returns
`{accepted:true,sessionId,messageId}`. `messageId` is the client's local **user**
message ID. At most one turn runs in a session. `display` affects the rendered
user item only; the provider receives `text`. Each image is
`{mediaType:"image/png"|"image/jpeg"|"image/webp"|"image/gif",data:BASE64}`.
Images are sent as multimodal image URLs, never as preview strings. Maximum 16
images and 24 MiB base64 per message; text is limited to 8 MiB. A duplicate turn
with identical input returns `{accepted:true,duplicate:true,status,...}` without
another provider call or tool execution. Different input with the same message
ID is rejected. Terminal duplicate turns also replay `turn/completed`.

`turn/interrupt {sessionId,messageId?}` returns `{interrupted:boolean,messageId?}`.
Provider streams, pending permissions, inbox callbacks, and shell process trees
are cancellable. A terminal event follows. Control requests are dispatched in
stdin order while provider/tool work runs separately.

`permission/respond {id,allowed:boolean}` returns `{accepted:true}`. The aliases
`decision:"allow"|"deny"` are also accepted. Responses must match a live permission.

`session/history {sessionId}` returns the same shape as `session/start`.
`sessions/list {}` returns `{conversations:[...]}` for the selected profile.

`session/recover {sessionId,action:"acknowledge"}` explicitly clears a restoration
pause after the user has inspected an uncertain mutating tool. It returns the
session summary. The old tool is never automatically executed again.

`shutdown {}` cancels active turns. Closing stdin also cancels and flushes them.

## Notifications

Every turn notification includes `sessionId` and the local user `messageId`:

- `turn/started {sessionId,messageId}`
- `message/delta {sessionId,messageId,id,text,kind:"text"|"thinking"}`
- `tool/start {sessionId,messageId,id,toolName,input}`
- `tool/result {sessionId,messageId,id,output,isError:boolean}`
- `permission/request {sessionId,messageId,id,toolName,toolUseId,input,description}`
- `turn/completed {sessionId,messageId,status:"completed"|"interrupted"|"failed",error?,usage?,recoveryRequired?}`
- `inbox/consumed {sessionId,messageId,receiptId}`

Assistant block IDs and tool IDs remain stable in history. Deltas append to their
block; thinking is separate from visible final text. Tool `output` is a JSON
value. Usage may contain `inputTokens`, `outputTokens`, `contextTokens`,
`contextWindow`, `contextModel`, and `costUsd`; input/output sum valid provider
request counters within the turn. `contextTokens` is the final request's input
plus output, including cached input once and thinking already included in the
completion count. It does not accumulate tool-chain requests. Missing final
counters omit `contextTokens`, even when an earlier request reported usage.
`contextModel` identifies the request model; `contextWindow` is included when
known. Cost is included only when reported upstream. No model price or unknown
context capacity is estimated.
Completed provider responses save measured usage before tools execute. A later
tool failure or cancellation retains those token/cost measurements in the
terminal event and journal. Starting another provider request makes its context
unknown until new counters arrive; earlier measured token totals remain counted
once, including after duplicate requests or restore.

## Durable inbox callback

The model's native `trex_read_messages {}` tool causes a **server request**:

```json
{"jsonrpc":"2.0","id":"inbox:UUID","method":"inbox/read","params":{"sessionId":"...","messageId":"..."}}
```

The host responds using that ID:

```json
{"jsonrpc":"2.0","id":"inbox:UUID","result":{"receiptId":"receipt-1","messages":[{"id":"queued-user-id","text":"Additional instructions","images":[],"previews":[]}]}}
```

An empty snapshot may omit receiptId. Compatibility form: each message contains
its own `receiptId`. The host can return a JSON-RPC error when unavailable.
Callbacks time out after 60 seconds and remain interruptible. Standalone chat
supplies an empty inbox.

The server validates the entire snapshot, stores its receipt and stable UI user
items, records the tool result, and appends actual user multimodal messages after
the entire tool batch. Preview strings never enter provider messages.
`inbox/consumed` is emitted only after that commit is durable. Repeating an
already committed receipt verifies identical content and emits consumed again
without adding messages twice. The host should acknowledge its queue only on
that notification, allowing recovery after a lost acknowledgement.

## Tool policy and recovery

Native tools: `read_file`, `list_files`, `search`, `write_file`, `apply_patch`,
`shell`, `trex_read_messages`. Plan exposes only native read tools and inbox, and
also rejects mutations even if a provider attempts to call them. It never runs
free shell commands. Ask requires per-call approval for writes, patches, and
shell. Full is explicit autonomous mutation and unrestricted shell access.

Workspace paths are canonicalized and checked; traversal, symlinks/reparse
points, Windows device/ADS paths, and escapes are rejected. Checks are not an OS
sandbox against hostile concurrent directory replacement. Full shell is not
filesystem confined. Native reads and searches are bounded. Write parents must
already exist; `make_directory` creates one explicit directory. Shell timeout is bounded
and kills its process tree on Windows.

`apply_patch` takes a strict JSON **string** in `patch`:

```json
{"files":[{"path":"file.txt","before":"exact current entire text","after":"new entire text"}]}
```

`before:null` creates a file. Deletes and fuzzy matching are unsupported. All
paths/preconditions are validated before writes. Replacements are atomic per
file; an OS failure during a multi-file commit reports which files committed.

Provider POST requests are never automatically retried. Incomplete/filtered
responses fail the turn and never execute their tool calls. Provider-native
assistant reasoning is retained, including opaque reasoning fields. A crash
during execution is journaled as uncertain, pauses resumed mutations until
explicit acknowledgement, and never automatically replays the tool. Journals
are exclusively locked to prevent concurrent processes opening one conversation.

### Optional app-owned teams

`session/start` may include immutable `team:{command:absolutePath,args:string[]}`
and `roleInstructions:string` (up to 8 KiB). Both default to absent on every
process, including restore. A team coordinator must use `mode:"plan"`. The
command must be the fixed Trex app sibling of this CLI; args are exactly
`["--trex-team-call",absoluteAppDataRoot,teamId,epoch]`. No model-selected executable,
credential or workspace is accepted. The app supplies this configuration only to
the principal. Success includes `teamEnabled:true` and, when instructions were
supplied, `rolePolicyApplied:true`; neither changes the journal schema.

The principal gains `trex_team_members`, `trex_delegate_task`, `trex_task_status`
and `trex_team_plan`. Native workspace tools remain read-only. Collaborators use
separate conversations and do not inherit the team tool provider. A stable
`taskKey` deduplicates identical delegations across cycles; uncertain/cancelled
work never automatically replays. Delegation waits for the app to deliver the
task and persist its report, bounded to 30 minutes. The app maintains a live
lease independently of provider acknowledgements. Stop, lost ownership, an
uncertain reply or transport failure ends delegation with recovery required.
Measurements already received remain accounted for.

The tool definitions mirror the app protocol: `trex_task_status({taskId?,waitMs?,
detail?:"compact"|"full"})` returns compact statuses and delivers each new report
once (a delivered report returns as `reportPreview` with `reportDelivered:true`;
`detail:"full"` adds the instruction and full report); coordinators end their
turn instead of polling, since the app opens a new turn when delegations finish.
`trex_team_plan` returns `{published,issued,steps:[{taskKey,memberId,dependsOn?,
taskId?,status?}]}`; `trex_delegate_task` returns `{taskId,status,member,task:{id,
status},awaitCoordinatorTurnEnd?,usage?,report?}` and the CLI still reads
`task.status` for uncertain/cancelled results. The journal keeps the bridge's MCP
response; the model receives only its `structuredContent` (plus `isError:true`),
never the wrapper or a duplicated text copy.

Task histories and provider histories are separate. Report/argument bounds and
configured member/policy checks are enforced in the app bridge. The bridge
inherits only the operating-system environment needed to run; provider API keys
and `TREX_HOME` are not forwarded. A restored app team starts paused and uses a
fresh epoch only after explicit review. No task is dispatched merely by
restoring the provider conversation.

### Optional session coordination

`session/start` may include immutable `coordination:{command:absolutePath,args:string[]}`
so the session can work alongside other Trex sessions of the same project. It
defaults to absent on every process, including restore. The command must be the
fixed Trex app sibling of this CLI (same rules as the team bridge); args are
exactly `["--trex-inbox-mcp",absoluteAppDataRoot,queueId,"--peers-only","--peer",
sessionId,projectDir]`, where `projectDir` must resolve to the session's `cwd`.
The CLI connects the app's MCP server in its coordination-only mode; success
includes `coordinationEnabled:true`, and a server that cannot connect reports
`coordinationEnabled:false` plus `trex_coordination` in `unavailableMcpServers`
while the session continues without it.

The model gains `trex_peers`, `trex_claim`, `trex_release` and `trex_message`
under those exact names, with the server's guidance in the system message.
They only touch the app's coordination registry, never the workspace: they are
advertised in every mode, including plan, and need no approval in ask. Nothing
blocks or waits; the app wakes an idle chat when another session writes to it.
A failed or interrupted coordination call is an ordinary tool error and never
requires recovery.

### Background terminals (runtime state)

Authorized `shell` calls may set `background:true` and omit `timeoutMs` to keep
servers, watches and monitors running between turns. The result contains an
opaque `id`, command, cwd, startedAt, status and nullable exitCode. The operation
ID is reserved once; replay does not spawn a second process, including after the
terminal finishes. At most 16 terminals run concurrently and 256 IDs are retained
per live session. Plan mode does not advertise shell or process_stop.

The model can use `process_list({})`, `process_output({id})` and
`process_stop({id})`. The desktop uses the same session-owned manager directly:

- `process/list({sessionId}) -> {processes:[{id,command,cwd,startedAt,status,exitCode}]}`
- `process/read({sessionId,processId}) -> {text,truncated,status}`
- `process/stop({sessionId,processId}) -> {terminated:boolean}`

IDs are opaque, not OS PIDs. A foreign session's ID is rejected. Output is a
bounded 64-KiB tail of combined stdout/stderr, kept only in this runtime. Stop
waits for process-tree shutdown; repeated stop of a finished terminal returns
false. Finishing or interrupting a model turn leaves previously started
background terminals available. EOF, shutdown, and Unix termination signals
cancel active turns and close background terminals. Restore starts with an
empty process registry and never replays a background launch from history.
Background terminals are intended for managed foreground commands such as
`npm run dev` or test watches, not shell commands that daemonize themselves.

### Visible plans

`trex_team_plan({steps:[{taskKey,memberId,task}]})` publishes 1–32 assigned steps
without enqueuing work. The entire input is bounded to 48 KiB. The app stores
the plan atomically beside durable delegation records. A later delegation uses
the same key, member and instructions. Published steps have no model-supplied
completion field: progress is projected from confirmed delegation results.
Updating a plan cannot change or hide work already issued in the current cycle.
Missing `plan` in older app snapshots means an empty plan. Restore never issues
unstarted plan steps automatically.

Ordinary sessions expose read-only `update_plan({plan:[{step,status}]})` with
1–64 steps, a maximum of one `in_progress` step, and statuses `pending`,
`in_progress`, `completed`. Accepted input and result use the existing durable
tool journal and history items. The app projects it as `TodoWrite`; a failed or
incomplete tool call cannot replace the visible list. These are agent-reported
task statuses, unlike team delegation results confirmed by the app.


## Extended API agent controls (version 1 additions)

All fields/methods below are additive. Old journals default missing fields;
restoration does not restore browser/desktop grants or restart processes.
`initialize.capabilities` advertises `contextCompaction`, `sessionConfiguration`,
`processInput`, `processResize`, `incrementalProcessOutput`, `mcpClient`,
`nativeCheckpoints`, `budgets` and `structuredErrors`.

Live session summaries also report `applicationIntegrations:{github,blender,hyperframes}`
from the effective native tool settings. The desktop app sends disabled preferences
through `session/start.settings.tools`, without enabling a tool disabled in the
CLI profile, and requires this acknowledgement before accepting a restricted
session. Disabled application tools are omitted from discovery and refused on
execution. These application preferences apply when opening/restarting chats;
they do not revoke the agent's general shell permissions.

- `session/start.settings`: bounded partial user-settings override (64 KiB).
  Fields and defaults are documented in README and settings.example.json.
- `session/compact({sessionId})`: idle only. Returns a complete session summary.
  `contextManagement` includes `compactions`, `archivedMessages`,
  `fullHistoryPreserved:true` and `estimateOnly:true`. Usage after compaction
  invalidates the earlier context reading without changing accumulated API totals.
- `session/configure({sessionId,model?,effort?})`: idle only; changes the next
  request's selected model/effort and invalidates screenshot observations.
- `session/close({sessionId})`: idle only; revokes desktop/MCP access and stops
  owned background trees before removing the live session.
- `context/compacted`: notification containing sessionId, messageId and compaction
  metadata (`at`, `cutoff`, `automatic`, `method:"extractive"`, estimatedBefore).
- `provider/retry`: session/message-scoped notification with attempt and delayMs.
- `turn/completed.errorDetails`: optional finite `{code,status?,retryAfterMs?,
  retryable,requestId,attempts}` for API errors; budget failures use
  `code:"budget_exceeded"`. Text and usage remain available as before. Durable
  duplicate turn requests replay the same structured error without another call.
- `session.budget`: conservative `reservedEstimateUsd`, `reservedEstimateTokens`,
  `notProviderBill:true`. Reservations persist even when a provider omits usage.
  It is not a guaranteed financial limit or a provider bill.
- `unavailableMcpServers`: optional startup diagnostics for configured servers.
- `session/start.accessibility: true | {keyboard}` (experimental, immutable for a
  live session): the CLI starts its own `a11y-mcp` server with the built-in
  Windows engine and exposes its `a11y_*` tools as the `trex_a11y` MCP server.
  Older values (`"trex"`, `"agent-desktop"`, `{engine, keyboard}`) are still
  accepted and use the same engine. `keyboard:true` adds `--keyboard`, which
  publishes `a11y_press` (real shortcuts) in full mode; without it no tool uses
  the keyboard. Plan mode keeps only the read-only tools; actions need approval
  outside full mode. The result includes `accessibilityEnabled` (false and
  `trex_a11y` in `unavailableMcpServers` outside Windows).
  `a11y-doctor --json` reports `{available, engine:"trex", reason}` without
  opening applications.
- The system prompt carries the guidance of each connected integration once per
  session: the native desktop provider's and each MCP server's
  `initialize.instructions` (clipped to 2,000 characters; dropped if it contains
  credential material). The session's tool permission policy still applies.

Native tools also include `edit_file`, `make_directory`, `rename_file`,
`remove_file`, `checkpoint_list`, `checkpoint_diff`, `checkpoint_restore`,
`git_status`, `git_diff`, `task_state`, `history_search`, `process_write` and
`process_resize`. Each definition provides a strict input schema. Plan mode
allows only read tools and `update_plan`; unknown names remain mutating.
`task_state({offset?,limit?})` reads the last durable successful plan, including
archived tasks. `history_search({query,limit?})` returns bounded retained-history
excerpts around the first match (`messageIndex`, `offset`, `excerpt`, `truncated`,
`totalBytes`), omitting structured image bytes. `history_search({messageIndex,
offset?})` reads 16 KiB of that stored message (`text`, `nextOffset` or null);
archived and trimmed tool results name their `messageIndex`. Compaction is an
extract, not a claim that every prior detail remains in the provider's active
context. Tool results older than `context.clearToolResultsAfterTurns` user turns
are replaced only in the provider request, at turn boundaries; events, journal
and `session/history` are unchanged.

`shell({command,background:true,interactive?:true,pty?:true,rows?,cols?})`
starts an owned job; foreground commands do not accept interactive/PTY options.
Interactive input is accepted into a bounded queue, not confirmed as processed by
the child. ConPTY/PTY preserves terminal semantics and jobs survive turn completion.

- `process/list` rows add `interactive` and `pty`.
- `process/read({sessionId,processId,after?})` adds byte `offset`, `nextOffset`
  and `exitCode`; `truncated` reports overwritten output. Incomplete trailing
  UTF-8 waits for the next read while a process is active.
- `process/write({sessionId,processId,text}) -> {accepted:true,bytes}`.
- `process/resize({sessionId,processId,rows,cols}) -> {resized:true}` (10..500).
- `process/updated({sessionId,event})` is an advisory activity notification;
  query current state/output to reconcile. Output notifications carry offsets,
  not unrestricted output bytes.

CLI session management, config, MCP, checkpoints, exec, diagnostics and eval are
management commands, not app-server methods. MCP servers are explicit trusted
user configuration. Their read-only hints must also appear in the user's
whitelist; errors/interruptions never reconnect or replay operations silently.
Project instructions cannot add servers or elevate permissions.

Wayland desktop access uses system portal sessions and PipeWire streams. Planning
creates a capture-only grant. Control requests keyboard/pointer devices and acts
only within granted streams. Screenshot coordinates are physical pixels mapped
to the portal's logical geometry. A shared desktop generation invalidates captures
after another Trex process sends input; observations expire after 30 seconds and
are consumed by one action. Manual focus changes cannot be detected reliably on
Wayland: inspect a fresh screenshot before input. Cancellation revokes the session;
no restore token is retained. `desktop-doctor` probes dependencies without consent.
