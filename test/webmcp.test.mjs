import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import OpenCodeChromeBridgePlugin, {
  TOOL_CAPABILITY_REQUIREMENTS,
  TOOL_ORIGIN_SCOPE_CLASSIFICATION
} from "../src/opencode-plugin.js";

const webMcpTools = ["chrome_webmcp_list", "chrome_webmcp_invoke"];

test("plugin publishes two page-scoped WebMCP tools with one negotiated capability", async () => {
  const { tool } = await OpenCodeChromeBridgePlugin();
  for (const name of webMcpTools) {
    assert.ok(tool[name], `${name} missing`);
    assert.ok(TOOL_CAPABILITY_REQUIREMENTS[name].includes("browser.webmcp"));
    assert.equal(TOOL_ORIGIN_SCOPE_CLASSIFICATION[name], "page");
  }
  assert.equal(tool.chrome_webmcp_list.args.tabId.safeParse(7).success, true);
  assert.equal(tool.chrome_webmcp_invoke.args.toolName.safeParse("cart.add-item").success, true);
  assert.equal(tool.chrome_webmcp_invoke.args.toolName.safeParse(" cart.add-item ").success, false);
  assert.equal(tool.chrome_webmcp_invoke.args.timeoutMs.safeParse(50).success, true);
  assert.equal(tool.chrome_webmcp_invoke.args.timeoutMs.safeParse(30_001).success, false);
});

test("WebMCP bridge calls forward cancellation and bounded timeout without bypass flags", async () => {
  const source = await readFile(new URL("../src/opencode-plugin.js", import.meta.url), "utf8");
  assert.match(source, /webMcpList[\s\S]{0,400}signal:\s*context\.abort/u);
  assert.match(source, /webMcpInvoke[\s\S]{0,500}signal:\s*context\.abort[\s\S]{0,200}timeoutMs/u);
  assert.doesNotMatch(source, /chrome_webmcp_(?:list|invoke)[\s\S]{0,500}skipPermissions/gu);
});

test("WebMCP dispatch is exact-document targeted and guarded by the scoped navigation barrier", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /NAVIGATION_BARRIER_COMMANDS[\s\S]{0,800}"webMcpList"[\s\S]{0,100}"webMcpInvoke"/u);
  assert.match(source, /executeScript\(\{[\s\S]{0,300}documentIds:\s*\[documentId\]/u);
});

test("WebMCP uses only documented discovery and abortable invocation methods", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /const getTools = context\.getTools/u);
  assert.match(source, /reflectApply\(executeTool,[\s\S]{0,120}payload\.toolName, payload\.input, \{ signal:/u);
  assert.doesNotMatch(source, /\.listTools\(|\.invokeTool\(|\.callTool\(|context\.tools/u);
});
