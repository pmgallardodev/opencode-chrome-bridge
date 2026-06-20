# Contributing

## Development setup

Use a Node.js version allowed by `package.json`, then install the locked dependency graph:

```bash
npm ci
```

Keep the extension and native host dependency-light. The Chrome extension uses plain JavaScript without a bundler or generated runtime code.

## Before opening a pull request

Run the repository gates:

```bash
npm run check
npm test
npm run smoke:native
npm audit --audit-level=high
```

Run `npm run verify` and `npm run check:chrome-extension` when a change affects installation, native messaging, the manifest, or browser behavior. These checks inspect the local machine and therefore are not part of generic CI.

Add or update tests for behavior changes. Keep commits focused, explain security-sensitive decisions, and update the README when commands, requirements, permissions, or public tools change.

## Pull requests

- Describe the user-visible result and verification performed.
- Link related issues.
- Do not commit browser captures, local configuration, credentials, state files, or dependency directories.
- Confirm that new Chrome permissions are necessary and document their security impact.

Security vulnerabilities must be reported privately as described in [SECURITY.md](SECURITY.md), not through an issue or pull request.
