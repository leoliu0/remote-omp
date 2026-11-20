import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LAUNCHD_LABEL,
  LEGACY_WINDOWS_TASK_NAME,
  SYSTEMD_UNIT,
  installService,
  launchdPlistPath,
  legacyLaunchdPlistPath,
  legacySystemdUnitPath,
  removeLegacyService,
  supervisordLogPath,
  systemdUnitPath,
  taskXmlPath,
  uninstallService,
  vbsLauncherPath,
  type RenderVars,
  type ServiceDeps,
  type SupervisorPlatform,
} from "./install.js";
import { legacyRemotePiHome } from "../paths.js";

/**
 * `installService` / `uninstallService` / `removeLegacyService` against a scratch home and a
 * recording command runner: no real systemctl/launchctl/schtasks runs and no real unit or data
 * directory is touched. The pre-rename (Remote Pi) service must be replaced, never left
 * running next to the new one.
 */

const NODE = "/opt/node/bin/node";

let home: string;
let prevOmpHome: string | undefined;
let supervisor: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omp-svc-"));
  // The data dir is <home>/.omp/remote, the pre-rename one <home>/.pi/remote.
  prevOmpHome = process.env["REMOTE_OMP_HOME"];
  process.env["REMOTE_OMP_HOME"] = home;
  supervisor = join(home, "dist", "bin", "supervisord.js");
  mkdirSync(dirname(supervisor), { recursive: true });
  writeFileSync(supervisor, "// stand-in for the real supervisor entry\n");
});

afterEach(() => {
  if (prevOmpHome === undefined) delete process.env["REMOTE_OMP_HOME"];
  else process.env["REMOTE_OMP_HOME"] = prevOmpHome;
  rmSync(home, { recursive: true, force: true });
});

function renderVars(): RenderVars {
  return {
    node: NODE,
    supervisor,
    home,
    user: "tester",
    path: "/usr/local/bin:/usr/bin:/bin",
    vbs: vbsLauncherPath(),
    logPath: supervisordLogPath(),
  };
}

/**
 * Every command run, in call order, as `cmd arg arg`; each elevated schtasks line shows up as
 * `elevated: <line>`. `failing` picks the commands that exit non-zero. `legacyTask` says
 * whether the old scheduled task is registered: `/Query` fails without it, and an elevated
 * `/Delete` of it removes it.
 */
function fakeSystem(
  platform: SupervisorPlatform,
  opts: { legacyTask?: boolean; failing?: (line: string) => boolean } = {},
): { events: string[]; deps: ServiceDeps } {
  const events: string[] = [];
  let legacyTask = opts.legacyTask ?? false;
  const deps: ServiceDeps = {
    platform,
    home,
    uid: 501,
    run: (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      events.push(line);
      const fails =
        opts.failing?.(line) === true ||
        (line === `schtasks /Query /TN ${LEGACY_WINDOWS_TASK_NAME}` && !legacyTask);
      if (fails) throw Object.assign(new Error(`${line} exited 1`), { status: 1, stderr: "boom" });
      return "";
    },
    runElevated: (lines) => {
      for (const line of lines) events.push(`elevated: ${line}`);
      if (lines.some((line) => line.startsWith(`schtasks /Delete /TN ${LEGACY_WINDOWS_TASK_NAME}`))) legacyTask = false;
    },
  };
  return { events, deps };
}

function writeFileIn(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("removeLegacyService — linux", () => {
  test("stops and deletes the old unit, then reloads systemd", () => {
    const unit = legacySystemdUnitPath(home);
    writeFileIn(unit, "[Unit]\nDescription=Remote Pi daemon supervisor\n");
    const sys = fakeSystem("linux");

    const result = removeLegacyService(sys.deps);

    expect(sys.events).toEqual([
      "systemctl --user disable --now remote-pi-supervisord.service",
      "systemctl --user daemon-reload",
    ]);
    expect(existsSync(unit)).toBe(false);
    expect(result).toEqual({ removed: ["systemd unit remote-pi-supervisord.service"] });
  });

  test("with no old unit it runs no command at all, and a second call after a removal is a no-op", () => {
    const clean = fakeSystem("linux");
    expect(removeLegacyService(clean.deps)).toEqual({ removed: [] });
    expect(clean.events).toEqual([]);

    writeFileIn(legacySystemdUnitPath(home), "[Unit]\n");
    expect(removeLegacyService(fakeSystem("linux").deps).removed).toHaveLength(1);

    const again = fakeSystem("linux");
    expect(removeLegacyService(again.deps)).toEqual({ removed: [] });
    expect(again.events).toEqual([]);
  });

  test("a systemctl that fails (no user bus) still lets the unit file go", () => {
    const unit = legacySystemdUnitPath(home);
    writeFileIn(unit, "[Unit]\n");
    const sys = fakeSystem("linux", { failing: () => true });

    const result = removeLegacyService(sys.deps);

    expect(existsSync(unit)).toBe(false);
    expect(result.removed).toEqual(["systemd unit remote-pi-supervisord.service"]);
  });

  test("the new unit and the old data directory are left alone", () => {
    writeFileIn(legacySystemdUnitPath(home), "[Unit]\n");
    writeFileIn(systemdUnitPath(home), "[Unit]\nDescription=new\n");
    const oldData = legacyRemotePiHome();
    writeFileIn(join(oldData, "identity.json"), "{}");

    removeLegacyService(fakeSystem("linux").deps);

    expect(readFileSync(systemdUnitPath(home), "utf8")).toBe("[Unit]\nDescription=new\n");
    expect(readFileSync(join(oldData, "identity.json"), "utf8")).toBe("{}");
  });

  test("never throws: a unit that cannot be deleted is logged and not reported as removed", () => {
    const unit = legacySystemdUnitPath(home);
    mkdirSync(unit, { recursive: true }); // unlinkSync on a directory fails
    const sys = fakeSystem("linux", { failing: () => true });
    const log: string[] = [];

    expect(removeLegacyService(sys.deps, log)).toEqual({ removed: [] });
    expect(log.some((line) => line.startsWith("failed to remove"))).toBe(true);
  });

  test("an unsupported platform is a no-op", () => {
    const sys = fakeSystem("unsupported");
    expect(removeLegacyService(sys.deps)).toEqual({ removed: [] });
    expect(sys.events).toEqual([]);
  });
});

describe("removeLegacyService — macos", () => {
  test("boots the old job out by its service target and deletes the plist", () => {
    const plist = legacyLaunchdPlistPath(home);
    writeFileIn(plist, "<plist/>");
    const sys = fakeSystem("macos");

    const result = removeLegacyService(sys.deps);

    expect(sys.events).toEqual(["launchctl bootout gui/501/dev.remotepi.supervisord"]);
    expect(existsSync(plist)).toBe(false);
    expect(result).toEqual({ removed: ["launchd job dev.remotepi.supervisord"] });
  });

  test("falls back to `launchctl unload <plist>` when bootout fails", () => {
    const plist = legacyLaunchdPlistPath(home);
    writeFileIn(plist, "<plist/>");
    const sys = fakeSystem("macos", { failing: (line) => line.startsWith("launchctl bootout") });

    const result = removeLegacyService(sys.deps);

    expect(sys.events).toEqual([
      "launchctl bootout gui/501/dev.remotepi.supervisord",
      `launchctl unload ${plist}`,
    ]);
    expect(existsSync(plist)).toBe(false);
    expect(result.removed).toEqual(["launchd job dev.remotepi.supervisord"]);
  });

  test("with no old plist it runs nothing and leaves the new plist alone", () => {
    writeFileIn(launchdPlistPath(home), "<plist/>");
    const sys = fakeSystem("macos");

    expect(removeLegacyService(sys.deps)).toEqual({ removed: [] });
    expect(sys.events).toEqual([]);
    expect(existsSync(launchdPlistPath(home))).toBe(true);
  });
});

describe("removeLegacyService — windows", () => {
  test("ends and deletes the old task through one elevated script, leaving the old data directory alone", () => {
    const oldData = legacyRemotePiHome();
    const oldXml = join(oldData, "RemotePiSupervisor.xml");
    const oldVbs = join(oldData, "RemotePiSupervisorLauncher.vbs");
    writeFileIn(oldXml, "<Task/>");
    writeFileIn(oldVbs, "WScript.Quit 0");
    const sys = fakeSystem("windows", { legacyTask: true });

    const result = removeLegacyService(sys.deps);

    expect(sys.events).toEqual([
      "schtasks /Query /TN RemotePiSupervisor",
      "schtasks /End /TN RemotePiSupervisor",
      "elevated: schtasks /Delete /TN RemotePiSupervisor /F",
      "elevated: exit /b 0",
      "schtasks /Query /TN RemotePiSupervisor",
    ]);
    expect(result).toEqual({ removed: ["scheduled task RemotePiSupervisor"] });
    expect(existsSync(oldXml)).toBe(true);
    expect(existsSync(oldVbs)).toBe(true);
  });

  test("with no old task it only asks, and shows no UAC prompt", () => {
    const sys = fakeSystem("windows");

    expect(removeLegacyService(sys.deps)).toEqual({ removed: [] });
    expect(sys.events).toEqual(["schtasks /Query /TN RemotePiSupervisor"]);
  });

  test("a declined elevation does not throw and is not reported as a removal", () => {
    const sys = fakeSystem("windows", { legacyTask: true });
    const log: string[] = [];
    const deps: ServiceDeps = {
      ...sys.deps,
      runElevated: () => {
        throw new Error("the UAC prompt was declined");
      },
    };

    expect(removeLegacyService(deps, log)).toEqual({ removed: [] });
    expect(log.some((line) => line.includes("UAC prompt was declined"))).toBe(true);
  });

  test("a delete that changed nothing is not reported as a removal", () => {
    const sys = fakeSystem("windows", { legacyTask: true });
    const log: string[] = [];
    const deps: ServiceDeps = { ...sys.deps, runElevated: () => undefined };

    expect(removeLegacyService(deps, log)).toEqual({ removed: [] });
    expect(log.some((line) => line.includes("still registered"))).toBe(true);
  });
});

describe("installService (injected system)", () => {
  test("linux: the old service is stopped and deleted before the new one is enabled", () => {
    const old = legacySystemdUnitPath(home);
    writeFileIn(old, "[Unit]\nDescription=Remote Pi daemon supervisor\n");
    const sys = fakeSystem("linux");

    const result = installService(renderVars(), sys.deps);

    expect(sys.events).toEqual([
      "systemctl --user disable --now remote-pi-supervisord.service",
      "systemctl --user daemon-reload",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now remote-omp-supervisord.service",
    ]);
    expect(existsSync(old)).toBe(false);
    expect(result.legacyRemoved).toEqual(["systemd unit remote-pi-supervisord.service"]);
    expect(result.unitPath).toBe(systemdUnitPath(home));
    const unit = readFileSync(result.unitPath, "utf8");
    expect(unit).toContain(`ExecStart="${NODE}" "${supervisor}"`);
    expect(unit).toContain("Description=Remote OMP daemon supervisor");
  });

  test("linux on a clean machine: only the new unit is written and enabled", () => {
    const sys = fakeSystem("linux");

    const result = installService(renderVars(), sys.deps);

    expect(sys.events).toEqual(["systemctl --user daemon-reload", `systemctl --user enable --now ${SYSTEMD_UNIT}`]);
    expect(result.legacyRemoved).toEqual([]);
    expect(existsSync(systemdUnitPath(home))).toBe(true);
  });

  test("a missing supervisor script fails before anything is touched: the old service keeps running", () => {
    const old = legacySystemdUnitPath(home);
    writeFileIn(old, "[Unit]\n");
    rmSync(supervisor);
    const sys = fakeSystem("linux");

    expect(() => installService(renderVars(), sys.deps)).toThrow(/supervisor script not found/);
    expect(sys.events).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  test("macos: the old job is booted out before the new plist is bootstrapped", () => {
    const oldPlist = legacyLaunchdPlistPath(home);
    writeFileIn(oldPlist, "<plist/>");
    const sys = fakeSystem("macos");

    const result = installService(renderVars(), sys.deps);

    const plist = launchdPlistPath(home);
    expect(sys.events).toEqual([
      "launchctl bootout gui/501/dev.remotepi.supervisord",
      `launchctl bootout gui/501 ${plist}`,
      `launchctl unload ${plist}`,
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
    expect(existsSync(oldPlist)).toBe(false);
    expect(result.legacyRemoved).toEqual(["launchd job dev.remotepi.supervisord"]);
    expect(readFileSync(plist, "utf8")).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });

  test("windows: the old task is deleted first, then RemoteOmpSupervisor is registered from UTF-16 XML in the new data dir", () => {
    const sys = fakeSystem("windows", { legacyTask: true });

    const result = installService(renderVars(), sys.deps);

    const xml = taskXmlPath();
    expect(xml).toBe(join(home, ".omp", "remote", "RemoteOmpSupervisor.xml"));
    expect(sys.events).toEqual([
      "schtasks /Query /TN RemotePiSupervisor",
      "schtasks /End /TN RemotePiSupervisor",
      "elevated: schtasks /Delete /TN RemotePiSupervisor /F",
      "elevated: exit /b 0",
      "schtasks /Query /TN RemotePiSupervisor",
      "schtasks /End /TN RemoteOmpSupervisor",
      `elevated: schtasks /Create /XML "${xml}" /TN RemoteOmpSupervisor /F`,
      "schtasks /Run /TN RemoteOmpSupervisor",
    ]);
    expect(result.legacyRemoved).toEqual(["scheduled task RemotePiSupervisor"]);

    const bytes = readFileSync(xml);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]); // UTF-16LE BOM, as schtasks /XML requires
    const text = bytes.subarray(2).toString("utf16le");
    expect(text).toContain("Remote OMP daemon supervisor");
    expect(text).toContain(vbsLauncherPath());
    const launcher = readFileSync(vbsLauncherPath(), "utf8");
    expect(launcher).toContain(supervisor);
    expect(launcher).toContain(supervisordLogPath());
  });

  test("windows on a clean machine: no deletion, no UAC prompt but the one for /Create", () => {
    const sys = fakeSystem("windows");

    installService(renderVars(), sys.deps);

    expect(sys.events.filter((line) => line.startsWith("elevated:"))).toEqual([
      `elevated: schtasks /Create /XML "${taskXmlPath()}" /TN RemoteOmpSupervisor /F`,
    ]);
  });
});

describe("uninstallService (injected system)", () => {
  test("linux: removes the current unit and the old one", () => {
    const current = systemdUnitPath(home);
    const old = legacySystemdUnitPath(home);
    writeFileIn(current, "[Unit]\n");
    writeFileIn(old, "[Unit]\n");
    const sys = fakeSystem("linux");

    const result = uninstallService(sys.deps);

    expect(sys.events).toEqual([
      "systemctl --user disable --now remote-omp-supervisord.service",
      "systemctl --user daemon-reload",
      "systemctl --user disable --now remote-pi-supervisord.service",
      "systemctl --user daemon-reload",
    ]);
    expect(result).toMatchObject({
      platform: "linux",
      unitPath: current,
      removed: true,
      legacyRemoved: ["systemd unit remote-pi-supervisord.service"],
    });
    expect(existsSync(current)).toBe(false);
    expect(existsSync(old)).toBe(false);
  });

  test("linux with nothing of the old install: no extra command", () => {
    writeFileIn(systemdUnitPath(home), "[Unit]\n");
    const sys = fakeSystem("linux");

    const result = uninstallService(sys.deps);

    expect(sys.events).toEqual([
      "systemctl --user disable --now remote-omp-supervisord.service",
      "systemctl --user daemon-reload",
    ]);
    expect(result.legacyRemoved).toEqual([]);
  });

  test("macos: boots out and deletes both plists", () => {
    const current = launchdPlistPath(home);
    const old = legacyLaunchdPlistPath(home);
    writeFileIn(current, "<plist/>");
    writeFileIn(old, "<plist/>");
    const sys = fakeSystem("macos");

    const result = uninstallService(sys.deps);

    expect(sys.events).toEqual([
      `launchctl bootout gui/501 ${current}`,
      `launchctl unload ${current}`,
      "launchctl bootout gui/501/dev.remotepi.supervisord",
    ]);
    expect(existsSync(current)).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(result.legacyRemoved).toEqual(["launchd job dev.remotepi.supervisord"]);
  });

  test("windows: deletes both tasks and the generated xml/vbs, but not the old data directory's copies", () => {
    writeFileIn(taskXmlPath(), "<Task/>");
    writeFileIn(vbsLauncherPath(), "WScript.Quit 0");
    const oldData = legacyRemotePiHome();
    writeFileIn(join(oldData, "RemotePiSupervisor.xml"), "<Task/>");
    const sys = fakeSystem("windows", { legacyTask: true });

    const result = uninstallService(sys.deps);

    expect(sys.events).toEqual([
      "schtasks /End /TN RemoteOmpSupervisor",
      "elevated: schtasks /Delete /TN RemoteOmpSupervisor /F",
      "elevated: exit /b 0",
      "schtasks /Query /TN RemotePiSupervisor",
      "schtasks /End /TN RemotePiSupervisor",
      "elevated: schtasks /Delete /TN RemotePiSupervisor /F",
      "elevated: exit /b 0",
      "schtasks /Query /TN RemotePiSupervisor",
    ]);
    expect(result.legacyRemoved).toEqual(["scheduled task RemotePiSupervisor"]);
    expect(existsSync(taskXmlPath())).toBe(false);
    expect(existsSync(vbsLauncherPath())).toBe(false);
    expect(existsSync(join(oldData, "RemotePiSupervisor.xml"))).toBe(true);
  });
});
