// `rovara chat` and `rovara chat status`: the chat tools Rovara talks to on the `rovara up` running here (owner decision 58: a chat tool is an ordinary channel adapter).
//
//  - `rovara chat` does not change anything itself: linking a chat account, binding a space to a project and choosing where you are told are made on a local page the running `rovara up` opens in your browser. Each one lets a
//    chat account act as you or sends the titles of your tasks to a place, so the API login this command holds (the one an AI tool may hold too) is not enough for any of them.
//  - `rovara chat status` shows what is set up, never a code or a token.
import { agentXError } from "@rovara-code/contracts";
import { homedir } from "node:os";
import type { Command } from "commander";
import type { TextWriter } from "../init/prompts.js";
import { terminalSafe } from "../session/app-request.js";
import { requireLocalRuntime } from "./local-runtime.js";

export interface ChatCommandContext {
  home?: string;
  stdout: TextWriter;
  fetch: typeof fetch;
}

async function call(context: ChatCommandContext, stateDir: string | undefined, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<Record<string, unknown>> {
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
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: unknown } };
  if (!response.ok) throw agentXError(response.status === 404 ? "NOT_FOUND" : "RUNTIME_UNAVAILABLE", terminalSafe(typeof body.error?.message === "string" ? body.error.message : `Rovara answered ${String(response.status)}`));
  return body;
}

const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : []);
const word = (value: unknown): string => terminalSafe(typeof value === "string" ? value : "");

export function registerChatCommands(program: Command, context: ChatCommandContext): void {
  const chat = program
    .command("chat")
    .description("open the page where you link a chat account, bind a chat space to a project and choose where you are told (`rovara up` must be running)")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      // A fresh page session: the page asks for one opened in the last few minutes.
      await call(context, options.stateDir, "/v1/local/pages/open", { method: "POST", body: { path: "/chat", fresh: true } });
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: true, data: { opened: true } })}\n` : "Opened the chat page in your browser. Linking an account, binding a space and choosing where you are told are done there.\n");
    });
  chat
    .command("status")
    .description("show the chats set up, the accounts linked to you, the spaces bound to a project and where you are told")
    .option("--state-dir <path>", "the folder `rovara up` uses (default: ~/.rovara)")
    .action(async (options: { stateDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ json: boolean }>();
      const stateDir = options.stateDir ?? (command.parent?.opts<{ stateDir?: string }>().stateDir);
      const channel = await call(context, stateDir, "/v1/app/channel");
      const notices = await call(context, stateDir, "/v1/app/me/notifications");
      if (globals.json) {
        context.stdout.write(`${JSON.stringify({ ok: true, data: { channel, notices } })}\n`);
        return;
      }
      const adapters = list(channel["adapters"]), links = list(channel["links"]), bindings = list(channel["bindings"]), targets = list(notices["targets"]);
      const lines = [
        adapters.length === 0 ? "No chat is set up. Name a chat plug-in in your plug-in config." : `Chats: ${adapters.map((adapter) => word(adapter["name"])).join(", ")}`,
        `Linked accounts: ${links.length === 0 ? "none" : links.map((link) => `${word(link["channel"])} ${word(link["maskedUserId"])}`).join(", ")}`,
        `Bound spaces: ${bindings.length === 0 ? "none" : bindings.map((binding) => `${word(binding["channel"])} ${word(binding["space"])} -> ${word(binding["project"])}`).join(", ")}`,
        notices["muted"] === true ? "You are told: nowhere (notices are muted)." : `You are told: ${targets.length === 0 ? "nowhere" : targets.map((target) => word((target["conversation"] as Record<string, unknown> | undefined)?.["space"] ?? target["channel"])).join(", ")}`,
        "Change any of this with `rovara chat`.",
      ];
      context.stdout.write(`${lines.join("\n")}\n`);
    });
}
