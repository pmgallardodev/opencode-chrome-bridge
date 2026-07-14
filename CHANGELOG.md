# Changelog

All notable changes to this project are documented in this file.

## v1.1.0 — 2026-07-14

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

## v1.0.2 — 2026-07-06

Baseline audited release: tab leases, session lifecycle, downloads, tab groups,
CDP subscriptions, console log capture, and Windows guided setup.
