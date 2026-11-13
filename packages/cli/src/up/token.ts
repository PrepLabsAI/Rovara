// `rovara token list | create | revoke`, the owner's script tokens on the `rovara up` running here.
//
//  - `create` does not make a token itself: a token is a long-lived credential, so it is made on a local page the running `rovara up` opens in your browser (a fresh page session, one form, shown once).
//    The API login this command holds is the one an AI tool may hold too, so it is refused for making tokens. The page address carries the session and is never printed.
//  - `list` shows names, hints and states, never a secret. `revoke` ends a token at once.
import { ScriptTokenListReaderSchema, agentXError } from "@rovara-code/contracts";
import { homedir } from "node:os";
import type { Command } from "commander";
import type { TextWriter } from "../init/prompts.js";
import { terminalSafe } from "../session/app-request.js";
import { requireLocalRuntime } from "./local-runtime.js";

export interface TokenCommandContext {
  home?: string;
  stdout: TextWriter;
  fetch: typeof fetch;
}

async function call(context: TokenCommandContext, stateDir: string | undefined, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<unknown> {
  const { url, secret } = await requireLocalRuntime(context.home ?? homedir(), stateDir);
  let response: Response;
  try {
    response = await context.fetch(`${url}${path}`, {
      method: init.method ?? "GET", headers: { authorization: `Bearer ${secret}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is not answering at its address. Start it again with `rovara up`.");
  }
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } };
  if (!response.ok) throw agentXError(response.status === 404 ? "NOT_FOUND" : "RUNTIME_UNAVAILABLE", terminalSafe(typeof body.error?.message === "string" ? body.error.message : `Rovara answered ${response.status}`));
  return body;
}

export function registerTokenCommands(program: Command, context: TokenCommandContext): void {
  const token = program.command("token").description("script tokens: let your own scripts on this computer read your tasks and start tasks on chosen projects, without your session (`rovara up` must be running)");
  token
    .command("list")
    .description("your script tokens: name, projects, what each may do, and its state (never the token itself)")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      const parsed = ScriptTokenListReaderSchema.safeParse(await call(context, options.stateDir, "/v1/app/script-tokens"));
      if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "Rovara answered with something unexpected; is this `rovara` as new as the one running?");
      const tokens = parsed.data.tokens;
      if (globals.json) {
        context.stdout.write(`${JSON.stringify({ ok: true, data: { tokens } })}\n`);
        return;
      }
      context.stdout.write(tokens.length === 0
        ? "You have no script tokens. Make one with `rovara token create`.\n"
        : `${tokens.map((entry) => `${terminalSafe(entry.tokenId)}  ${terminalSafe(entry.hint)}  ${entry.status}  ${terminalSafe(entry.name)}  projects ${entry.projects.map(terminalSafe).join(",")}  may ${entry.permissions.join("+")}  until ${terminalSafe(entry.expiresAt)}${entry.lastUsedAt === undefined ? "" : `  last used ${terminalSafe(entry.lastUsedAt)}`}`).join("\n")}\n`);
    });
  token
    .command("create")
    .description("open the page where you make a script token (a token lasts for weeks, so it is made in your browser; it is shown once)")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      // A fresh page session: the page asks for one opened in the last few minutes.
      await call(context, options.stateDir, "/v1/local/pages/open", { method: "POST", body: { path: "/tokens", fresh: true } });
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { opened: true } })}\n` : "Opened the script tokens page in your browser. Make the token there: it is shown once, so copy it then.\n");
    });
  token
    .command("revoke")
    .description("end a script token at once")
    .argument("<token-id>", "the token's ID (stk_...), from `rovara token list`")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (id: string, options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      if (!/^stk_[0-9a-z]{20}$/u.test(id)) throw agentXError("CONFIG_INVALID", "that is not a script token ID; run `rovara token list` to see yours");
      const answer = await call(context, options.stateDir, `/v1/app/script-tokens/${id}/revoke`, { method: "POST", body: {} }) as { token?: { status?: unknown } };
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { revoked: answer.token?.status === "revoked" } })}\n` : `${terminalSafe(id)} is revoked.\n`);
    });
}
