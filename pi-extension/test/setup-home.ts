import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Per-file scratch home. Files that need their own layout still set REMOTE_OMP_HOME
// themselves; this is the floor underneath them.
if (!process.env["REMOTE_OMP_HOME"]) {
  const home = mkdtempSync(join(tmpdir(), "remote-omp-test-home-"));
  process.env["REMOTE_OMP_HOME"] = home;
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });
}
