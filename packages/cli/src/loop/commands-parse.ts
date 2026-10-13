// rovara loop (#355): what a comment asks for. Only a comment whose first line starts with `/rovara` is a
// command; anything else from a collaborator is a reply to the loop running on that issue.
import { LOOPS, skippablePhases, type LoopDefinition } from "./definitions.js";

export type ParsedComment =
  | { kind: "start"; loop: LoopDefinition; instruction: string; /** Phases declared away (`--skip design`). */ skip: string[] }
  | { kind: "stop" }
  | { kind: "approve"; /** #358: `/rovara approve owner/name`: one per-PR loop's blocked reviews, from the issue. */ repo?: string }
  | { kind: "changes"; text: string }
  | { kind: "invalid"; reason: string }
  | { kind: "reply"; text: string };

const COMMAND = /^\/rovara(?:\s+(\S+))?([^\n]*)/u;

export function parseComment(body: string): ParsedComment {
  const text = body.replace(/\r\n/gu, "\n").trim();
  const match = COMMAND.exec(text);
  if (match === null) return { kind: "reply", text };
  const keyword = (match[1] ?? "").toLowerCase();
  if (keyword === "stop") return { kind: "stop" };
  if (keyword === "approve") {
    const repo = /^\s+`?([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})`?\s*$/u.exec(match[2] ?? "")?.[1];
    return repo === undefined ? { kind: "approve" } : { kind: "approve", repo };
  }
  // `/rovara changes: <what>` (the colon is optional); the request is the rest of the comment.
  if (keyword === "changes" || keyword === "changes:") {
    const request = [match[2] ?? "", text.slice(match[0].length)].join("").replace(/^\s*:/u, "").trim();
    if (request === "") return { kind: "invalid", reason: "Say what to change after `/rovara changes:`, for example `/rovara changes: keep the old API too`." };
    return { kind: "changes", text: request };
  }
  const loop = LOOPS.find((candidate) => candidate.keyword === keyword);
  if (loop === undefined) {
    return { kind: "invalid", reason: `\`/rovara ${keyword || "…"}\` is not a command I know. Start a loop with ${LOOPS.map((candidate) => `\`/rovara ${candidate.keyword} <instruction>\``).join(", ")}, answer a plan with \`/rovara approve\` or \`/rovara changes: …\`, or end a loop with \`/rovara stop\`.` };
  }
  // The instruction is the rest of the first line, and every line after it, after any `--skip <phase>[,<phase>]`.
  let instruction = [match[2] ?? "", text.slice(match[0].length)].join("").trim();
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
  if (instruction === "") return { kind: "invalid", reason: `Say what to do after \`/rovara ${loop.keyword}\`, for example \`/rovara ${loop.keyword} fix the flaky retry test\`.` };
  return { kind: "start", loop, instruction, skip: [...new Set(skip)] };
}
