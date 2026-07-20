import assert from "node:assert/strict";
import test from "node:test";
import OpenCodeChromeBridgePlugin from "../src/opencode-plugin.js";
import { TOOL_CAPABILITY_REQUIREMENTS, TOOL_ORIGIN_SCOPE_CLASSIFICATION } from "../src/tool-metadata.js";

const workflowTools = ["chrome_workflow_start", "chrome_workflow_stop", "chrome_workflow_cancel", "chrome_workflows", "chrome_workflow_get", "chrome_workflow_import", "chrome_workflow_delete", "chrome_workflow_run"];

test("plugin publishes approval-gated workflow tools with explicit negotiated capabilities", async () => {
  const plugin = await OpenCodeChromeBridgePlugin();
  for (const name of workflowTools) {
    assert.ok(plugin.tool[name], `${name} missing`);
    assert.ok(TOOL_CAPABILITY_REQUIREMENTS[name].includes("browser.workflows"));
  }
  assert.equal(TOOL_ORIGIN_SCOPE_CLASSIFICATION.chrome_workflow_run, "page");
  assert.equal(TOOL_ORIGIN_SCOPE_CLASSIFICATION.chrome_workflow_start, "browser");
});

test("workflow public tool schemas are bounded and use id, name, or shortcut selectors", async () => {
  const { tool } = await OpenCodeChromeBridgePlugin();
  assert.equal(tool.chrome_workflow_start.args.name.safeParse("x").success, true);
  assert.equal(tool.chrome_workflow_start.args.name.safeParse("x".repeat(121)).success, false);
  assert.equal(tool.chrome_workflow_run.args.totalTimeoutMs.safeParse(50).success, true);
  assert.equal(tool.chrome_workflow_run.args.totalTimeoutMs.safeParse(120001).success, false);
  for (const key of ["id", "name", "shortcut"]) {
    assert.ok(tool.chrome_workflow_get.args[key]);
    assert.ok(tool.chrome_workflow_run.args[key]);
  }
  const readme = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../README.md", import.meta.url), "utf8"));
  const example = JSON.parse(readme.match(/Workflows are local[\s\S]*?```json\r?\n([\s\S]*?)\r?\n```/u)?.[1] ?? "null");
  assert.equal(tool.chrome_workflow_import.args.workflow.safeParse(example).success, true);
  assert.equal(tool.chrome_workflow_import.args.workflow.safeParse({ ...example, createdAt: "not-a-date" }).success, false);
  assert.equal(tool.chrome_workflow_import.args.workflow.safeParse({ ...example, updatedAt: "2026-07-16" }).success, false);
});
