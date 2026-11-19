import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShellEnv, parseEnvBlock } from "./shell_env.js";

describe("parseEnvBlock", () => {
  const M = "__MARK__";

  test("reads the NUL-separated block and ignores rc-file output around it", () => {
    const out = `motd line\n${M}A=1\0B=two=parts\0MULTI=line1\nline2\0${M}prompt junk`;
    expect(parseEnvBlock(out, M)).toEqual({ A: "1", B: "two=parts", MULTI: "line1\nline2" });
  });

  test("no complete block → null", () => {
    expect(parseEnvBlock("no markers here", M)).toBeNull();
    expect(parseEnvBlock(`${M}A=1\0`, M)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("loginShellEnv", () => {
  let dir: string;
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test("returns what the user's shell exports, despite rc noise", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-shellenv-"));
    // Stands in for `zsh -ilc <cmd>`: prints like a chatty rc file, exports a
    // variable the way one would, then runs the command it was handed.
    const shell = join(dir, "fake-shell.sh");
    writeFileSync(shell, '#!/bin/sh\necho "welcome back"\nexport RP_FROM_RC="set by rc"\nexec /bin/sh -c "$2"\n');
    chmodSync(shell, 0o755);
    const env = await loginShellEnv({ shell });
    expect(env?.["RP_FROM_RC"]).toBe("set by rc");
  });

  test("a shell that cannot run → null, so the caller keeps its own environment", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-shellenv-"));
    expect(await loginShellEnv({ shell: join(dir, "no-such-shell") })).toBeNull();
  });

  test("a shell that hangs is cut off by the timeout", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-shellenv-"));
    const shell = join(dir, "hung-shell.sh");
    writeFileSync(shell, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(shell, 0o755);
    expect(await loginShellEnv({ shell, timeoutMs: 200 })).toBeNull();
  });
});
