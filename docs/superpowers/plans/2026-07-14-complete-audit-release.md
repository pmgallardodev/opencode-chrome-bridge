# Complete Audit and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every defect reproduced by the complete repository/runtime audit and publish verified release `v1.0.2`.

**Architecture:** Preserve the existing plugin → HTTP client → native host → MV3 extension → Chrome design. Add fail-fast validation at the extension boundary, keep the permission gate deny-by-default, and make release metadata consistency executable through tests.

**Tech Stack:** Node.js 26.3.1, Node test runner, Chrome Manifest V3 APIs, npm lockfile v3, GitHub Actions and GitHub Releases.

## Global Constraints

- `@opencode-ai/plugin` must be pinned exactly to `1.17.20`.
- All release-facing versions must be exactly `1.0.2` before tagging.
- Every browser tool except `chrome_status` remains approval-gated and fail-closed.
- Runtime checks must not print personal browser data or bearer tokens.
- Every behavioral fix follows a witnessed red-green regression cycle.
- The tag is created only from the integrated `main` commit after Ubuntu, macOS, and Windows CI pass.

---

### Task 1: Fix browser lifecycle input validation and downloads-folder behavior

**Files:**
- Modify: `test/background-runtime.test.mjs`
- Modify: `extension/background.js`

**Interfaces:**
- Consumes: `executeCommand(method, params)` and the Chrome API test harness.
- Produces: `validateOptionalLeaseParams(params)`; `showDownload({})` opens the default downloads folder; tab/window creation rejects incomplete lease identifiers before browser mutation.

- [ ] **Step 1: Add failing runtime regressions**

Extend `createBackgroundHarness()` with injectable `tabsCreate`, `windowsCreate`, and `downloadsShowDefaultFolder` functions and counters. Add these tests:

```js
test("showDownload opens the default folder when downloadId is omitted", async () => {
  let defaultFolderCalls = 0;
  const harness = createBackgroundHarness({
    downloadsShowDefaultFolder: async () => { defaultFolderCalls += 1; }
  });

  const result = await harness.execute("showDownload", {});

  assert.equal(result.showed, "defaultFolder");
  assert.equal(defaultFolderCalls, 1);
});

test("tab creation rejects partial lease identifiers before opening a tab", async () => {
  let createCalls = 0;
  const harness = createBackgroundHarness({
    tabsCreate: async () => { createCalls += 1; return { id: 8 }; }
  });

  await assert.rejects(
    harness.execute("createTab", { url: "about:blank", sessionId: "session-a" }),
    /sessionId and turnId must be provided together/u
  );
  assert.equal(createCalls, 0);
});

test("window creation rejects empty lease identifiers before opening a window", async () => {
  let createCalls = 0;
  const harness = createBackgroundHarness({
    windowsCreate: async () => { createCalls += 1; return { id: 2, tabs: [] }; }
  });

  await assert.rejects(
    harness.execute("createWindow", { sessionId: "", turnId: "turn-a" }),
    /sessionId must be a non-empty string/u
  );
  assert.equal(createCalls, 0);
});
```

- [ ] **Step 2: Run the focused test and witness the expected failures**

Run:

```bash
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test test/background-runtime.test.mjs
```

Expected: the downloads test fails with `downloadId must be an integer`; the lease tests show that mutation occurred or fail without the new validation message.

- [ ] **Step 3: Implement the minimal root-cause fixes**

Validate paired lease identifiers before `chrome.tabs.create()` and `chrome.windows.create()`:

```js
function validateOptionalLeaseParams(params) {
  const hasSessionId = params.sessionId != null;
  const hasTurnId = params.turnId != null;
  if (hasSessionId !== hasTurnId) {
    throw new Error("sessionId and turnId must be provided together");
  }
  if (hasSessionId) {
    requireNonEmptyString(params.sessionId, "sessionId");
    requireNonEmptyString(params.turnId, "turnId");
  }
}
```

Call it at the beginning of the `createTab` and `createWindow` cases. Change `showDownload()` so `params.downloadId == null` selects `chrome.downloads.showDefaultFolder()` while preserving explicit `showDefaultFolder: true` compatibility.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test test/background-runtime.test.mjs
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit the behavioral fixes**

```bash
git add extension/background.js test/background-runtime.test.mjs
git commit -m "fix: validate browser lifecycle commands"
```

### Task 2: Synchronize and lock release metadata

**Files:**
- Modify: `test/documentation.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `extension/manifest.json`
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: package, manifest, popup, README, and lockfile metadata.
- Produces: one regression proving every release-facing field equals `1.0.2`.

- [ ] **Step 1: Add the failing version consistency regression**

Add a test that reads all release-facing files and asserts:

```js
test("release metadata is synchronized for v1.0.2", async () => {
  const expectedVersion = "1.0.2";
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"));
  const popupHtml = await readFile(path.join(repoRoot, "extension", "popup.html"), "utf8");
  const popupJs = await readFile(path.join(repoRoot, "extension", "popup.js"), "utf8");
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.equal(packageJson.version, expectedVersion);
  assert.equal(packageLock.version, expectedVersion);
  assert.equal(packageLock.packages[""].version, expectedVersion);
  assert.equal(manifest.version, expectedVersion);
  assert.match(popupHtml, /<span id="version">v1\.0\.2<\/span>/u);
  assert.match(popupJs, /"v1\.0\.2"/u);
  assert.match(readme, /Version-v1\.0\.2-/u);
  assert.match(readme, /alt="Version v1\.0\.2"/u);
});
```

- [ ] **Step 2: Run the focused test and witness the expected failure**

Run:

```bash
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test --test-name-pattern="release metadata" test/documentation.test.mjs
```

Expected: FAIL because the current values are `1.0.0`.

- [ ] **Step 3: Update every version field to 1.0.2**

Change both package-lock root versions, package version, manifest version, popup markup/fallback, README badge URL, and README badge alt text from `1.0.0` to `1.0.2`.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test --test-name-pattern="release metadata" test/documentation.test.mjs
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit the synchronized metadata**

```bash
git add README.md extension/manifest.json extension/popup.html extension/popup.js package.json package-lock.json test/documentation.test.mjs
git commit -m "fix: synchronize v1.0.2 release metadata"
```

### Task 3: Update the pinned OpenCode plugin dependency

**Files:**
- Modify: `test/documentation.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: npm registry metadata for `@opencode-ai/plugin@1.17.20`.
- Produces: a reproducible lockfile with plugin and SDK 1.17.20 and a regression pinning the intended production dependency.

- [ ] **Step 1: Add the failing dependency regression**

Add assertions to the release metadata test:

```js
assert.equal(packageJson.dependencies["@opencode-ai/plugin"], "1.17.20");
assert.equal(packageLock.packages[""].dependencies["@opencode-ai/plugin"], "1.17.20");
assert.equal(packageLock.packages["node_modules/@opencode-ai/plugin"].version, "1.17.20");
assert.equal(packageLock.packages["node_modules/@opencode-ai/sdk"].version, "1.17.20");
```

- [ ] **Step 2: Run the focused test and witness the 1.17.13 failure**

Run:

```bash
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test --test-name-pattern="release metadata" test/documentation.test.mjs
```

Expected: FAIL comparing 1.17.13 with 1.17.20.

- [ ] **Step 3: Generate the compatible lockfile with Node 26.3.1**

Run:

```bash
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node /Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/lib/node_modules/npm/bin/npm-cli.js install --save-exact @opencode-ai/plugin@1.17.20
```

Expected: package and lockfile pin 1.17.20; npm reports zero vulnerabilities.

- [ ] **Step 4: Verify dependency integrity and all tests**

Run:

```bash
npm ls --all
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test
```

Expected: clean dependency tree and zero test failures.

- [ ] **Step 5: Commit the dependency update**

```bash
git add package.json package-lock.json test/documentation.test.mjs
git commit -m "chore: update OpenCode plugin to 1.17.20"
```

### Task 4: Execute the complete local release gate

**Files:**
- Verify only: all tracked files and installed runtime state.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: fresh evidence for static, dependency, native, installation, and real-browser correctness.

- [ ] **Step 1: Run syntax, tests, smoke, dependency, and static-security checks**

Run with Node 26.3.1:

```bash
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node scripts/check-syntax.mjs
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node --test --experimental-test-coverage
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node scripts/smoke-native-host.mjs
npm ls --all
npm audit --omit=dev
semgrep scan --config=p/javascript --error --metrics=off .
gitleaks detect --source . --no-banner --redact
git diff --check origin/main...HEAD
```

Expected: zero failures, vulnerabilities, Semgrep findings, secret findings, or whitespace errors.

- [ ] **Step 2: Verify the existing installed baseline without registering a temporary path**

Run the installation checks from the permanent main checkout:

```bash
cd /Users/pablomiguelgallardo/Desktop/Opencode
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node scripts/verify.mjs
/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node scripts/check-chrome-extension.mjs
```

Expected: the permanent checkout remains registered with a Node 26.3.1 launcher and the extension is enabled. Do not add the temporary worktree to the global OpenCode config; branch code is covered by the Node/VM/native smoke gates until it is integrated.

- [ ] **Step 3: Run a temporary real-Chrome lifecycle**

Use `src/bridge-client.js` to create an inactive `about:blank` tab, get it, evaluate a fixed object, set/reset an 800×600 emulated viewport, then close the tab in `finally`. Print only booleans for each assertion.

Expected: every boolean is `true`; the temporary tab is closed.

- [ ] **Step 4: Audit the final diff against the design**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Expected: only the planned documentation, tests, version/dependency metadata, and demonstrated root-cause fixes are present.

### Task 5: Integrate, tag, and publish v1.0.2

**Files:**
- External state: Git branch, GitHub PR, protected `main`, tag `v1.0.2`, GitHub release.

**Interfaces:**
- Consumes: verified branch `audit/v1.0.2` and GitHub repository policy.
- Produces: integrated commit, annotated evidence in the release notes, tag and public release `v1.0.2`.

- [ ] **Step 1: Push the branch and open the release PR**

```bash
git push -u origin audit/v1.0.2
gh pr create --base main --head audit/v1.0.2 --title "Fix bridge lifecycle bugs and prepare v1.0.2" --body "Fixes the default downloads-folder action, validates lifecycle lease identifiers before browser mutation, synchronizes all v1.0.2 metadata, and updates the pinned OpenCode plugin. Verification includes Node 26 tests and coverage, native-host smoke, npm audit, Semgrep, Gitleaks, installation checks, and a temporary real-Chrome lifecycle."
```

Expected: a PR URL targeting `main`.

- [ ] **Step 2: Require all cross-platform checks**

```bash
gh pr checks --watch --interval 10 audit/v1.0.2
```

Expected: Ubuntu, macOS, and Windows Node jobs all pass.

- [ ] **Step 3: Merge under repository policy and verify integration**

```bash
gh pr merge audit/v1.0.2 --merge --delete-branch
git fetch --prune origin
git merge --ff-only origin/main
```

Expected: local `main`/integration target contains every audited commit. If review policy rejects self-merge, stop without tagging until the required approval is present.

- [ ] **Step 4: Reinstall and repeat the complete release gate on the integrated commit**

From `/Users/pablomiguelgallardo/Desktop/Opencode` on integrated `main`, run:

```bash
npm ci
npm run install:native -- --node=/Users/pablomiguelgallardo/.local/share/fnm/node-versions/v26.3.1/installation/bin/node
npm run install:opencode
npm run verify
npm run check:chrome-extension
```

Reload the unpacked extension so Chrome reads manifest/background version 1.0.2, then repeat Task 4 Steps 1 and 3 against the integrated commit.

Expected: the permanent launcher/config/extension path all resolve to integrated `main`, the extension reports version 1.0.2, and the complete static/native/real-Chrome evidence remains green.

- [ ] **Step 5: Create and verify the release**

```bash
gh release create v1.0.2 --target main --title v1.0.2 --notes "Fix browser lifecycle validation and the default downloads-folder action; synchronize package, extension, popup, lockfile, and README metadata; update @opencode-ai/plugin to 1.17.20. Verified with the complete Node 26.3.1 suite and coverage, native-host round trips including a 9 MiB response, npm audit, Semgrep, Gitleaks, installation verification, a temporary real-Chrome lifecycle, and passing Ubuntu, macOS, and Windows CI."
gh release view v1.0.2 --json tagName,name,publishedAt,targetCommitish,url,body,isDraft,isPrerelease,isImmutable
git ls-remote --tags origin refs/tags/v1.0.2
```

Expected: a non-draft, non-prerelease release whose tag and remote ref resolve to the verified integrated SHA.
