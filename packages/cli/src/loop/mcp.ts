// rovara loop (#355): the agent's tools, served over stdio to the one session the loop started for one issue.
// `loop_complete` leaves a claim in the item's inbox and waits for the daemon's verdict: the agent claims a step
// done, and the loop decides.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VerdictSchema } from "./daemon.js";
import { loopNamed, stepOf } from "./definitions.js";
import { SUMMARY_MAX } from "./runtime.js";
import type { LoopStore } from "./state.js";

export interface LoopMcpOptions {
  store: LoopStore;
  repo: string;
  issue: number;
  version: string;
  /** How long loop_complete waits for the daemon; the daemon answers within seconds when it runs. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) });

export function createLoopMcpServer(options: LoopMcpOptions): McpServer {
  const server = new McpServer({ name: "rovara-loop", version: options.version });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  server.registerTool("loop_status", {
    title: "Where this issue's loop stands",
    description: "The loop running on this issue, its current step, and who acts next.",
    inputSchema: {},
  }, async () => {
    const state = await options.store.item(options.repo, options.issue);
    if (state === undefined) return text(`No loop is running on ${options.repo}#${options.issue}.`);
    const step = stepOf(loopNamed(state.loop), state.step);
    const turn = step.terminal ? "The loop has ended."
      : step.actor === "agent" ? "It is your turn: work, then call loop_complete with a summary."
      : step.actor === "code" ? `The loop is running this step itself (${step.action ?? "its own work"}): wait.`
      : step.gate ? `It is waiting for a person to approve the ${step.artifact ?? "document"}, or ask for changes: wait.` : "It is the person's turn: wait for their reply.";
    return text([`Loop ${state.loop} on ${state.repo}#${state.issue}, step ${state.step}. ${turn}`, "", `Instruction from @${state.startedBy}:`, state.instruction].join("\n"));
  });

  server.registerTool("loop_complete", {
    title: "Claim this step done",
    description: `Say you have finished this step, with a summary of what you did and anything you need from the person (at most ${SUMMARY_MAX} characters). The summary is posted on the issue. The loop checks the claim and answers whether it was accepted.`,
    inputSchema: { summary: z.string().describe("What you did, and anything you need from the person. Posted on the issue.") },
  }, async ({ summary }) => {
    const claimId = randomUUID();
    const inbox = options.store.inboxDir(options.repo, options.issue);
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    await writeFile(join(inbox, `claim-${claimId}.json`), JSON.stringify({ claimId, summary }), { mode: 0o600 });
    const verdictPath = join(inbox, `verdict-${claimId}.json`);
    const deadline = Date.now() + (options.waitMs ?? 60_000);
    while (Date.now() < deadline) {
      const raw = await readFile(verdictPath, "utf8").catch(() => undefined);
      if (raw !== undefined) {
        await rm(verdictPath, { force: true });
        const verdict = VerdictSchema.parse(JSON.parse(raw));
        return verdict.outcome === "pass" ? text(`Accepted: ${verdict.reason}`) : text(`Not accepted: ${verdict.reason}`, true);
      }
      await sleep(options.pollMs ?? 500);
    }
    await rm(join(inbox, `claim-${claimId}.json`), { force: true });
    return text("The rovara loop daemon did not answer. Ask the person to check it with `rovara loop status`, then call loop_complete again.", true);
  });
  return server;
}
