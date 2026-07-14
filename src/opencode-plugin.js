import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { bridgeCommand, bridgeStatus, writeDataUrlToFile, pollEvents } from "./bridge-client.js";

export default async function OpenCodeChromeBridgePlugin() {
  const { tool } = await loadOpenCodeTool();
  const schema = tool.schema;

  return {
    tool: requireApprovals({
      chrome_status: tool({
        description: "Check whether the local OpenCode Chrome Bridge native host is reachable.",
        args: {},
        async execute() {
          return JSON.stringify(await bridgeStatus(), null, 2);
        }
      }),
      chrome_tabs: tool({
        description: "List open Chrome tabs visible to the OpenCode Chrome Bridge extension.",
        args: {},
        async execute() {
          return JSON.stringify(await bridgeCommand("listTabs"), null, 2);
        }
      }),
      chrome_open: tool({
        description: "Open a new Chrome tab, or navigate an existing tab when tabId is provided.",
        args: {
          url: schema.string().describe("URL to open or navigate to."),
          tabId: schema.number().int().optional().describe("Existing Chrome tab id to navigate."),
          sessionId: schema.string().optional().describe("Optional browser-control session id to claim the created or navigated tab."),
          turnId: schema.string().optional().describe("Optional browser-control turn id to claim the created or navigated tab.")
        },
        async execute(args) {
          const result = args.tabId == null
            ? await bridgeCommand("createTab", {
              url: args.url,
              active: true,
              sessionId: args.sessionId,
              turnId: args.turnId
            })
            : await bridgeCommand("navigate", {
              tabId: args.tabId,
              url: args.url,
              sessionId: args.sessionId,
              turnId: args.turnId
            });
          return JSON.stringify(result, null, 2);
        }
      }),
      chrome_close_tab: tool({
        description: "Close a Chrome tab by id.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id to close.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("closeTab", args), null, 2);
        }
      }),
      chrome_activate_tab: tool({
        description: "Focus and activate a Chrome tab, bringing its window to the foreground.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id to activate.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("activateTab", args), null, 2);
        }
      }),
      chrome_reload: tool({
        description: "Reload a Chrome tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id to reload.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("reload", args), null, 2);
        }
      }),
      chrome_back: tool({
        description: "Navigate a Chrome tab back in history.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("back", args), null, 2);
        }
      }),
      chrome_forward: tool({
        description: "Navigate a Chrome tab forward in history.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("forward", args), null, 2);
        }
      }),
      chrome_get_tab: tool({
        description: "Get metadata for a single Chrome tab by id.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("getTab", args), null, 2);
        }
      }),
      chrome_claim_tab: tool({
        description: "Claim an existing user Chrome tab into a browser-control session so it can later be finalized as handoff, deliverable, or released.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id to claim."),
          sessionId: schema.string().describe("Browser-control session id."),
          turnId: schema.string().describe("Browser-control turn id."),
          origin: schema.enum(["user", "agent"]).default("user").describe("Whether the tab existed before the agent or was agent-created.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("claimTab", args), null, 2);
        }
      }),
      chrome_finalize_tabs: tool({
        description: "Finalize a browser-control session. Agent-created tabs not listed in keep are closed; kept tabs are marked as handoff or deliverable and left open.",
        args: {
          sessionId: schema.string().describe("Browser-control session id to finalize."),
          keep: schema.array(schema.object({
            tabId: schema.number().int(),
            status: schema.enum(["handoff", "deliverable"])
          })).default([]).describe("Tabs to keep open after finalization.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("finalizeTabs", args), null, 2);
        }
      }),
      chrome_end_turn: tool({
        description: "End a browser-control turn without finalizing tabs. Active leases for the turn are released and persistent debuggers are detached.",
        args: {
          sessionId: schema.string().describe("Browser-control session id."),
          turnId: schema.string().describe("Browser-control turn id to end.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("endTurn", args), null, 2);
        }
      }),
      chrome_page_text: tool({
        description: "Extract title, URL, and visible body text from a Chrome tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          maxChars: schema.number().int().min(1).max(50000).default(12000).describe("Maximum text characters to return.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("pageText", args), null, 2);
        }
      }),
      chrome_dom_content: tool({
        description: "Get the full HTML source or text content of a Chrome tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          contentType: schema.enum(["html", "text"]).default("html").describe("Return full HTML source or plain text."),
          maxChars: schema.number().int().min(1).max(500000).default(50000).describe("Maximum characters to return.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("domContent", args), null, 2);
        }
      }),
      chrome_set_viewport: tool({
        description: "Emulate a viewport size for a Chrome tab through CDP without resizing the browser window.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id used to identify the window."),
          width: schema.number().int().min(100).max(7680).describe("Window width in pixels."),
          height: schema.number().int().min(100).max(4320).describe("Window height in pixels.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("setViewport", args), null, 2);
        }
      }),
      chrome_reset_viewport: tool({
        description: "Clear CDP viewport emulation for a Chrome tab and restore its normal page metrics.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id used to identify the window.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("resetViewport", args), null, 2);
        }
      }),
      chrome_screenshot: tool({
        description: "Capture the visible viewport of a Chrome tab and save it to a PNG or JPEG file. Omit tabId to capture the currently active window.",
        args: {
          outputPath: schema.string().describe("Absolute or project-relative path for the image file."),
          tabId: schema.number().int().optional().describe("Chrome tab id to capture. Omit to capture the active window."),
          format: schema.enum(["png", "jpeg"]).default("png").describe("Image format.")
        },
        async execute(args, context) {
          const outputPath = await resolveProjectOutputPath(context.directory, args.outputPath, "outputPath");
          const result = await bridgeCommand(
            "screenshot",
            { tabId: args.tabId ?? null, format: args.format },
            { timeoutMs: 30000 }
          );
          const file = await writeDataUrlToFile(result.dataUrl, outputPath);
          return JSON.stringify(file, null, 2);
        }
      }),
      chrome_screenshot_region: tool({
        description: "Capture a rectangular region of a Chrome tab and save it to a PNG or JPEG file. Coordinates are CSS pixels against the page; the region can extend beyond the visible viewport. Defaults to JPEG with quality 80 to keep file size small.",
        args: {
          outputPath: schema.string().describe("Absolute or project-relative path for the image file."),
          x: schema.number().describe("Region top-left x in CSS pixels (page coordinates)."),
          y: schema.number().describe("Region top-left y in CSS pixels (page coordinates)."),
          width: schema.number().int().min(1).describe("Region width in CSS pixels."),
          height: schema.number().int().min(1).describe("Region height in CSS pixels."),
          tabId: schema.number().int().optional().describe("Chrome tab id to capture. Omit to capture the active tab in the active window."),
          format: schema.enum(["png", "jpeg"]).default("jpeg").describe("Image format. JPEG recommended for small file size."),
          quality: schema.number().int().min(1).max(100).default(80).describe("JPEG quality (1-100). Ignored for PNG."),
          timeoutMs: schema.number().int().min(1000).max(120000).optional().describe("Bridge timeout in milliseconds.")
        },
        async execute(args, context) {
          const outputPath = await resolveProjectOutputPath(context.directory, args.outputPath, "outputPath");
          const result = await bridgeCommand(
            "screenshotRegion",
            {
              tabId: args.tabId ?? null,
              x: args.x,
              y: args.y,
              width: args.width,
              height: args.height,
              format: args.format,
              quality: args.quality
            },
            { timeoutMs: args.timeoutMs ?? 30000 }
          );
          const file = await writeDataUrlToFile(result.dataUrl, outputPath);
          return JSON.stringify({ ...file, region: result.region, format: result.format }, null, 2);
        }
      }),
      chrome_click: tool({
        description: "Click viewport coordinates in a Chrome tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          x: schema.number().describe("Viewport x coordinate."),
          y: schema.number().describe("Viewport y coordinate."),
          button: schema.enum(["left", "middle", "right"]).default("left").describe("Mouse button to use."),
          modifiers: schema.array(schema.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys to hold during click.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("click", args), null, 2);
        }
      }),
      chrome_double_click: tool({
        description: "Double-click viewport coordinates in a Chrome tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          x: schema.number().describe("Viewport x coordinate."),
          y: schema.number().describe("Viewport y coordinate."),
          button: schema.enum(["left", "middle", "right"]).default("left").describe("Mouse button to use."),
          modifiers: schema.array(schema.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys to hold during click.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("doubleClick", args), null, 2);
        }
      }),
      chrome_hover: tool({
        description: "Move the mouse to viewport coordinates in a Chrome tab without clicking.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          x: schema.number().describe("Viewport x coordinate."),
          y: schema.number().describe("Viewport y coordinate.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("hover", args), null, 2);
        }
      }),
      chrome_scroll: tool({
        description: "Scroll at a viewport position in a Chrome tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          x: schema.number().describe("Viewport x coordinate to scroll at."),
          y: schema.number().describe("Viewport y coordinate to scroll at."),
          deltaX: schema.number().optional().describe("Horizontal scroll amount in pixels (positive = right). At least one of deltaX or deltaY is required and must be non-zero."),
          deltaY: schema.number().optional().describe("Vertical scroll amount in pixels (positive = down). At least one of deltaX or deltaY is required and must be non-zero.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("scroll", args), null, 2);
        }
      }),
      chrome_type: tool({
        description: "Insert text into the currently focused element in a Chrome tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          text: schema.string().describe("Text to type.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("type", args), null, 2);
        }
      }),
      chrome_keypress: tool({
        description: "Send a keyboard key to a Chrome tab. Supports modifier keys for shortcuts like Ctrl+C.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          key: schema.string().describe("Chrome DevTools Protocol key value, for example Enter, Tab, Escape, KeyA."),
          modifiers: schema.array(schema.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys to hold. Use ControlOrMeta for Ctrl on Windows/Linux or Cmd on Mac.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("keypress", args), null, 2);
        }
      }),
      chrome_evaluate: tool({
        description: "Evaluate JavaScript in a Chrome tab using the Chrome Debugger Protocol. Use for inspection or controlled local automation.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          expression: schema.string().describe("JavaScript expression to evaluate in the page.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("evaluate", args), null, 2);
        }
      }),
      chrome_wizard_step: tool({
        description: "Run a click + wait + optional eval + optional screenshot sequence in a single tool call. Use to drive a multi-step form or wizard without chaining four separate chrome_click, chrome_evaluate, and chrome_screenshot invocations per step.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          x: schema.number().describe("Viewport x coordinate to click."),
          y: schema.number().describe("Viewport y coordinate to click."),
          button: schema.enum(["left", "middle", "right"]).default("left").describe("Mouse button to use."),
          modifiers: schema.array(schema.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys to hold during click."),
          waitMs: schema.number().int().min(0).max(10000).default(400).describe("Milliseconds to wait after the click before evaluating or screenshotting."),
          expression: schema.string().optional().describe("JavaScript expression to evaluate after the wait."),
          screenshotPath: schema.string().optional().describe("If set, capture a viewport screenshot to this project-relative path after the wait."),
          screenshotFormat: schema.enum(["png", "jpeg"]).default("jpeg").describe("Screenshot format when screenshotPath is set."),
          screenshotQuality: schema.number().int().min(1).max(100).default(80).describe("JPEG quality (1-100) when screenshotFormat is jpeg."),
          timeoutMs: schema.number().int().min(1000).max(120000).optional().describe("Per-bridge-call timeout in milliseconds.")
        },
        async execute(args, context) {
          const timeoutMs = args.timeoutMs;

          const clickResult = await bridgeCommand("click", {
            tabId: args.tabId,
            x: args.x,
            y: args.y,
            button: args.button,
            modifiers: args.modifiers
          }, { timeoutMs });

          const waitMs = args.waitMs ?? 400;
          if (waitMs > 0) await sleep(waitMs);

          let evaluation;
          if (typeof args.expression === "string" && args.expression.length > 0) {
            evaluation = await bridgeCommand("evaluate", {
              tabId: args.tabId,
              expression: args.expression
            }, { timeoutMs });
          }

          let screenshot;
          if (typeof args.screenshotPath === "string" && args.screenshotPath.length > 0) {
            const outputPath = await resolveProjectOutputPath(context.directory, args.screenshotPath, "screenshotPath");
            const result = await bridgeCommand(
              "screenshot",
              { tabId: args.tabId, format: args.screenshotFormat, quality: args.screenshotQuality },
              { timeoutMs: Math.max(timeoutMs ?? 15000, 30000) }
            );
            screenshot = await writeDataUrlToFile(result.dataUrl, outputPath);
          }

          return JSON.stringify({
            clicked: true,
            clickResult,
            waitedMs: waitMs,
            evaluation,
            screenshot
          }, null, 2);
        }
      }),
      chrome_cdp_targets: tool({
        description: "List Chrome DevTools Protocol targets visible to the OpenCode Chrome Bridge extension.",
        args: {},
        async execute() {
          return JSON.stringify(await bridgeCommand("cdpTargets"), null, 2);
        }
      }),
      chrome_cdp: tool({
        description: "Run a full Chrome DevTools Protocol (full CDP) command against a Chrome tab or target. This can inspect and control sensitive browser internals.",
        args: {
          method: schema.string().describe("CDP method name, for example Runtime.evaluate or DOM.getDocument."),
          commandParams: schema.record(schema.string(), schema.any()).optional().describe("CDP command parameters."),
          tabId: schema.number().int().optional().describe("Chrome tab id to attach to."),
          targetId: schema.string().optional().describe("Chrome debugger target id to attach to when tabId is not used.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("cdpCommand", args, { timeoutMs: 30000 }), null, 2);
        }
      }),
      chrome_history: tool({
        description: "Search the user's Chrome history visible to the OpenCode Chrome Bridge extension.",
        args: {
          query: schema.string().optional().describe("Search text. Omit or use an empty string for recent history."),
          limit: schema.number().int().min(1).max(1000).default(100).describe("Maximum history entries to return."),
          from: schema.union([schema.string(), schema.number()]).optional().describe("Start time as an ISO date string or millisecond timestamp."),
          to: schema.union([schema.string(), schema.number()]).optional().describe("End time as an ISO date string or millisecond timestamp.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("history", args), null, 2);
        }
      }),
      chrome_bookmarks: tool({
        description: "Search the user's Chrome bookmarks visible to the OpenCode Chrome Bridge extension.",
        args: {
          query: schema.string().optional().describe("Bookmark search text. Omit or use an empty string for all searchable bookmarks."),
          limit: schema.number().int().min(1).max(1000).default(100).describe("Maximum bookmarks to return.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("bookmarks", args), null, 2);
        }
      }),
      chrome_set_window_state: tool({
        description: "Set a Chrome window state: normal, minimized, maximized, or fullscreen.",
        args: {
          windowId: schema.number().int().describe("Chrome window id."),
          state: schema.enum(["normal", "minimized", "maximized", "fullscreen"]).describe("Target window state.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("setWindowState", args), null, 2);
        }
      }),
      chrome_get_window_state: tool({
        description: "Get metadata and state for a single Chrome window by id.",
        args: {
          windowId: schema.number().int().describe("Chrome window id.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("getWindowState", args), null, 2);
        }
      }),
      chrome_open_window: tool({
        description: "Create a new Chrome window with optional URL, type, size, position, and state.",
        args: {
          url: schema.string().optional().describe("URL to open in the new window."),
          type: schema.enum(["popup", "panel"]).optional().describe("Window type. Defaults to a normal window."),
          state: schema.enum(["normal", "minimized", "maximized", "fullscreen"]).optional().describe("Initial window state."),
          width: schema.number().int().min(100).max(7680).optional().describe("Window width in pixels."),
          height: schema.number().int().min(100).max(4320).optional().describe("Window height in pixels."),
          left: schema.number().int().optional().describe("Window left offset in pixels."),
          top: schema.number().int().optional().describe("Window top offset in pixels."),
          incognito: schema.boolean().optional().describe("Open as an incognito window."),
          sessionId: schema.string().optional().describe("Optional browser-control session id to claim newly-created tabs."),
          turnId: schema.string().optional().describe("Optional browser-control turn id to claim newly-created tabs.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("createWindow", args), null, 2);
        }
      }),
      chrome_drag: tool({
        description: "Drag the mouse along a path of viewport coordinates with smooth interpolation. Performs a press-move-release sequence.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          points: schema.array(schema.object({ x: schema.number(), y: schema.number() })).min(1).max(100).describe("Array of {x,y} viewport coordinates defining the drag path."),
          steps: schema.number().int().min(1).max(500).default(20).describe("Interpolation steps between consecutive points."),
          stepDelayMs: schema.number().int().min(0).max(1000).default(8).describe("Delay between interpolated steps in milliseconds."),
          button: schema.enum(["left", "middle", "right"]).default("left").describe("Mouse button to use."),
          modifiers: schema.array(schema.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys to hold.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("moveSequence", { ...args, drag: true }), null, 2);
        }
      }),
      chrome_move: tool({
        description: "Move the mouse along a path of viewport coordinates with smooth interpolation, without pressing any button.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          points: schema.array(schema.object({ x: schema.number(), y: schema.number() })).min(1).max(100).describe("Array of {x,y} viewport coordinates defining the move path."),
          steps: schema.number().int().min(1).max(500).default(20).describe("Interpolation steps between consecutive points."),
          stepDelayMs: schema.number().int().min(0).max(1000).default(8).describe("Delay between interpolated steps in milliseconds.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("moveSequence", { ...args, drag: false }), null, 2);
        }
      }),
      chrome_downloads_list: tool({
        description: "List Chrome downloads, optionally filtered by state or query.",
        args: {
          state: schema.enum(["in_progress", "interrupted", "complete"]).optional().describe("Filter downloads by state."),
          query: schema.string().optional().describe("Search query for filename or URL."),
          limit: schema.number().int().min(1).max(1000).default(100).describe("Maximum downloads to return.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("listDownloads", args), null, 2);
        }
      }),
      chrome_download_cancel: tool({
        description: "Cancel an in-progress Chrome download by id.",
        args: {
          downloadId: schema.number().int().describe("Chrome download id.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("cancelDownload", args), null, 2);
        }
      }),
      chrome_download_pause: tool({
        description: "Pause an in-progress Chrome download by id.",
        args: {
          downloadId: schema.number().int().describe("Chrome download id.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("pauseDownload", args), null, 2);
        }
      }),
      chrome_download_resume: tool({
        description: "Resume a paused Chrome download by id.",
        args: {
          downloadId: schema.number().int().describe("Chrome download id.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("resumeDownload", args), null, 2);
        }
      }),
      chrome_download_show: tool({
        description: "Show a downloaded file in its folder, or show the default downloads folder.",
        args: {
          downloadId: schema.number().int().optional().describe("Chrome download id. Omit to show the default downloads folder."),
          showDefaultFolder: schema.boolean().optional().describe("Show the default downloads folder instead of a specific file.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("showDownload", args), null, 2);
        }
      }),
      chrome_tab_group_create: tool({
        description: "Create a Chrome tab group from a set of tabs, with optional title, color, and collapsed state.",
        args: {
          tabIds: schema.array(schema.number().int()).describe("Array of Chrome tab ids to group."),
          title: schema.string().optional().describe("Tab group title."),
          color: schema.enum(["grey", "blue", "red", "yellow", "green", "pink", "orange", "cyan", "purple"]).optional().describe("Tab group color."),
          collapsed: schema.boolean().optional().describe("Whether the tab group is collapsed."),
          windowId: schema.number().int().optional().describe("Chrome window id to create the group in.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("createTabGroup", args), null, 2);
        }
      }),
      chrome_tab_group_update: tool({
        description: "Update a Chrome tab group title, color, or collapsed state.",
        args: {
          groupId: schema.number().int().describe("Chrome tab group id."),
          title: schema.string().optional().describe("New tab group title."),
          color: schema.enum(["grey", "blue", "red", "yellow", "green", "pink", "orange", "cyan", "purple"]).optional().describe("New tab group color."),
          collapsed: schema.boolean().optional().describe("Whether the tab group is collapsed.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("updateTabGroup", args), null, 2);
        }
      }),
      chrome_tab_groups: tool({
        description: "List Chrome tab groups, optionally filtered by window.",
        args: {
          windowId: schema.number().int().optional().describe("Chrome window id to filter tab groups.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("listTabGroups", args), null, 2);
        }
      }),
      chrome_group_tabs: tool({
        description: "Add Chrome tabs to an existing tab group, or create a new group when groupId is omitted.",
        args: {
          tabIds: schema.array(schema.number().int()).describe("Array of Chrome tab ids to group."),
          groupId: schema.number().int().optional().describe("Existing tab group id. Omit to create a new group.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("groupTabs", args), null, 2);
        }
      }),
      chrome_ungroup_tabs: tool({
        description: "Remove Chrome tabs from their tab group.",
        args: {
          tabIds: schema.array(schema.number().int()).describe("Array of Chrome tab ids to remove from their group.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("ungroupTabs", args), null, 2);
        }
      }),
      chrome_events: tool({
        description: "Poll buffered browser events (tabs, windows, downloads, CDP) from the Chrome bridge. Returns events since the given sequence number.",
        args: {
          since: schema.number().int().min(0).default(0).describe("Return events with seq greater than this value. Use 0 for the current buffer, or the nextSeq from the previous call.")
        },
        async execute(args) {
          return JSON.stringify(await pollEvents(args.since ?? 0), null, 2);
        }
      }),
      chrome_get_console_logs: tool({
        description: "Read accumulated console messages, network log entries, and uncaught exceptions for a Chrome tab. On the first call, auto-attaches a persistent debugger and enables Console, Log, and Runtime domains so events flow into the buffer. Pass clear:true to reset the buffer after reading. Useful to diagnose runtime errors such as 404s on script includes.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          clear: schema.boolean().optional().describe("If true, empty the buffer after returning the entries."),
          autoAttach: schema.boolean().optional().describe("If true (default), auto-attach the persistent console debugger on the first call. Set false to read the existing buffer without attaching.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("getConsoleLogs", {
            tabId: args.tabId,
            clear: args.clear ?? false,
            autoAttach: args.autoAttach !== false
          }), null, 2);
        }
      }),
      chrome_release_debuggers: tool({
        description: "Release persistent Chrome debugger attachments created by console logging or CDP event subscriptions.",
        args: {
          tabIds: schema.array(schema.number().int()).optional().describe("Specific tab ids to release. Omit to release all persistent debugger attachments.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("releaseDebuggers", { tabIds: args.tabIds }), null, 2);
        }
      }),
      chrome_cursor_state: tool({
        description: "Set the visible browser-control cursor state and favicon badge for a tab: active, handoff, deliverable, hidden, or abort.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          state: schema.enum(["active", "handoff", "deliverable", "hidden", "abort"]).describe("Cursor state to show.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("setCursorState", args), null, 2);
        }
      }),
      chrome_favicon_badge: tool({
        description: "Set or clear the OpenCode browser-control favicon badge for a tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          badge: schema.enum(["active", "handoff", "deliverable"]).optional().describe("Badge to show. Omit to clear.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("setFaviconBadge", { tabId: args.tabId, badge: args.badge ?? null }), null, 2);
        }
      }),
      chrome_accessibility_tree: tool({
        description: "Capture a compact accessibility tree of a Chrome tab with stable element references (e1, e2, ...). Use the refs with chrome_click_element and chrome_fill_element to act on elements without pixel coordinates. Sensitive fields (passwords, payment autocomplete) are always redacted. Refs are valid until the tab navigates.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          interactiveOnly: schema.boolean().optional().describe("If true, only include interactive elements (buttons, links, inputs)."),
          maxNodes: schema.number().int().min(1).max(2000).default(800).describe("Maximum elements to include."),
          maxChars: schema.number().int().min(100).max(200000).default(50000).describe("Maximum characters of tree text to return.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("accessibilityTree", args), null, 2);
        }
      }),
      chrome_click_element: tool({
        description: "Click an element in a Chrome tab by its accessibility-tree reference. Scrolls the element into view and clicks its center through CDP. Capture chrome_accessibility_tree first to obtain refs.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          ref: schema.string().describe("Element reference from chrome_accessibility_tree, e.g. e12."),
          button: schema.enum(["left", "middle", "right"]).default("left").describe("Mouse button to use."),
          modifiers: schema.array(schema.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys to hold during click.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("clickElement", args), null, 2);
        }
      }),
      chrome_fill_element: tool({
        description: "Focus an input, textarea, or contenteditable element by accessibility-tree reference and type text into it. By default the existing content is selected first, so the new text replaces it.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id."),
          ref: schema.string().describe("Element reference from chrome_accessibility_tree, e.g. e12."),
          text: schema.string().describe("Text to type into the element."),
          clear: schema.boolean().default(true).describe("Select existing content first so the text replaces it. Set false to append at the current caret.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("fillElement", args), null, 2);
        }
      }),
      chrome_blocked_urls: tool({
        description: "List the effective blocked URL patterns the bridge enforces on navigation. Patterns come from enterprise managed storage and the extension's local storage key blockedUrlPatterns.",
        args: {},
        async execute() {
          return JSON.stringify(await bridgeCommand("getBlockedUrlPatterns"), null, 2);
        }
      }),
      chrome_subscribe_cdp: tool({
        description: "Subscribe to Chrome DevTools Protocol events for a tab. Emitted events appear via chrome_events with category 'cdp'.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id to subscribe to."),
          methods: schema.array(schema.string()).describe("Array of CDP event method names to subscribe to, e.g. [\"Network.responseReceived\", \"Console.messageAdded\"].")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("subscribeCdpEvents", args), null, 2);
        }
      }),
      chrome_unsubscribe_cdp: tool({
        description: "Unsubscribe from Chrome DevTools Protocol events for a tab. Omit methods to remove all subscriptions for the tab.",
        args: {
          tabId: schema.number().int().describe("Chrome tab id to unsubscribe from."),
          methods: schema.array(schema.string()).optional().describe("Array of CDP event method names to unsubscribe from. Omit to remove all subscriptions for the tab.")
        },
        async execute(args) {
          return JSON.stringify(await bridgeCommand("unsubscribeCdpEvents", args), null, 2);
        }
      })
    })
  };
}

// Every tool that can inspect or mutate Chrome requires explicit approval before
// running. context.ask() surfaces OpenCode's native "allow once / allow always / deny"
// prompt. Keep this deny-by-default: newly-added browser tools are guarded even when
// they do not yet have custom prompt metadata. Only the local bridge status probe is
// safe to run without access to browser data.
const APPROVAL_EXEMPT_TOOLS = new Set(["chrome_status"]);

const APPROVAL_METADATA = {
  chrome_cdp: (args) => ({ action: "Run a full Chrome DevTools Protocol command", method: args.method, tabId: args.tabId, targetId: args.targetId }),
  chrome_evaluate: (args) => ({ action: "Evaluate JavaScript in the page", tabId: args.tabId, expression: previewText(args.expression) }),
  chrome_wizard_step: (args) => ({ action: "Click, then optionally evaluate JavaScript and screenshot", tabId: args.tabId, expression: previewText(args.expression) }),
  chrome_open: (args) => ({ action: "Open or navigate a tab", url: args.url, tabId: args.tabId }),
  chrome_open_window: (args) => ({ action: "Open a new browser window", url: args.url }),
  chrome_click: (args) => ({ action: "Click in the page", tabId: args.tabId, x: args.x, y: args.y, button: args.button }),
  chrome_double_click: (args) => ({ action: "Double-click in the page", tabId: args.tabId, x: args.x, y: args.y }),
  chrome_hover: (args) => ({ action: "Move the mouse over the page", tabId: args.tabId, x: args.x, y: args.y }),
  chrome_scroll: (args) => ({ action: "Scroll the page", tabId: args.tabId }),
  chrome_type: (args) => ({ action: "Type text into the focused element", tabId: args.tabId, text: previewText(args.text) }),
  chrome_keypress: (args) => ({ action: "Send a key to the page", tabId: args.tabId, key: args.key, modifiers: args.modifiers }),
  chrome_drag: (args) => ({ action: "Drag the mouse across the page", tabId: args.tabId, points: args.points?.length }),
  chrome_move: (args) => ({ action: "Move the mouse across the page", tabId: args.tabId, points: args.points?.length }),
  chrome_history: (args) => ({ action: "Search the user's browsing history", query: args.query }),
  chrome_bookmarks: (args) => ({ action: "Search the user's bookmarks", query: args.query }),
  chrome_page_text: (args) => ({ action: "Read the page text", tabId: args.tabId }),
  chrome_accessibility_tree: (args) => ({ action: "Read the page accessibility tree", tabId: args.tabId }),
  chrome_click_element: (args) => ({ action: "Click a page element by reference", tabId: args.tabId, ref: args.ref }),
  chrome_fill_element: (args) => ({ action: "Type into a page element by reference", tabId: args.tabId, ref: args.ref, text: previewText(args.text) }),
  chrome_dom_content: (args) => ({ action: "Read the page DOM content", tabId: args.tabId, contentType: args.contentType }),
  chrome_get_console_logs: (args) => ({ action: "Read the page console logs", tabId: args.tabId }),
  chrome_screenshot: (args) => ({ action: "Capture a screenshot of the page", tabId: args.tabId, outputPath: args.outputPath }),
  chrome_screenshot_region: (args) => ({ action: "Capture a screenshot region of the page", tabId: args.tabId, outputPath: args.outputPath }),
  chrome_downloads_list: (args) => ({ action: "List the user's Chrome downloads", query: args.query })
};

function requireApprovals(tools) {
  const guarded = { ...tools };
  for (const [name, definition] of Object.entries(guarded)) {
    if (APPROVAL_EXEMPT_TOOLS.has(name)) continue;
    const describe = APPROVAL_METADATA[name]
      ?? (() => ({ action: definition.description ?? `Run ${name}` }));
    const run = definition.execute;
    guarded[name] = {
      ...definition,
      async execute(args, context) {
        if (typeof context?.ask !== "function") {
          throw new Error(`${name} requires an OpenCode runtime with permission prompts`);
        }
        await context.ask({
          permission: name,
          patterns: [name],
          always: [name],
          metadata: describe(args)
        });
        return run(args, context);
      }
    };
  }
  return guarded;
}

function previewText(value) {
  if (typeof value !== "string") return undefined;
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

async function resolveProjectOutputPath(projectDirectory, outputPath, fieldName) {
  const resolvedDir = await realpath(projectDirectory);
  const resolvedPath = path.isAbsolute(outputPath)
    ? path.resolve(outputPath)
    : path.resolve(resolvedDir, outputPath);
  assertPathWithin(resolvedDir, resolvedPath, fieldName);

  const nearestExistingPath = await nearestExistingAncestor(resolvedPath);
  const nearestExistingRealPath = await realpath(nearestExistingPath);
  assertPathWithin(resolvedDir, nearestExistingRealPath, fieldName);

  return resolvedPath;
}

async function nearestExistingAncestor(candidatePath) {
  let current = candidatePath;
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

function assertPathWithin(root, candidate, fieldName) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${fieldName} must be within the project directory: ${root}`);
}

async function loadOpenCodeTool() {
  const resolvedPath = import.meta.resolve("@opencode-ai/plugin");
  return import(resolvedPath);
}
