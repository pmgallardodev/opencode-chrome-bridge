import assert from "node:assert/strict";
import test from "node:test";
import OpenCodeChromeBridgePlugin, { TOOL_CAPABILITY_REQUIREMENTS, TOOL_ORIGIN_SCOPE_CLASSIFICATION } from "../src/opencode-plugin.js";

const scheduleTools = [
  "chrome_schedule_create", "chrome_schedules", "chrome_schedule_update",
  "chrome_schedule_delete", "chrome_schedule_run_now", "chrome_schedule_history"
];

test("plugin publishes approval-gated schedule tools with explicit capabilities", async () => {
  const { tool } = await OpenCodeChromeBridgePlugin();
  for (const name of scheduleTools) {
    assert.ok(tool[name], `${name} missing`);
    assert.ok(TOOL_CAPABILITY_REQUIREMENTS[name].includes("browser.schedules"));
    assert.equal(TOOL_ORIGIN_SCOPE_CLASSIFICATION[name], "browser");
  }
});

test("schedule schemas require explicit unattended grants and bounded calendar recurrences", async () => {
  const { tool } = await OpenCodeChromeBridgePlugin();
  const create = tool.chrome_schedule_create.args;
  for (const field of ["name", "workflowId", "recurrence", "requiredOrigins", "unattendedApproved", "enabled", "notify"]) {
    assert.ok(create[field], `missing schedule create field ${field}`);
  }
  assert.equal(create.unattendedApproved.safeParse(true).success, true);
  assert.equal(create.unattendedApproved.safeParse(false).success, false);
  assert.equal(create.requiredOrigins.safeParse(Array.from({ length: 101 }, (_, index) => `https://${index}.example`)).success, false);
  for (const recurrence of [
    { kind: "daily", hour: 9, minute: 30 },
    { kind: "weekly", weekday: 1, hour: 9, minute: 30 },
    { kind: "monthly", day: 31, hour: 9, minute: 30 },
    { kind: "annual", month: 2, day: 29, hour: 9, minute: 30 }
  ]) {
    assert.equal(create.recurrence.safeParse(recurrence).success, true, `rejected ${recurrence.kind}`);
  }
  assert.equal(create.recurrence.safeParse({ kind: "daily", hour: 24, minute: 0 }).success, false);
  assert.equal(Object.hasOwn(create, "skipPermissions"), false);
});
