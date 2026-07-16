import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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

test("page asset publication rolls back its own bundle after an output-directory symlink swap", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-race-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-race-outside-"));
  t.after(() => Promise.all([
    rm(projectDirectory, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  await mkdir(path.join(projectDirectory, "artifacts"));
  await writeFile(path.join(outside, "unrelated.txt"), "keep me");
  const originalDirectory = path.join(projectDirectory, "artifacts-original");
  await assert.rejects(() => materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "artifacts",
    assets: [{ url: "https://example.com/app.js", mimeType: "text/javascript", content: "secret bytes" }],
    renameBundle: async (source, destination) => {
      await rename(path.join(projectDirectory, "artifacts"), originalDirectory);
      await symlink(outside, path.join(projectDirectory, "artifacts"));
      await rename(source, destination);
    }
  }), /output directory changed|identity|publish/iu);
  assert.deepEqual(await readdir(outside), ["unrelated.txt"]);
  assert.equal(await readFile(path.join(outside, "unrelated.txt"), "utf8"), "keep me");
  assert.deepEqual(await readdir(originalDirectory), []);
});

test("page asset manifests propagate inventory overflow and never persist signed URL secrets", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-private-"));
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  const bundle = await materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "assets",
    inventoryTruncated: true,
    assets: [{
      url: "https://user:password@example.com/app.js?X-Amz-Credential=AKIA-SECRET&token=raw-token#private",
      mimeType: "text/javascript",
      content: "console.log('safe')"
    }]
  });
  const manifest = await readFile(path.join(bundle.path, "manifest.json"), "utf8");
  assert.equal(JSON.parse(manifest).inventoryTruncated, true);
  assert.equal(JSON.parse(manifest).truncated, true);
  assert.doesNotMatch(`${manifest}\n${(await readdir(bundle.path)).join("\n")}`, /user|password|AKIA-SECRET|raw-token|#private/iu);
  assert.match(manifest, /X-Amz-Credential=%5BREDACTED%5D/iu);
});

test("page asset staging rejects a path swap before the first retained file is opened", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-stage-open-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-stage-open-outside-"));
  t.after(() => Promise.all([
    rm(projectDirectory, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  let originalStaging;
  await assert.rejects(() => materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "assets",
    assets: [{ url: "https://example.com/private.js", content: "private page bytes" }],
    beforeBundleFileOpen: async ({ stagingPath }) => {
      originalStaging = `${stagingPath}.moved`;
      await rename(stagingPath, originalStaging);
      await symlink(outside, stagingPath);
    }
  }), /staging|identity|changed/iu);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(originalStaging), []);
});

test("page asset staging zeroes every retained file when its directory inode moves outside", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-stage-move-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-stage-move-outside-"));
  t.after(() => Promise.all([
    rm(projectDirectory, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  const stolen = path.join(outside, "stolen-bundle");
  await assert.rejects(() => materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "assets",
    assets: [
      { url: "https://example.com/one.js", content: "first private page bytes" },
      { url: "https://example.com/two.js", content: "second private page bytes" }
    ],
    afterBundleFilesWritten: async ({ stagingPath }) => {
      await rename(stagingPath, stolen);
    }
  }), /staging|identity|changed/iu);
  const stolenFiles = await readdir(stolen);
  assert.equal(stolenFiles.length, 3);
  for (const filename of stolenFiles) {
    assert.equal((await readFile(path.join(stolen, filename))).length, 0, filename);
  }
});

test("page asset cleanup never deletes an unrelated staging-path replacement", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-stage-cleanup-"));
  const owned = path.join(projectDirectory, "owned-moved-aside");
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  let replacement;
  await assert.rejects(() => materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "assets",
    assets: [{ url: "https://example.com/private.js", content: "private page bytes" }],
    afterBundleFilesWritten: async () => { throw new Error("injected publish failure"); },
    beforeBundleCleanup: async ({ stagingPath }) => {
      replacement = stagingPath;
      await rename(stagingPath, owned);
      await mkdir(stagingPath);
      await writeFile(path.join(stagingPath, "unrelated-sentinel.txt"), "keep me");
    }
  }), /injected publish failure/iu);
  assert.equal(await readFile(path.join(replacement, "unrelated-sentinel.txt"), "utf8"), "keep me");
  for (const filename of await readdir(owned)) {
    assert.equal((await readFile(path.join(owned, filename))).length, 0, filename);
  }
});

test("page asset bundles cap retained content files and describe every omitted resource", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-page-assets-fd-cap-"));
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  const bundle = await materializePageAssetBundle({
    projectDirectory,
    outputDirectory: "assets",
    assets: Array.from({ length: 130 }, (_, index) => ({
      url: `https://example.com/${index}.js`,
      content: String(index)
    }))
  });
  const manifest = JSON.parse(await readFile(path.join(bundle.path, "manifest.json"), "utf8"));
  assert.equal(manifest.assets.length, 130);
  assert.equal(manifest.assets.filter((asset) => asset.filename !== null).length, 127);
  assert.equal(manifest.assets.filter((asset) => /omitted/iu.test(asset.error ?? "")).length, 3);
  assert.equal(manifest.truncated, true);
  assert.equal((await readdir(bundle.path)).length, 128);
});
