// OpenCode 2 plugin entrypoint.
//
// OpenCode 2 validates the entrypoint's default export against its
// `{ id, setup }` plugin schema. The implementation lives in
// ./opencode-plugin-v2.js, which also exports helpers for tests; keep those out
// of this module's namespace.
export { default } from "./opencode-plugin-v2.js";
