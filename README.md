# OpenCode Chrome Bridge

<p align="center">
  <img src="extension/images/icon128.png" alt="OpenCode Chrome Bridge" width="96" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-v1.3.0-0f766e?style=flat-square" alt="Version v1.3.0" />
  <img src="https://img.shields.io/badge/Node-22.22.2%2B-339933?logo=node.js&logoColor=white&style=flat-square" alt="Node 22.22.2 or a supported newer release" />
  <img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white&style=flat-square" alt="Chrome MV3" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="License MIT" />
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-8A2BE2?style=flat-square" alt="PRs Welcome" /></a>
  <a href="https://github.com/pmgallardodev/opencode-chrome-bridge/issues"><img src="https://img.shields.io/github/issues/pmgallardodev/opencode-chrome-bridge?style=flat-square" alt="Issues" /></a>
</p>

Control your real Chrome browser from OpenCode.

OpenCode Chrome Bridge combines an unpacked Chrome extension, a local native messaging host, and an OpenCode plugin that exposes browser tools for tabs, bounded page intelligence, screenshots, history, bookmarks, and full Chrome DevTools Protocol access.

```text
OpenCode tool -> local HTTP bridge -> Chrome native host -> Chrome extension -> real Chrome profile
```

> This bridge connects to your actual Chrome profile. Use it only in trusted local workflows.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [Tools exposed to OpenCode](#tools-exposed-to-opencode)
- [Scripts reference](#scripts-reference)
- [Project structure](#project-structure)
- [Security model](#security-model)
- [Manual installation](#manual-installation)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)
- [OpenCode Chrome Bridge vs MCP Playwright](#opencode-chrome-bridge-vs-mcp-playwright)
- [Contributing](#contributing)
- [FAQ](#faq)
- [License](#license)
- [Author](#author)

## Overview

OpenCode Chrome Bridge lets OpenCode inspect and control a real Chrome profile via a lightweight local bridge. Instead of spinning up a headless browser, it connects to the Chrome instance you already have open — reusing your logins, extensions, history, and cookies.

Key points:

- No headless browser. Connects to your real Chrome profile.
- Full Chrome DevTools Protocol (CDP) access from OpenCode tools.
- Bearer-token security on the local bridge — token rotates each Chrome session.
- Fixed extension ID via RSA key in `manifest.json` — no config drift between installs.
- Vanilla JS throughout — no bundler, no build step required.
- macOS, Linux, and Windows 10/11 supported.

## Architecture

### Components

| Component | Location | Role |
| --- | --- | --- |
| Chrome extension (MV3) | `extension/` | Runs inside Chrome; relays commands to the browser API |
| Native messaging host | `native-host/` | Node.js process launched by Chrome; HTTP bridge on `127.0.0.1` |
| OpenCode plugin | `src/opencode-plugin.js` | Registers tools with OpenCode; calls the bridge client |
| Bridge client | `src/bridge-client.js` | HTTP client that reads state and talks to the native host |
| Install scripts | `scripts/` | Wire up native host manifest and OpenCode plugin config |

### Data flow

```text
+----------------------------------------------------------+
|                        OpenCode                          |
|  Invokes a tool (e.g. chrome_screenshot)                 |
+-----------------------------+----------------------------+
                              |
                    src/opencode-plugin.js
                              |
                    src/bridge-client.js
                     reads state.json for
                     port + bearer token
                              |
                   HTTP POST 127.0.0.1:{port}
                              |
+-----------------------------v----------------------------+
|              native-host (Node.js process)               |
|  Launched by Chrome via native messaging (stdio)         |
|  Listens on a random port, 127.0.0.1 only               |
|  Forwards commands to Chrome extension via stdio         |
+-----------------------------+----------------------------+
                              |
                   Chrome native messaging
                    (stdio, length-prefixed)
                              |
+-----------------------------v----------------------------+
|              Chrome extension (MV3)                      |
|  background.js receives the command                      |
|  Calls chrome.tabs / chrome.debugger / chrome.history    |
|  Returns result back through the same channel            |
+----------------------------------------------------------+
```

### Security boundary

The native host binds only to `127.0.0.1`. Every request must include a `Bearer` token written to `~/.opencode/chrome-bridge/state.json` at startup. The token contains 256 random bits and changes whenever Chrome launches a new native-host process.

## Requirements

- **Node.js** 22.22.2, 24.15.0, or 26.0.0+
- **Google Chrome** (stable) with Developer mode enabled
- **OpenCode** CLI installed and configured
- **macOS**, **Linux**, or **Windows 10/11**
- On macOS, `sips` (bundled with the OS) is used to generate extension icons

Windows support in this repository is for OpenCode and Node.js running natively on Windows. The automatic installer does not bridge a WSL process to Chrome running on the Windows host; WSL has separate filesystem, registry, and loopback boundaries.

## Quickstart

### 1. Clone the repository

```bash
git clone https://github.com/pmgallardodev/opencode-chrome-bridge.git
cd opencode-chrome-bridge
```

### 2. Windows guided setup

On Windows 10/11, double-click `setup-windows.cmd` from the cloned repository. Run it as a normal user, without administrator privileges.

The setup checks the supported Node.js range from `package.json`, npm, the OpenCode CLI, and Google Chrome stable before changing anything. These commands must be available through `PATH`, and Chrome must use a standard installation location. The setup does not install Node.js, Git, OpenCode, or Chrome; if a requirement is missing, it stops and reports the problem in the console.

When requirements pass, it installs the repository's npm dependencies, registers the native host under `HKCU`, installs the OpenCode plugin from this repository, and verifies the result. It then opens `chrome://extensions` and the local `extension` folder.

In Chrome, enable **Developer mode**, select **Load unpacked**, and choose the opened `extension` folder. Restart OpenCode afterward. The Chrome step cannot be automated because Chrome requires explicit user approval for unpacked extensions.

The window remains open so errors can be read. From an existing terminal or automation, use `setup-windows.cmd --no-pause`; add `--no-open` to skip opening Chrome and Explorer. Setup is safe to rerun after correcting a requirement or moving the repository.

### 3. Manual and non-Windows setup

Install dependencies:

```bash
npm ci
```

The committed lockfile pins the dependency graph used by development and the guided installer.

#### Generate extension icons (optional, macOS only)

The generated icons are committed to the repository, so this step is not required after cloning. Run it on macOS only when changing the icon source:

```bash
npm run icons
```

#### Register the Chrome native messaging host

```bash
npm run install:native
```

If your shell runs an older Node while another supported runtime is installed, select it explicitly:

```bash
npm run install:native -- --node=/absolute/path/to/node
```

This writes the native host manifest to:

| Platform | Native-host manifest | Launcher |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opencode.chrome_bridge.json` | `~/.opencode/chrome-bridge/bin/opencode-chrome-native-host` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.opencode.chrome_bridge.json` | `~/.opencode/chrome-bridge/bin/opencode-chrome-native-host` |
| Windows | `%USERPROFILE%\.opencode\chrome-bridge\native-host\com.opencode.chrome_bridge.json` | `%USERPROFILE%\.opencode\chrome-bridge\bin\opencode-chrome-native-host.cmd` |

On Windows, the installer also creates this per-user registration; it does not require an administrator terminal:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.chrome_bridge
```

All quickstart commands can be run unchanged in PowerShell. The Windows launcher records the absolute paths of the selected `node.exe` and this checkout, so rerun `npm run install:native` after moving the repository or changing Node installations.

#### Register as an OpenCode plugin

```bash
npm run install:opencode
```

This adds the repository path to the global OpenCode config:

- macOS/Linux: `~/.config/opencode/opencode.jsonc`
- Windows: `%USERPROFILE%\.config\opencode\opencode.jsonc`

#### Load the Chrome extension

Open:

```text
chrome://extensions
```

Enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder inside this repository (the one containing `manifest.json`).

#### Restart OpenCode and verify

```bash
npm run verify
```

Then ask OpenCode:

```text
chrome_status
```

If the bridge is connected, try:

```text
chrome_tabs
chrome_cdp_targets
```

## Tools exposed to OpenCode

### Connection

| Tool | Description |
| --- | --- |
| `chrome_status` | Check whether the local native bridge is reachable |

### Tab management

| Tool | Description |
| --- | --- |
| `chrome_tabs` | List open Chrome tabs |
| `chrome_get_tab` | Get metadata for a single tab by id |
| `chrome_open` | Open a URL or navigate an existing tab |
| `chrome_close_tab` | Close a tab by id |
| `chrome_activate_tab` | Focus and activate a tab |
| `chrome_reload` | Reload a tab |
| `chrome_back` | Navigate a tab back in history |
| `chrome_forward` | Navigate a tab forward in history |

### Page content

| Tool | Description |
| --- | --- |
| `chrome_page_text` | Read title, URL, and visible page text |
| `chrome_dom_content` | Get the full HTML source or text content of a tab |
| `chrome_screenshot` | Capture a tab viewport to a PNG or JPEG file |
| `chrome_screenshot_region` | Capture a CSS-pixel rectangle of a page (defaults to JPEG, can extend beyond the viewport) |

### Browser Intelligence

| Tool | Description |
| --- | --- |
| `chrome_tab_context` | Read bounded visible text, page metadata, current selection, selected element refs, MIME type, and dimensions |
| `chrome_read_page` | Read one coherent context + accessibility snapshot and optionally save a viewport screenshot |
| `chrome_find` | Rank bounded page matches deterministically by ref, role, accessible name, label, placeholder, and visible text |
| `chrome_wait_for` | Wait for exactly one typed URL, navigation, text, ref, selector, network-idle, or download condition |
| `chrome_batch` | Run a prevalidated sequence of typed high-level browser actions and receive ordered, action-indexed results |

Visible text and selections are bounded and sensitive password, payment, hidden, script,
style, and template content is excluded or redacted. `chrome_find` returns at most 100
matches; page readers return at most 200,000 text characters and 2,000 accessibility
nodes. `chrome_wait_for` has a 120,000 ms ceiling and does not evaluate arbitrary page
JavaScript.

For `chrome_tab_context` and `chrome_read_page`, `outputDirectory` must be a
project-relative directory. Oversized text and requested screenshots are written below
the project using atomic, collision-safe files; symlinks and path escapes are rejected.
Inline previews remain bounded, while the returned artifact paths point to the complete
saved result.

Every Browser Intelligence tool uses OpenCode's native **allow once / allow always /
deny** permission prompt. A `chrome_batch` invocation asks for one OpenCode approval for
the complete action list, then validates every action before the first browser side
effect. The allowlist is limited to `getTab`, `activateTab`, `navigate`, `reload`,
`back`, `forward`, `tabContext`, `findElements`, `waitFor`, `clickElement`, and
`fillElement`. Nested batches, workflow or scheduler meta-actions, and raw CDP are not
accepted through this tool; use the separately approved `chrome_cdp` tool when full CDP
is intentionally required.

A batch accepts at most 25 actions. Each action has a maximum 30,000 ms budget and the
whole batch has a maximum 120,000 ms budget. `stopOnError` defaults to `true`; setting it
to `false` continues after ordinary action errors, while validation and timeout
failures always stop before another action starts. A timeout cannot roll back a browser
side effect that Chrome already completed.

```json
{
  "actions": [
    {
      "type": "findElements",
      "params": { "tabId": 42, "query": "Checkout", "interactiveOnly": true }
    },
    {
      "type": "waitFor",
      "params": {
        "tabId": 42,
        "condition": { "type": "text", "value": "Order confirmed" },
        "timeoutMs": 10000
      }
    }
  ],
  "stopOnError": true,
  "totalTimeoutMs": 20000
}
```

### Element-based interaction

| Tool | Description |
| --- | --- |
| `chrome_accessibility_tree` | Capture a compact accessibility tree with stable element references (`e1`, `e2`, ...); sensitive fields are always redacted |
| `chrome_click_element` | Click an element by accessibility-tree reference (scrolls it into view first) |
| `chrome_fill_element` | Focus an element by reference and type text, replacing existing content by default |

Element references survive page mutations but are invalidated by navigation — capture a fresh tree after navigating. Passwords, hidden inputs, and payment autocomplete fields (`cc-number`, `current-password`, `one-time-code`, ...) are reported as `[redacted]` and never leave the page.

### Coordinate interaction

| Tool | Description |
| --- | --- |
| `chrome_click` | Mouse click at viewport coordinates |
| `chrome_double_click` | Double click at viewport coordinates |
| `chrome_hover` | Hover at viewport coordinates |
| `chrome_scroll` | Scroll at a viewport position |
| `chrome_drag` | Drag along a path of coordinates with smooth interpolation |
| `chrome_move` | Move the mouse along a path without pressing any button |
| `chrome_type` | Type into the focused element |
| `chrome_keypress` | Send a key such as `Enter`, `Tab`, or `Escape` |
| `chrome_evaluate` | Evaluate JavaScript in a tab |
| `chrome_wizard_step` | Run click + wait + optional eval + optional screenshot in a single tool call |

### DevTools Protocol (CDP)

| Tool | Description |
| --- | --- |
| `chrome_cdp_targets` | List Chrome DevTools Protocol targets |
| `chrome_cdp` | Send a full CDP command to a tab or target |
| `chrome_subscribe_cdp` | Subscribe to CDP events for a tab |
| `chrome_unsubscribe_cdp` | Unsubscribe from CDP events for a tab |

### Viewport and window

| Tool | Description |
| --- | --- |
| `chrome_set_viewport` | Emulate a viewport size via CDP `Emulation.setDeviceMetricsOverride` |
| `chrome_reset_viewport` | Clear emulated viewport metrics |
| `chrome_set_window_state` | Set a Chrome window state (normal, minimized, maximized, fullscreen) |
| `chrome_get_window_state` | Get metadata and state for a Chrome window |
| `chrome_open_window` | Create a new Chrome window with optional URL, type, size, and state |

### Browser data

| Tool | Description |
| --- | --- |
| `chrome_history` | Search Chrome history |
| `chrome_bookmarks` | Search Chrome bookmarks |
| `chrome_downloads_list` | List Chrome downloads, optionally filtered by state or query |
| `chrome_download_cancel` | Cancel an in-progress download |
| `chrome_download_pause` | Pause an in-progress download |
| `chrome_download_resume` | Resume a paused download |
| `chrome_download_show` | Show a downloaded file in its folder |

### Tab groups

| Tool | Description |
| --- | --- |
| `chrome_tab_groups` | List Chrome tab groups, optionally filtered by window |
| `chrome_tab_group_create` | Create a Chrome tab group from a set of tabs |
| `chrome_tab_group_update` | Update a tab group title, color, or collapsed state |
| `chrome_group_tabs` | Add tabs to an existing group, or create a new group |
| `chrome_ungroup_tabs` | Remove tabs from their group |

### Events

| Tool | Description |
| --- | --- |
| `chrome_events` | Poll buffered browser events (tabs, windows, downloads, CDP) since a sequence number |
| `chrome_get_console_logs` | Read accumulated console messages, network log entries, and uncaught exceptions for a tab |
| `chrome_network_requests` | Read bounded lifecycle summaries with credential-bearing URL fields redacted |
| `chrome_release_debuggers` | Release persistent debugger attachments created for logging or CDP subscriptions |

Network summaries never capture request bodies, response bodies, cookies, or
authorization headers. URL user-info and fragments are removed, and sensitive query
values (including prefixed AWS and Google credential/signature keys) are replaced with
`[redacted]`. Capture uses a bounded 1,000-request / 2,000,000-character buffer and can
be released with `chrome_release_debuggers`.

### Session lifecycle and visual state

| Tool | Description |
| --- | --- |
| `chrome_claim_tab` | Claim an existing tab for a browser-control session |
| `chrome_resume_session` | Resume handoff/deliverable tabs after a restart and repair their managed groups |
| `chrome_finalize_tabs` | Finalize a session, closing unkept agent tabs and preserving handoff or deliverable tabs |
| `chrome_end_turn` | Release active tab leases and debugger attachments for a turn |
| `chrome_cursor_state` | Update the visible browser-control cursor state |
| `chrome_favicon_badge` | Set or clear the browser-control favicon badge |

While the cursor state is `active`, the controlled page shows a pulsing viewport border and a **Stop OpenCode** button. Pressing it emits a `stopRequested` bridge event (visible through `chrome_events`) so the driving agent can halt the turn.

Session tabs are grouped per Chrome window and newly opened child tabs are adopted only
from a live leased parent. `chrome_resume_session` fails closed on malformed or internal
tabs and keeps handoff state intact when recovery must be retried.

### Origin permissions, uploads, assets, and notifications

| Tool | Description |
| --- | --- |
| `chrome_upload_files` | Upload up to 20 workspace files (50 MiB total) to a live file-input ref with staged all-or-nothing commit |
| `chrome_page_assets` | Inventory deduplicated DOM/CDP resources and optionally save an atomic workspace bundle |
| `chrome_notify` | Show a branded Chrome notification with a title up to 120 characters and message up to 1,000 characters |

Page-local tools request canonical `scheme://host:effective-port/path` scopes. Their grants
preserve scheme, effective port, and configured path boundaries; navigation and redirects
are recomputed, session grants are isolated by OpenCode session, and batch preflight denies
the whole action list before side effects when any origin is refused. Arbitrary JavaScript
(`chrome_evaluate` and wizard expressions) and raw `chrome_cdp` instead require approval
for the complete origin root because the browser same-origin model lets code on `/public`
reach same-origin resources such as `/admin`; a path approval does not isolate those tools.
`Page.navigate` additionally requires its destination scope.

`chrome_upload_files` resolves and opens every file below the real workspace before
staging bytes. Directories, symlink escapes, identity swaps, stale refs, and partial
commits fail closed. `chrome_page_assets` combines DOM and CDP inventories, deduplicates
URLs, and can materialize resource content under a project-relative `outputDirectory`.
Its bundle contains collision-safe filenames plus a `manifest.json` with redacted source URLs,
MIME types, SHA-256 hashes, byte sizes, truncation flags, and per-resource errors. Binary
CDP resources are decoded from base64; total decoded content is capped at 10 MiB. Bundles
are written directly below the verified output directory without renaming an open directory;
an atomically published `manifest.json` is the commit marker, so partial directories are not
returned as complete bundles. Realpath/symlink containment checks reject workspace escapes.
Asset URLs redact credentials, fragments, and sensitive signed-query values before they
enter a response, filename, or manifest. This release never fetches cross-origin content:
cross-origin iframe and subresource URLs remain redacted inventory metadata with an
explicit skipped-content error. Bundle publication retains identity-checked asset handles
through final verification, then reopens and verifies the manifest commit marker by identity
and hash. It caps materialized content at 127 resource files plus the manifest; any additional
inventory entries remain in the manifest with an explicit
omission error and set its truncation flag.

The `notifications` permission is used only by `chrome_notify`; notification text is
bounded and the packaged OpenCode icon is used. No bridge credential is displayed.

### Navigation policy

| Tool | Description |
| --- | --- |
| `chrome_blocked_urls` | List the effective blocked URL patterns enforced on navigation |

Navigation commands (`chrome_open`, `chrome_open_window`) refuse URLs matching `blockedUrlPatterns`, read from enterprise managed storage (see `extension/managed_schema.json`) and from the extension's local storage. Patterns match hostname + path with `*` wildcards; a bare domain blocks the whole domain.

## Scripts reference

| Script | Command | Description |
| --- | --- | --- |
| Check syntax | `npm run check` | Validates JS syntax across all source files |
| Generate icons | `npm run icons` | Generates PNG icons from the favicon source |
| Install native host | `npm run install:native` | Writes the manifest and launcher; also registers Chrome under `HKCU` on Windows |
| Install OpenCode plugin | `npm run install:opencode` | Adds this repo to OpenCode plugin config |
| Guided Windows setup | `setup-windows.cmd` or `npm run setup:windows` | Checks requirements, installs dependencies, registers the bridge and plugin, then verifies |
| Print extension ID | `npm run print:extension-id` | Prints the fixed extension ID |
| Check Chrome extension | `npm run check:chrome-extension` | Verifies Chrome has the extension loaded |
| Run tests | `npm test` | Runs the Node built-in test suite |
| Verify wiring | `npm run verify` | Checks native host manifest + OpenCode config |
| Smoke native host | `npm run smoke:native` | Tests that the native host can bind, write state, and round-trip commands and events |

## Project structure

```text
opencode-chrome-bridge/
|-- extension/
|   |-- images/
|   |   |-- cursor-chat.png
|   |   |-- icon16.png
|   |   |-- icon32.png
|   |   |-- icon48.png
|   |   |-- icon128.png
|   |   `-- opencode-favicon.ico
|   |-- background.js
|   |-- content-scripts/
|   |   |-- a11y.js
|   |   `-- opencode.js
|   |-- managed_schema.json
|   |-- manifest.json
|   |-- popup.html
|   `-- popup.js
|-- native-host/
|   `-- opencode-chrome-native-host.mjs
|-- scripts/
|   |-- check-chrome-extension.mjs
|   |-- check-syntax.mjs
|   |-- generate-icons.mjs
|   |-- install-native-host.mjs
|   |-- install-opencode-plugin.mjs
|   |-- lib/
|   |   |-- opencode-config.mjs
|   |   |-- platform-support.mjs
|   |   `-- windows-setup.mjs
|   |-- print-extension-id.mjs
|   |-- setup-windows.mjs
|   |-- smoke-native-host.mjs
|   `-- verify.mjs
|-- src/
|   |-- bridge-client.js
|   `-- opencode-plugin.js
|-- test/
|   |-- background-runtime.test.mjs
|   |-- bridge-capabilities.test.mjs
|   |-- content-script-runtime.test.mjs
|   |-- documentation.test.mjs
|   |-- platform-support.test.mjs
|   `-- windows-setup.test.mjs
|-- CHANGELOG.md
|-- .github/
|   |-- ISSUE_TEMPLATE/
|   |-- workflows/
|   |   `-- ci.yml
|   |-- dependabot.yml
|   `-- pull_request_template.md
|-- .gitleaks.toml
|-- .gitignore
|-- CODE_OF_CONDUCT.md
|-- CONTRIBUTING.md
|-- LICENSE
|-- package-lock.json
|-- package.json
|-- SECURITY.md
|-- setup-windows.cmd
`-- README.md
```

## Security model

The native host listens only on:

```text
127.0.0.1
```

It writes bridge state to:

```text
~/.opencode/chrome-bridge/state.json
```

That state file contains a bearer token generated from 256 random bits. The token rotates every time Chrome starts a new native-host process.

Treat that token as a full local browser-control capability. Any local process that can read the state file can call the bridge until the native-host process exits, including tools that inspect tabs, history, bookmarks, downloads, and CDP state.

The extension requests only the browser permissions used by its implemented tools: `alarms`, `bookmarks`, `debugger`, `downloads`, `downloads.ui`, `history`, `nativeMessaging`, `notifications`, `scripting`, `storage`, `tabGroups`, `tabs`, and `webNavigation`. It also requests `<all_urls>` host access so it can inject the local cursor overlay into controlled pages. The extension-page CSP blocks network connections; only the Node plugin talks to the authenticated local HTTP bridge, while the extension communicates with the native host through Chrome native messaging.

`chrome_cdp` is intentionally powerful. It is equivalent to enabling full CDP access for OpenCode — it can inspect and control sensitive Chrome internals in the connected profile. Keep this extension loaded only in Chrome profiles where OpenCode is allowed to inspect browser state.

Arbitrary JavaScript and raw CDP approvals are therefore origin-wide rather than
path-prefix grants. Execution remains bound to the exact approved live document, but
Chrome's same-origin model means approving these tools on `/public` cannot isolate
same-origin `/admin` data.

### Tool approval prompts

Every browser tool except `chrome_status` asks for your explicit approval before it runs. This deny-by-default rule covers reads, metadata, navigation, browser mutations, lifecycle operations, and newly added tools. The plugin calls OpenCode's permission system (`context.ask`), so you get the native **allow once / allow always / deny** prompt with concrete details of the action:

- **Allow once** runs this single call and prompts again next time.
- **Allow always** adds the tool to OpenCode's persisted allow-list so it stops prompting — this is how you make a capability permanently active, and it is always your choice, never the default.
- **Deny** aborts the action before any command reaches the bridge.

The gate fails closed. If the OpenCode runtime does not expose `context.ask`, browser tools return an error before any command reaches the bridge. Upgrade OpenCode instead of bypassing the permission check.

You can pre-decide a tool without seeing a prompt by setting it to `allow`, `ask`, or `deny` in your `opencode.jsonc` `permission` config. An **allow always** decision has the same effect, so reserve persistent grants for capabilities you intend to keep active.

### Fixed extension ID

The extension ID is derived from the RSA public key in `manifest.json`:

```text
miccjajdhchpcdpmmiahheilooppepnl
```

This allows the native host `allowed_origins` to be hardcoded, preventing ID drift between installs.

### Native host name

```text
com.opencode.chrome_bridge
```

## Manual installation

### Native messaging host on Windows

The supported installation path is automatic and should be run from PowerShell without elevation:

```powershell
npm run install:native
```

It creates the `.cmd` launcher and JSON manifest under `%USERPROFILE%\.opencode\chrome-bridge`, then runs the equivalent of:

```powershell
reg.exe add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.chrome_bridge" /ve /t REG_SZ /d "$env:USERPROFILE\.opencode\chrome-bridge\native-host\com.opencode.chrome_bridge.json" /f
```

Inspect the registration with:

```powershell
reg.exe query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.chrome_bridge" /ve
```

To remove only the Windows native-host registration and generated launcher files:

```powershell
reg.exe delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.chrome_bridge" /f
Remove-Item -Recurse -Force "$env:USERPROFILE\.opencode\chrome-bridge"
```

### Chrome extension

1. Generate icons if not already done:

```bash
npm run icons
```

2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the `extension/` folder.

3. Verify Chrome shows:

```text
OpenCode Chrome Bridge
```

4. Confirm from the terminal:

```bash
npm run check:chrome-extension
```

Expected result (output includes profile details specific to your machine):

```json
{
  "ok": true,
  "extensionId": "miccjajdhchpcdpmmiahheilooppepnl",
  "expectedPath": "/absolute/path/to/opencode-chrome-bridge/extension",
  "profiles": [...]
}
```

If you change `manifest.json`, popup files, or icons, reload the extension card at `chrome://extensions`.

### OpenCode plugin

1. Run the installer:

```bash
npm run install:opencode
```

2. It updates `~/.config/opencode/opencode.jsonc` to include this repository in the `plugin` array:

```jsonc
{
  "plugin": [
    "/absolute/path/to/opencode-chrome-bridge"
  ]
}
```

3. Restart OpenCode after the config changes.

4. Verify:

```bash
npm run verify
```

Expected result:

```json
{
  "ok": true,
  "extensionId": "miccjajdhchpcdpmmiahheilooppepnl",
  "nativeHostName": "com.opencode.chrome_bridge",
  "opencodePluginPath": "/absolute/path/to/opencode-chrome-bridge"
}
```

## Verification

Run the full local suite:

```bash
npm run check
npm test
npm run verify
npm run check:chrome-extension
npm run smoke:native
```

What each command proves:

- `npm run check` — JavaScript syntax is valid across all source files.
- `npm test` — manifest, icons, popup, plugin tools, and native launcher behavior match expectations.
- `npm run verify` — OpenCode config and Chrome native-host manifest are wired to this workspace.
- `npm run check:chrome-extension` — Chrome has loaded this unpacked extension.
- `npm run smoke:native` — the native host can bind a local bridge, write bridge state, and round-trip commands and events.

For a direct bridge status check:

```bash
node -e 'const m=await import("./src/bridge-client.js"); console.log(await m.bridgeStatus())'
```

If your shell is sandboxed and blocks `127.0.0.1`, run bridge checks outside that sandbox.

On Windows, `npm run verify` also executes `reg.exe query` and confirms that Chrome's `HKCU` registration points to the generated manifest. This validates the registration, manifest, `.cmd` launcher, absolute Node path, and OpenCode plugin configuration. A final native Windows smoke check is:

```powershell
npm run check
npm test
npm run verify
npm run check:chrome-extension
npm run smoke:native
```

## Troubleshooting

### `chrome_status` cannot connect

Run:

```bash
npm run verify
npm run check:chrome-extension
```

Then open the popup:

```text
chrome-extension://miccjajdhchpcdpmmiahheilooppepnl/popup.html
```

If `~/.opencode/chrome-bridge/state.json` does not exist, reload the extension from `chrome://extensions`.

### Chrome extension is installed but not connected

Run:

```bash
npm run install:native
```

Then reload the extension. The native manifest should point to:

- macOS/Linux: `~/.opencode/chrome-bridge/bin/opencode-chrome-native-host`
- Windows: `%USERPROFILE%\.opencode\chrome-bridge\bin\opencode-chrome-native-host.cmd`

On Windows, confirm the registry value before reloading Chrome:

```powershell
reg.exe query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.chrome_bridge" /ve
```

### OpenCode does not show the tools

Run:

```bash
npm run install:opencode
npm run verify
```

Restart OpenCode after the config changes.

### Manifest changed but Chrome shows the old extension

Open:

```text
chrome://extensions/?id=miccjajdhchpcdpmmiahheilooppepnl
```

Click the reload button on the extension card.

### Popup reports an old protocol, missing capabilities, or disabled permissions

Update every component together, then reinstall both local pieces:

```bash
npm ci
npm run install:native
npm run install:opencode
```

Open `chrome://extensions/?id=miccjajdhchpcdpmmiahheilooppepnl`, enable the extension
and its required permissions, and click reload. The popup shows only bounded diagnostic
text and these repair commands; it never renders local bridge secrets. It compares the
complete manifest permissions and host origins with Chrome's active grants, and compares
the extension's actual capability handshake with the native host requirements. Missing
capabilities, permissions, and origins are listed in sorted form.

## OpenCode Chrome Bridge vs MCP Playwright

| | OpenCode Chrome Bridge | Playwright MCP |
| --- | --- | --- |
| Browser session | Connects directly to your real Chrome profile | Can launch an isolated or persistent profile, or connect to existing browser tabs through its extension |
| Logins and cookies | Reuses the selected Chrome profile automatically | Can reuse a persistent profile, storage state, or the connected browser profile |
| Browser-level data | Direct tools for history and bookmarks, downloads, windows, and tab groups | Focuses primarily on page and browser-context automation |
| Interaction model | OpenCode tools, coordinate input, JavaScript, and raw CDP | Semantic locators, accessibility snapshots, auto-waiting, and Playwright APIs |
| CDP access | Unrestricted `chrome_cdp` command surface | Playwright-mediated, with optional DevTools capabilities |
| Cross-browser testing | Chrome only | Chromium/Chrome, Firefox, WebKit, and Edge |
| Best for | Operating and inspecting a live Chrome profile from OpenCode | Repeatable automation, browser testing, and cross-browser workflows |

Current Playwright MCP is not limited to a fresh headless session: its [persistent profile and browser extension modes](https://github.com/microsoft/playwright-mcp#user-profile) can reuse authentication and existing browser tabs. This bridge is narrower and more Chrome-specific. Its differentiators are direct OpenCode plugin integration, explicit access to Chrome history and bookmarks, download and tab groups management, tab handoff/finalization, and unrestricted CDP commands.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and pull-request requirements. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Security vulnerabilities must not be filed as public issues. Follow [SECURITY.md](SECURITY.md) to report them privately.

## FAQ

### Does it work with Chrome Canary?

Automatic native-host registration targets Google Chrome stable. On macOS, the checker also detects Canary profiles, but Canary still needs its own native-host manifest location.

#### Chrome Canary on Windows

This is a manual variant. First run `npm run install:native` for the generated manifest, then register the same manifest under Canary's key:

```powershell
reg.exe add "HKCU\Software\Google\Chrome SxS\NativeMessagingHosts\com.opencode.chrome_bridge" /ve /t REG_SZ /d "$env:USERPROFILE\.opencode\chrome-bridge\native-host\com.opencode.chrome_bridge.json" /f
```

The automatic installer and extension checker target Chrome stable on Windows; Canary registration is not included in `npm run verify`.

### Does it support Windows?

Yes. Clone the repository and double-click `setup-windows.cmd`. It validates requirements, configures the native host and OpenCode plugin, and opens Chrome for the final **Load unpacked** step. Windows 10/11 installation uses Chrome's per-user `HKCU` registry branch, so administrator privileges are not required.

### Why does the native host use a launcher script?

Chrome GUI apps often do not inherit your shell `PATH`. The launcher uses an absolute Node.js path so Chrome can start the host reliably regardless of the environment.

### Can `chrome_cdp` access sensitive data?

Yes. Full CDP access can inspect and control sensitive browser internals. Like every browser tool except `chrome_status`, `chrome_cdp` requires an OpenCode allow once / allow always / deny decision before execution. See [Tool approval prompts](#tool-approval-prompts). Use it only in trusted local workflows.

### Why is the extension ID fixed?

The ID is derived from the RSA public key embedded in `manifest.json`. This allows the native host `allowed_origins` to be hardcoded and prevents the ID from changing between loads or machines.

## License

MIT — see [LICENSE](LICENSE).

## Author

- Author: [@pmgallardodev](https://github.com/pmgallardodev)
- Issues: https://github.com/pmgallardodev/opencode-chrome-bridge/issues
