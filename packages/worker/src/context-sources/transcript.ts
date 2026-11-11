// E3: the saved transcript of a stage that used sources holds stubs, never the sources' text (design 3.6, "Where results go").
//
// Pi appends each tool result to the session file as it happens. When a prompt has finished and the session is idle, the results of the context tools are
// rewritten in place: the content becomes `[Tracker ABC-123 · 2.1 KB · see Sources]` and the details are dropped. The live session keeps what the model read
// in memory for the rest of the turn; a session opened again from the file (a resume) reads the stubs.
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isContextToolName, stubFor, stubSourceFrames } from "./frame.js";

interface Entry { type?: unknown; summary?: unknown; message?: { role?: unknown; toolName?: unknown; content?: unknown; details?: unknown; structuredContent?: unknown } }

function textOf(content: unknown): string {
  return Array.isArray(content) ? content.map((block) => (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("\n") : "";
}

/** Rewrites the context tools' results in a session file as stubs. Returns how many results were replaced. A file that cannot be read is left alone. */
export async function stubPersistedContextResults(sessionFile: string): Promise<number> {
  let raw: string;
  try { raw = await readFile(sessionFile, "utf8"); } catch { return 0; }
  let replaced = 0;
  const lines = raw.split("\n").map((line) => {
    if (line.trim() === "" || !(line.includes("toolResult") || line.includes("compaction"))) return line;
    let entry: Entry;
    try { entry = JSON.parse(line) as Entry; } catch { return line; }
    // A conversation summary (a `compaction` entry) is not a tool result, but a frame in it is a source's text all the same (compaction.ts keeps it out; this is the file's own check).
    if (entry.type === "compaction") {
      if (typeof entry.summary !== "string") return line;
      const stubbed = stubSourceFrames(entry.summary);
      if (stubbed === entry.summary) return line;
      replaced += 1;
      return JSON.stringify({ ...entry, summary: stubbed });
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (message === undefined || message.role !== "toolResult" || !isContextToolName(message.toolName)) return line;
    const text = textOf(message.content);
    // Only a source's text is replaced. A fixed sentence of Rovara's own ("SIM is unavailable") is not a source's words and stays readable.
    if (!text.includes("<source-result ")) return line;
    replaced += 1;
    const next = { ...entry, message: { ...message, content: [{ type: "text", text: stubFor(text) }] } };
    delete next.message.details;
    // An MCP tool's result keeps the whole answer in its structured content too (Pi's rovara server tools).
    delete next.message.structuredContent;
    return JSON.stringify(next);
  });
  if (replaced === 0) return 0;
  const temporary = `${sessionFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, sessionFile);
  return replaced;
}
