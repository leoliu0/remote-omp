/**
 * Admission of a phone prompt by omp.
 *
 * On omp `pi.sendUserMessage(text)` returns the promise of `session.prompt()`.
 * Sent to an idle session it settles only when the WHOLE RUN has ended, so the
 * extension cannot wait for it before echoing the prompt to the phone: the
 * app drops the optimistic bubble after 20 s without an echo, and the answer of
 * a long run would arrive before the question it answers.
 *
 * omp has no admission callback for extensions (`SendUserMessageOptions` is
 * `{deliverAs, attribution}`), but it announces the moment it takes a prompt:
 * `message_start { message: { role: "user" } }` (agent-loop `emitInputMessages`).
 * A wait registered before the hand-over resolves on the first such event whose
 * text matches, or when {@link PROMPT_ADMISSION_CEILING_MS} has passed (prompt
 * setup can take long: maintenance, auto-thinking, a vision description).
 */

/** Longest a prompt stays unechoed while omp has not reported it started. */
export const PROMPT_ADMISSION_CEILING_MS = 1_500;

interface Wait {
  /** Prompt text, trimmed: omp may re-wrap the text, never re-spell it. */
  readonly text: string;
  admit(): void;
}

export interface PromptAdmissionWait {
  /** Settles `true` when omp reported the prompt started, `false` at the ceiling. Never rejects. */
  readonly admitted: Promise<boolean>;
  /** Drop the wait (the hand-over settled or failed first). Idempotent. */
  cancel(): void;
}

export class PromptAdmissions {
  private readonly _waits = new Set<Wait>();

  /** Waits not yet admitted, cancelled or timed out. */
  get pending(): number {
    return this._waits.size;
  }

  /** Register a wait for `text`. Call BEFORE handing the prompt to the host. */
  expect(text: string, ceilingMs: number = PROMPT_ADMISSION_CEILING_MS): PromptAdmissionWait {
    let settle!: (admitted: boolean) => void;
    // Executor form: `Promise.withResolvers` needs lib es2024; this package targets Node 20.
    const admitted = new Promise<boolean>((resolve) => { settle = resolve; });
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: boolean): void => {
      if (!this._waits.delete(wait)) return;
      clearTimeout(timer);
      settle(value);
    };
    const wait: Wait = { text: text.trim(), admit: () => finish(true) };
    this._waits.add(wait);
    timer = setTimeout(() => finish(false), ceilingMs);
    // Never keep a process alive (or a test hanging) for an echo ceiling.
    timer.unref();
    return { admitted, cancel: () => finish(false) };
  }

  /**
   * omp started a user prompt with this text. Releases the oldest matching wait
   * only: two identical prompts in flight are admitted one `message_start` each.
   */
  noteStarted(text: string): void {
    const key = text.trim();
    for (const wait of this._waits) {
      if (wait.text === key) {
        wait.admit();
        return;
      }
    }
  }
}
