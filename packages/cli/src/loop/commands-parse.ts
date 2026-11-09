// rovara loop (#355): what a comment asks for. Only a comment whose first line starts with `/rovara` is a
// command; anything else from a collaborator is a reply to the loop running on that issue.
import { parseRovaraComment } from "@agentx/contracts";
import { LOOPS, skippablePhases, type LoopDefinition } from "./definitions.js";

export type ParsedComment =
  | { kind: "start"; loop: LoopDefinition; instruction: string; /** Phases declared away (`--skip design`). */ skip: string[] }
  | { kind: "stop" }
  | { kind: "approve"; /** #358: `/rovara approve owner/name`: one per-PR loop's blocked reviews, from the issue. */ repo?: string }
  | { kind: "changes"; text: string }
  /** #359: `/rovara file 2,4`: file a Review loop's findings as issues. */
  | { kind: "file"; numbers: number[] }
  | { kind: "invalid"; reason: string }
  | { kind: "reply"; text: string };

export function parseComment(body: string): ParsedComment {
  // The shared grammar (contracts/rovara-comment.ts) reads stop, file, approve and changes; the keywords below are the loop's own.
  const parsed = parseRovaraComment(body);
  switch (parsed.kind) {
    case "reply": case "stop": case "approve": case "changes": case "file": case "invalid": return parsed;
    case "lesson": return { kind: "invalid", reason: "`/rovara lesson …` answers a pull request's \"Lessons used\" list, which a loop does not post." };
    case "other": break;
  }
  const { keyword } = parsed;
  const loop = LOOPS.find((candidate) => candidate.keyword === keyword);
  if (loop === undefined) {
    return { kind: "invalid", reason: `\`/rovara ${keyword || "…"}\` is not a command I know. Start a loop with ${LOOPS.map((candidate) => `\`/rovara ${candidate.keyword} <instruction>\``).join(", ")}, answer a plan with \`/rovara approve\` or \`/rovara changes: …\`, or end a loop with \`/rovara stop\`.` };
  }
  // The instruction is the rest of the first line, and every line after it, after any `--skip <phase>[,<phase>]`.
  let instruction = [parsed.rest, parsed.tail].join("").trim();
  const skip: string[] = [];
  for (let flag = /^--skip(?:\s+|=)(\S+)\s*/u.exec(instruction); flag !== null; flag = /^--skip(?:\s+|=)(\S+)\s*/u.exec(instruction)) {
    skip.push(...(flag[1] ?? "").toLowerCase().split(",").filter((phase) => phase !== ""));
    instruction = instruction.slice(flag[0].length);
  }
  const allowed = skippablePhases(loop);
  const unknown = skip.filter((phase) => !allowed.includes(phase));
  if (unknown.length > 0) {
    return { kind: "invalid", reason: allowed.length === 0
      ? `The ${loop.name} loop has no phases to skip.`
      : `The ${loop.name} loop can skip ${allowed.map((phase) => `\`${phase}\``).join(" and ")}, not ${unknown.map((phase) => `\`${phase}\``).join(", ")}.` };
  }
  // A loop that asks for its brief (#359: Review) starts without one.
  if (instruction === "" && loop.brief === undefined) return { kind: "invalid", reason: `Say what to do after \`/rovara ${loop.keyword}\`, for example \`/rovara ${loop.keyword} fix the flaky retry test\`.` };
  return { kind: "start", loop, instruction, skip: [...new Set(skip)] };
}
