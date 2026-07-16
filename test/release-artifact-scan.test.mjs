import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanTrackedFiles } from "../scripts/lib/release-artifact-scan.mjs";

async function fixture(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-scan-"));
  for (const [relativePath, content] of Object.entries(entries)) {
    const target = path.join(root, relativePath.replaceAll("\\", "/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test("release scanner rejects normalized sensitive paths and binary/archive artifacts", async () => {
  const cases = [
    ".ENV.Production",
    "config\\Credentials.JSON",
    "exports/session-token.txt",
    "Artifacts/Screenshots/result.PNG",
    "Traces/run.json",
    "logs/browser trace.JSON",
    "Downloaded Extensions/tool.CRX",
    "Competitor Extensions/addon.ZIP",
    "Audit Copies/report.md",
    "Docs/Super Powers/notes.md",
    "SUPERPOWERS.md",
    "keys/private key.PEM"
  ];
  for (const trackedPath of cases) {
    const root = await fixture({ [trackedPath]: "fixture" });
    try {
      const issues = await scanTrackedFiles({ root, trackedPaths: [trackedPath] });
      assert.ok(issues.some((issue) => issue.path === trackedPath), `scanner allowed ${trackedPath}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("release scanner rejects high-confidence secrets in tracked text", async () => {
  const cases = [
    "-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----",
    `github_token = "ghp_${"a".repeat(36)}"`,
    `openai_token = "sk-proj-${"b".repeat(32)}"`,
    `aws_access_key_id = "AKIA${"C".repeat(16)}"`,
    "password = \"correct-horse-battery-staple\"",
    "api_token: \"live_token_value_123456789\""
  ];
  for (const [index, content] of cases.entries()) {
    const trackedPath = `src/case-${index}.txt`;
    const root = await fixture({ [trackedPath]: content });
    try {
      const issues = await scanTrackedFiles({ root, trackedPaths: [trackedPath] });
      assert.ok(issues.some((issue) => issue.kind === "secret"), `scanner allowed secret case ${index}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("release scanner accepts a safe tree and explicit fixture/documentation placeholders", async () => {
  const entries = {
    ".env.example": "API_TOKEN=YOUR_TOKEN_HERE\n",
    "README.md": "token = \"<your-token>\"\npassword = \"REDACTED\"\n",
    "extension/images/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "src/index.js": "export const version = '1.4.0';\n",
    "test/release-artifact-scan.test.mjs": `const fake = "ghp_${"z".repeat(36)}";`
  };
  const root = await fixture(entries);
  try {
    assert.deepEqual(await scanTrackedFiles({ root, trackedPaths: Object.keys(entries) }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release scanner fails closed on oversized tracked text files", async () => {
  const trackedPath = "logs/oversized-audit.log";
  const root = await fixture({
    [trackedPath]: `github_token = "ghp_${"a".repeat(36)}"\n${"x".repeat((2 * 1024 * 1024) + 64)}`
  });
  try {
    const issues = await scanTrackedFiles({ root, trackedPaths: [trackedPath] });
    assert.ok(
      issues.some((issue) => issue.path === trackedPath && issue.reason === "oversized tracked text file"),
      "scanner must reject oversized tracked text instead of skipping it"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
