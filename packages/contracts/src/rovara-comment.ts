// Lane L8: what a pull request or issue comment asks of Rovara. A comment is a command only when its first line starts with `/rovara`; anything else
// is a reply. This is the grammar the `rovara loop` has used since #355, moved here so the loop (which adds its own loop-starting keywords) and the
// broker's PR-comment commands (approve, changes, stop, lesson) read comments the same way. It is pure: it decides nothing and reads nothing.
//
// Who may give a command is not decided here. A command that approves or changes something is only as good as the proof behind it: the broker looks
// the comment up at the code host by id and checks its author's permission (the W0 `Approvers` seam, method `code-host-comment`).

export type RovaraComment =
  | { kind: "stop" }
  /** `/rovara approve` or `/rovara approve owner/name` (#358: one per-PR loop's blocked reviews, from the issue). */
  | { kind: "approve"; repo?: string; /** The first hex characters of the version being approved (`/rovara approve 3f2a9c`): the version the person read. */ digest?: string }
  | { kind: "changes"; text: string }
  /** `/rovara file 2,4`: file a Review loop's findings as issues (#359). */
  | { kind: "file"; numbers: number[] }
  /** `/rovara lesson 3 wrong`: say a lesson listed in the pull request's "Lessons used" did not apply (or did). */
  | { kind: "lesson"; number: number; verdict: "wrong" | "right" | "retire" }
  | { kind: "invalid"; reason: string }
  /** A `/rovara <keyword>` the grammar here does not own; the caller (the loop) reads it. `rest` is the rest of the first line, `tail` every line after it. */
  | { kind: "other"; keyword: string; rest: string; tail: string; text: string }
  | { kind: "reply"; text: string };

const COMMAND = /^\/rovara(?:\s+(\S+))?([^\n]*)/u;
const LESSON_VERDICTS: Readonly<Record<string, "wrong" | "right" | "retire">> = { wrong: "wrong", right: "right", useful: "right", retire: "retire" };

export function parseRovaraComment(body: string): RovaraComment {
  const text = body.replace(/\r\n/gu, "\n").trim();
  const match = COMMAND.exec(text);
  if (match === null) return { kind: "reply", text };
  const keyword = (match[1] ?? "").toLowerCase();
  if (keyword === "stop") return { kind: "stop" };
  if (keyword === "file") {
    const numbers = [...new Set((match[2] ?? "").split(/[\s,]+/u).filter((part) => part !== "").map(Number))];
    if (numbers.length === 0 || numbers.length > 20 || numbers.some((number) => !Number.isInteger(number) || number <= 0)) {
      return { kind: "invalid", reason: "Say which findings to file, by number: for example `/rovara file 2` or `/rovara file 2,4`." };
    }
    return { kind: "file", numbers };
  }
  if (keyword === "approve") {
    // `/rovara approve`, `/rovara approve <digest>`, `/rovara approve owner/name`, `/rovara approve owner/name <digest>` (the digest is 8 to 12 hex characters).
    const parts = /^(?:\s+`?([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})`?)?(?:\s+`?([0-9a-fA-F]{8,12})`?)?\s*$/u.exec(match[2] ?? "");
    if (parts === null) return { kind: "approve" };
    return { kind: "approve", ...(parts[1] === undefined ? {} : { repo: parts[1] }), ...(parts[2] === undefined ? {} : { digest: parts[2].toLowerCase() }) };
  }
  // `/rovara changes: <what>` (the colon is optional); the request is the rest of the comment.
  if (keyword === "changes" || keyword === "changes:") {
    const request = [match[2] ?? "", text.slice(match[0].length)].join("").replace(/^\s*:/u, "").trim();
    if (request === "") return { kind: "invalid", reason: "Say what to change after `/rovara changes:`, for example `/rovara changes: keep the old API too`." };
    return { kind: "changes", text: request };
  }
  if (keyword === "lesson") {
    const parts = /^\s+#?([1-9][0-9]{0,2})\s+([A-Za-z]+)\s*$/u.exec(match[2] ?? "");
    const verdict = parts === null ? undefined : LESSON_VERDICTS[(parts[2] ?? "").toLowerCase()];
    if (parts === null || verdict === undefined) return { kind: "invalid", reason: "Say which lesson and what you think of it: for example `/rovara lesson 3 wrong`, `/rovara lesson 3 right` or `/rovara lesson 3 retire`." };
    return { kind: "lesson", number: Number(parts[1]), verdict };
  }
  return { kind: "other", keyword, rest: match[2] ?? "", tail: text.slice(match[0].length), text };
}
