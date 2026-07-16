import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("README documents first-class Windows installation and verification", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /Windows 10\/11/u);
  assert.match(readme, /PowerShell/u);
  assert.match(readme, /HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.opencode\.chrome_bridge/u);
  assert.match(readme, /opencode-chrome-native-host\.cmd/u);
  assert.match(readme, /reg\.exe query/u);
  assert.match(readme, /setup-windows\.cmd/u);
  assert.match(readme, /does not install.*Node\.js.*OpenCode.*Chrome/isu);
  assert.match(readme, /installs? (?:this repository as|the) OpenCode plugin/iu);
  assert.match(readme, /Load unpacked/iu);
  assert.match(readme, /--no-pause/u);
  assert.match(readme, /without (?:administrator|admin) privileges/iu);
  assert.match(readme, /npm ci/u);
  assert.doesNotMatch(readme, /Windows native messaging path not yet implemented/u);
  assert.doesNotMatch(readme, /Windows support needs registry installation/u);
});

test("README describes current Playwright MCP capabilities and the bridge differentiators", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /Playwright MCP[\s\S]*existing browser tabs/iu);
  assert.match(readme, /persistent profile/iu);
  assert.match(readme, /history and bookmarks/iu);
  assert.match(readme, /tab groups/iu);
  assert.doesNotMatch(readme, /\| Headless \/ fresh session \|/u);
  assert.doesNotMatch(readme, /\| Start fresh each run \|/u);
});

test("README explains Chrome Canary as a manual Windows variant", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /Chrome Canary on Windows/iu);
  assert.match(readme, /Google\\Chrome SxS\\NativeMessagingHosts/u);
  assert.match(readme, /manual/iu);
});

test("README lists every public browser lifecycle tool and current project files", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  for (const name of [
    "chrome_claim_tab",
    "chrome_finalize_tabs",
    "chrome_end_turn",
    "chrome_release_debuggers",
    "chrome_cursor_state",
    "chrome_favicon_badge",
    "chrome_accessibility_tree",
    "chrome_click_element",
    "chrome_fill_element",
    "chrome_blocked_urls"
  ]) {
    assert.ok(readme.includes(`\`${name}\``), `README is missing ${name}`);
  }
  for (const name of ["setup-windows.mjs", "windows-setup.mjs", "opencode-config.mjs", "windows-setup.test.mjs"]) {
    assert.match(readme, new RegExp(name.replaceAll(".", "\\."), "u"), `project structure is missing ${name}`);
  }
});

test("tracked product text contains no references to the removed comparison product", async () => {
  const marker = "code" + "x";
  const files = await collectTextFiles(repoRoot);
  const matches = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text?.toLowerCase().includes(marker)) matches.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(matches, []);
});

test("package metadata is safe and complete for a public source repository", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.engines.node, "^22.22.2 || ^24.15.0 || >=26.0.0");
  assert.equal(packageJson.repository?.type, "git");
  assert.equal(packageJson.repository?.url, "git+https://github.com/pmgallardodev/opencode-chrome-bridge.git");
  assert.equal(packageJson.homepage, "https://github.com/pmgallardodev/opencode-chrome-bridge#readme");
  assert.equal(packageJson.bugs?.url, "https://github.com/pmgallardodev/opencode-chrome-bridge/issues");
});

test("release metadata is synchronized for v1.3.0", async () => {
  const expectedVersion = "1.3.0";
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"));
  const popupHtml = await readFile(path.join(repoRoot, "extension", "popup.html"), "utf8");
  const popupJs = await readFile(path.join(repoRoot, "extension", "popup.js"), "utf8");
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const bridgeClient = await readFile(path.join(repoRoot, "src", "bridge-client.js"), "utf8");
  const nativeHost = await readFile(path.join(repoRoot, "native-host", "opencode-chrome-native-host.mjs"), "utf8");

  assert.equal(packageJson.version, expectedVersion);
  assert.equal(packageLock.version, expectedVersion);
  assert.equal(packageLock.packages[""].version, expectedVersion);
  assert.equal(manifest.version, expectedVersion);
  assert.match(popupHtml, /<span id="version">v1\.3\.0<\/span>/u);
  assert.match(popupJs, /"v1\.3\.0"/u);
  assert.match(readme, /Version-v1\.3\.0-/u);
  assert.match(readme, /alt="Version v1\.3\.0"/u);
  assert.match(bridgeClient, /BRIDGE_CLIENT_VERSION = "1\.3\.0"/u);
  assert.match(nativeHost, /HOST_VERSION = "1\.3\.0"/u);
  assert.equal(packageJson.dependencies["@opencode-ai/plugin"], "1.17.20");
  assert.equal(packageLock.packages[""].dependencies["@opencode-ai/plugin"], "1.17.20");
  assert.equal(packageLock.packages["node_modules/@opencode-ai/plugin"].version, "1.17.20");
  assert.equal(packageLock.packages["node_modules/@opencode-ai/sdk"].version, "1.17.20");
});

test("README documents v1.3 session control, privacy, assets, notifications, and recovery limits", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  for (const tool of ["chrome_resume_session", "chrome_upload_files", "chrome_network_requests", "chrome_page_assets", "chrome_notify"]) {
    assert.ok(readme.includes(`\`${tool}\``), `README is missing ${tool}`);
  }
  assert.match(readme, /scheme:\/\/host:effective-port\/path/iu);
  assert.match(readme, /request bodies.*never|never.*request bodies/iu);
  assert.match(readme, /10 MiB/iu);
  assert.match(readme, /120 characters/iu);
  assert.match(readme, /1,?000 characters/iu);
  assert.match(readme, /npm run install:native/u);
  assert.match(readme, /npm run install:opencode/u);
  assert.match(readme, /chrome:\/\/extensions/u);
  assert.match(readme, /cross-origin content.*not fetched|never fetches.*cross-origin/iu);
  assert.match(readme, /asset URLs.*redact|redact.*asset URLs/iu);
  assert.match(readme, /complete manifest permissions.*host origins|host origins.*complete manifest permissions/iu);
  assert.match(readme, /missing capabilities/iu);
});

test("README documents the exact Browser Intelligence public tools and safeguards", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const extractSection = (contents) => contents.match(
    /### Browser Intelligence\r?\n([\s\S]*?)(?=\r?\n### )/u
  )?.[1] ?? "";
  const section = extractSection(readme);
  assert.equal(
    extractSection(readme.replace(/\r?\n/gu, "\r\n")).replace(/\r\n/gu, "\n"),
    section.replace(/\r\n/gu, "\n")
  );
  const documentedTools = [...section.matchAll(/\| `(chrome_[a-z_]+)` \|/gu)].map((match) => match[1]);
  assert.deepEqual(documentedTools, [
    "chrome_tab_context",
    "chrome_read_page",
    "chrome_find",
    "chrome_wait_for",
    "chrome_batch"
  ]);
  assert.match(section, /25 actions/iu);
  assert.match(section, /30,?000 ms/iu);
  assert.match(section, /120,?000 ms/iu);
  assert.match(section, /outputDirectory[\s\S]*project/iu);
  assert.match(section, /atomic[\s\S]*collision-safe/iu);
  assert.match(section, /one (?:OpenCode )?approval/iu);
  assert.match(section, /allow once[\s\S]*allow always[\s\S]*deny/iu);
  assert.match(section, /raw CDP|arbitrary CDP/iu);
  assert.match(section, /stopOnError/u);
  assert.match(section, /"type": "findElements"/u);
  assert.match(section, /"type": "waitFor"/u);
});

test("public repository includes governance and security documents", async () => {
  for (const file of [
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".gitleaks.toml"
  ]) {
    await assert.doesNotReject(access(path.join(repoRoot, file)), `missing ${file}`);
  }
});

test("CI uses a supported Node release and runs all local quality gates", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  assert.match(workflow, /node-version: ["']22\.22\.2["']/u);
  for (const command of ["npm ci", "npm run check", "npm test", "npm run smoke:native", "npm audit --audit-level=high"]) {
    assert.ok(workflow.includes(`run: ${command}`), `CI is missing ${command}`);
  }
});

test("security policy documents the browser-control boundary and private reporting", async () => {
  const security = await readFile(path.join(repoRoot, "SECURITY.md"), "utf8");

  assert.match(security, /privately/iu);
  assert.match(security, /security\/advisories\/new/u);
  assert.match(security, /real Chrome profile/iu);
  assert.match(security, /127\.0\.0\.1/u);
  assert.match(security, /every browser tool except `chrome_status`/iu);
  assert.match(security, /fails closed/iu);
  assert.doesNotMatch(security, /falls? back/iu);
});

test("README documents deny-by-default browser approvals", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /every browser tool except `chrome_status`/iu);
  assert.match(readme, /fails closed/iu);
  assert.doesNotMatch(readme, /gate falls back/iu);
});

test("README distinguishes path-local approvals from origin-wide JavaScript and raw CDP", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /page-local tools[\s\S]*path boundaries/iu);
  assert.match(readme, /arbitrary JavaScript[\s\S]*raw.*CDP[\s\S]*origin root/iu);
  assert.match(readme, /same-origin[\s\S]*\/public[\s\S]*\/admin/iu);
});

test("README explains that extension pages cannot access the HTTP bridge", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /extension-page CSP blocks network connections/iu);
});

async function collectTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTextFiles(entryPath));
    else if (entry.isFile() && !/\.(?:png|ico)$/u.test(entry.name)) files.push(entryPath);
  }
  return files;
}
