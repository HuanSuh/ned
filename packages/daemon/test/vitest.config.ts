import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  root,
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // One fresh module graph (and so one fresh NED_HOME, read at import time by src/paths.ts) per test file.
    isolate: true,
    pool: "forks",
    testTimeout: 10_000,
    silent: "passed-only",
  },
});
