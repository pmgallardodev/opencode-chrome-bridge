import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
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

test("workspace artifact writing aborts and cleans up when the output directory is replaced", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-race-project-"));
  const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-race-outside-"));
  t.after(() => Promise.all([
    rm(projectDirectory, { force: true, recursive: true }),
    rm(outsideDirectory, { force: true, recursive: true })
  ]));
  const { writeWorkspaceTextArtifact } = await loadArtifacts();
  const parentDirectory = path.join(projectDirectory, "artifacts");
  const outputDirectory = path.join(parentDirectory, "browser");
  const movedDirectory = path.join(parentDirectory, "browser-moved");
  await mkdir(outputDirectory, { recursive: true });

  const probePath = path.join(projectDirectory, "file-handle-probe");
  const probe = await open(probePath, "w");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalWriteFile = fileHandlePrototype.writeFile;
  await probe.close();
  await rm(probePath, { force: true });

  let signalWriteStarted;
  const writeStarted = new Promise((resolve) => {
    signalWriteStarted = resolve;
  });
  let releaseWrite;
  const writeBarrier = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let barrierReleased = false;
  const releaseBarrier = () => {
    if (barrierReleased) return;
    barrierReleased = true;
    releaseWrite();
  };
  let intercepted = false;
  fileHandlePrototype.writeFile = async function (...args) {
    const result = await originalWriteFile.apply(this, args);
    if (!intercepted) {
      intercepted = true;
      signalWriteStarted();
      await writeBarrier;
    }
    return result;
  };
  t.after(() => {
    fileHandlePrototype.writeFile = originalWriteFile;
    releaseBarrier();
  });

  const writing = writeWorkspaceTextArtifact({
    outputDirectory: "artifacts/browser",
    prefix: "tab-context",
    projectDirectory,
    text: "race coverage"
  });
  void writing.catch(() => {});
  try {
    await writeStarted;
    await rename(outputDirectory, movedDirectory);
    try {
      await symlink(outsideDirectory, outputDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("creating directory symlinks requires elevated Windows privileges");
        releaseBarrier();
        await writing.catch(() => {});
        return;
      }
      throw error;
    }
    releaseBarrier();
    await assert.rejects(writing, /output directory changed during artifact write/u);
    assert.deepEqual(await readdir(outsideDirectory), []);
    assert.deepEqual(await readdir(movedDirectory), []);
    assert.equal((await readdir(projectDirectory)).some((entry) => entry.endsWith(".tmp")), false);
  } finally {
    fileHandlePrototype.writeFile = originalWriteFile;
    releaseBarrier();
    await writing.catch(() => {});
  }
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
  assert.equal(result.context.returnedChars, 100);
  assert.equal(result.context.totalChars, null);
  assert.equal(result.context.truncated.visibleText, true);
  assert.equal(result.artifact.preview, result.context.visibleText);
  assert.equal(result.artifact.originalChars, visibleText.length);
  assert.equal(result.artifact.originalReturnedChars, visibleText.length);
  assert.equal(result.artifact.originalTotalChars, null);
  assert.equal(result.artifact.originalTruncated, false);
  assert.equal(await readFile(result.artifact.path, "utf8"), visibleText);
  assert.match(result.artifact.relativePath, /^browser-output[\\/]tab-context-[a-z0-9-]+\.txt$/u);
});

test("combined page artifacts validate screenshots before publishing text", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-prevalidate-"));
  t.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const { materializeReadPageArtifacts } = await loadArtifacts();

  await assert.rejects(
    materializeReadPageArtifacts({
      forceText: true,
      outputDirectory: "browser-output",
      previewChars: 100,
      projectDirectory,
      result: {
        context: { visibleText: "private page text" },
        screenshot: { dataUrl: "data:image/gif;base64,R0lGODlh", format: "gif" }
      }
    }),
    /unsupported MIME type/u
  );

  assert.deepEqual(await readdir(projectDirectory), []);
});

test("combined page artifacts roll back prior writes by identity", async (t) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-rollback-"));
  t.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const outputDirectory = path.join(projectDirectory, "browser-output");
  await mkdir(outputDirectory);
  const unrelatedPath = path.join(outputDirectory, "keep.txt");
  await writeFile(unrelatedPath, "unrelated");
  const { materializeReadPageArtifacts } = await loadArtifacts();

  const probePath = path.join(projectDirectory, "file-handle-probe");
  const probe = await open(probePath, "w");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalWriteFile = fileHandlePrototype.writeFile;
  await probe.close();
  await rm(probePath, { force: true });
  let writeCalls = 0;
  fileHandlePrototype.writeFile = async function (...args) {
    writeCalls += 1;
    if (writeCalls === 2) throw new Error("simulated second artifact write failure");
    return originalWriteFile.apply(this, args);
  };
  t.after(() => {
    fileHandlePrototype.writeFile = originalWriteFile;
  });

  try {
    await assert.rejects(
      materializeReadPageArtifacts({
        forceText: true,
        outputDirectory: "browser-output",
        previewChars: 100,
        projectDirectory,
        result: {
          context: { visibleText: "private page text" },
          screenshot: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", format: "png" }
        }
      }),
      /simulated second artifact write failure/u
    );
  } finally {
    fileHandlePrototype.writeFile = originalWriteFile;
  }

  assert.equal(writeCalls, 2);
  assert.deepEqual(await readdir(outputDirectory), ["keep.txt"]);
  assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated");
  assert.equal((await readdir(projectDirectory)).some((entry) => entry.endsWith(".tmp")), false);
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
      context: {
        returnedChars: fullText.length,
        totalChars: fullText.length,
        truncated: { selection: false, visibleText: false },
        visibleText: fullText
      },
      screenshot: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", format: "png" },
      tabId: 7
    }
  });

  assert.equal(JSON.stringify(output).includes("dataUrl"), false);
  assert.equal(output.context.visibleText.length, 100);
  assert.equal(output.context.returnedChars, 100);
  assert.equal(output.context.totalChars, fullText.length);
  assert.equal(output.context.truncated.visibleText, true);
  assert.equal(output.context.visibleTextArtifact.originalReturnedChars, fullText.length);
  assert.equal(output.context.visibleTextArtifact.originalTotalChars, fullText.length);
  assert.equal(output.context.visibleTextArtifact.originalTruncated, false);
  assert.equal(await readFile(output.context.visibleTextArtifact.path, "utf8"), fullText);
  assert.deepEqual(await readFile(output.screenshot.path), Buffer.from("89504e470d0a1a0a", "hex"));
});
