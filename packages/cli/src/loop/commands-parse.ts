// rovara loop (#355): what a comment asks for. Only a comment whose first line starts with `/rovara` is a
// command; anything else from a collaborator is a reply to the loop running on that issue.
import { LOOPS, type LoopDefinition } from "./definitions.js";

export type ParsedComment =
  | { kind: "start"; loop: LoopDefinition; instruction: string }
  | { kind: "stop" }
  | { kind: "invalid"; reason: string }
  | { kind: "reply"; text: string };

const COMMAND = /^\/rovara(?:\s+(\S+))?([^\n]*)/u;

export function parseComment(body: string): ParsedComment {
  const text = body.replace(/\r\n/gu, "\n").trim();
  const match = COMMAND.exec(text);
  if (match === null) return { kind: "reply", text };
  const keyword = (match[1] ?? "").toLowerCase();
  if (keyword === "stop") return { kind: "stop" };
  const loop = LOOPS.find((candidate) => candidate.keyword === keyword);
  if (loop === undefined) {
    return { kind: "invalid", reason: `\`/rovara ${keyword || "…"}\` is not a command I know. Start a loop with ${LOOPS.map((candidate) => `\`/rovara ${candidate.keyword} <instruction>\``).join(", ")}, or end one with \`/rovara stop\`.` };
  }
  // The instruction is the rest of the first line, and every line after it.
  const instruction = [match[2] ?? "", text.slice(match[0].length)].join("").trim();
  if (instruction === "") return { kind: "invalid", reason: `Say what to do after \`/rovara ${loop.keyword}\`, for example \`/rovara ${loop.keyword} fix the flaky retry test\`.` };
  return { kind: "start", loop, instruction };
}
