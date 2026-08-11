// OpenCode 2 adapter.
//
// OpenCode 2 replaced the v1 plugin contract wholesale: a plugin is now a
// `{ id, setup }` module that registers tools through `ctx.tool.transform()`
// instead of a factory returning a `{ tool: { ... } }` map, tool inputs are JSON
// Schema instead of Zod shapes, and the tool context lost `ask()`, `directory`
// and `metadata()`.
//
// Rather than fork the implementation, this module reuses the v1 tool
// definitions verbatim — including the approval wrapper in ./opencode-plugin.js
// that makes every browser tool deny-by-default — and translates the surrounding
// contract. That keeps one source of truth for tool behaviour and security
// policy across both OpenCode generations.
import createChromeBridgePlugin from "./opencode-plugin.js";
import { requestPermission } from "./opencode-service-client.js";

export const PLUGIN_ID = "opencode-chrome-bridge";

export default {
  id: PLUGIN_ID,
  async setup(context) {
    const { tool } = await loadOpenCodeTool();
    const { tool: tools } = await createChromeBridgePlugin();
    const directories = new Map();
    const registration = await context.tool.transform((draft) => {
      for (const [name, definition] of Object.entries(tools)) {
        draft.add(toV2Tool(name, definition, tool.schema, context, directories));
      }
    });
    return () => registration.dispose();
  }
};

export function toV2Tool(name, definition, schema, pluginContext, directories) {
  return {
    name,
    description: definition.description,
    input: toInputSchema(definition.args, schema),
    // The approval wrapper in opencode-plugin.js raises its own permission
    // prompt for every tool, so declaring `options.permission` here would ask
    // the user twice for one call. Code mode is off because the wrapper's
    // per-origin page scoping assumes tools are invoked one call at a time.
    options: { codemode: false },
    async execute(input, toolContext) {
      const context = await createV1ToolContext(toolContext, pluginContext, directories);
      return toV2Result(await definition.execute(input ?? {}, context));
    }
  };
}

export function toInputSchema(args, schema) {
  // `io: "input"` keeps Zod defaults optional in the published schema; without
  // it every defaulted field is advertised to the model as required.
  return schema.toJSONSchema(schema.strictObject(args ?? {}), { io: "input" });
}

export async function createV1ToolContext(toolContext, pluginContext, directories, options = {}) {
  const sessionID = toolContext?.sessionID;
  const directory = await resolveSessionDirectory(sessionID, pluginContext, directories);
  return {
    sessionID,
    messageID: toolContext?.messageID,
    agent: toolContext?.agent,
    directory,
    worktree: directory,
    // OpenCode 2 does not hand tools an abort signal. A signal that never
    // aborts keeps the v1 call sites working; their own timeouts still apply.
    abort: toolContext?.abort ?? toolContext?.signal ?? new AbortController().signal,
    metadata(update) {
      const progress = toolContext?.progress;
      if (typeof progress !== "function") return;
      // Fire-and-forget: v1's metadata() is synchronous and callers do not await.
      void Promise.resolve(progress({ ...update?.metadata, title: update?.title })).catch(() => {});
    },
    ask(input) {
      return requestPermission({
        sessionID,
        action: input.permission,
        resources: input.patterns,
        save: input.always,
        metadata: input.metadata,
        agent: toolContext?.agent,
        source: toolContext?.messageID !== undefined && toolContext?.id !== undefined
          ? { type: "tool", messageID: toolContext.messageID, id: toolContext.id }
          : undefined
      }, options);
    }
  };
}

async function resolveSessionDirectory(sessionID, pluginContext, directories) {
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    throw new Error("OpenCode Chrome Bridge tools require a session-scoped tool context");
  }
  if (directories?.has(sessionID)) return directories.get(sessionID);
  const session = await pluginContext.session.get({ sessionID });
  const directory = session?.location?.directory;
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error(`OpenCode session ${sessionID} did not report a project directory`);
  }
  directories?.set(sessionID, directory);
  return directory;
}

export function toV2Result(result) {
  if (typeof result === "string") return { content: result };
  const content = [{ type: "text", text: result.output }];
  for (const attachment of result.attachments ?? []) {
    content.push({ type: "file", uri: attachment.url, mime: attachment.mime, name: attachment.filename });
  }
  const metadata = result.title === undefined ? result.metadata : { ...result.metadata, title: result.title };
  return metadata === undefined ? { content } : { content, metadata };
}

async function loadOpenCodeTool() {
  const resolvedPath = import.meta.resolve("@opencode-ai/plugin");
  return import(resolvedPath);
}
