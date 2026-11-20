import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/** POSIX-only describes: features the Bloco C (plan/40) intentionally skips on
 *  Windows (symlinks/`~/.local/bin`, systemd, launchd). */
const posixOnly = process.platform === "win32";
import {
  LAUNCHD_LABEL,
  LEGACY_CLI_LINKS,
  LEGACY_LAUNCHD_LABEL,
  LEGACY_SYSTEMD_UNIT,
  LEGACY_WINDOWS_TASK_NAME,
  SYSTEMD_UNIT,
  WINDOWS_TASK_NAME,
  buildCmdShim,
  buildElevatedCmd,
  defaultRenderVars,
  detectPlatform,
  findNodeBinary,
  findSupervisorScript,
  findRemoteOmpScript,
  findTemplate,
  isOnPath,
  launchdPlistPath,
  legacyLaunchdPlistPath,
  legacySystemdUnitPath,
  linkCliBinaries,
  renderTemplate,
  supervisordLogPath,
  systemdUnitPath,
  taskXmlPath,
  unlinkCliBinaries,
  userLocalBinDir,
  vbsLauncherPath,
} from "./install.js";

/**
 * Pure-function tests for the install module. The real `launchctl`/`systemctl`/
 * `schtasks` calls are never made here — they change real OS state; the install
 * and uninstall flows run against an injected system in `install_service.test.ts`.
 * The smoke test for activation is documented in the README and run manually.
 */

describe("detectPlatform", () => {
  test("returns a known platform", () => {
    const p = detectPlatform();
    expect(["macos", "linux", "windows", "unsupported"]).toContain(p);
  });
});

describe("findNodeBinary", () => {
  test("returns process.execPath (absolute)", () => {
    expect(findNodeBinary()).toBe(process.execPath);
    expect(isAbsolute(findNodeBinary())).toBe(true); // `/...` POSIX, `C:\...` win32
  });
});

describe("findSupervisorScript", () => {
  test("ends with bin/supervisord.js (whatever distRoot is)", () => {
    // `join` yields the platform separator (`/` POSIX, `\` win32).
    expect(findSupervisorScript().endsWith(join("bin", "supervisord.js"))).toBe(true);
  });
});

describe("findTemplate", () => {
  test("systemd template file exists on disk with always-on hardening", () => {
    const p = findTemplate("systemd");
    expect(p.endsWith("systemd.service.template")).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("[Service]");
    expect(content).toContain('ExecStart="{NODE}" "{SUPERVISOR}"');
    expect(content).toContain("Restart=always");
    expect(content).toContain("StartLimitIntervalSec=0");
    expect(content).toContain("KillMode=mixed");
    expect(content).toContain("TimeoutStopSec=15s");
    expect(content).toContain("OOMPolicy=continue");
    expect(content).toContain("After=basic.target");
    expect(content).not.toContain("After=default.target");
    expect(content).toContain("{NODE}");
    expect(content).toContain("{SUPERVISOR}");
    expect(content).toContain("Description=Remote OMP daemon supervisor");
    expect(content).toContain("Documentation=https://github.com/leoliu0/remote-omp");
  });

  test("launchd template file exists on disk", () => {
    const p = findTemplate("launchd");
    expect(p.endsWith("launchd.plist.template")).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("<key>Label</key>");
    expect(content).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(content).toContain("{HOME}/.omp/remote/supervisord.log");
    expect(content).toContain("{NODE}");
    expect(content).toContain("{SUPERVISOR}");
  });

  test("task-scheduler (Windows) template file exists on disk (plan/40)", () => {
    const p = findTemplate("taskscheduler");
    expect(p.endsWith("task-scheduler.xml.template")).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("<Task ");
    expect(content).toContain("<LogonTrigger>");
    expect(content).toContain("<RestartOnFailure>");
    // {NODE}/{SUPERVISOR} now live in the VBS launcher, not the XML — the XML's
    // action invokes wscript.exe with {VBS} (asserted below).
    // Must declare UTF-16 to match the UTF-16LE+BOM bytes install.ts writes —
    // schtasks /Create /XML rejects a mismatch ("unable to switch the encoding").
    expect(content).toContain('encoding="UTF-16"');
    // The action runs the hidden VBScript launcher (plan/40), not node directly,
    // so the supervisor starts with no console window.
    expect(content).toContain("wscript.exe");
    expect(content).toContain("{VBS}");
    expect(content).toContain("<Hidden>true</Hidden>");
  });

  test("vbs-launcher (Windows) template file exists on disk (plan/40)", () => {
    const p = findTemplate("vbs-launcher");
    expect(p.endsWith("task-launcher.vbs.template")).toBe(true);
    const content = readFileSync(p, "utf8");
    // Hidden window (style 0), wait=True, propagate exit code, tee to {LOG}.
    expect(content).toContain(".Run(");
    expect(content).toContain("WScript.Quit");
    expect(content).toContain("cmd /c");
    expect(content).toContain("{NODE}");
    expect(content).toContain("{SUPERVISOR}");
    expect(content).toContain("{LOG}");
  });

  test("no template names the pre-rename service, data directory or agent", () => {
    for (const name of ["systemd", "launchd", "taskscheduler", "vbs-launcher"] as const) {
      const content = readFileSync(findTemplate(name), "utf8");
      expect(content, name).not.toMatch(/remote-pi|remotepi|pi-supervisord|\.pi\/remote/i);
      expect(content, name).not.toMatch(/\bpi\b/i);
    }
  });
});

describe("renderTemplate", () => {
  const vars = {
    node: "/usr/local/bin/node",
    supervisor: "/Users/x/dist/bin/supervisord.js",
    home: "/Users/x",
    user: "jacob",
    path: "/usr/local/bin:/usr/bin:/bin",
    vbs: "/Users/x/.omp/remote/RemoteOmpSupervisorLauncher.vbs",
    logPath: "/Users/x/.omp/remote/supervisord.log",
  };

  test("substitutes every placeholder in systemd template", () => {
    const tpl = readFileSync(findTemplate("systemd"), "utf8");
    const out = renderTemplate(tpl, vars);
    expect(out).not.toContain("{NODE}");
    expect(out).not.toContain("{SUPERVISOR}");
    expect(out).not.toContain("{HOME}");
    expect(out).not.toContain("{PATH}");
    expect(out).not.toContain("{USER}");
    expect(out).toContain(vars.node);
    expect(out).toContain(vars.supervisor);
    expect(out).toContain(vars.home);
    expect(out).toContain(vars.path);
  });

  test("substitutes every placeholder in launchd template", () => {
    const tpl = readFileSync(findTemplate("launchd"), "utf8");
    const out = renderTemplate(tpl, vars);
    expect(out).not.toContain("{NODE}");
    expect(out).not.toContain("{SUPERVISOR}");
    expect(out).not.toContain("{HOME}");
    expect(out).not.toContain("{PATH}");
    expect(out).toContain(`<string>${vars.node}</string>`);
    expect(out).toContain(`<string>${vars.supervisor}</string>`);
    expect(out).toContain(`<string>${vars.home}/.omp/remote/supervisord.log</string>`);
  });

  test("global replacement (multiple occurrences of same placeholder)", () => {
    // HOME appears in multiple keys of the launchd plist.
    const tpl = readFileSync(findTemplate("launchd"), "utf8");
    const out = renderTemplate(tpl, vars);
    // No unsubstituted {HOME} anywhere.
    expect(out.match(/\{HOME\}/g)).toBeNull();
    // And the value appears more than once (logs + EnvironmentVariables).
    const matches = out.match(new RegExp(vars.home.replace(/[/.]/g, "\\$&"), "g"));
    expect(matches && matches.length > 1).toBe(true);
  });

  test("substitutes {VBS} in the task-scheduler template, action calls wscript", () => {
    const tpl = readFileSync(findTemplate("taskscheduler"), "utf8");
    const out = renderTemplate(tpl, vars);
    expect(out).not.toContain("{VBS}");
    expect(out).toContain(vars.vbs);
    // {NODE}/{SUPERVISOR} no longer appear in the XML — they moved to the VBS.
    expect(out).not.toContain("{NODE}");
    expect(out).not.toContain("{SUPERVISOR}");
  });

  test("substitutes {NODE}/{SUPERVISOR}/{LOG} in the vbs-launcher template", () => {
    const tpl = readFileSync(findTemplate("vbs-launcher"), "utf8");
    const out = renderTemplate(tpl, vars);
    expect(out).not.toContain("{NODE}");
    expect(out).not.toContain("{SUPERVISOR}");
    expect(out).not.toContain("{LOG}");
    expect(out).toContain(vars.node);
    expect(out).toContain(vars.supervisor);
    expect(out).toContain(vars.logPath);
  });
});

describe("data-dir paths (taskXmlPath, vbsLauncherPath, supervisordLogPath)", () => {
  let prevOmpHome: string | undefined;
  let scratch: string;

  beforeEach(() => {
    prevOmpHome = process.env["REMOTE_OMP_HOME"];
    scratch = mkdtempSync(join(tmpdir(), "omp-install-paths-"));
  });

  afterEach(() => {
    if (prevOmpHome === undefined) delete process.env["REMOTE_OMP_HOME"];
    else process.env["REMOTE_OMP_HOME"] = prevOmpHome;
    rmSync(scratch, { recursive: true, force: true });
  });

  test("vbsLauncherPath is absolute and ends with the launcher .vbs under ~/.omp/remote", () => {
    const p = vbsLauncherPath();
    expect(isAbsolute(p)).toBe(true);
    expect(p.endsWith("RemoteOmpSupervisorLauncher.vbs")).toBe(true);
    expect(p.endsWith(join(".omp", "remote", "RemoteOmpSupervisorLauncher.vbs"))).toBe(true);
  });

  test("all three follow REMOTE_OMP_HOME, evaluated when called", () => {
    process.env["REMOTE_OMP_HOME"] = scratch;
    expect(taskXmlPath()).toBe(join(scratch, ".omp", "remote", "RemoteOmpSupervisor.xml"));
    expect(vbsLauncherPath()).toBe(join(scratch, ".omp", "remote", "RemoteOmpSupervisorLauncher.vbs"));
    expect(supervisordLogPath()).toBe(join(scratch, ".omp", "remote", "supervisord.log"));

    const other = join(scratch, "other");
    process.env["REMOTE_OMP_HOME"] = other;
    expect(supervisordLogPath()).toBe(join(other, ".omp", "remote", "supervisord.log"));
  });
});

describe("buildCmdShim", () => {
  test("forwards all args to node with quoted node + target", () => {
    const shim = buildCmdShim("C:\\node\\node.exe", "C:\\ext\\dist\\index.js");
    expect(shim).toContain('@echo off');
    expect(shim).toContain('"C:\\node\\node.exe" "C:\\ext\\dist\\index.js" %*');
    expect(shim.endsWith("\r\n")).toBe(true);
  });
});

describe("buildElevatedCmd", () => {
  test("redirects schtasks lines to the log but leaves control-flow bare", () => {
    const out = buildElevatedCmd(
      [
        "schtasks /End /TN RemoteOmpSupervisor",
        "schtasks /Create /XML \"x.xml\" /TN RemoteOmpSupervisor /F",
        "if errorlevel 1 exit /b 1",
        "schtasks /Run /TN RemoteOmpSupervisor",
      ],
      "C:\\Temp\\out.log",
    );
    expect(out.startsWith("@echo off\r\n")).toBe(true);
    // schtasks lines get the redirect…
    expect(out).toContain('schtasks /End /TN RemoteOmpSupervisor >> "C:\\Temp\\out.log" 2>&1');
    expect(out).toContain('schtasks /Run /TN RemoteOmpSupervisor >> "C:\\Temp\\out.log" 2>&1');
    // …control flow does NOT (redirecting it would swallow the exit code).
    expect(out).toContain("if errorlevel 1 exit /b 1\r\n");
    expect(out).not.toContain('exit /b 1 >> ');
  });
});

// systemd/launchd paths are POSIX-only (Windows uses Task Scheduler — plan/40).
describe.skipIf(posixOnly)("paths", () => {
  test("systemdUnitPath lives under ~/.config/systemd/user/", () => {
    expect(systemdUnitPath()).toMatch(/\.config\/systemd\/user\/remote-omp-supervisord\.service$/);
  });

  test("launchdPlistPath lives under ~/Library/LaunchAgents/", () => {
    expect(launchdPlistPath()).toMatch(/Library\/LaunchAgents\/dev\.remoteomp\.supervisord\.plist$/);
  });

  test("the unit and plist directories hang off the given home, not the real one", () => {
    expect(systemdUnitPath("/tmp/h")).toBe(join("/tmp/h", ".config", "systemd", "user", "remote-omp-supervisord.service"));
    expect(launchdPlistPath("/tmp/h")).toBe(join("/tmp/h", "Library", "LaunchAgents", "dev.remoteomp.supervisord.plist"));
    expect(legacySystemdUnitPath("/tmp/h")).toBe(join("/tmp/h", ".config", "systemd", "user", "remote-pi-supervisord.service"));
    expect(legacyLaunchdPlistPath("/tmp/h")).toBe(join("/tmp/h", "Library", "LaunchAgents", "dev.remotepi.supervisord.plist"));
  });
});

describe("service names", () => {
  test("the current service is named after Remote OMP", () => {
    expect(SYSTEMD_UNIT).toBe("remote-omp-supervisord.service");
    expect(LAUNCHD_LABEL).toBe("dev.remoteomp.supervisord");
    expect(WINDOWS_TASK_NAME).toBe("RemoteOmpSupervisor");
  });

  test("the pre-rename names survive only so an old install can be cleaned up", () => {
    expect(LEGACY_SYSTEMD_UNIT).toBe("remote-pi-supervisord.service");
    expect(LEGACY_LAUNCHD_LABEL).toBe("dev.remotepi.supervisord");
    expect(LEGACY_WINDOWS_TASK_NAME).toBe("RemotePiSupervisor");
    expect([...LEGACY_CLI_LINKS]).toEqual(["remote-pi", "pi-supervisord"]);
  });
});

describe("defaultRenderVars", () => {
  test("populates all required fields", () => {
    const vars = defaultRenderVars();
    expect(vars.node).toBe(process.execPath);
    expect(vars.supervisor.endsWith(join("bin", "supervisord.js"))).toBe(true);
    expect(isAbsolute(vars.home)).toBe(true);
    expect(vars.user.length).toBeGreaterThan(0);
    expect(vars.path.length).toBeGreaterThan(0);
  });
});

// ── CLI bin linking (plan/27) ────────────────────────────────────────────────

describe("findRemoteOmpScript", () => {
  test("resolves to dist/index.js sibling of supervisord", () => {
    const p = findRemoteOmpScript();
    expect(basename(p)).toBe("index.js");
    // Same dist root as supervisord: dirname(index.js) === dirname(dist/bin).
    expect(dirname(p)).toBe(dirname(dirname(findSupervisorScript())));
  });
});

// `~/.local/bin` + `:`-delimited PATH are POSIX-only (Windows skips CLI symlinks).
describe.skipIf(posixOnly)("userLocalBinDir + isOnPath", () => {
  test("userLocalBinDir composes ~/.local/bin from given homedir", () => {
    expect(userLocalBinDir("/tmp/fakehome")).toBe("/tmp/fakehome/.local/bin");
  });

  test("isOnPath matches dirs with and without trailing slash", () => {
    expect(isOnPath("/x/.local/bin", "/usr/bin:/x/.local/bin:/opt/bin")).toBe(true);
    expect(isOnPath("/x/.local/bin", "/usr/bin:/x/.local/bin/:/opt/bin")).toBe(true);
    expect(isOnPath("/x/.local/bin/", "/usr/bin:/x/.local/bin")).toBe(true);
    expect(isOnPath("/x/.local/bin", "/usr/bin:/opt/bin")).toBe(false);
    expect(isOnPath("/x/.local/bin", "")).toBe(false);
  });
});

// CLI symlinks are POSIX-only — on Windows linkCliBinaries writes `.cmd` shims
// instead (the describe below).
describe.skipIf(posixOnly)("linkCliBinaries / unlinkCliBinaries", () => {
  let tmpHome: string;
  let fakePaths: { remoteOmp: string; supervisord: string };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "omp-link-"));
    // Stand-ins for the real extension files so the test doesn't depend
    // on `pnpm build` having run.
    const stub = join(tmpHome, "fake-ext");
    mkdirSync(join(stub, "bin"), { recursive: true });
    fakePaths = {
      remoteOmp: join(stub, "index.js"),
      supervisord: join(stub, "bin", "supervisord.js"),
    };
    writeFileSync(fakePaths.remoteOmp, "#!/usr/bin/env node\n");
    writeFileSync(fakePaths.supervisord, "#!/usr/bin/env node\n");
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("link creates two symlinks pointing at the real extension files", () => {
    const result = linkCliBinaries(tmpHome, fakePaths);
    expect(result.binDir).toBe(join(tmpHome, ".local", "bin"));
    expect(result.links).toHaveLength(2);

    const names = result.links.map((l) => l.name).sort();
    expect(names).toEqual(["remote-omp", "remote-omp-supervisord"]);

    for (const link of result.links) {
      expect(lstatSync(link.path).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link.path)).toBe(link.target);
    }
  });

  test("link is idempotent (re-running yields same symlinks, no error)", () => {
    linkCliBinaries(tmpHome, fakePaths);
    const second = linkCliBinaries(tmpHome, fakePaths);
    for (const link of second.links) {
      expect(readlinkSync(link.path)).toBe(link.target);
    }
    // The "unchanged" branch should have fired the second time.
    expect(second.log.some((l) => l.includes("(unchanged)"))).toBe(true);
  });

  test("link replaces a stale symlink pointing elsewhere", () => {
    const binDir = join(tmpHome, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    // Write a fake stale symlink first
    const stale = join(binDir, "remote-omp");
    writeFileSync(join(tmpHome, "fake-old.js"), "// old\n");
    symlinkSync(join(tmpHome, "fake-old.js"), stale);
    expect(readlinkSync(stale)).toBe(join(tmpHome, "fake-old.js"));

    const result = linkCliBinaries(tmpHome, fakePaths);
    const cli = result.links.find((l) => l.name === "remote-omp")!;
    expect(readlinkSync(cli.path)).toBe(cli.target);
    expect(readlinkSync(cli.path)).not.toBe(join(tmpHome, "fake-old.js"));
  });

  test("link signals onPath=false when binDir is absent from PATH (typical CI)", () => {
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "/usr/bin:/bin";
    try {
      const result = linkCliBinaries(tmpHome, fakePaths);
      expect(result.onPath).toBe(false);
      expect(result.log.some((l) => l.includes("not on $PATH"))).toBe(true);
    } finally {
      process.env["PATH"] = originalPath;
    }
  });

  test("unlink removes both symlinks, idempotent on second call", () => {
    linkCliBinaries(tmpHome, fakePaths);
    const first = unlinkCliBinaries(tmpHome);
    expect(first.removed.map((r) => r.existed)).toEqual([true, true]);
    for (const r of first.removed) {
      expect(existsSync(r.path)).toBe(false);
    }
    // Second call is a no-op
    const second = unlinkCliBinaries(tmpHome);
    expect(second.removed.map((r) => r.existed)).toEqual([false, false]);
  });

  test("unlink does NOT delete the extension files (link targets are preserved)", () => {
    const linkResult = linkCliBinaries(tmpHome, fakePaths);
    unlinkCliBinaries(tmpHome);
    for (const link of linkResult.links) {
      // The target file (the actual dist/index.js etc) still exists.
      expect(existsSync(link.target)).toBe(true);
    }
  });

  // The pre-rename build (Remote Pi) linked `remote-pi` and `pi-supervisord`. The new link
  // step and unlink retire them — but only symlinks: anything else under those names is
  // somebody else's file.
  describe("pre-rename links", () => {
    let binDir: string;
    let oldTarget: string;
    const present = (path: string): boolean => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    };

    beforeEach(() => {
      binDir = join(tmpHome, ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      oldTarget = join(tmpHome, "old-ext", "index.js");
      mkdirSync(dirname(oldTarget), { recursive: true });
      writeFileSync(oldTarget, "// old\n");
    });

    test("link removes them (a dangling one too) and creates the new links", () => {
      symlinkSync(oldTarget, join(binDir, "remote-pi"));
      symlinkSync(join(tmpHome, "gone.js"), join(binDir, "pi-supervisord")); // target does not exist

      const result = linkCliBinaries(tmpHome, fakePaths);

      for (const name of LEGACY_CLI_LINKS) expect(present(join(binDir, name))).toBe(false);
      expect(result.links.map((l) => readlinkSync(l.path))).toEqual([fakePaths.remoteOmp, fakePaths.supervisord]);
      expect(result.log).toContain(`removed ${join(binDir, "remote-pi")}`);
      expect(result.log).toContain(`removed ${join(binDir, "pi-supervisord")}`);
    });

    test("link leaves a regular file under an old name alone", () => {
      const mine = join(binDir, "remote-pi");
      writeFileSync(mine, "#!/bin/sh\necho mine\n");

      const result = linkCliBinaries(tmpHome, fakePaths);

      expect(readFileSync(mine, "utf8")).toBe("#!/bin/sh\necho mine\n");
      expect(lstatSync(mine).isSymbolicLink()).toBe(false);
      expect(result.log.some((l) => l.includes(`left ${mine} alone`))).toBe(true);
    });

    test("unlink removes the old symlinks too, listing them after the current names", () => {
      linkCliBinaries(tmpHome, fakePaths);
      for (const name of LEGACY_CLI_LINKS) symlinkSync(oldTarget, join(binDir, name));

      const result = unlinkCliBinaries(tmpHome);

      expect(result.removed.map((r) => [r.name, r.existed])).toEqual([
        ["remote-omp", true],
        ["remote-omp-supervisord", true],
        ["remote-pi", true],
        ["pi-supervisord", true],
      ]);
      for (const r of result.removed) expect(present(r.path)).toBe(false);
      expect(existsSync(oldTarget)).toBe(true); // targets are never touched
    });

    test("unlink leaves a regular file under any reserved name alone", () => {
      const names = ["remote-omp", "remote-omp-supervisord", ...LEGACY_CLI_LINKS];
      for (const name of names) writeFileSync(join(binDir, name), `#!/bin/sh\necho ${name}\n`);

      const result = unlinkCliBinaries(tmpHome);

      for (const name of names) expect(readFileSync(join(binDir, name), "utf8")).toBe(`#!/bin/sh\necho ${name}\n`);
      expect(result.removed.map((r) => [r.name, r.existed])).toEqual([
        ["remote-omp", false],
        ["remote-omp-supervisord", false],
      ]);
    });
  });
});

// Windows variant (plan/40): real `.cmd` shims, not symlinks. `platform: "win32"`
// takes the Windows branch on any host, `mutatePath:false` keeps the test from
// touching the real user PATH, and `node` is injected so the shim contents are
// deterministic.
describe("linkCliBinaries / unlinkCliBinaries (Windows .cmd shims)", () => {
  let tmpHome: string;
  let fakePaths: { remoteOmp: string; supervisord: string };
  const node = "C:\\Program Files\\nodejs\\node.exe";

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "omp-link-win-"));
    const stub = join(tmpHome, "fake-ext");
    mkdirSync(join(stub, "bin"), { recursive: true });
    fakePaths = {
      remoteOmp: join(stub, "index.js"),
      supervisord: join(stub, "bin", "supervisord.js"),
    };
    writeFileSync(fakePaths.remoteOmp, "// stub\n");
    writeFileSync(fakePaths.supervisord, "// stub\n");
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("link writes remote-omp.cmd + remote-omp-supervisord.cmd pointing at node + targets", () => {
    const result = linkCliBinaries(tmpHome, fakePaths, { node, mutatePath: false, platform: "win32" });
    expect(result.binDir).toBe(join(tmpHome, ".local", "bin"));
    const names = result.links.map((l) => l.name).sort();
    expect(names).toEqual(["remote-omp-supervisord.cmd", "remote-omp.cmd"]);
    for (const link of result.links) {
      expect(existsSync(link.path)).toBe(true);
      const content = readFileSync(link.path, "utf8");
      expect(content).toContain(`"${node}"`);
      expect(content).toContain(`"${link.target}"`);
      expect(content).toContain("%*");
    }
  });

  test("link is idempotent (re-running overwrites the same .cmd files)", () => {
    linkCliBinaries(tmpHome, fakePaths, { node, mutatePath: false, platform: "win32" });
    const second = linkCliBinaries(tmpHome, fakePaths, { node, mutatePath: false, platform: "win32" });
    for (const link of second.links) {
      expect(readFileSync(link.path, "utf8")).toBe(buildCmdShim(node, link.target));
    }
  });

  test("unlink removes both .cmd shims, idempotent on second call", () => {
    linkCliBinaries(tmpHome, fakePaths, { node, mutatePath: false, platform: "win32" });
    const first = unlinkCliBinaries(tmpHome, { platform: "win32" });
    expect(first.removed.map((r) => r.existed)).toEqual([true, true]);
    for (const r of first.removed) expect(existsSync(r.path)).toBe(false);
    const second = unlinkCliBinaries(tmpHome, { platform: "win32" });
    expect(second.removed.map((r) => r.existed)).toEqual([false, false]);
  });

  test("link removes the pre-rename shims it recognises and leaves a hand-written one alone", () => {
    const binDir = join(tmpHome, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const oldShim = join(binDir, "remote-pi.cmd");
    const mine = join(binDir, "pi-supervisord.cmd");
    writeFileSync(oldShim, buildCmdShim(node, "C:\\old\\dist\\index.js"));
    writeFileSync(mine, "@echo off\r\necho my own wrapper\r\n");

    const result = linkCliBinaries(tmpHome, fakePaths, { node, mutatePath: false, platform: "win32" });

    expect(existsSync(oldShim)).toBe(false);
    expect(readFileSync(mine, "utf8")).toBe("@echo off\r\necho my own wrapper\r\n");
    expect(result.log.some((l) => l.includes(`left ${mine} alone`))).toBe(true);
  });

  test("unlink removes our shims — current and pre-rename — and nothing else", () => {
    const binDir = join(tmpHome, ".local", "bin");
    linkCliBinaries(tmpHome, fakePaths, { node, mutatePath: false, platform: "win32" });
    writeFileSync(join(binDir, "remote-pi.cmd"), buildCmdShim(node, "C:\\old\\dist\\index.js"));
    writeFileSync(join(binDir, "pi-supervisord.cmd"), "@echo off\r\necho my own wrapper\r\n");

    const result = unlinkCliBinaries(tmpHome, { platform: "win32" });

    expect(result.removed.map((r) => [r.name, r.existed])).toEqual([
      ["remote-omp.cmd", true],
      ["remote-omp-supervisord.cmd", true],
      ["remote-pi.cmd", true],
    ]);
    expect(existsSync(join(binDir, "remote-pi.cmd"))).toBe(false);
    expect(readFileSync(join(binDir, "pi-supervisord.cmd"), "utf8")).toBe("@echo off\r\necho my own wrapper\r\n");
  });
});
