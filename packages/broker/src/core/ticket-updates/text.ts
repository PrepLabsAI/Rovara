// The words a ticket is written with: a title made inert, and a link made only when it is a plain https address. Shared by the one-shot comments (`handler.ts`) and the ticket thread (`thread.ts`).
export const TITLE_MAX = 120;

/** A title made safe to post: no controls, no mention or markup characters (nobody is pinged, nothing becomes a link), one line, cut. */
export function inertTicketTitle(title: string): string {
  const plain = title.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/:\/\//gu, ": ").replace(/[@<>[\]()`*_~#|!]/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...plain].slice(0, TITLE_MAX).join("").trimEnd();
  return cut === "" ? "(no title)" : cut;
}

/** A pull request's address when it is a plain https address (no sign-in data), else nothing: only an address Rovara can vouch for is put in a ticket. */
export function plainHttpsLink(link: string): string | undefined {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}


/** A line of free words (a question, an answer, a plan line) made safe to post: the title's rules (no controls, no mention or markup characters, nothing becomes a link), one line, cut at `max` characters. Empty stays empty. */
export function inertTicketLine(text: string, max: number): string {
  const plain = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/:\/\//gu, ": ").replace(/[@<>[\]()`*_~#|!]/gu, " ").replace(/\s+/gu, " ").trim();
  return [...plain].slice(0, max).join("").trimEnd();
}
