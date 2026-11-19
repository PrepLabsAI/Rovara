// Company close calls this BEFORE removing its saved-environment rows, after
// blocking new company work. Existing project rows are the durable push fence;
// the company erase keeps them until this step proves the registry prefix empty.
import { orgPk, OrgIdSchema, isSavedEnvRepositoryName, savedEnvRepositoryName, type DocumentStore, type ImageRegistry } from "@agentx/contracts";
import type { SavedEnvRoleSessions } from "./saved-env-role-sessions.js";
import { onProjectDeleted, SAVED_ENV_JOB_LEASE_MS, type SavedEnvDeps } from "../core/test-env/saved-env.js";

// ECR tokens may remain usable for their own 12-hour life. Wait a full build
// lease plus that life after fencing pushes; never infer expiry from STS alone.
export const SAVED_ENV_ERASE_DRAIN_MS = SAVED_ENV_JOB_LEASE_MS + 12 * 3_600_000;
type EraseAnswer = { complete: true; repositories: number } | { complete: false; reason: "push_sessions_draining" | "unavailable" };
type CompanyEraseInput = {
  companyId: string; store: Pick<DocumentStore, "query">; saved: SavedEnvDeps;
  sessions: Pick<SavedEnvRoleSessions, "listCompanyRepositories">;
  registry: Pick<ImageRegistry, "deleteRepository">;
  /** Live host lifecycle read for THIS company; only literal true permits erase. */
  companyClosing(companyId: string): Promise<boolean>;
};

/** The company-close job's saved-image step. The host's idempotent mark must
 * durably block all new company work before it resolves. Retry this whole step
 * during the drain; do not remove project rows until erase reports complete. */
export async function closeCompanySavedEnvironments(input: CompanyEraseInput & {
  markCompanyClosing(companyId: string): Promise<void>;
}): Promise<EraseAnswer> {
  try {
    const company = OrgIdSchema.parse(input.companyId);
    await input.markCompanyClosing(company);
    return await eraseCompanySavedEnvironments(input);
  } catch { return { complete: false, reason: "unavailable" }; }
}

export async function eraseCompanySavedEnvironments(input: CompanyEraseInput): Promise<EraseAnswer> {
  try {
    const company = OrgIdSchema.parse(input.companyId);
    if (await input.companyClosing(company) !== true) return { complete: false, reason: "unavailable" };
    const prefix = savedEnvRepositoryName({ env: input.saved.session.config.env, orgId: company, projectId: "-" }).split("/").slice(0, 3).join("/") + "/";
    let cursor: string | undefined;
    let draining = false;
    const seen = new Set<string>();
    for (let page = 0; ; page += 1) {
      if (page >= 100) throw new Error();
      const listed = await input.store.query({ pk: orgPk(company), sk: { op: "beginsWith", prefix: "SAVED_ENV#" }, ...(cursor === undefined ? {} : { cursor }) });
      for (const row of listed.items) {
        const projectId = row.sk.slice("SAVED_ENV#".length);
        if (row["orgId"] !== company || row["projectId"] !== projectId) throw new Error();
        const state = await input.saved.store.get(company, projectId);
        if (state === undefined) throw new Error();
        // Fence all jobs before enumerating, even while the use switch is off.
        if (state.deleted !== true) {
          const erased = await onProjectDeleted(input.saved, { orgId: company, projectId });
          if (!erased.ok) throw new Error();
        }
        const fenced = await input.saved.store.get(company, projectId);
        const deletedAt = Date.parse(fenced?.deletedAt ?? "");
        if (!Number.isFinite(deletedAt)) throw new Error();
        if (input.saved.now() < deletedAt + SAVED_ENV_ERASE_DRAIN_MS) draining = true;
      }
      cursor = listed.cursor;
      if (cursor === undefined) break;
      if (seen.has(cursor)) throw new Error();
      seen.add(cursor);
    }
    if (draining) return { complete: false, reason: "push_sessions_draining" };
    const names = await input.sessions.listCompanyRepositories({ companyId: company });
    if (names.some(name => !isSavedEnvRepositoryName(name) || !name.startsWith(prefix))) throw new Error();
    for (const repository of new Set(names)) await input.registry.deleteRepository({ companyId: company, repository });
    if ((await input.sessions.listCompanyRepositories({ companyId: company })).length !== 0) throw new Error();
    return { complete: true, repositories: new Set(names).size };
  } catch { return { complete: false, reason: "unavailable" }; }
}
