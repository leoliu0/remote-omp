declare module "qrcode-terminal" {
  interface QROptions {
    small?: boolean;
  }
  function generate(
    input: string,
    opts: QROptions,
    callback?: (qrcode: string) => void,
  ): void;
  function generate(input: string, callback?: (qrcode: string) => void): void;
  function setErrorLevel(level: "L" | "M" | "Q" | "H"): void;
  export = { generate, setErrorLevel };
}

// Plan/66 — omp's own modules. Inside omp these resolve to the host's bundled
// instances (omp's extension loader maps `@oh-my-pi/pi-coding-agent/*`), so
// `settings` is omp's live singleton. Outside omp they don't resolve at all.
// Typed as `unknown`; `src/actions/model_roles.ts` narrows them at runtime.
declare module "@oh-my-pi/pi-coding-agent/config/settings" {
  export const settings: unknown;
  export const isSettingsInitialized: unknown;
}
declare module "@oh-my-pi/pi-coding-agent/config/model-roles" {
  export const getKnownRoleIds: unknown;
  export const getRoleInfo: unknown;
  export const roleCandidatePool: unknown;
}
declare module "@oh-my-pi/pi-coding-agent/config/model-resolver" {
  export const resolveModelRoleValue: unknown;
}
