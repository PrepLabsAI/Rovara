import { agentXError } from "@agentx/contracts";
import type { Command } from "commander";
import { developerTokenKey, resolveDeveloperEnvironment } from "./config.js";
import type { TokenStore } from "../token-store.js";

interface ReplayResponse { project: string; tasks: Array<{ taskId: string; stage: string; round: number; actual: string[]; replayed: string[]; gained: string[]; lost: string[]; changed: boolean }>; totals: { changedTasks: number; lessonsGained: number; lessonsLost: number } }

export function registerLessonsReplayCommand(program: Command, context: { home: string; tokenStore: TokenStore; fetch: typeof fetch; stdout: { write(text: string): unknown } }): void {
  const lessons = program.command("lessons").description("inspect project lessons");
  lessons.command("replay").description("compare current lesson selection with the last finished tasks")
    .requiredOption("--project <name>", "the exact project name")
    .option("--tasks <count>", "number of finished tasks to replay (1 to 50)", "30")
    .option("--json", "print JSON")
    .action(async (options: { project: string; tasks: string; json?: boolean }, command: Command) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(options.project)) throw agentXError("CONFIG_INVALID", "name a project by its exact name");
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(options.tasks)) throw agentXError("CONFIG_INVALID", "--tasks must be a whole number from 1 to 50");
      const globals = command.optsWithGlobals<{ env: string; json: boolean }>();
      const { env, entry } = await resolveDeveloperEnvironment(context.home, globals.env);
      const tokens = await context.tokenStore.get(developerTokenKey(entry.issuer));
      if (tokens === undefined || tokens.expiresAt <= Date.now()) throw agentXError("AUTH_REQUIRED", `sign in to ${env} again with \`rovara login ${entry.url}\``);
      const url = `${entry.url.replace(/\/$/u, "")}/v1/dev/projects/${encodeURIComponent(options.project)}/lessons/replay?tasks=${options.tasks}`;
      let response: Response;
      try { response = await context.fetch(url, { method: "GET", headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(30_000) }); }
      catch { throw agentXError("RUNTIME_UNAVAILABLE", "the lessons replay route is not answering"); }
      const body = await response.json().catch(() => undefined) as ReplayResponse | { error?: { message?: unknown } } | undefined;
      if (!response.ok || body === undefined || !("totals" in body)) {
        const message = body !== undefined && "error" in body && typeof body.error?.message === "string" ? body.error.message : `Rovara answered HTTP ${response.status}`;
        throw agentXError(response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "NOT_FOUND" : "RUNTIME_UNAVAILABLE", message);
      }
      if (options.json === true || globals.json) context.stdout.write(`${JSON.stringify({ ok: true, data: body })}\n`);
      else {
        const lines = body.tasks.filter((load) => load.changed).map((load) => `  ${load.taskId} ${load.stage} round ${load.round}: gained ${load.gained.join(", ") || "none"}; lost ${load.lost.join(", ") || "none"}`);
        context.stdout.write(`${body.project}: ${body.totals.changedTasks} changed tasks, ${body.totals.lessonsGained} lessons gained, ${body.totals.lessonsLost} lost.\n${lines.map((line) => `${line}\n`).join("")}`);
      }
    });
}
