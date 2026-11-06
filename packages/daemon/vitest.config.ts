// A bare `vitest` / `vitest run <file>` from packages/daemon picks this up, so test/setup.ts (temp NED_HOME,
// NED_NO_LLM, port 7791) always runs. src/paths.ts also refuses the real ~/.ned under vitest.
export { default } from "./test/vitest.config.ts";
