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

`session/start {cwd,mode,model?,effort?,conversationId?}` returns
`{sessionId,conversationId,model,effort,mode,items,recoveryRequired,contextWindow,contextWindowSource,usage?}`. `cwd` must
exist. Modes: `plan`, `ask`, `full`; `auto` and `default` alias `ask`. `items` is a
normalized ChatItem array with durable stable IDs. A live session has a fixed
workspace and mode. A fresh process can explicitly select another mode while
restoring the same conversation. A conversation is bound to its original
profile name, provider, base URL, and canonical workspace; mismatches fail.
Rotating a key or changing a profile's default model does not change that binding.
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
Existing version-1 journals remain loadable; historical missing counts are not
estimated.

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
already exist; native tools do not create directories. Shell timeout is bounded
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
