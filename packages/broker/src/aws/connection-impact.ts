import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AgentXError, AgentXNameSchema, ON_THE_WEBSITE_MESSAGE, agentXError } from "@agentx/contracts";
import type { AdaptedHttpRequest } from "./lambda.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./developer-routes.js";
import { companyInstallationSnapshotReader } from "./github-credentials.js";
import { projectsUsingInstallation, ProjectJoinLimit } from "./github-lifecycle.js";
import { CONNECTION_NOT_FOUND, DISCONNECT_OWNER_ONLY } from "./github-connect-routes.js";
import type { ServerReadContext } from "./server-read-context.js";

const Body = z.object({ provider: z.literal("github"), operation: z.literal("disconnect"), target: z.object({ installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict() }).strict();
export const impactUnavailable = () => agentXError("RUNTIME_UNAVAILABLE", "GitHub disconnect preview is unavailable.");

export async function connectionImpactRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL, initial: DeveloperCaller,
  context: ServerReadContext, standing: () => Promise<{ caller: DeveloperCaller; companyId: string; role: string }>) {
  let raw: unknown;
  try { raw = JSON.parse(request.body ?? ""); } catch { /* strict body below */ }
  const input = Body.safeParse(raw);
  if (!input.success || url.search !== "") throw agentXError("CONFIG_INVALID", "That disconnect preview is invalid.");
  const authority = async () => {
    const who = await standing();
    if (who.role !== "owner") throw agentXError("FORBIDDEN", DISCONNECT_OWNER_ONLY);
    if (who.caller.webApp !== true) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
    if (who.caller.developerId !== initial.developerId) throw impactUnavailable();
    return who;
  };
  try {
    const first = await authority();
    const inventory = companyInstallationSnapshotReader(context.client, deps.tableName, deps.now);
    const rows = await inventory.readComplete(first.companyId);
    const target = rows.find(row => row.installationId === input.data.target.installationId);
    if (target === undefined) throw agentXError("NOT_FOUND", CONNECTION_NOT_FOUND);
    const ownerElsewhere = rows.some(row => row.installationId !== target.installationId && row.state === "active" && row.accountLogin.toLowerCase() === target.accountLogin.toLowerCase());
    let disconnectBlockers: { kind: "exact"; count: number; projects: string[] } | { kind: "unknown"; reason: "read_bound" | "read_unavailable" };
    try {
      const names = await projectsUsingInstallation(deps, first.companyId, { installationId: target.installationId, accountLogin: target.accountLogin, ownerElsewhere }, context.budget);
      const projects = z.array(AgentXNameSchema).max(400).parse(names);
      if (new Set(projects).size !== projects.length || projects.some((name, index) => name !== [...projects].sort()[index])) throw new Error("invalid project projection");
      disconnectBlockers = { kind: "exact", count: projects.length, projects };
    } catch (error) {
      context.check(); // A global bound is never a successful unknown join.
      disconnectBlockers = { kind: "unknown", reason: error instanceof ProjectJoinLimit ? "read_bound" : "read_unavailable" };
    }
    const finalTarget = await inventory.rereadTarget(first.companyId, target.installationId);
    if (finalTarget === undefined) throw agentXError("NOT_FOUND", CONNECTION_NOT_FOUND);
    if (!isDeepStrictEqual(target, finalTarget)) throw impactUnavailable();
    // No domain await follows the final live caller proof.
    const last = await authority();
    if (last.companyId !== first.companyId) throw impactUnavailable();
    context.check();
    const unknown = { kind: "unknown" as const, reason: "not_projected" as const };
    return { ...input.data, checkedAt: new Date(deps.now()).toISOString(), snapshot: "non_atomic" as const, disconnectBlockers, repositories: unknown, runningTasks: unknown, queuedTasks: unknown };
  } catch (error) {
    context.check();
    if (error instanceof AgentXError && (error.code === "FORBIDDEN" || (error.code === "NOT_FOUND" && error.message.endsWith(CONNECTION_NOT_FOUND)))) throw error;
    throw impactUnavailable();
  }
}
