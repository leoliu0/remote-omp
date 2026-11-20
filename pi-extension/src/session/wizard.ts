import { listSessions, sessionHasSock } from "./global_config.js";

/**
 * Minimal wizard for `/remote-omp join` with no argument.
 *
 * The omp `ExtensionUIContext.select` accepts a title and string options
 * and returns the chosen option. Wizard offers existing sessions + an "explicit
 * create" sentinel. If user picks the sentinel, prompts for a fresh name via
 * `select`-with-option-other (omp's "Other" escape hatch). Returns the picked
 * session name, or null if user cancelled.
 */
export interface WizardUI {
  select(title: string, options: string[]): Promise<string | undefined>;
}

const CREATE_SENTINEL = "━━━ Create new session ━━━";

export async function joinWizard(
  ui: WizardUI,
  defaultName: string,
): Promise<string | null> {
  const sessions = listSessions();
  const liveSessions = sessions.filter(sessionHasSock);
  const options = [...liveSessions, CREATE_SENTINEL];
  const picked = await ui.select(
    liveSessions.length
      ? "Choose a session to join, or create a new one"
      : "No active sessions. Create one?",
    options,
  );
  if (!picked) return null;
  if (picked === CREATE_SENTINEL) {
    // Caller is expected to follow up with a name prompt via ctx.ui.select
    // (the omp input dialog). For non-interactive contexts we return the
    // default name.
    return defaultName;
  }
  return picked;
}
