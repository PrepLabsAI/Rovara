// rovara loop (#355): what a comment asks for. Only a comment whose first line starts with `/rovara` is a
// command; anything else from a collaborator is a reply to the loop running on that issue.
import { LOOPS, type LoopDefinition } from "./definitions.js";

export type ParsedComment =
  | { kind: "start"; loop: LoopDefinition; instruction: string }
  | { kind: "stop" }
  | { kind: "approve" }
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
  if (keyword === "approve") return { kind: "approve" };
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
  // The instruction is the rest of the first line, and every line after it.
  const instruction = [match[2] ?? "", text.slice(match[0].length)].join("").trim();
  if (instruction === "") return { kind: "invalid", reason: `Say what to do after \`/rovara ${loop.keyword}\`, for example \`/rovara ${loop.keyword} fix the flaky retry test\`.` };
  return { kind: "start", loop, instruction };
}
