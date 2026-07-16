import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";

const MAX_OUTPUT_DIRECTORY_CHARS = 500;
const MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_ATOMIC_NAME_ATTEMPTS = 10;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const ARTIFACT_IDENTITY = Symbol("workspaceArtifactIdentity");
const MAX_PAGE_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_ASSETS = 2_000;

export async function materializePageAssetBundle({
  assets,
  outputDirectory,
  projectDirectory,
  totalByteLimit = MAX_PAGE_ASSET_BYTES
}) {
  if (!Array.isArray(assets) || assets.length > MAX_PAGE_ASSETS) {
    throw new Error(`page assets must be an array with at most ${MAX_PAGE_ASSETS} entries`);
  }
  if (!Number.isInteger(totalByteLimit) || totalByteLimit < 1 || totalByteLimit > MAX_PAGE_ASSET_BYTES) {
    throw new Error(`page asset total byte limit must be between 1 and ${MAX_PAGE_ASSET_BYTES}`);
  }
  const decoded = [];
  let totalBytes = 0;
  for (let index = 0; index < assets.length; index += 1) {
    const asset = normalizePageAsset(assets[index], index);
    totalBytes += asset.data?.length ?? 0;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > totalByteLimit) {
      throw new Error(`page assets exceed the ${totalByteLimit} total byte limit`);
    }
    decoded.push(asset);
  }

  const directory = await resolveWorkspaceDirectory(projectDirectory, outputDirectory);
  await assertWorkspaceDirectoryIdentity(directory);
  const suffix = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
  const stagingPath = path.join(directory.projectRoot, `.opencode-page-assets-${suffix}.tmp`);
  const finalPath = path.join(directory.resolvedDirectory, `page-assets-${suffix}`);
  await mkdir(stagingPath, { mode: 0o700 });
  try {
    const manifestAssets = [];
    for (const asset of decoded) {
      const entry = {
        url: asset.url,
        kind: asset.kind,
        mimeType: asset.mimeType,
        truncated: asset.truncated,
        error: asset.error
      };
      if (asset.data) {
        const filename = pageAssetFilename(asset, manifestAssets.length);
        await writeFile(path.join(stagingPath, filename), asset.data, { flag: "wx", mode: 0o600 });
        Object.assign(entry, {
          filename,
          sha256: createHash("sha256").update(asset.data).digest("hex"),
          size: asset.data.length
        });
      } else {
        Object.assign(entry, { filename: null, sha256: null, size: 0 });
      }
      manifestAssets.push(entry);
    }
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      totalBytes,
      truncated: manifestAssets.some((asset) => asset.truncated === true),
      assets: manifestAssets
    };
    await writeFile(path.join(stagingPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    await assertWorkspaceDirectoryIdentity(directory);
    await rename(stagingPath, finalPath);
    await assertWorkspaceDirectoryIdentity(directory);
    const finalRealPath = await realpath(finalPath);
    assertPathWithin(directory.projectRoot, finalRealPath);
    if (!samePath(path.dirname(finalRealPath), directory.resolvedDirectory)) {
      throw new Error("page asset bundle escaped its verified output directory");
    }
    return {
      ...manifest,
      path: finalPath,
      relativePath: path.relative(directory.projectRoot, finalPath)
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function normalizePageAsset(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`page asset ${index} must be an object`);
  }
  let parsed;
  try { parsed = new URL(value.url); } catch { throw new Error(`page asset ${index} has an invalid URL`); }
  if (!["http:", "https:", "data:", "blob:"].includes(parsed.protocol)) {
    throw new Error(`page asset ${index} has an unsupported URL scheme`);
  }
  const mimeType = typeof value.mimeType === "string" && value.mimeType.length <= 255
    ? value.mimeType
    : "application/octet-stream";
  let data = null;
  if (value.content != null) {
    if (typeof value.content !== "string") throw new Error(`page asset ${index} content must be a string`);
    if (value.base64Encoded === true) {
      if (value.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.content)) {
        throw new Error(`page asset ${index} contains invalid base64`);
      }
      data = Buffer.from(value.content, "base64");
      if (data.toString("base64") !== value.content) throw new Error(`page asset ${index} contains invalid base64`);
    } else {
      data = Buffer.from(value.content, "utf8");
    }
  }
  return {
    url: parsed.href,
    kind: typeof value.kind === "string" ? value.kind.slice(0, 50) : "other",
    mimeType,
    base64Encoded: value.base64Encoded === true,
    data,
    error: typeof value.error === "string" ? value.error.slice(0, 500) : null,
    truncated: value.truncated === true
  };
}

function pageAssetFilename(asset, index) {
  const parsed = new URL(asset.url);
  const rawBase = path.posix.basename(parsed.pathname) || `asset-${index + 1}`;
  const cleaned = rawBase.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^\.+/u, "").slice(0, 80) || `asset-${index + 1}`;
  const extension = path.extname(cleaned).slice(0, 12);
  const stem = path.basename(cleaned, extension).slice(0, 64) || `asset-${index + 1}`;
  const fallbackExtension = pageAssetExtension(asset.mimeType);
  const digest = createHash("sha256").update(asset.url).digest("hex").slice(0, 12);
  return `${String(index + 1).padStart(4, "0")}-${stem}-${digest}${extension || fallbackExtension}`;
}

function pageAssetExtension(mimeType) {
  const normalized = mimeType.split(";", 1)[0].trim().toLowerCase();
  return ({
    "text/css": ".css",
    "text/html": ".html",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "application/json": ".json",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp"
  })[normalized] ?? ".bin";
}

export async function writeWorkspaceTextArtifact({
  outputDirectory,
  prefix = "tab-context",
  projectDirectory,
  text
}) {
  if (typeof text !== "string") throw new Error("text artifact content must be a string");
  const data = Buffer.from(text, "utf8");
  if (data.length > MAX_TEXT_ARTIFACT_BYTES) {
    throw new Error(`text artifact exceeds the ${MAX_TEXT_ARTIFACT_BYTES} byte limit`);
  }
  return writeWorkspaceArtifact({
    data,
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    outputDirectory,
    prefix,
    projectDirectory
  });
}

export async function writeWorkspaceImageArtifact({
  dataUrl,
  outputDirectory,
  prefix = "page-screenshot",
  projectDirectory
}) {
  const { data, extension, mimeType } = decodeSupportedImageDataUrl(dataUrl);
  return writeWorkspaceArtifact({
    data,
    extension,
    mimeType,
    outputDirectory,
    prefix,
    projectDirectory
  });
}

export async function materializeContextText({
  context,
  force = false,
  outputDirectory,
  previewChars = 12000,
  projectDirectory
}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("tab context must be an object");
  }
  if (typeof context.visibleText !== "string") {
    throw new Error("tab context visibleText must be a string");
  }
  if (!Number.isInteger(previewChars) || previewChars < 100 || previewChars > 20000) {
    throw new Error("previewChars must be an integer between 100 and 20000");
  }
  if (!force && context.visibleText.length <= previewChars) {
    return { artifact: null, context };
  }
  const fullText = context.visibleText;
  const preview = fullText.slice(0, previewChars);
  const originalReturnedChars = Number.isInteger(context.returnedChars)
    ? context.returnedChars
    : fullText.length;
  const originalTotalChars = Number.isInteger(context.totalChars) ? context.totalChars : null;
  const originalTruncated = context.truncated?.visibleText === true;
  const artifact = await writeWorkspaceTextArtifact({
    outputDirectory,
    prefix: "tab-context",
    projectDirectory,
    text: fullText
  });
  Object.assign(artifact, {
    originalChars: fullText.length,
    originalReturnedChars,
    originalTotalChars,
    originalTruncated,
    preview
  });
  return {
    context: {
      ...context,
      visibleText: preview,
      returnedChars: preview.length,
      truncated: {
        ...(context.truncated ?? {}),
        visibleText: originalTruncated || fullText.length > preview.length
      }
    },
    artifact
  };
}

export async function materializeReadPageArtifacts({
  forceText = false,
  outputDirectory,
  previewChars = 12000,
  projectDirectory,
  result
}) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !result.context || typeof result.context !== "object" || Array.isArray(result.context)) {
    throw new Error("read page result must contain a tab context object");
  }
  const screenshotDataUrl = prevalidateReadPageScreenshot(result.screenshot, outputDirectory);
  const createdArtifacts = [];
  try {
    const materialized = typeof outputDirectory === "string" && outputDirectory.length > 0
      ? await materializeContextText({
          context: result.context,
          force: forceText,
          outputDirectory,
          previewChars,
          projectDirectory
        })
      : { artifact: null, context: result.context };
    if (materialized.artifact) createdArtifacts.push(materialized.artifact);
    let screenshot = null;
    if (screenshotDataUrl != null) {
      screenshot = await writeWorkspaceImageArtifact({
        dataUrl: screenshotDataUrl,
        outputDirectory,
        prefix: "page-screenshot",
        projectDirectory
      });
      createdArtifacts.push(screenshot);
    }
    return {
      ...result,
      context: {
        ...materialized.context,
        visibleTextArtifact: materialized.artifact
      },
      screenshot
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const artifact of createdArtifacts.reverse()) {
      try {
        await rollbackWorkspaceArtifact(artifact);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "read page artifact transaction failed and rollback was incomplete"
      );
    }
    throw error;
  }
}

function prevalidateReadPageScreenshot(screenshot, outputDirectory) {
  if (screenshot == null) return null;
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw new Error("outputDirectory is required to materialize a screenshot");
  }
  if (typeof screenshot !== "object" || Array.isArray(screenshot)) {
    throw new Error("read page screenshot result is invalid");
  }
  const dataUrl = screenshot.dataUrl;
  decodeSupportedImageDataUrl(dataUrl);
  return dataUrl;
}

export function decodeSupportedImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("Screenshot response was not a data URL");
  const match = /^data:([^;,]+)(;base64)?,(.*)$/u.exec(dataUrl);
  if (!match) throw new Error("Screenshot response was not a data URL");
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error("Screenshot response used an unsupported MIME type");
  }
  if (match[2] !== ";base64") throw new Error("Screenshot response must use base64 encoding");
  const encoded = match[3];
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new Error("Screenshot response contained invalid base64 data");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.toString("base64") !== encoded) {
    throw new Error("Screenshot response contained invalid base64 data");
  }
  if (data.length > MAX_IMAGE_ARTIFACT_BYTES) {
    throw new Error("Screenshot response is too large to write");
  }
  const validSignature = mimeType === "image/png"
    ? data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!validSignature) {
    throw new Error(`Screenshot response did not contain a valid ${mimeType} signature`);
  }
  return {
    data,
    extension: mimeType === "image/png" ? "png" : "jpg",
    mimeType
  };
}

async function writeWorkspaceArtifact({
  data,
  extension,
  mimeType,
  outputDirectory,
  prefix,
  projectDirectory
}) {
  const safePrefix = requireSafePrefix(prefix);
  const directory = await resolveWorkspaceDirectory(projectDirectory, outputDirectory);
  const { projectRoot, resolvedDirectory } = directory;
  for (let attempt = 0; attempt < MAX_ATOMIC_NAME_ATTEMPTS; attempt += 1) {
    const suffix = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
    const filename = `${safePrefix}-${suffix}.${extension}`;
    const finalPath = path.join(resolvedDirectory, filename);
    // Keep the temporary in the verified project root. If the requested
    // output directory is renamed or replaced while bytes are written, the
    // cleanup path remains stable and no link is attempted until identity is
    // checked again. Portable Node cannot make the final link relative to an
    // already-open directory descriptor, so the checks narrow and detect the
    // race rather than claiming absolute immunity to an adversarial rename.
    const temporaryPath = path.join(projectRoot, `.opencode-artifact-${randomBytes(12).toString("hex")}.tmp`);
    let finalPublished = false;
    let temporaryIdentity = null;
    let handle = null;
    try {
      await assertWorkspaceDirectoryIdentity(directory);
      handle = await open(temporaryPath, exclusiveNoFollowWriteFlags(), 0o600);
      temporaryIdentity = await validateTemporaryFile(handle, temporaryPath, directory);
      await assertWorkspaceDirectoryIdentity(directory);
      await handle.writeFile(data);
      await handle.sync();
      await assertWorkspaceDirectoryIdentity(directory);
      await handle.close();
      handle = null;
      await assertWorkspaceDirectoryIdentity(directory);
      await link(temporaryPath, finalPath);
      finalPublished = true;
      await validatePublishedFile(finalPath, temporaryIdentity, directory);
      await assertWorkspaceDirectoryIdentity(directory);
      const artifact = withArtifactIdentity({
        bytes: data.length,
        mimeType,
        path: finalPath,
        relativePath: path.relative(projectRoot, finalPath)
      }, temporaryIdentity);
      await unlink(temporaryPath);
      temporaryIdentity = null;
      return artifact;
    } catch (error) {
      await handle?.close().catch(() => {});
      let failure = error;
      try {
        await assertWorkspaceDirectoryIdentity(directory);
      } catch (identityError) {
        failure = identityError;
      }
      if (temporaryIdentity) {
        await unlinkIfIdentityMatches(temporaryPath, temporaryIdentity);
      } else {
        await unlink(temporaryPath).catch(() => {});
      }
      if (finalPublished && temporaryIdentity) {
        await unlinkIfIdentityMatches(finalPath, temporaryIdentity);
      }
      if (error?.code === "EEXIST" && !finalPublished) continue;
      throw failure;
    }
  }
  throw new Error("Could not allocate a collision-safe workspace artifact name");
}

async function resolveWorkspaceDirectory(projectDirectory, outputDirectory) {
  if (typeof projectDirectory !== "string" || projectDirectory.length === 0) {
    throw new Error("projectDirectory must be a non-empty string");
  }
  if (typeof outputDirectory !== "string"
    || outputDirectory.length === 0
    || outputDirectory.length > MAX_OUTPUT_DIRECTORY_CHARS
    || outputDirectory.includes("\0")
    || path.isAbsolute(outputDirectory)) {
    throw new Error("outputDirectory must be a relative path within the project directory");
  }
  const projectRoot = await realpath(projectDirectory);
  const rootInfo = await lstat(projectRoot);
  if (!rootInfo.isDirectory()) throw new Error("projectDirectory must resolve to a directory");
  const candidate = path.resolve(projectRoot, outputDirectory);
  assertPathWithin(projectRoot, candidate);

  const nearestExisting = await nearestExistingAncestor(candidate);
  const nearestRealPath = await realpath(nearestExisting);
  assertPathWithin(projectRoot, nearestRealPath);
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  await assertNoSymbolicLinkComponents(projectRoot, candidate);
  const resolvedDirectory = await realpath(candidate);
  assertPathWithin(projectRoot, resolvedDirectory);
  const directoryInfo = await lstat(resolvedDirectory);
  if (!directoryInfo.isDirectory()) throw new Error("outputDirectory must resolve to a directory");
  const projectInfo = await lstat(projectRoot);
  return {
    directoryIdentity: identityOf(directoryInfo),
    projectIdentity: identityOf(projectInfo),
    projectRoot,
    requestedDirectory: candidate,
    resolvedDirectory
  };
}

async function assertWorkspaceDirectoryIdentity(directory) {
  try {
    const projectInfo = await lstat(directory.projectRoot);
    if (!projectInfo.isDirectory() || identityOf(projectInfo) !== directory.projectIdentity) throw new Error();
    const requestedInfo = await lstat(directory.requestedDirectory);
    if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) throw new Error();
    await assertNoSymbolicLinkComponents(directory.projectRoot, directory.requestedDirectory);
    const currentRealPath = await realpath(directory.requestedDirectory);
    if (!samePath(currentRealPath, directory.resolvedDirectory)) throw new Error();
    const currentInfo = await lstat(directory.resolvedDirectory);
    if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()
      || identityOf(currentInfo) !== directory.directoryIdentity) throw new Error();
  } catch {
    throw new Error("output directory changed during artifact write");
  }
}

async function validateTemporaryFile(handle, temporaryPath, directory) {
  const handleInfo = await handle.stat();
  const pathInfo = await lstat(temporaryPath);
  const temporaryRealPath = await realpath(temporaryPath);
  if (!handleInfo.isFile()
    || !pathInfo.isFile()
    || pathInfo.isSymbolicLink()
    || identityOf(handleInfo) !== identityOf(pathInfo)
    || !samePath(temporaryRealPath, temporaryPath)) {
    throw new Error("temporary artifact file identity is invalid");
  }
  assertPathWithin(directory.projectRoot, temporaryRealPath);
  return identityOf(handleInfo);
}

async function validatePublishedFile(finalPath, temporaryIdentity, directory) {
  const finalInfo = await lstat(finalPath);
  const finalRealPath = await realpath(finalPath);
  if (!finalInfo.isFile()
    || finalInfo.isSymbolicLink()
    || identityOf(finalInfo) !== temporaryIdentity
    || !samePath(path.dirname(finalRealPath), directory.resolvedDirectory)) {
    throw new Error("published artifact file identity is invalid");
  }
  assertPathWithin(directory.projectRoot, finalRealPath);
}

async function unlinkIfIdentityMatches(candidatePath, expectedIdentity) {
  try {
    const info = await lstat(candidatePath);
    if (!info.isSymbolicLink() && identityOf(info) === expectedIdentity) await unlink(candidatePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function withArtifactIdentity(artifact, identity) {
  Object.defineProperty(artifact, ARTIFACT_IDENTITY, { value: identity });
  return artifact;
}

async function rollbackWorkspaceArtifact(artifact) {
  const identity = artifact?.[ARTIFACT_IDENTITY];
  if (typeof artifact?.path !== "string" || typeof identity !== "string") return;
  await unlinkIfIdentityMatches(artifact.path, identity);
}

function exclusiveNoFollowWriteFlags() {
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  return fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow;
}

function identityOf(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

async function assertNoSymbolicLinkComponents(projectRoot, candidate) {
  const relative = path.relative(projectRoot, candidate);
  let current = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error("outputDirectory must not contain a symbolic link");
    }
  }
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function assertPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error("outputDirectory must be a relative path within the project directory");
}

function requireSafePrefix(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) {
    throw new Error("artifact prefix must contain only lowercase letters, numbers, and hyphens");
  }
  return value;
}
