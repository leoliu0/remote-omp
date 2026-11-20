import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file runs against its own throwaway REMOTE_OMP_HOME, so no test
    // can create or move anything under the developer's real ~/.omp/remote
    // (a stray `~/.omp/remote` would also block the one-time migration from ~/.pi/remote).
    setupFiles: ["./test/setup-home.ts"],
  },
});
