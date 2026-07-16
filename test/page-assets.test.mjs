import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializePageAssetBundle } from "../src/workspace-artifacts.js";

test("page asset bundles decode text and base64, dedupe safe names, and publish a URL manifest", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-"));
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  const result = await materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "artifacts/assets",
    assets: [
      { url: "https://example.com/a/app.js?one", mimeType: "text/javascript", content: "console.log(1)" },
      { url: "https://example.com/b/app.js?two", mimeType: "text/javascript", content: "console.log(2)" },
      { url: "https://example.com/image.png", mimeType: "image/png", content: "iVBORw0KGgo=", base64Encoded: true }
    ]
  });

  assert.equal(result.assets.length, 3);
  assert.equal(new Set(result.assets.map((asset) => asset.filename)).size, 3);
  assert.ok(result.assets.every((asset) => !asset.filename.includes("?") && !asset.filename.includes("..")));
  assert.deepEqual(await readFile(path.join(result.path, result.assets[2].filename)), Buffer.from("89504e470d0a1a0a", "hex"));
  const manifest = JSON.parse(await readFile(path.join(result.path, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.assets.map((asset) => asset.url), [
    "https://example.com/a/app.js?one",
    "https://example.com/b/app.js?two",
    "https://example.com/image.png"
  ]);
  assert.ok(manifest.assets.every((asset) => /^[a-f0-9]{64}$/u.test(asset.sha256) && asset.size > 0));
});

test("page asset bundles enforce one total byte cap without publishing partial output", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-limit-"));
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  await assert.rejects(() => materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "artifacts/assets",
    totalByteLimit: 4,
    assets: [{ url: "https://example.com/app.js", mimeType: "text/javascript", content: "12345" }]
  }), /total byte limit/iu);
  assert.deepEqual(await readdir(projectDirectory), []);
});

test("page asset bundles reject invalid base64 and symlink output escapes", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-safe-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-outside-"));
  t.after(() => Promise.all([
    rm(projectDirectory, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  await assert.rejects(() => materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "assets",
    assets: [{ url: "https://example.com/a.bin", mimeType: "application/octet-stream", content: "!!!!", base64Encoded: true }]
  }), /base64/iu);
  await symlink(outside, path.join(projectDirectory, "escape"));
  await assert.rejects(() => materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "escape/assets",
    assets: []
  }), /symbolic link|outside|workspace|project/iu);
});

test("page asset transaction cleanup never recursively follows an unverified final path", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../src/workspace-artifacts.js"), "utf8");
  assert.match(source, /stagingPath = path\.join\(directory\.projectRoot/u);
  assert.doesNotMatch(source, /rm\(finalPath,\s*\{\s*recursive:\s*true/u);
});
