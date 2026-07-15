import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadArtifacts() {
  return import("../src/workspace-artifacts.js");
}

test("workspace text artifacts are atomic and collision-safe", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-artifacts-"));
  t.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const { writeWorkspaceTextArtifact } = await loadArtifacts();

  const first = await writeWorkspaceTextArtifact({
    outputDirectory: "artifacts/browser",
    prefix: "tab-context",
    projectDirectory,
    text: "first page text"
  });
  const second = await writeWorkspaceTextArtifact({
    outputDirectory: "artifacts/browser",
    prefix: "tab-context",
    projectDirectory,
    text: "second page text"
  });

  assert.notEqual(first.path, second.path);
  assert.match(first.relativePath, /^artifacts[\\/]browser[\\/]tab-context-[a-z0-9-]+\.txt$/u);
  assert.equal(first.mimeType, "text/plain; charset=utf-8");
  assert.equal(first.bytes, Buffer.byteLength("first page text"));
  assert.equal(await readFile(first.path, "utf8"), "first page text");
  assert.equal(await readFile(second.path, "utf8"), "second page text");
  const entries = await readdir(path.join(projectDirectory, "artifacts", "browser"));
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
});

test("workspace image artifacts accept only bounded PNG and JPEG data URLs", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-images-"));
  t.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const { writeWorkspaceImageArtifact } = await loadArtifacts();
  const png = "data:image/png;base64,iVBORw0KGgo=";

  const artifact = await writeWorkspaceImageArtifact({
    dataUrl: png,
    outputDirectory: "captures",
    prefix: "page-screenshot",
    projectDirectory
  });

  assert.equal(artifact.mimeType, "image/png");
  assert.match(artifact.relativePath, /^captures[\\/]page-screenshot-[a-z0-9-]+\.png$/u);
  assert.deepEqual(await readFile(artifact.path), Buffer.from("89504e470d0a1a0a", "hex"));
  await assert.rejects(
    writeWorkspaceImageArtifact({
      dataUrl: "data:image/gif;base64,R0lGODlh",
      outputDirectory: "captures",
      prefix: "page-screenshot",
      projectDirectory
    }),
    /unsupported MIME type/u
  );
  await assert.rejects(
    writeWorkspaceImageArtifact({
      dataUrl: "data:image/png;base64,YWJjZA==",
      outputDirectory: "captures",
      prefix: "page-screenshot",
      projectDirectory
    }),
    /valid image\/png signature/u
  );
});

test("workspace artifacts reject path traversal, absolute output directories, and symlink escapes", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-contained-"));
  const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-outside-"));
  t.after(() => Promise.all([
    rm(projectDirectory, { force: true, recursive: true }),
    rm(outsideDirectory, { force: true, recursive: true })
  ]));
  const { writeWorkspaceTextArtifact } = await loadArtifacts();

  for (const outputDirectory of ["../escape", path.resolve(outsideDirectory)]) {
    await assert.rejects(
      writeWorkspaceTextArtifact({
        outputDirectory,
        prefix: "tab-context",
        projectDirectory,
        text: "private page"
      }),
      /relative.*within the project directory|within the project directory.*relative/iu
    );
  }

  await mkdir(path.join(projectDirectory, "artifacts"));
  const linkPath = path.join(projectDirectory, "artifacts", "outside-link");
  try {
    await symlink(outsideDirectory, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("creating directory symlinks requires elevated Windows privileges");
      return;
    }
    throw error;
  }
  await assert.rejects(
    writeWorkspaceTextArtifact({
      outputDirectory: "artifacts/outside-link",
      prefix: "tab-context",
      projectDirectory,
      text: "private page"
    }),
    /symbolic link|within the project directory/iu
  );
  assert.deepEqual(await readdir(outsideDirectory), []);
});

test("oversized context text is replaced with a preview and a workspace artifact", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-preview-"));
  t.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const { materializeContextText } = await loadArtifacts();
  const visibleText = "page ".repeat(200);

  const result = await materializeContextText({
    context: { returnedChars: visibleText.length, title: "Example", totalChars: null, visibleText },
    force: false,
    outputDirectory: "browser-output",
    previewChars: 100,
    projectDirectory
  });

  assert.equal(result.context.visibleText.length, 100);
  assert.equal(result.artifact.preview, result.context.visibleText);
  assert.equal(result.artifact.originalChars, visibleText.length);
  assert.equal(result.artifact.returnedChars, visibleText.length);
  assert.equal(result.artifact.totalChars, null);
  assert.equal(await readFile(result.artifact.path, "utf8"), visibleText);
  assert.match(result.artifact.relativePath, /^browser-output[\\/]tab-context-[a-z0-9-]+\.txt$/u);
});

test("combined page artifacts replace raw data URLs with safe text and image paths", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-combined-"));
  t.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const { materializeReadPageArtifacts } = await loadArtifacts();
  const fullText = "visible ".repeat(100);

  const output = await materializeReadPageArtifacts({
    forceText: false,
    outputDirectory: "browser-output",
    previewChars: 100,
    projectDirectory,
    result: {
      accessibility: { nodeCount: 1, tree: '[e1] button "Continue"' },
      context: { returnedChars: fullText.length, totalChars: null, visibleText: fullText },
      screenshot: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", format: "png" },
      tabId: 7
    }
  });

  assert.equal(JSON.stringify(output).includes("dataUrl"), false);
  assert.equal(output.context.visibleText.length, 100);
  assert.equal(await readFile(output.context.visibleTextArtifact.path, "utf8"), fullText);
  assert.deepEqual(await readFile(output.screenshot.path), Buffer.from("89504e470d0a1a0a", "hex"));
});
