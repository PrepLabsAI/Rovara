// `rovara test-env`: a project's test environment on this computer. `show` reads what is approved and what waits; `propose` sends an environment (a JSON file) to be proved and approved; `open` has the running
// `rovara up` open the project's page, where the owner approves. Approving is never done from here: it is the owner's own act on the page, with a proof the page signs for exactly one request.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { agentXError } from "@agentx/contracts";
import type { Command } from "commander";
import type { UpCommandContext } from "./cli.js";
import { requireLocalRuntime } from "./local-runtime.js";

const PROJECT = /^[A-Za-z0-9._-]{1,100}$/u;
const MAX_FILE_BYTES = 400_000;

interface Reply { status: number; body: Record<string, unknown> }

async function call(context: Pick<UpCommandContext, "home" | "fetch">, stateDir: string | undefined, method: string, path: string, body?: unknown): Promise<Reply> {
  const { url, secret } = await requireLocalRuntime(context.home ?? homedir(), stateDir);
  let response: Response;
  try {
    response = await context.fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is not answering at its address. Start it again with `rovara up`.");
  }
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

function failure(reply: Reply): never {
  const error = reply.body["error"] as { message?: unknown } | undefined;
  throw agentXError("CONFIG_INVALID", typeof error?.message === "string" ? error.message : `Rovara answered ${String(reply.status)}`);
}

function linesOf(state: Record<string, unknown>): string[] {
  const approved = state["approved"] as { revision: number; approvedAt: string; lines: string[] } | undefined;
  const proposal = state["proposal"] as { digest: string; risk: string; lessSafe: string[]; changes: string[]; proved: boolean } | undefined;
  const out: string[] = [];
  out.push(approved === undefined ? "Approved: none (tasks run the project's own checks)." : `Approved: revision ${String(approved.revision)} (${approved.approvedAt})`);
  for (const line of approved?.lines ?? []) out.push(`  ${line}`);
  if (proposal === undefined) out.push("Waiting for approval: nothing.");
  else {
    out.push(`Waiting for approval: ${proposal.digest.slice(0, 12)}, risk ${proposal.risk}, Prove run ${proposal.proved ? "passed" : "not passed"}.`);
    if (proposal.lessSafe.length > 0) out.push(`  Less safe than the approved revision: ${proposal.lessSafe.join(", ")}`);
    for (const line of proposal.changes) out.push(`  ${line}`);
    out.push(proposal.proved ? "  Approve it on its page: rovara test-env open <project>" : "  It cannot be approved until a Prove run passes for exactly this proposal.");
  }
  return out;
}

export function registerTestEnvCommand(program: Command, context: Pick<UpCommandContext, "home" | "stdout" | "fetch">): void {
  const command = program.command("test-env").description("a project's test environment on this computer (`rovara up` must be running)");
  const checkProject = (project: string): void => { if (!PROJECT.test(project)) throw agentXError("CONFIG_INVALID", "name a project by its exact name"); };

  command.command("show <project>").description("what is approved for the project, and the proposal that waits")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (project: string, options: { stateDir?: string }, cmd: Command) => {
      checkProject(project);
      const globals = cmd.optsWithGlobals<{ json: boolean }>();
      const reply = await call(context, options.stateDir, "GET", `/v1/app/projects/${encodeURIComponent(project)}/test-environment`);
      if (reply.status !== 200) failure(reply);
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: reply.body })}\n` : `${linesOf(reply.body).join("\n")}\n`);
    });

  command.command("propose <project> <file>").description("send a test environment (a JSON file) to be proved and approved; nothing changes until it is approved")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (project: string, file: string, options: { stateDir?: string }, cmd: Command) => {
      checkProject(project);
      const globals = cmd.optsWithGlobals<{ json: boolean }>();
      const text = await readFile(file, "utf8").catch(() => { throw agentXError("CONFIG_INVALID", "the file could not be read"); });
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw agentXError("CONFIG_INVALID", "the file is too large to be a test environment");
      let environment: unknown;
      try { environment = JSON.parse(text); } catch { throw agentXError("CONFIG_INVALID", "the file is not JSON"); }
      const reply = await call(context, options.stateDir, "POST", `/v1/app/projects/${encodeURIComponent(project)}/test-environment/propose`, { environment });
      if (reply.status !== 200) failure(reply);
      const proposal = reply.body["proposal"] as { digest: string; risk: string; lessSafe: string[] };
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: reply.body })}\n`
        : `Proposed ${proposal.digest.slice(0, 12)}: risk ${proposal.risk}${proposal.lessSafe.length === 0 ? "" : `, less safe: ${proposal.lessSafe.join(", ")}`}.\nIt is approved on its page after a Prove run passes: rovara test-env open ${project}\n`);
    });

  command.command("open <project>").description("open the project's test environment page in your browser, where you approve a change")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (project: string, options: { stateDir?: string }, cmd: Command) => {
      checkProject(project);
      const globals = cmd.optsWithGlobals<{ json: boolean }>();
      const reply = await call(context, options.stateDir, "POST", `/v1/app/projects/${encodeURIComponent(project)}/test-environment/open`, {});
      if (reply.status !== 200 || reply.body["opened"] !== true) failure(reply);
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { opened: true } })}\n` : "Opened in your browser.\n");
    });
}
