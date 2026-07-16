# Changelog

All notable changes to this project are documented in this file.

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
  atomically publish content plus a URL/MIME/hash/size manifest below the workspace.
- **Branded notifications.** `chrome_notify` uses the sole new `notifications`
  permission with strict 120-character title and 1,000-character message limits.
- **Repair diagnostics.** The popup distinguishes missing hosts, protocol mismatch,
  capabilities, and disabled permissions with exact local repair commands and links.

### Security

- Asset content is capped at 10 MiB decoded, validates binary base64, uses
  collision-safe filenames, and rejects realpath/symlink escapes before atomic publish.
- Asset URLs redact credentials and signed query values; cross-origin resource content
  is inventory-only and is never fetched or bundled in this release.
- Asset staging keeps identity-pinned file handles through publication, zeroes retained
  files on identity failure, and limits bundles to 127 content files plus the manifest.
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
