# Security policy

## Supported version

Security fixes are applied to the latest commit on `main`. This project has not yet declared additional maintained release branches.

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/pmgallardodev/opencode-chrome-bridge/security/advisories/new). Do not include exploit details, browser data, tokens, or personal information in a public issue.

Include the affected component, reproduction steps, impact, and any proposed mitigation. You should receive an acknowledgement within seven days. A coordinated disclosure date will be agreed after the report is validated and a fix is available.

## Security boundary

This project controls a real Chrome profile. A successful command can inspect or change tabs, history, bookmarks, downloads, page content, and Chrome DevTools Protocol state.

The native host listens on `127.0.0.1` and requires a per-process bearer token stored in the current user's private state directory. This protects against remote network access; it does not protect against malicious software already running as the same operating-system user.

As an additional layer, every browser tool except `chrome_status` requires an OpenCode allow once / allow always / deny decision before execution. The gate fails closed: denying, or running on a host without permission-prompt support, aborts the action before any command reaches the bridge. A user can deliberately persist an allow-always grant. This mitigates prompt injection from untrusted page content, but is not a substitute for loading the extension only in trusted profiles.

Only install the extension and plugin on trusted machines and Chrome profiles. Never publish bridge state files, screenshots, HAR files, traces, or logs that may contain browser data.

The RSA value in `extension/manifest.json` is a public Chrome extension signing key used only to keep the unpacked extension ID stable. It is not a credential.
