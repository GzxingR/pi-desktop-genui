# Capability and data-flow review — `io.github.gzxingr.genui`

This document exists because the review policy requires a capability/data-flow matrix for plugins
requesting prompt injection, tool registration or in-agent execution. Every row is grounded in a
file in this repository; nothing here is aspirational.

Verified against **PI-Desktop 0.15.3** on Windows. Upstream: [`omdsh-dev/dsh-genui`](https://github.com/omdsh-dev/dsh-genui) (MIT).

---

## 1. Trust model

The plugin has two halves that run in **different processes with different trust levels**:

| Half | Process | Trust | Can it reach the model? | Can it open a panel? |
|---|---|---|---|---|
| `main.js` + `src/*` | plugin process | sandboxed by the permission gateway | no | yes |
| `src/extension.js` | agent sidecar | **same trust as the agent** | via `pi.sendUserMessage` | no |
| `renderer/*` | panel window | no `pi` object at all; only `pluginBridge` | no | is the panel |

The two halves cannot call each other. They rendezvous through **four JSON files in the plugin's own
data directory** (`~/.pi-desktop/plugins/data/<plugin id>/`): `config.json`, `state.json`,
`action.json`, `panel-request.json`. `src/store.js` is the only module that touches them.

**Why this matters to a reviewer:** the plugin process cannot send messages, so the action loop and
the fence capture *must* live in the agent half, and the agent half cannot open a panel, so it asks
the plugin process through `panel-request.json`. That is the entire reason `agent.extension` is
requested — it is not a convenience.

## 2. Capability matrix

| Permission | Host API actually used | Where | Can touch | Cannot touch |
|---|---|---|---|---|
| `ui.panel` | `pi.ui.openPanel()` (no title arg), `pi.ui.showToast()` | `main.js` `openGenUiPanel`, commands | open/raise this plugin's own panel; show a toast | no other plugin's panel; no window control |
| `agent.tool.register` | `pi.agent.registerTool` / `unregisterTool` | `main.js` `onLoad` / `onUnload` | expose `render_ui`, `validate_dsh_ui`, `genui_status` | cannot call other plugins' tools; cannot execute shell/fs tools |
| `agent.prompt.inject` | `contributes.skills` → `skills/genui.md` | `manifest.json` | the skill body enters the prompt when the model selects it | no silent per-turn injection; no system-prompt rewrite |
| `agent.extension` | `pi.on("message_end"｜"session_start"｜"before_agent_start")`, `pi.sendUserMessage` | `src/extension.js` | inspect an assistant message and return a rewritten one; send one user-text message | no tool registration in the agent half; no provider access; no file access beyond §4 |

### Deliberately NOT requested

`fs.read` · `fs.write` · `fs.delete` · `net.fetch` · `net.websocket` · `shell.openExternal` ·
`clipboard.*` · `background.service` · `session.read` · `agent.complete` · `desktop.control`.
There is no `fs`/`net` block in `manifest.json`. The package declares four permissions and uses four.

## 3. Data flows

| # | Trigger | Path | Payload | Destination | Retained as |
|---|---|---|---|---|---|
| 1 | model calls `render_ui` | tool args → `guard.normalize` → `store.saveState` → `pi.ui.openPanel` | the spec | `state.json`, then the panel via `genui.pull` | `state.json` (overwritten by the next render) |
| 2 | panel polls | `onPanelInvoke("genui.pull")` → `store.loadState` | the spec + counters | panel window | nothing new |
| 3 | assistant message ends | `message_end` → fence regex → `guard.normalize` → `store.saveState` → `store.requestPanel` | the spec from the fence | `state.json`; reply text rewritten in place | `state.json` |
| 4 | user triggers a component with `action` | panel → `onPanelInvoke("genui.action")` → `store.queueAction` → `action.json` → agent pump → `pi.sendUserMessage` | `[genui-action] action=… payload=…` | the model (as a user message) | removed from `action.json` before the send |
| 5 | `genui.clear` | panel/command → `store.clearState` + remove `action.json` | none | — | — |

The model-authored fence text is **never executed and never inserted into the DOM**: the panel
renders from validated component nodes, and every string reaches the DOM through
`textContent`/`createElement` (`renderer/genui.js`). The single exception is the `svg` component,
which renders an author-supplied SVG document inside an `<img src="data:image/svg+xml;base64,…">`,
i.e. an isolated image context with no script execution and no access to panel CSS or the DOM.

## 4. Storage

| File | Written by | Contents | Bound |
|---|---|---|---|
| `config.json` | `main.js` `syncConfigFromSettings` | the five manifest settings + the host locale | fixed key set, rewritten wholesale |
| `state.json` | both halves | `seq`, title, normalized spec, node count, dropped/warning notes, `armed` flag, source, session id | spec already capped at 200 nodes / 8 levels by `guard`; reads refuse files > 4 MiB |
| `action.json` | plugin process | one pending action | single slot; text capped at 8 000 chars; older than 10 min is discarded unread |
| `panel-request.json` | agent half | "please open the panel" | single slot; older than 60 s is discarded unread |

Writes go through a temp file + rename (`store.writeJson`), so a reader never sees a partial file.
Every path is derived from `os.homedir()` plus fixed names — **no path from a spec, a tool argument
or a message ever reaches the filesystem.**

Never stored: credentials or tokens of any kind, message bodies, message history, workspace paths,
clipboard contents, telemetry, or any identifier for the user. The plugin has no network code, so
nothing can leave the machine.

## 5. Privacy — what this plugin does not touch

Stated explicitly, because a reviewer should not have to infer it:

**Never read, collected, logged, transmitted or stored:**

- your name, e-mail address, account identifiers, or any GitHub/platform identity
- machine identity: hostname, user name, OS user directory, hardware id, IP address
- credentials of any kind: passwords, API keys, access tokens, cookies, SSH material
- message history, other sessions, other plugins' data, workspace file contents
- clipboard contents, browser data, telemetry, crash reports, usage statistics

**What the plugin does persist** is exactly the four files in §4, in its own
directory: the interface spec it was asked to render, the counter that versions
it, one pending action, one panel-open request, and the plugin's own settings.
A spec is content the model wrote for that one request; it is overwritten by the
next render and removed by `genui.clear`.

**There is no network code in the package at all** — no `net.fetch`, no
`net.websocket`, no CDN reference, no telemetry endpoint, no auto-update ping.
Nothing can leave the machine, so nothing can be exfiltrated.

**The rendered interface is the only place model content meets the UI, and it is
safe by construction**: every string goes through `textContent`/`createElement`
(no `innerHTML`), the only markup path is the `svg` component's isolated
`data:` image context, and the spec guard rejects unsafe keys and unknown
component types before anything renders.

The release process runs `scripts/verify-artifact.mjs` against the packed
`.piplug`, which fails the build (non-zero exit) if the artifact contains an
absolute path, an OS user name, a development folder name, a credential shape,
a private-key block, an e-mail address outside the intended public identity, a
private IP address, or icon metadata. **The 0.1.0 artifact passes that scan with
zero hits.**

## 6. Dependencies and provenance

- **Runtime dependencies: none.** No `node_modules` in the package, no bundled third-party library.
  The charts and function plots are hand-written SVG (`renderer/genui.js`), not ECharts/Mermaid/three.js.
- Only Node built-ins are imported: `node:fs`, `node:os`, `node:path`, `node:zlib`, `node:crypto`
  (icon generator only), `node:http`/`https` in no file at all.
- The panel is plain HTML/CSS/JS with **no build step** and no CDN reference; nothing is fetched at
  runtime, so there is no remote code loading and no version drift.
- Upstream lineage: the `dsh-ui` component vocabulary and field semantics come from
  `omdsh-dev/dsh-genui` (MIT). `LICENSE` reproduces the upstream copyright notice and permission
  notice as the licence requires; the skill document and component tables are derived from its
  `SKILL.md`.

## 7. Negative-path evidence

Each item is asserted by an automated test in this package; run them with `node scripts/*-sim.js`,
`node scripts/selftest.js`, `node src/guard.selftest.js` (344 assertions total).

| Claim | Assertion |
|---|---|
| The guard never throws on hostile input | 12 pathological inputs incl. 200-deep nesting, `null`, scalars, bad JSON |
| A promise or prototype key cannot pollute | `__proto__` / `constructor` attempts; `{}.polluted === undefined` |
| Unknown component types are dropped, siblings survive | mixed spec → 3 of 4 nodes kept, one `dropped` entry |
| `echart`/`mermaid`/`diagram`/`scene3d` are kept, not executed | flagged `unsupported-in-port`, rendered as a placeholder that preserves the JSON |
| Budgets hold | `maxNodes` truncation, depth limit, non-finite numbers dropped, strings truncated |
| An unparseable `dsh-ui` fence is left untouched | reply byte-identical, nothing staged |
| Non-`assistant` messages and non-`dsh-ui` fences are ignored | `message_end` returns `undefined` |
| Disabled switches stop the work | `enabled=false` and `interceptFences=false` both suppress the rewrite |
| The action pump cannot run away | idle pump sends nothing; read-only spec (`armed=false`) is not forwarded; `actionLoop=false` is inert; one claim = one send |
| Panel channels fail closed | unknown channel → `UNSUPPORTED`; action without a name → `INVALID_ARGUMENT`; missing spec → `ok:false` |
| The panel is opened without a hard-coded title | asserted on every `openPanel` call (marketplace rule) |
| Unload is clean | all 3 tools and 4 commands unregistered; the panel watcher interval cleared |

## 8. Residual risks — stated plainly for the reviewer

1. **Both halves use Node `fs` directly, not the host's `pi.fs` gateway.** The agent half has no
   gateway API at all, so file access cannot be routed through it. Mitigation: fixed filenames only,
   own data directory only, 4 MiB read cap, atomic writes, no caller-supplied path anywhere. The same
   trade-off is already shipped by `local.pi-markdown` for its notes. A reviewer may still prefer a
   gateway-based design; that would require a host API the extension half does not expose today.
2. **`message_end` can rewrite the assistant's own reply.** That is the point (it replaces a JSON
   blob with a one-line pointer), and it is bounded: only the exact ```dsh-ui fences are touched, the
   role is preserved, prose around the fence is preserved byte-for-byte, and any failure returns
   `undefined` so the turn proceeds unchanged.
3. **The action loop injects a user message.** It sends exactly one fixed-shape string
   (`[genui-action] action=<name> payload=<json>`) and only when the displayed spec contains an
   actionable component and the user actually triggered it. It cannot send arbitrary text: the name
   is capped at 120 chars, the payload at 8 000, and both come from the panel, not from model output.
4. **`agent.extension` is agent-level trust.** Any code in that half runs with the agent's own
   authority. The extension half is 292 lines, registers no tools, reads no files except through
   `src/store.js`, and returns `undefined` on every error path — reviewing those two files is the
   whole audit surface.