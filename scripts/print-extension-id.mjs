#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"));
const key = Buffer.from(manifest.key, "base64");
const digest = createHash("sha256").update(key).digest().subarray(0, 16);
const id = [...digest].map((byte) => "abcdefghijklmnop"[byte >> 4] + "abcdefghijklmnop"[byte & 15]).join("");

console.log(id);
