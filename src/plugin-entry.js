// OpenCode plugin entrypoint.
//
// OpenCode's plugin loader invokes every module export as a plugin factory,
// so the entrypoint must expose exactly one export: the plugin function.
// The implementation lives in ./opencode-plugin.js, which also exports
// helper functions and constants for tests; those must not leak into the
// entrypoint's module namespace.
export { default } from "./opencode-plugin.js";
