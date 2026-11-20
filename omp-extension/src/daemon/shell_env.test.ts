import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterLoginShellEnv, loginShellEnv, parseEnvJsonBlock } from "./shell_env.js";

describe("parseEnvJsonBlock", () => {
  const S = "__START__";
  const E = "__END__";

  test("reads JSON object between markers and ignores rc-file output around it", () => {
    const out = `motd line\n${S}{"A":"1","B":"two=parts","MULTI":"line1\\nline2"}${E}prompt junk`;
    expect(parseEnvJsonBlock(out, S, E)).toEqual({ A: "1", B: "two=parts", MULTI: "line1\nline2" });
  });

  test("no complete block, invalid JSON, or empty object → null", () => {
    expect(parseEnvJsonBlock("no markers here", S, E)).toBeNull();
    expect(parseEnvJsonBlock(`${S}{"A":"1"}`, S, E)).toBeNull();
    expect(parseEnvJsonBlock(`${S}{not-json}${E}`, S, E)).toBeNull();
    expect(parseEnvJsonBlock(`${S}{}${E}`, S, E)).toBeNull();
    expect(parseEnvJsonBlock(`${S}[]${E}`, S, E)).toBeNull();
  });
});

describe("filterLoginShellEnv", () => {
  test("strips interactive shell ephemera and preserves base service overrides", () => {
    const filtered = filterLoginShellEnv(
      {
        API_KEY: "secret",
        PWD: "/tmp/other",
        OLDPWD: "/tmp",
        SHLVL: "2",
        _: "/usr/bin/node",
        REMOTE_OMP_HOME: "/from-rc",
        REMOTE_OMP_NOTIFY_URL: "https://ntfy.sh/rc",
      },
      {
        REMOTE_OMP_HOME: "/from-service",
        REMOTE_OMP_NOTIFY_URL: "https://ntfy.sh/svc",
        REMOTE_OMP_NOTIFY_TOKEN: "tok-svc",
        REMOTE_OMP_NOTIFY_MODE: "always",
      },
    );
    expect(filtered).toEqual({
      API_KEY: "secret",
      REMOTE_OMP_HOME: "/from-service",
      REMOTE_OMP_NOTIFY_URL: "https://ntfy.sh/svc",
      REMOTE_OMP_NOTIFY_TOKEN: "tok-svc",
      REMOTE_OMP_NOTIFY_MODE: "always",
    });
  });

  test("keeps the REMOTE_OMP_* overrides the service sets and does not know the pre-rename names", () => {
    const base = {
      REMOTE_OMP_RELAY: "wss://relay.example",
      REMOTE_OMP_ALLOW_FILE_IDENTITY: "1",
      REMOTE_PI_HOME: "/old-home",
      REMOTE_PI_RELAY: "wss://old.example",
      REMOTE_PI_NOTIFY_URL: "https://ntfy.sh/old",
    };
    expect(filterLoginShellEnv({ API_KEY: "secret" }, base)).toEqual({
      API_KEY: "secret",
      REMOTE_OMP_RELAY: "wss://relay.example",
      REMOTE_OMP_ALLOW_FILE_IDENTITY: "1",
    });
  });
});

describe.skipIf(process.platform === "win32")("loginShellEnv", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (!dir) return;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    dir = undefined;
  });

  test("returns what the user's shell exports, despite rc noise", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-shellenv-"));
    const shell = join(dir, "fake-shell.sh");
    writeFileSync(shell, '#!/bin/sh\necho "welcome back"\nexport RP_FROM_RC="set by rc"\nexec /bin/sh -c "$2"\n');
    chmodSync(shell, 0o755);
    const res = await loginShellEnv({ shell });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.env["RP_FROM_RC"]).toBe("set by rc");
  });

  test("a shell that cannot run or empty shell path → ok:false (never rejects)", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-shellenv-"));
    const missing = await loginShellEnv({ shell: join(dir, "no-such-shell") });
    expect(missing.ok).toBe(false);
    const empty = await loginShellEnv({ shell: "" });
    expect(empty.ok).toBe(false);
  });

  test("failing command / non-zero shell exit → ok:false (not empty success)", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-shellenv-"));
    const shell = join(dir, "failing-shell.sh");
    writeFileSync(shell, '#!/bin/sh\necho "env: illegal option -- 0" >&2\nexit 1\n');
    chmodSync(shell, 0o755);
    const res = await loginShellEnv({ shell });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/code=1/);
      expect(res.stderr).toContain("illegal option");
    }
  });

  test("marker text in an env var or rc output does not truncate env", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-shellenv-"));
    const shell = join(dir, "marker-noise-shell.sh");
    writeFileSync(
      shell,
      '#!/bin/sh\nexport A_CMD="__REMOTE_OMP_ENV__ $2"\nexport Z_AFTER="still-here"\nexec /bin/sh -c "$2"\n',
    );
    chmodSync(shell, 0o755);
    const res = await loginShellEnv({ shell });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.env["A_CMD"]).toContain("__REMOTE_OMP_ENV__");
      expect(res.env["Z_AFTER"]).toBe("still-here");
    }
  });

  test("resolves immediately when end marker arrives even if a grandchild holds stdout open", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-shellenv-"));
    const shell = join(dir, "bg-holder-shell.sh");
    writeFileSync(shell, '#!/bin/sh\nsleep 30 &\nexport RP_BG="ok"\n/bin/sh -c "$2"\n');
    chmodSync(shell, 0o755);
    const t0 = Date.now();
    const res = await loginShellEnv({ shell, timeoutMs: 5000 });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.env["RP_BG"]).toBe("ok");
    expect(elapsed).toBeLessThan(2500);
  });

  test("a shell that hangs is cut off by the timeout (including grandchildren)", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-shellenv-"));
    const shell = join(dir, "hung-shell.sh");
    writeFileSync(shell, "#!/bin/sh\nsleep 30 &\nwait\n");
    chmodSync(shell, 0o755);
    const res = await loginShellEnv({ shell, timeoutMs: 200 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/timed out/);
  });
});
