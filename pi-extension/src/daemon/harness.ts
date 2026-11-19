/**
 * Coding-agent CLIs the supervisor can run as a daemon (plan 67). They speak
 * the same RPC wire protocol but take different command-line flags — see
 * `rpcSpawnArgs` — so a daemon records which one it runs.
 */
export type Harness = "pi" | "omp";

export function isHarness(v: unknown): v is Harness {
  return v === "pi" || v === "omp";
}

/**
 * The harness whose process is running this code, read from its entry script
 * (`process.argv[1]`): the launcher name (`…/bin/omp`) or the package path
 * (`…/@oh-my-pi/pi-coding-agent/dist/cli.js`). Undefined for anything else,
 * e.g. the standalone `remote-pi` CLI.
 */
export function harnessFromArgv(argv1: string | undefined): Harness | undefined {
  if (!argv1) return undefined;
  const path = argv1.replace(/\\/g, "/");
  const launcher = path.slice(path.lastIndexOf("/") + 1).replace(/\.(cmd|exe|[cm]?js)$/i, "");
  // omp first: its package is also named `pi-coding-agent`.
  if (launcher === "omp" || path.includes("/@oh-my-pi/")) return "omp";
  if (launcher === "pi" || path.includes("/pi-coding-agent/")) return "pi";
  return undefined;
}

/**
 * Which harness a new daemon runs: the explicit `--harness` flag, else
 * `REMOTE_PI_HARNESS` (the supervisor exports it to every daemon, so a daemon
 * creating another one keeps its own harness), else the harness running the
 * command, else `pi`. An unknown flag throws; an unknown env value is ignored.
 */
export function resolveHarness(o: { flag?: string; env?: string; argv1?: string }): Harness {
  if (o.flag !== undefined) {
    if (!isHarness(o.flag)) throw new Error(`unknown harness "${o.flag}" (expected pi or omp)`);
    return o.flag;
  }
  if (isHarness(o.env)) return o.env;
  return harnessFromArgv(o.argv1) ?? "pi";
}
