# Changelog

All notable changes to this project are documented in this file.

## v1.4.4 — 2026-07-20

### Fixed

- The OpenCode plugin loads again under OpenCode 1.18. The plugin loader
  validates every module export and invokes each one as a plugin factory, so
  the non-function exports in `src/opencode-plugin.js` (`TOOL_CAPABILITY_REQUIREMENTS`,
  `ALL_TOOL_REQUIRED_CAPABILITIES`, and `TOOL_ORIGIN_SCOPE_CLASSIFICATION`)
  aborted the load with "Plugin export is not a function", and the exported
  helper functions failed when invoked with the plugin context. Tool metadata
  now lives in the new `src/tool-metadata.js` module, and the package
  entrypoint is the new `src/plugin-entry.js`, which exposes exactly one
  export: the plugin factory. The implementation module keeps its helper
  exports for tests without leaking them into the plugin entrypoint.

### Maintenance

- `@opencode-ai/plugin` dependency and lockfile updated to 1.18.4, matching
  the OpenCode 1.18 plugin contract.
- Package, lockfile, manifest, popup, bridge client, native host, smoke
  fixtures, and release verification report version 1.4.4 together.

## v1.4.3 — 2026-07-17

### Fixed

- `chrome_wizard_step` no longer fails after a click that navigates: the tab
  metadata reads that re-bind the wizard to the live page (and the binding
  read inside `authorizePageTransition`) were sent under the stale pre-click
  page scopes, so the extension's page guard rejected them before the new
  page could be authorized. These reads now escape the inherited scope
  context through the new `withoutBridgePageScopes` bridge-client helper,
  matching the unscoped pre-approval metadata reads.
- The background service worker now deletes `windowActivationGenerations`
  entries when a Chrome window closes instead of retaining them for the
  worker's lifetime.

### Security

- The main-world pre-evaluation origin guard used by `chrome_evaluate` and
  scoped `Runtime.evaluate` no longer compares scopes with
  `Array.prototype.includes`, which a hostile page could patch to always
  return true. The guard now compares unforgeable `location` fields with a
  plain `===` loop, and both call sites share one helper.

### Maintenance

- Full-codebase bug and OWASP review of the extension background worker,
  content scripts, popup, native host, bridge client, OpenCode plugin,
  workspace artifact writer, and installer scripts.
- The `chrome_get_console_logs` description and README now match the
  implemented behavior: only the Runtime domain is enabled and only console
  messages and uncaught exceptions are buffered.

## v1.4.2 — 2026-07-16

### Fixed

- A bridge HTTP response that reports success but carries an invalid or empty JSON
  body now fails with a clear "Bridge returned an invalid JSON response" error in
  both bridge-client transports, instead of surfacing later as a confusing
  `TypeError` when the command result is read.

### Maintenance

- Full-codebase bug review of the extension, native host, plugin, bridge client,
  content scripts, and installer scripts; behavioral probes over navigation-policy
  matching, key event synthesis, schedule recurrence, and scope canonicalization
  confirmed no further functional defects.
- Removed an unused `rm` import from the workspace artifact writer.

## v1.4.1 — 2026-07-16

### Fixed

- Agent tab claims no longer race the navigation commit: a tab created with
  `chrome.tabs.create({url})` reports an empty `url` while the target URL is still in
  `pendingUrl`, which made `claimTab` fail as a "Chrome internal tab". Claimability now
  falls back to `pendingUrl` only while no URL has committed; a committed internal page
  stays unclaimable even while it navigates elsewhere.
- The installed smoke sends its WebMCP expected bindings with the `pageScope` reported by
  `getTab`, matching what the OpenCode plugin sends, so `npm run smoke:installed` passes
  against a real Chrome runtime.
- Non-string page scopes fail with a clear "must be a string URL" error instead of a
  misleading "ambiguous encoded separator or traversal" message.

## v1.4.0 — 2026-07-16

### Added

- **Reusable browser workflows.** Recording, import, inspection, deletion, and bounded
  sequential execution use a versioned typed schema whose capabilities and origins are
  derived from an explicit operation allowlist.
- **Local workflow schedules.** Daily, weekly, monthly, and annual recurrences provide
  explicit unattended approval, manual execution, notification policy, and sanitized history.
- **Experimental WebMCP.** `chrome_webmcp_list` and `chrome_webmcp_invoke` discover and
  execute the current origin-isolated document's model-context tools through an `ISOLATED`
  content-script adapter and the official Chrome API signatures.

### Security

- Workflow and schedule storage, step counts, timeouts, origins, history, and serialized data
  are bounded. Imported capability/origin claims are ignored and recomputed before persistence.
- Unattended schedules require a dedicated exact `browser.schedule-unattended` approval bound
  to workflow, recurrence, notification policy, origins, and managed tabs. Material changes
  require reapproval; the client cannot submit an approval bypass flag.
- Schedule/alarm mutations use durable committed journal transitions, restart repair, and
  occurrence claims so an acknowledged operation is durable and a completed occurrence is not
  replayed after a crash.
- WebMCP admissions bind an exact descriptor to an exact live document, enforce one committed
  invocation per tab and eight globally, and expire after 30 seconds. The pre-dispatch deadline
  cannot revoke an invocation after its irreversible page commit.

### Changed

- Package, lockfile, manifest, popup, bridge client, native host, smoke fixtures, and release
  verification now report version 1.4.0 together.
- Installation, upgrade, repair, privacy, WebMCP experimental prerequisites, schemas, limits,
  and failure semantics are documented in the README and security policy.

## v1.3.0 — 2026-07-16

### Added

- **Resumable session control.** Managed per-window tab groups, child-tab adoption, and
  `chrome_resume_session` preserve explicit handoff/deliverable work across restarts.
- **Origin-scoped approvals.** Page-local tools bind grants to canonical scheme, effective
  port, and path prefixes. Arbitrary JavaScript and raw CDP require origin-root approval to
  match the browser same-origin model; session grants stay isolated and batches preflight origins.
- **Safe workspace uploads.** `chrome_upload_files` stages bounded file chunks and
  commits only after every real workspace file and live input ref is verified.
- **Private network summaries.** `chrome_network_requests` exposes bounded lifecycle
  metadata while omitting bodies/headers and redacting credential-bearing URLs.
- **Page asset bundles.** `chrome_page_assets` deduplicates DOM/CDP resources and can
  publish content below the workspace with an atomic URL/MIME/hash/size manifest commit marker.
- **Branded notifications.** `chrome_notify` uses the sole new `notifications`
  permission with strict 120-character title and 1,000-character message limits.
- **Repair diagnostics.** The popup distinguishes missing hosts, protocol mismatch,
  capabilities, and disabled permissions with exact local repair commands and links.

### Security

- Asset content is capped at 10 MiB decoded, validates binary base64, uses
  collision-safe filenames, and rejects realpath/symlink escapes before atomic publish.
- Asset URLs redact credentials and signed query values; cross-origin resource content
  is inventory-only and is never fetched or bundled in this release.
- Asset publication writes directly below the verified output parent without renaming an
  open directory, keeps identity-pinned asset handles through final verification, publishes
  the manifest last as the atomic commit marker, zeroes retained files on identity failure,
  and limits bundles to 127 content files plus the manifest.
- Popup health checks compare the full manifest permission/origin grant and the current
  extension capabilities instead of treating one permission as representative.
- Browser origin authorization is recomputed after navigation and redirect; stale page
  provenance, partial uploads, and recovery failures all fail closed.
- Network summaries accept events only from the proven current top-level frame and loader;
  attachment seeds that binding before Network capture and navigation rotates it fail closed.

## v1.2.0 — 2026-07-15

### Added

- **Browser Intelligence.** `chrome_tab_context` reads bounded visible text, selection,
  selected element refs, MIME type, and dimensions. `chrome_read_page` returns one
  coherent context + accessibility snapshot with an optional screenshot artifact.
- **Deterministic discovery and waits.** `chrome_find` ranks elements by accessible
  signals with stable document-order ties. `chrome_wait_for` supports one typed URL,
  navigation, text, ref, selector, network-idle, or download condition with bounded
  polling, timeouts, and transport cancellation.
- **Typed browser batches.** `chrome_batch` prevalidates up to 25 high-level actions,
  requests one OpenCode approval, runs actions sequentially with per-action and total
  budgets, and returns ordered action-indexed results. Nested/meta actions and raw CDP
  are not part of its allowlist.
- **Versioned capability negotiation.** The extension, native host, bridge client, and
  plugin now negotiate protocol compatibility and exact tool capabilities before an
  approved tool executes.

### Security

- Page context and ranked finding omit sensitive subtrees and bound all traversals,
  strings, and result collections.
- Workspace artifacts are atomically written to collision-safe paths below an explicit
  project-relative output directory; symlink and path escapes fail closed.
- Network-idle tracking is bounded, cleans up debugger consumers on cancellation, and
  reports only redacted request state needed for the wait.

## v1.1.0 — 2026-07-15

### Added

- **Element-based interaction.** New `chrome_accessibility_tree` tool captures a compact
  accessibility snapshot with stable element references (`e1`, `e2`, ...), and
  `chrome_click_element` / `chrome_fill_element` act on those references — no pixel
  coordinates needed. Sensitive fields (passwords, hidden inputs, payment autocomplete)
  are always reported as `[redacted]` and never leave the page.
- **In-page agent indicator.** While the cursor state is `active`, the controlled page
  shows a pulsing viewport border and a **Stop OpenCode** button. Pressing it emits a
  `stopRequested` bridge event that agents can observe through `chrome_events`.
  Animations respect `prefers-reduced-motion`.
- **Navigation policy.** `blockedUrlPatterns` (from enterprise managed storage via
  `extension/managed_schema.json`, or the extension's local storage) now blocks
  `chrome_open` / `chrome_open_window` navigation to matching hostname + path patterns.
  New `chrome_blocked_urls` tool lists the effective patterns.
- **Host liveness ping.** The extension verifies the native host with a ping/pong round
  trip, so the popup can distinguish a healthy host from a present-but-wedged one.
- `minimum_chrome_version: 116` is now declared in the extension manifest.

### Fixed

- Synthetic clicks temporarily make the in-page **Stop OpenCode** control transparent
  to pointer input, so it cannot intercept clicks aimed at page controls underneath it.
- `chrome_fill_element` accepts only writable text fields and verifies the resulting
  value before reporting success.
- Navigation policy reads and validates configured storage fail closed, canonicalizes
  trailing slashes, and decodes percent-encoded paths before matching.
- Native-host status requires the current ping to receive its matching pong.
- Accessibility snapshots redact every standard `cc-*` autocomplete field, including
  cardholder names, plus password, one-time-code, and transaction fields.
- `chrome_keypress` applies Shift to printable letters and suppresses text insertion for
  Control, Alt, and Meta shortcuts.

### Fixed (carried from the v1.0.2 review)

- `chrome_keypress` now resolves `text` and virtual key codes, so Enter submits forms
  and printable keys insert characters.
- The favicon badge inlines its icon as a data: URI (SVG-as-image blocks external URLs).
- The popup no longer reports **Connected** before the native host has proven alive
  (`bridgeReady` announcement plus retry loop).
- `finalizeTabs` releases the lease of an agent tab that was already closed in a race.
- `chrome_open` claims navigated tabs when `sessionId`/`turnId` are provided.
- `Target.getTargets` through `chrome_cdp` returns CDP-shaped `TargetInfo` objects.
- `chrome_scroll` no longer defaults both deltas to 0.
- Windows setup rejects `%` in `cmd /c` tokens instead of corrupting paths.

## v1.0.2 — 2026-07-14

Baseline audited release: tab leases, session lifecycle, downloads, tab groups,
CDP subscriptions, console log capture, and Windows guided setup.
