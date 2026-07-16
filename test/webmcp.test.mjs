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
  assert.equal(tool.chrome_webmcp_list.args.timeoutMs.safeParse(50).success, true);
  assert.equal(tool.chrome_webmcp_list.args.timeoutMs.safeParse(30_001).success, false);
  assert.equal(tool.chrome_webmcp_invoke.args.toolName.safeParse("cart.add-item").success, true);
  assert.equal(tool.chrome_webmcp_invoke.args.toolName.safeParse(" cart.add-item ").success, false);
  assert.equal(tool.chrome_webmcp_invoke.args.timeoutMs.safeParse(50).success, true);
  assert.equal(tool.chrome_webmcp_invoke.args.timeoutMs.safeParse(30_001).success, false);
});

test("WebMCP bridge calls forward cancellation and bounded timeout without bypass flags", async () => {
  const source = await readFile(new URL("../src/opencode-plugin.js", import.meta.url), "utf8");
  assert.match(source, /webMcpBridgeCommand\("webMcpList", args, context\.abort\)/u);
  assert.match(source, /webMcpBridgeCommand\("webMcpInvoke",[\s\S]{0,500}context\.abort\)/u);
  assert.match(source, /WEBMCP_LIST_TRANSPORT_TIMEOUT_MS\s*=\s*35_000/u);
  assert.match(source, /WEBMCP_INVOKE_TRANSPORT_TIMEOUT_MS\s*=\s*0/u);
  assert.equal((source.match(/timeoutMs:\s*method === "webMcpInvoke"/gu) ?? []).length, 1);
  assert.equal((source.match(/webMcpBridgeCommand\("webMcp(?:List|Invoke)"/gu) ?? []).length, 2);
  assert.match(source, /timeoutMs:\s*method === "webMcpInvoke"\s*\?\s*WEBMCP_INVOKE_TRANSPORT_TIMEOUT_MS/u);
  assert.doesNotMatch(source, /chrome_webmcp_(?:list|invoke)[\s\S]{0,500}skipPermissions/gu);
});

test("WebMCP contracts describe isolated execution and admission-only timeout", async () => {
  const { tool } = await OpenCodeChromeBridgePlugin();
  assert.match(tool.chrome_webmcp_list.description, /ISOLATED world/u);
  assert.doesNotMatch(tool.chrome_webmcp_list.description, /MAIN world/u);
  assert.match(tool.chrome_webmcp_invoke.args.timeoutMs.description, /admission|pre-dispatch/iu);
  assert.doesNotMatch(tool.chrome_webmcp_invoke.args.timeoutMs.description, /page tool timeout|execution time/iu);
});

test("bridge client and native host preserve timeout zero without creating timeout machinery", async () => {
  const client = await readFile(new URL("../src/bridge-client.js", import.meta.url), "utf8");
  const host = await readFile(new URL("../native-host/opencode-chrome-native-host.mjs", import.meta.url), "utf8");
  assert.match(client, /commandTimeout === 0[\s\S]{0,100}return 0/u);
  assert.match(client, /if \(timeoutMs > 0\)[\s\S]{0,100}req\.setTimeout/u);
  assert.match(host, /timeoutMs === 0[\s\S]{0,100}null/u);
  assert.match(host, /if \(entry\.timeout !== null\) clearTimeout/u);
  assert.match(host, /body\.method === "scopedCommand"[\s\S]{0,100}body\.params\?\.method === "webMcpInvoke"/u);
  assert.match(host, /No-timeout transport is restricted to WebMCP invoke/u);
  assert.match(host, /MAX_PENDING_COMMANDS/u);
});

test("WebMCP dispatch is exact-document targeted and guarded by the scoped navigation barrier", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /NAVIGATION_BARRIER_COMMANDS[\s\S]{0,800}"webMcpList"[\s\S]{0,100}"webMcpInvoke"/u);
  assert.match(source, /executeScript\(\{[\s\S]{0,300}documentIds:\s*\[documentId\]/u);
  assert.match(source, /world:\s*"ISOLATED"/u);
  assert.doesNotMatch(source, /world:\s*"MAIN"[\s\S]{0,500}webMcp/u);
});

test("WebMCP uses only documented discovery and abortable invocation methods", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /reflectApply\(officialGetTools, context/u);
  assert.match(source, /reflectApply\(officialExecuteTool,[\s\S]{0,160}descriptor,[\s\S]{0,80}inputJson,[\s\S]{0,80}\{ signal/u);
  assert.doesNotMatch(source, /const (?:getTools|executeTool) = context\.(?:getTools|executeTool)/u);
  assert.doesNotMatch(source, /\.listTools\(|\.invokeTool\(|\.callTool\(|context\.tools/u);
});

test("WebMCP isolated adapter needs no page-created clean realm or page-global registry", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const adapter = source.slice(source.indexOf("async function webMcp"), source.indexOf("function assertWebMcpFields"));
  assert.doesNotMatch(adapter, /createElement\(["']iframe["']\)|contentWindow/u);
  assert.doesNotMatch(source, /__opencodeWebMcpInvocationRegistry|registryKey/u);
});
