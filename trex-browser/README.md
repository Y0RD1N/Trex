# Trex Browser

The MCP transport negotiates `2024-11-05`, `2025-03-26`, `2025-06-18` and
`2025-11-25`. This is separate from the companion's doctor/management protocol.
Codex CLI 0.164.0 requests `2025-06-18`; rejecting that version prevented it
from receiving browser tools even though direct manual controls worked.
`browser_navigate` opens the visible project browser automatically. Metadata
discovery (`initialize` / `tools/list` / doctor) never opens a browser.

Trex prepares the authenticated broker from the app before connecting native
agents. `trex-browser prepare --json` starts only that service, without creating
profiles or opening Chrome. This matters on Windows: Codex can put MCP children
in a job that prohibits breakaway. The MCP adapter uses the existing service;
the broker opens Chrome on the first navigation and survives adapter shutdown.
Standalone clients with such a job must run `prepare` from an independent
terminal first. Job protections remain enabled.

An independently installed Windows/Linux browser companion. The Rust executable provisions and checks a private current-user home, sanitizes the runtime environment, and supervises the packaged Node worker. One detached worker owns Playwright, Chromium/Chrome, CDP diagnostics, profiles, capture coordination and artifacts. It contains no AI provider, API-key integration or embedded application browser.

Linux uses an official pinned `node` executable beside the worker, a 0700 XDG
state home, descriptor-relative upload snapshots and pidfd process supervision.
The broker detaches with `setsid`; killing an agent's process group does not
close the browser. Fedora's native Chromium is detected at its installed ELF
path, with its sandbox enabled. The RPM includes the companion and private
runtime; a separate tar.xz distribution is also available. See the
[Fedora installation and validation guide](../docs/fedora.md).

## Runtime layout

```text
trex-browser.exe
trex-browser-runtime/
  node.exe                      # official Node 24.22.1 LTS
  worker.mjs                    # copy worker/*.mjs here
  browser.mjs
  security.mjs
  tools.mjs
  guard.mjs
  package.json                  # copy this directory's package*.json
  package-lock.json
  node_modules/                 # npm ci --omit=dev --ignore-scripts
  ffmpeg/                       # Playwright's official ffmpeg installation
    ffmpeg-1013/...
```

The worker uses the exact official `playwright@1.64.1` dependency and its public `page.screencast.start/stop` API. The packaged `PLAYWRIGHT_BROWSERS_PATH` points at `ffmpeg/`. Install ffmpeg during packaging with `node node_modules/playwright-core/cli.js install ffmpeg`; never install dependencies during ordinary execution. Chrome is discovered only at installed browser locations; Edge is a verified executable fallback. Browser launch explicitly sets `chromiumSandbox: true`. Only dedicated project-specific `BROWSER1` through `BROWSER99` persistent profiles are opened. Existing daily Chrome profiles are never selected.

Source package files live at `trex-browser/package*.json`; source worker modules live at `trex-browser/worker/*.mjs`. Release launch never falls back to an arbitrary Node executable from PATH. Development source runs require `TREX_BROWSER_DEV=1`, an isolated `TREX_BROWSER_HOME`, and the debug native executable at `target/debug/trex-browser.exe` for browser process supervision. Production callers use the native executable.

## CLI

```text
trex-browser --version
trex-browser doctor --json
trex-browser tools --json --mode observe|qa|full
trex-browser spaces --stdin-json
trex-browser spaces list --cwd C:\absolute\project --json
trex-browser profiles list --cwd C:\absolute\project
trex-browser profiles create --cwd C:\absolute\project --profile BROWSER1
trex-browser mcp --cwd C:\absolute\project --mode qa --client opaque-client-id --profile BROWSER1
trex-browser call --stdin-json
trex-browser artifact-open --stdin-json
trex-browser pause|resume|takeover|status|stop --cwd C:\absolute\project --mode full --client opaque-client-id
trex-browser stop
```

`--client-id` is an alias for `--client`. `doctor`, version, and tools inspection do not launch a browser. Profiles management and status can start the broker but do not launch Chrome. `profiles list/create` return `{ "profiles": [{ "id", "name", "projectId", "createdAt" }] }`. Stop with a project closes only the companion's owned context. Stop without a project stops this private-home broker and its owned contexts. No operation kills Chrome by executable name.

`call` reads one object from stdin and emits one MCP CallToolResult JSON object to stdout:

```json
{"name":"browser_take_screenshot","arguments":{"type":"png"},"cwd":"C:/absolute/project","mode":"qa","clientId":"conversation-or-room-id","profile":"BROWSER1","operationId":"unique-operation-id","timeoutMs":30000}
```

`operationId` is optional and generated if absent. `timeoutMs` is 100–90000, default 30000. `browser_wait_for.time` is **seconds**, from 0 to 60; out-of-range values are rejected before execution. Input is at most 1 MiB. Total output is at most 8 MiB. Modes, project, client and profile come exclusively from the trusted outer request or MCP launch flags. Arguments cannot override them. Each call receives a separate short-lived immutable broker grant; observe and full adapters may share a logical room client without changing each other's policy. Nested form, drag and array arguments are validated completely before any action.

`artifact-open` takes `{artifactId,cwd,mode,clientId,profile?}` and opens a validated generated PNG/JPEG/WebM through the operating system. No arbitrary host path is accepted or returned. The model-facing `browser_artifact` accepts `{artifactId,read?,open?}`; open requires QA/full. Other artifact types are metadata only except bounded JSON reads.

## MCP and results

Newline-delimited JSON-RPC stdio supports MCP `2025-11-25`: initialize, ping, tools/list, tools/call, and cancellation notifications. No global Claude/Codex configuration is changed. The host should construct a private per-agent MCP configuration artifact referencing the executable and explicit launch context. Closing a CLI or MCP adapter cancels only its outstanding operations and leaves the broker/profile available; native startup detaches the broker through a short-lived helper with a deliberate Windows process/job boundary.

Each launched browser has a native guard. It verifies the browser's parent and executable, retains Windows process handles, and captures only verified descendants with the same executable. Explicit profile close first asks Playwright to close, then bounds cleanup with that guard. The guard also watches its retained broker handle, so broker death cleans owned browser processes even when another process holds an inherited pipe writer. Completion requires a flushed native stop confirmation and process exit, independent of pipe EOF. It never kills Chrome by name or terminates a reused PID. A hard broker or browser crash can lose recent browser-storage writes that Chrome has not yet committed; clean profile close preserves committed state. Uncertain actions still require review and are never replayed automatically. Private internal `__guard-browser` and `__upload-snapshot` commands are not exposed as model tools.

The exact schemas are generated in [docs/tools.json](docs/tools.json) and [docs/observe-tools.json](docs/observe-tools.json). Result shape:

```json
{
  "content": [{"type":"text","text":"JSON summary"}],
  "structuredContent": {
    "ok":true,"operationId":"...","projectId":"...","profile":"BROWSER1",
    "generation":1,"revision":8,"data":{},"artifacts":[],
    "receipt":{"status":"completed","manualReview":false,"replaySafe":false}
  }
}
```

This full envelope is what hosts get from `call` (the text is the JSON of `structuredContent`). MCP agents (stdio and HTTP) receive only the lean agent view `{ok:true,...data,revision?,artifacts?}` that `modelView` builds; receipts and ownership metadata stay with the host. In an agent's text, batch steps also drop their operation IDs and receipts (`agentText`); its `structuredContent` keeps them. Hosts that forward results to a model should send that view once, not both the text and `structuredContent` (trex-agent does this and keeps the envelope in its journal).

Screenshots default to JPEG quality 70 in CSS pixels, with a wide viewport scaled to 1024 px at its scroll position; `type:"png"`, `scale:"device"` and `fullResolution:true` (native width) keep full detail. Artifact `width`/`height` are read from the encoded image. Screenshots add transient MCP image content. Artifacts contain `{artifactId,mimeType,bytes,sha256,kind,projectId,profile,createdAt,width?,height?,durationMs?}`. They never contain capability tokens or host paths. Binary screenshots are limited to 4 MiB; larger images return an actionable crop/JPEG error. Video remains a private artifact reference. Artifact integrity is rechecked on access.

## Policy and lifetime

Observe permits only explicit HTTP(S) navigation/back/reload, existing-tab list/select, frames, snapshots, console/page errors, network metadata/bounded bodies, screenshots, waits, artifact metadata/read, status and exact-operation cancellation. It denies forms, arbitrary JavaScript, mouse/keyboard, uploads, emulation, mocks, capture administration and lifecycle ownership changes. QA/full grant browser-scoped automation, not desktop or native UI control. This component cannot infer approval from site text. Page content is marked untrusted; it never supplies policy.

The broker listens only on IPv4 loopback, requires an exact Host header, rejects all browser Origin headers and authenticates every request with a 256-bit random bearer token stored only in the private home. The random port is not authentication. Tokens never occur in argv, model responses, receipts or logs. Native launch sanitizes the environment; no AI API keys are loaded. The private home root, broker credentials and artifacts are current-user/SYSTEM only and refuse links, junctions/reparse points and hard-linked files. Native checks admit exact Windows-derived Chromium network capability SIDs only inside dedicated `user-data` trees, plus Chromium's exact non-executable-data deny ACE. This includes the global window's `browser-window/user-data`, personal data, agent profiles and older project windows. Chrome can import component files/directories retaining legacy account ACLs: below a current-user-owned `user-data` root, those account grants are removed and the held, non-linked entry is made private before continuing. This never relaxes permissions or repairs the home/profile root, broker metadata or artifacts. Unknown capabilities, Everyone grants and unsupported deny entries still fail closed. Profile names are fixed-format and scoped beneath that home. Proprietary Edge capability names have not been guessed; an incompatible Edge profile fails closed.

Ownership is project/profile plus a logical client and monotonically changing generation. Another client must explicitly take over. `browser_status` distinguishes `pauseReason: manual | uncertain | runtime | null` and reports the uncertain operation ID/tool without arguments. Normal agent work must not call `browser_pause`. An explicit human pause is preserved until the owner resumes it.

### Spaces, tabs and parallelism

The desktop host reserves a stable persistent profile and client identity for
**each ordinary chat, planner, executor and team member**, including the coordinator. `spaces --stdin-json` accepts
`{cwd,members:[{clientId,label}]}` and returns `{spaces:[{clientId,label,profile}]}`.
Allocation is broker-serialized, validates the complete request first, preserves
existing manual profiles, and never launches Chrome. BROWSER1 remains available
for explicit manual clients; ordinary chats no longer implicitly share the
global profile preference. At most 98 allocated spaces fit a project.
Repeated allocation recovers the same bindings after restart. The command and
management endpoint are host APIs, not model-facing tools.

`spaces list --cwd ABS --json` returns all saved instances in that project,
including live legacy/manual profiles. Each entry includes its client/label,
profile, running/paused/activity state, tab count, current tool and selected URL.
This overview does not create browser contexts, join their input queues or
change ownership. The app panel polls it while open and shows only running
instances; reserved and historical profiles remain saved without appearing as
open agents. The native agents center likewise shows only opening or running
spaces. Status and tab-list queries never launch a fresh browser: its first
page operation opens that agent's space on demand. Each human control targets
the selected instance only.

Ownership still covers a whole project/profile. Independent clients cannot
create tabs in another owner's profile; shared identities serialize page inputs.
Different allocated profiles run concurrently with separate browser storage.
Trex Browser presents personal tabs and agent profiles from all projects inside
one native application window. Opening it from the desktop or from TREX joins
the same broker-owned window. Profile identity includes its project, so two
projects using BROWSER2 keep different cookies, local storage, permissions,
downloads, queues and Playwright target connections. Agents cannot inspect the
personal tabs. Existing profile storage is opened in place without migration.
Background agents do not change the human-selected tab. The agents center's
View/Pause/Take control actions address the full project/profile identity.
Closing an agent leaves other agents and personal tabs open.
Playwright action traces remain scoped to each agent. Raw Chromium performance
tracing is browser-wide and requires exclusive use, with no personal tabs.

Some providers, including Google, reject embedded browsers such as Electron
with “This browser or app may not be secure.” The address bar offers **Abrir en
navegador del sistema** and explains this on Google's sign-in page. Authentication
in that external browser stays there; it does not log the Electron session in.
TREX does not spoof its browser identity or copy cookies between browsers.
Popup-based authentication supported by a site retains its opener, request body
and profile session inside a tab of the shared window.
The team scheduler supports up to four independent read-only tasks. Tasks that
can write the shared workspace remain exclusive. `trex_team_plan.dependsOn: []`
marks independent work; prerequisites must be earlier plan keys. Omitted
`dependsOn` preserves sequential plans. `trex_delegate_task` with `wait:false`
queues work and returns its durable task ID; status with `waitMs` up to 30000
waits for results. Uncertain work is never automatically retried. See
[the team spaces guide](../docs/agent-browser-spaces.md).

Snapshots read Playwright's AI aria snapshot once (`worker/observe.mjs`) and return
`tabId` and a **page-specific revision**. By default they list elements as
`ref kind name = "value" [states]` lines (states: checked, selected, expanded,
pressed, disabled, required, invalid), plus headings (`h1`…), alerts and status
text; disabled controls stay listed, child-frame content needs `frameId`, and
`more` says when the list was cut. `full:true` (or `compact:false`) adds the
accessibility tree, cut at 16,000 characters (scope it with `selector`).

Refs are aria refs bound to their element: they stay valid across actions,
same-document navigation and `browser_evaluate`. Only a new document in the
main frame (detected by its time origin), a pause, a takeover or a closed tab
bumps the revision and drops them; a child frame navigating drops only its own
refs. A ref whose element was re-rendered is re-resolved by role, name and
position while as many look-alikes exist as before (a deleted row never
redirects to the next one); otherwise the error lists candidates. Pass the
snapshot's `tabId`, `revision` and `ref` together. The visible selected tab
remains a profile-level convenience, not a separate agent identity.

Page actions (click, type, fill_form, select_option, press_key, hover, drag,
mouse, file_upload, handle_dialog, and the same steps in a batch) wait up to
about 1 s for a navigation they started or for the DOM to go quiet, then return
`effect`: `added` lines with refs, a `removed` count, `changed` lines with their
previous value or state, new `text`, and `url`/`title` when they change. A new
document reports `navigated:true` and lists the new page. No `effect` means
nothing visible changed. Typed, filled and selected values are read back
(`mismatch`, `mismatches`, `selected` labels). A role/name or selector that
matches zero or several elements reports the count and up to five candidates
with fresh refs, after a case-insensitive name match.

QA/full expose 42 browser tools; observe exposes 15. `browser_batch` accepts
1..16 ordered `{tool,arguments}` steps and validates every schema and bound mode
before any dispatch. No nested batch, ownership/lifecycle or file-upload step
is accepted. Inputs remain serialized within the profile. It returns per-step
receipts and artifact refs, with only the latest screenshot image inline.
Text results have a combined 1 MiB budget. Each issued step has a durable receipt
without arguments, page content or image data. A failure stops subsequent steps;
completed actions are not rolled back. The error text names the step that stopped
the batch (`steps[i] tool`), the completed steps (never replay them) and the
steps that never ran. Cancellation targets the parent operation
and interrupts its current step. Never replay a partial batch automatically.

These are web-page/browser controls, not native desktop or Chrome-settings UI
controls. Model arguments cannot override the bound project, client or profile.
Doctor advertises `spaces`, `batch` and `pageScopedRefs`; an older companion must
be updated before the desktop enables team spaces.

Network throttling is tracked per tab. Profile-wide offline changes are also
applied to every CDP session with network conditions, preserving that tab's
throttling values. Updating only latency or throughput preserves offline mode.
Real HTTP tests verify that `navigator.onLine` and request failures agree.

Only page actions share the serialized action queue. Screenshots, snapshots, frame/tab listings, logs, bounded network reads, artifact reads and waits remain available during a pause and while an action is pending. Navigation, tab switching, log clearing, arbitrary JavaScript and mouse/keyboard input are not observations. A timed-out observation returns `READ_TIMEOUT` with no manual-review requirement and never pauses page controls; a cancelled observation likewise leaves the profile available. Late cancelled snapshots cannot replace newer refs. Shared browser startup remains single-flight. Observation still enforces project/profile/client ownership and the immutable mode.

Status and an owner's dialog response operate outside the action queue, so a synchronous alert can be handled while its initiating action waits. Cancel identifies one exact operation in the same project/client/profile. A cancelled or timed-out page action whose effects cannot be established pauses controls with an uncertain manual-review receipt. The agent can inspect its outcome using screenshots/snapshots, then explicitly call `browser_resume` before a new action; it must never replay the previous action automatically. If `pendingAction.cancelRequested` remains true, `browser_resume` returns `RECOVERY_PENDING` immediately instead of waiting behind the stuck execution. After inspection, the owner can use `browser_close` to discard that execution and cancel its queued inputs, then explicitly navigate again. Another full/QA client may explicitly take over for this recovery without resuming the old action. The dedicated profile is preserved; neither the old action nor its URL is reopened automatically. Capture finalization and explicit profile close remain possible during a pause. Locator action waits are bounded at ten seconds. Unissued queued calls return a cancelled receipt and do not pause another operation; foreign calls are rejected before dispatch. Cancellation does not close the profile. Durable operation reservations survive broker restarts and reject duplicate IDs while retained. Runtime-supervisor failures require component recovery rather than silently disabling supervision.

One capture manager prevents simultaneous video, action trace, performance trace, CPU sampling and heap snapshot sessions. Video stop finalizes a real silent page screencast WebM without closing the page/profile. Encoding dimensions are fixed at capture start and remain accurate if the viewport changes later. Captures auto-finalize after at most 120 seconds (default 60). A video uses Playwright's official packaged ffmpeg, checked by `doctor`; a missing encoder sets `runtime.ffmpeg` and `capabilities.video` false with a diagnostic. Raw CDP is not exposed as a model tool. Performance outputs are Chromium trace JSON, CPU profile JSON and heap snapshot JSON; action traces are Playwright ZIPs with DOM snapshots, without source files or screencast screenshots. HAR is not currently exported; bounded network metadata and selected bodies are available instead.

Finalized artifacts are limited to 64 MiB each, 200 retained, 512 MiB total and seven days. Network metadata retains at most 300 requests (failures included via `requestfailed`); listings default to document, xhr and fetch requests plus failures (`types`, `all`, `url`, `status`, `failed` filter them). Body reads return 16 KB from `offset` by default (`maxBytes` up to 1 MiB, bodies up to 64 MiB). Console reads default to the newest 20 events with text cut to 300 characters and repeats merged; `level`, a `since` cursor and `full:true` (raw events) are arguments. Uploads must be regular non-linked files under the authorized workspace, at most 64 MiB combined per call. Native upload snapshots hold verified ancestor and file handles while copying bounded bytes; Playwright receives immutable payloads before any asynchronous locator work. Downloads stay in the private artifacts directory and are exposed only by ID. Temporary downloads and capture output can exceed the finalized artifact size limit before rejection; the recording duration is bounded, but the encoder does not provide a hard live byte cap.

The native helper requests Windows `CREATE_BREAKAWAY_FROM_JOB` and never retries without it if Windows rejects creation. A permitted breakaway can leave the broker in a shared ancestor job; membership in any job is therefore not treated as a launch failure. Native tests verify survival after the launcher's kill job is terminated, rejection when that job prohibits breakaway, and real Chrome operation after an MCP adapter process-tree kill. Browser guards still clean up only owned browsers when their broker stops.

## Verification

```powershell
npm ci --ignore-scripts
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/runtime/ffmpeg"
node node_modules/playwright-core/cli.js install ffmpeg
npm test
cargo test
```

Tests use local loopback fixtures, isolated temporary profiles, and the installed Chrome executable. They do not use user browser profiles, real website sessions, model providers, paid calls, production installation or the Trex GUI. `tests/native-startup.test.mjs` additionally runs the actual native launcher when `TREX_BROWSER_TEST_NATIVE` names its executable and `TREX_BROWSER_RUNTIME` names its packaged runtime. Set `TREX_BROWSER_TEST_VISIBLE=1` to exercise the default visible window. It verifies navigation, mouse interaction, screenshots, MCP process-tree termination and owned shutdown. External packaging is owned by the repository installer workflow.

API/version references checked 2026-10-24: [Playwright screencast](https://playwright.dev/docs/api/class-screencast), [Playwright persistent context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [Playwright npm registry](https://registry.npmjs.org/playwright/1.64.1), [Node 24.22.1 release and hashes](https://nodejs.org/en/blog/release/v24.22.1).
