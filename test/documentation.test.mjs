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
    "chrome_favicon_badge"
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
