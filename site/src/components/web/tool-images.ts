// Pictures a tool returned. The extension sends each image block of a tool
// result (e.g. `read` of a png) inside the result text as
// `![image](data:image/…;base64,…)`. Mirrors the phone app
// (app/lib/ui/chat/widgets/tool_request_card.dart `toolResultImages`, and
// chat_page.dart for the display modes): the card shows the text without that
// markdown plus the pictures, a failed tool shows none, and a tool that
// returned pictures stays visible in every display mode — hidden mode shows
// only the pictures.

export type ToolDisplay = "brief" | "full" | "hidden";

/** The fields of a tool row these helpers read (web-client.ts `ToolCallData`). */
export interface ToolImageSource {
  output?: string;
  status: "pending" | "done" | "error";
}

// Raster base64 only, the same set the markdown renderer allows (markdown-url.ts).
const RESULT_IMAGE = /!\[[^\]\n]*\]\((data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)\)/gi;

/** Data URIs of the pictures a tool returned; empty when it returned none or failed. */
export function toolResultImages(tool: ToolImageSource): string[] {
  if (tool.status === "error" || typeof tool.output !== "string") return [];
  return Array.from(tool.output.matchAll(RESULT_IMAGE), (m) => m[1]);
}

/**
 * The output text with the pictures' markdown removed (also from a failed
 * tool's error, which shows no pictures, as on the phone); unset while running.
 */
export function toolResultText(tool: ToolImageSource): string | undefined {
  if (tool.output === undefined) return undefined;
  const text = tool.output.replace(RESULT_IMAGE, "");
  return text === tool.output ? text : text.trim();
}

/** Tools the brief mode leaves out of the timeline (unless they returned a picture). */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "find",
  "ls",
  "view",
  "cat",
  "head",
  "tail",
  "web_search",
  "google_web_search",
  "mcp__read",
  "mcp__grep",
  "mcp__glob",
  "mcp__gemini_search_google_web_search",
]);

/** How a tool row renders: its card (pill or full), only its pictures, or nothing. */
export function toolRowView(
  tool: ToolImageSource & { tool: string },
  display: ToolDisplay,
): "card" | "images" | null {
  const hasImages = toolResultImages(tool).length > 0;
  if (display === "hidden") return hasImages ? "images" : null;
  if (display === "brief" && !hasImages && READ_ONLY_TOOLS.has(tool.tool.toLowerCase())) return null;
  return "card";
}
