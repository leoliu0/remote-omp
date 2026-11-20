/**
 * What an extension takes from the omp process it runs in, beyond the
 * `ExtensionAPI` it is handed (`omp-api.ts`).
 *
 *  - `hostTui()`: omp's own TUI classes, to draw the received-photo message in
 *    the terminal. Inside omp `@oh-my-pi/pi-tui` resolves to the host's bundled
 *    instance (the same mapping `actions/model_roles.ts` relies on for omp's
 *    config modules), which is also what a `Component` handed back to omp has
 *    to be built from. Outside omp the import fails and `hostTui()` is
 *    `undefined`: nothing is drawn by us and omp's default renderer shows the
 *    message.
 *  - `convertToPng()`: a phone photo as PNG, for the terminal preview. omp runs
 *    on Bun, whose `Bun.Image` is what omp's own conversion calls; without Bun
 *    there is no preview.
 */

import type { Component } from "./omp-api.js";

/** A node that holds children (omp's `Container`, `Box`). */
export interface HostContainer extends Component {
  addChild(child: Component): void;
}

/** The four pi-tui classes the received-photo renderer composes. */
export interface HostTui {
  Box: new (paddingX: number, paddingY: number, bgFn?: (text: string) => string) => HostContainer;
  Container: new () => HostContainer;
  Image: new (base64Data: string, mimeType: string, theme: { fallbackColor: (text: string) => string }) => Component;
  Text: new (text: string) => Component;
}

async function loadHostTui(): Promise<HostTui | undefined> {
  try {
    // Dynamic: the module exists only inside omp, so a static import would break every other host (CLI, supervisor, tests).
    const { Box, Container, Image, Text } = await import("@oh-my-pi/pi-tui");
    if ([Box, Container, Image, Text].every((cls) => typeof cls === "function")) {
      return { Box, Container, Image, Text } as HostTui;
    }
  } catch {
    // not inside omp
  }
  return undefined;
}

// Loaded once, before the extension factory runs: a message renderer is synchronous.
const _tui = await loadHostTui();

/** omp's TUI classes; undefined when this process is not omp. */
export function hostTui(): HostTui | undefined {
  return _tui;
}

/** The slice of Bun's image API used for the conversion. */
interface BunImageCtor {
  new (bytes: Uint8Array): { png(): { toBase64(): Promise<string> } };
}

/**
 * Re-encodes an image as PNG. Resolves `null` when it cannot (no Bun, or bytes
 * the decoder rejects); a PNG comes back unchanged.
 */
export async function convertToPng(
  base64Data: string,
  mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
  if (mimeType === "image/png") return { data: base64Data, mimeType };
  const BunImage = (globalThis as { Bun?: { Image?: BunImageCtor } }).Bun?.Image;
  if (!BunImage) return null;
  try {
    const data = await new BunImage(Buffer.from(base64Data, "base64")).png().toBase64();
    return { data, mimeType: "image/png" };
  } catch {
    return null;
  }
}
