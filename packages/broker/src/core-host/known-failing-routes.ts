import { z } from "zod";
import { agentXError, type OrgId, type Principal } from "@agentx/contracts";
import { createKnownFailing } from "../core/test-env/known-failing.js";
import type { SessionMembers } from "../core/sessions/access.js";
import { developerIdOf } from "../core/sessions/create.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
const PATH = /^\/v1\/app\/projects\/([^/]+)\/known-failing$/u;
export const isKnownFailingPath = (path: string, method: string): boolean => PATH.test(path) && (method === "GET" || method === "POST");
const Undo = z.object({ action: z.literal("undo"), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u), name: z.string().min(1).max(500), checkId: z.string().min(1).max(64), markedBy: z.string().min(1).max(200), markedAt: z.string().datetime(), epoch: z.number().int().positive() }).strict();
export async function routeKnownFailing(input: { flow: TaskFlowDeps; principal: Principal; companyId: OrgId; members: SessionMembers | undefined; webApp: boolean; path: string; request: BrokerRequest; env?: NodeJS.ProcessEnv }): Promise<BrokerResponse> {
  const project = decodeURIComponent(PATH.exec(input.path)![1]!);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(project) || input.principal.companyId !== input.companyId || input.members === undefined) throw agentXError("NOT_FOUND", "Project not found.");
  const who = { companyId: input.companyId, developerId: developerIdOf(input.principal), principal: input.principal };
  const role = await input.members.companyRole(who), grant = await input.members.projectGrant(who, project);
  if (role === undefined || (role !== "owner" && role !== "admin" && grant === undefined) || await input.flow.projects.latest(project) === undefined) throw agentXError("NOT_FOUND", "Project not found.");
  const service = createKnownFailing({ store: input.flow.store, audit: input.flow.audit, now: () => (input.flow.now?.() ?? new Date()).getTime(), env: input.env ?? process.env, evidenceOf: async () => undefined,
    mayMaintain: async (p, name) => {
      if (p.companyId !== input.companyId || input.members === undefined) return false;
      const live = { companyId: input.companyId, developerId: developerIdOf(p), principal: p };
      const companyRole = await input.members.companyRole(live);
      return companyRole === "owner" || companyRole === "admin" || (companyRole === "member" && await input.members.projectGrant(live, name) === "maintainer");
    },
  });
  if (input.request.method === "POST") {
    if (!input.webApp) throw agentXError("FORBIDDEN", "Use the website as a current project maintainer.");
    let body: unknown; try { body = JSON.parse(input.request.body ?? ""); } catch { throw agentXError("CONFIG_INVALID", "Invalid Undo request."); }
    const parsed = Undo.safeParse(body);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "Invalid Undo request.");
    const { name, checkId, markedBy, markedAt, epoch } = parsed.data;
    const marks = await service.marks(input.companyId, project);
    const selected = marks.marks.find((mark) => mark.name === name && mark.checkId === checkId && mark.markedBy === markedBy && mark.markedAt === markedAt && mark.epoch === epoch);
    if (selected === undefined) throw agentXError("CHANGE_STALE", "The mark changed. Reload and decide again.");
    await service.undo(input.companyId, project, input.principal, true, selected);
  }
  const result = await service.marks(input.companyId, project);
  const marks = result.marks.map((mark) => ({ name: mark.name, checkId: mark.checkId, markedBy: mark.markedBy, markedAt: mark.markedAt, epoch: mark.epoch, markedByName: mark.markedBy, markedByYou: mark.markedBy === input.principal.personId }));
  return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ ...(input.request.method === "POST" ? { status: "done" } : {}), max: result.max, marks }) };
}
