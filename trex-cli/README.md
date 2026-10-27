# Trex Agent

Standalone Rust API coding agent for named DeepSeek, MiniMax, OpenRouter, and
custom OpenAI-compatible profiles. It is independent of the desktop app.

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

Servers and watches can use `shell({command,background:true})`. They remain
available between model turns; `process_list`, `process_output`, and
`process_stop` inspect or stop individual owned terminals. The desktop exposes
their count, recent output and stop control in the chat, including team members.
Closing this CLI stops its managed terminals. Restore does not restart them.

All tests use temporary workspaces and loopback mock providers. No real API key
or paid completion is needed. Windows binary and offline transport behavior are
tested here; Linux/macOS secure-storage runtime behavior requires their native
OS services and has not been exercised on Windows.
