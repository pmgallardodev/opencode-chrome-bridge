import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SECRET_CONTENT_ALLOWLIST = Object.freeze([
  "test/release-artifact-scan.test.mjs"
]);

const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
const GITHUB_TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u;
const OPENAI_TOKEN_RE = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u;
const QUOTED_ASSIGNMENT_RE = /\b(password|passwd|pwd|token|api[_-]?(?:key|token)|secret|credential|private[_-]?key)\b\s*[:=]\s*(["'])([^\r\n"']+)\2/giu;
const ENV_ASSIGNMENT_RE = /^\s*(PASSWORD|PASSWD|PWD|TOKEN|API[_-]?(?:KEY|TOKEN)|SECRET|CREDENTIAL|PRIVATE[_-]?KEY)\s*=\s*([^\s#]+)\s*$/gmu;
const SAFE_VALUE_RE = /^(?:<[^>]+>|\$\{[^}]+\}|\*+|x+|z+|a\.repeat\([^)]*\)|b\.repeat\([^)]*\)|c\.repeat\([^)]*\)|(?:your|example|sample|placeholder|redacted|not[-_ ]?real|must[-_ ]?not|fake|dummy|test)(?:[-_ ].*)?)$/iu;
const TEXT_BYTES_LIMIT = 2 * 1024 * 1024;

export async function scanTrackedFiles({
  contentAllowlist = DEFAULT_SECRET_CONTENT_ALLOWLIST,
  root,
  trackedPaths
}) {
  if (typeof root !== "string" || !Array.isArray(trackedPaths)) {
    throw new TypeError("scanTrackedFiles requires a root and trackedPaths array");
  }
  const allowlisted = new Set(contentAllowlist.map(normalizePath));
  const entries = [];
  for (const trackedPath of trackedPaths) {
    if (typeof trackedPath !== "string" || trackedPath.length === 0) continue;
    let content = null;
    try {
      content = await readFile(path.join(root, trackedPath.replaceAll("\\", "/")));
    } catch (error) {
      entries.push({ content: null, error: error?.message ?? String(error), path: trackedPath });
      continue;
    }
    entries.push({ content, path: trackedPath });
  }
  return scanTrackedEntries(entries, { contentAllowlist: allowlisted });
}

export function scanTrackedEntries(entries, { contentAllowlist = DEFAULT_SECRET_CONTENT_ALLOWLIST } = {}) {
  if (!Array.isArray(entries)) throw new TypeError("scanTrackedEntries requires an entries array");
  const allowlisted = contentAllowlist instanceof Set
    ? contentAllowlist
    : new Set(contentAllowlist.map(normalizePath));
  const issues = [];
  for (const entry of entries) {
    const trackedPath = entry?.path;
    if (typeof trackedPath !== "string" || trackedPath.length === 0) {
      issues.push({ kind: "path", path: String(trackedPath ?? ""), reason: "invalid tracked path" });
      continue;
    }
    const pathReason = sensitivePathReason(trackedPath);
    if (pathReason) issues.push({ kind: "path", path: trackedPath, reason: pathReason });
    if (entry?.error) {
      issues.push({ kind: "read", path: trackedPath, reason: `tracked file cannot be read: ${entry.error}` });
      continue;
    }
    const normalizedPath = normalizePath(trackedPath);
    if (pathReason || allowlisted.has(normalizedPath) || !isTextContent(entry?.content)) continue;
    const text = Buffer.isBuffer(entry.content)
      ? entry.content.subarray(0, TEXT_BYTES_LIMIT + 1).toString("utf8")
      : String(entry.content);
    if (Buffer.byteLength(text) > TEXT_BYTES_LIMIT) continue;
    for (const reason of secretReasons(text)) issues.push({ kind: "secret", path: trackedPath, reason });
  }
  return issues;
}

export function normalizePath(value) {
  return String(value)
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/")
    .toLowerCase();
}

function sensitivePathReason(trackedPath) {
  const normalized = normalizePath(trackedPath);
  const segments = normalized.split("/").filter(Boolean);
  const wordSegments = segments.map(pathWords);
  const basename = segments.at(-1) ?? "";
  const basenameWords = wordSegments.at(-1) ?? "";
  if (segments.some((segment) => /^\.env(?:\..+)?$/u.test(segment) && !/^\.env\.(?:example|sample|template)$/u.test(segment))) {
    return "environment file";
  }
  if (segments.some((segment) => [".npmrc", ".pypirc", ".netrc"].includes(segment))) return "credential configuration file";
  if (wordSegments.some((words) => /(?:^| )(?:credentials?|tokens?|secrets?|passwords?)(?: |$)/u.test(words))) return "credential or token file";
  if (wordSegments.some((words) => /(?:^| )(?:screenshots?|screen captures?|traces?)(?: |$)/u.test(words))) return "screenshot or trace artifact";
  if (wordSegments.some((words) => /(?:^| )(?:downloaded |competitor )extensions?(?: |$)/u.test(words))) return "downloaded extension artifact";
  if (wordSegments.some((words) => /(?:^| )(?:audit copies?|internal audits?)(?: |$)/u.test(words))) return "internal audit copy";
  if (wordSegments.some((words) => /(?:^| )(?:super powers?|superpowers?)(?: |$)/u.test(words))) return "private superpowers material";
  if (wordSegments.some((words, index) => words === "docs" && /^super powers?(?: |$)|^superpowers?(?: |$)/u.test(wordSegments[index + 1] ?? ""))) {
    return "private docs/superpowers material";
  }
  if (/\.(?:crx|pem|key|p12|pfx|jks|keystore)$/iu.test(basename)) return "sensitive binary, key, or extension archive";
  if (/\.(?:zip|tar|tgz|gz|7z)$/iu.test(basename) && /(?:downloaded|competitor|extension|audit|credential|secret|token|super ?powers?)/u.test(wordSegments.join(" "))) {
    return "sensitive archive";
  }
  if (/^(?:id rsa|id dsa|id ecdsa|id ed25519|private key)(?: |$)/u.test(basenameWords)) return "private key file";
  return null;
}

function pathWords(segment) {
  return segment.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function isTextContent(content) {
  if (typeof content === "string") return true;
  if (!Buffer.isBuffer(content)) return false;
  return !content.subarray(0, Math.min(content.length, 8192)).includes(0);
}

function secretReasons(text) {
  const reasons = [];
  if (PRIVATE_KEY_RE.test(text)) reasons.push("private key block");
  if (GITHUB_TOKEN_RE.test(text)) reasons.push("GitHub token");
  if (OPENAI_TOKEN_RE.test(text)) reasons.push("OpenAI token");
  if (AWS_ACCESS_KEY_RE.test(text)) reasons.push("AWS access key");
  for (const match of text.matchAll(QUOTED_ASSIGNMENT_RE)) {
    if (!safeAssignmentValue(match[3])) reasons.push(`obvious ${match[1]} assignment`);
  }
  for (const match of text.matchAll(ENV_ASSIGNMENT_RE)) {
    if (!safeAssignmentValue(match[2])) reasons.push(`obvious ${match[1]} assignment`);
  }
  return [...new Set(reasons)];
}

function safeAssignmentValue(value) {
  const normalized = String(value).trim();
  return normalized.length < 8 || SAFE_VALUE_RE.test(normalized);
}
