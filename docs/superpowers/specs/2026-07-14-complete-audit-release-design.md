# Complete Audit and Release Design

## Goal

Audit the complete OpenCode Chrome Bridge repository and installed runtime, fix every reproducible defect found, and publish a verified patch release after all local and cross-platform gates pass.

## Scope

The audit covers every executable and release-facing surface:

- the OpenCode plugin and its permission gate;
- the local bridge client and screenshot file handling;
- the native messaging host, HTTP boundary, state file, command framing, events, timeouts, and shutdown behavior;
- the Chrome MV3 service worker, CDP ownership, browser actions, tab leases, event buffering, and visual overlay;
- macOS/Linux/Windows installation and verification helpers;
- package dependencies, repository security policy, CI, documentation, and release metadata;
- the installed Chrome extension and native-host wiring on this Mac.

The audit does not add unrelated product features or redesign the user interface. Refactoring is limited to changes required to fix a demonstrated defect or make its regression test reliable.

## Approach

Use a focused stabilization release. Start with the current clean `origin/main`, execute tests with the Node 26.3.1 runtime registered for Chrome, and inspect each trust boundary directly. For every behavioral defect, first add a regression test and observe the expected failure, then make the smallest root-cause fix and rerun the focused and full suites.

Dependency work is limited to updating the pinned `@opencode-ai/plugin` package from 1.17.13 to the current compatible 1.17.20 release and validating the resulting lockfile. The existing Dependabot PR for 1.17.18 is therefore superseded by this release branch.

## Confirmed Starting Defects

1. Public release metadata is stale and inconsistent with the latest published release: Git tag and release `v1.0.1` point at `main`, while `package.json`, `package-lock.json`, `extension/manifest.json`, the README badge, popup markup, and popup preview fallback still report 1.0.0.
2. The production plugin dependency is pinned to 1.17.13 while 1.17.20 is the current compatible patch. The open 1.17.18 update has green CI but is already behind.
3. The repository has no regression that requires release-facing version fields to stay synchronized, so partial future bumps can pass all existing tests.

Any further issue must be reproduced from current code or runtime evidence before it is changed.

## Verification Design

The release gate is cumulative:

1. Static integrity: JavaScript syntax checks, Semgrep JavaScript rules, secret scan, clean dependency tree, and zero known production vulnerabilities.
2. Automated behavior: the complete Node test suite on the Chrome-registered Node 26.3.1 runtime, including new regression tests.
3. Native integration: command, error, large-response, event, permission, and cleanup paths through the native-host smoke test.
4. Installed runtime: verification of the OpenCode config, native-host manifest and launcher, extension ID/path/enabled state, plus a real create/get/evaluate/viewport/reset/close tab lifecycle in Chrome using a temporary `about:blank` tab.
5. Cross-platform CI: Ubuntu, macOS, and Windows jobs must pass on the release PR.
6. Release integrity: all version fields must equal 1.0.2, the tag must point to the verified integrated commit, and the GitHub release must be non-draft and non-prerelease.

## Error and Safety Policy

- Browser commands and permission checks remain fail-closed.
- No personal tabs, history, bookmarks, downloads, cookies, profile contents, or bearer tokens are printed during verification.
- Runtime tests create only temporary tabs and files and clean them in `finally` blocks.
- No release is created from an unmerged or failing commit.
- If branch protection prevents integration, publish a PR with complete evidence and continue only after the required repository policy is satisfied.

## Acceptance Criteria

- Every tracked executable source file and trust boundary listed above has been inspected.
- Every reproduced defect has a regression test or an explicit release-integrity check.
- All local gates pass with zero failures under Node 26.3.1.
- The installed bridge completes the real Chrome lifecycle without leaving the temporary tab open.
- GitHub CI passes on Ubuntu, macOS, and Windows.
- The work is integrated into `main`.
- Tag `v1.0.2` and its GitHub release point to that integrated commit and contain an evidence-based changelog.
