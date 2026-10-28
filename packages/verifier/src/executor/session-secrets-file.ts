import { readFile, rm } from "node:fs/promises";
import type { CredentialRedactor } from "./redact.js";

/**
 * The file the executor child leaves for its parent, and the parent's last scan of the out directory (MIDSTEP-2 fix round 2).
 *
 * A credential is one JSON string per line, as it always was. An evidence-only value (a draft, a route, a cache id: scrubbed, never refused) is `{"v":"...","e":1}`, so the parent can tell
 * them apart: it scrubs both from the text it writes, but only a credential (or an account) in an output file ends the run `credential-leak`. A file that carries only an evidence-only value
 * is removed and logged: such a value can scrub or drop, never fail the run, however late it was learned (a trace written before the value was registered is the case).
 */
export function sessionSecretLine(value: string, evidenceOnly: boolean): string {
  return `${JSON.stringify(evidenceOnly ? { v: value, e: 1 } : value)}\n`;
}

export async function readSessionSecretFile(path: string): Promise<Array<{ value: string; evidenceOnly: boolean }>> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return []; }
  const out: Array<{ value: string; evidenceOnly: boolean }> = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "string") out.push({ value: parsed, evidenceOnly: false });
      else if (typeof parsed === "object" && parsed !== null && typeof (parsed as { v?: unknown }).v === "string") out.push({ value: (parsed as { v: string }).v, evidenceOnly: (parsed as { e?: unknown }).e === 1 });
    } catch { /* an unreadable line is skipped, as before */ }
  }
  return out;
}

export type OutputFileVerdict = "clean" | "credential" | "evidence-only";

/** What one output file carries: an account credential or a credential session value ("credential"), only an evidence-only value ("evidence-only"), or nothing. */
export function outputFileVerdict(redactor: CredentialRedactor, bytes: Uint8Array): OutputFileVerdict {
  if (redactor.contains(bytes, "model")) return "credential";
  return redactor.contains(bytes, "all") ? "evidence-only" : "clean";
}

/** The parent's scan of one output file: removes a file that carries anything registered, and says why in the log. The caller turns "credential" into `credential-leak`. */
export async function scanOutputFile(input: { file: string; outDir: string; redactor: CredentialRedactor; log: (line: string) => Promise<void> }): Promise<OutputFileVerdict> {
  const verdict = outputFileVerdict(input.redactor, await readFile(input.file));
  if (verdict === "clean") return verdict;
  await rm(input.file, { force: true });
  const name = input.file.slice(input.outDir.length + 1);
  await input.log(verdict === "credential" ? `removed an output file that carried an account credential or a session value: ${name}`
    : `removed an output file that carried a value only scrubbed from evidence (not a credential): ${name}`);
  return verdict;
}
