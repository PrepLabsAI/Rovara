// The two "knowledge stays in Rovara" switches on a hosted company (Lead 4 L4-JA7, journey audit B7): the company's "Knowledge stays in Rovara" and a project's "local coding tools can fetch lessons" (decision 46b).
// The laptop has them on its lessons page (`local/app/lessons.ts` `localToolsSwitch`, `core/local-pages/server.ts` POST /lessons/local-tools) and reads them at `GET /v1/app/org/lessons/local-tools` and
// `GET /v1/app/projects/{p}/lessons/local-tools` (`local/app/lessons-routes.ts`); a hosted company had no way to read or set either, so "tools may read" stayed on for ever. This is the hosted twin:
//
//   GET /v1/dev/company/lessons/local-tools                         { stays: boolean }                  the company's switch (true: team knowledge stays inside Rovara for every project)
//   PUT /v1/dev/company/lessons/local-tools        { stays }        { stays: boolean }                  an owner or admin of the company only
//   GET /v1/dev/projects/{project}/lessons/local-tools              LocalToolsState + { canChange }     whether a local tool gets the project's lessons now, and the first reason it does not
//   PUT /v1/dev/projects/{project}/lessons/local-tools  { enabled } LocalToolsState + { canChange }     a project admin (maintainer) or an owner or admin of the company only
//
// Rules (the laptop's, because the settings are not copied: the SAME `setCompanyLocalTools` / `setProjectLocalTools` / `readLocalToolsState` run here, over the SAME stored rows the knowledge reads and the wiki tools gate read,
// `DocumentLocalToolsSettings`, so a change is in force on the very next read; nothing is cached):
//   - "who": the contract's own words (`contracts/src/lessons-local-tools.ts`, decision 46b): the company's switch is "an owner or admin", the project's is "a maintainer"; the hosted lessons API's rule for a project's settings
//     (`lessons-api.ts` `mayChange`) is a project maintainer or a company owner or admin, read live. There is no step-up here (it is being removed from the product); the role is the check.
//   - The company comes ONLY from live membership (`companyOf`); a reader that throws or answers something malformed is "sign in again". Nothing in a path, query or body names a company or a person.
//   - A project the company does not have is "No such project." (the lessons API's words); so is a project the person has no part in (not on its roster and not an owner or admin), so names cannot be probed.
//   - A script token neither reads nor sets either switch (the knowledge a tool reads is gated BY these; a tool must never change its own gate).
//   - Every change is audited BEFORE it is made (the ledger records who and the new value; the stored row names no person); no record, no change.
//   - It does NOT depend on the lessons switch: a company that wants its knowledge to stay in Rovara can say so whether or not lessons are on (the wiki tools gate reads the same row either way).
//   - Refusals are fixed words; nothing a caller sent is echoed, and nothing about a store fault leaks.
import { AgentXError, AgentXNameSchema, LocalToolsCompanyBodySchema, LocalToolsProjectBodySchema, OrgIdSchema, OrgRoleSchema, agentXError, type AuditSink, type DocumentStore, type LocalToolsState, type OrgId, type OrgRole, type ProjectRole } from "@agentx/contracts";
import { lessonAuditSink } from "../lessons/audit-sink.js";
import { DocumentLocalToolsSettings, documentLearningSettings } from "../lessons/document-settings.js";
import { readLocalToolsState, setCompanyLocalTools, setProjectLocalTools, type LocalToolsSetResult } from "../lessons/local-tools-setting.js";
import { NOT_FOR_SCRIPT_TOKENS, NO_SUCH_PROJECT } from "./lessons-api.js";

export const KNOWLEDGE_SWITCH_COMPANY_PATH = "/v1/dev/company/lessons/local-tools";
const PROJECT_PATH = /^\/v1\/dev\/projects\/([^/]+)\/lessons\/local-tools$/u;
/** Whether a path is this API's (the dev router asks before it hands a request here). */
export const isKnowledgeSwitchPath = (path: string): boolean => path === KNOWLEDGE_SWITCH_COMPANY_PATH || PROJECT_PATH.test(path);

export const COMPANY_SWITCH_NEEDS_ADMIN = "Only an owner or admin of the company can change whether knowledge stays in Rovara.";
export const PROJECT_SWITCH_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can change this.";
const SIGN_IN_AGAIN = "Sign in again.";
const UNAVAILABLE = "That can't be read or saved right now. Try again.";
const NOT_RECORDED = "That could not be recorded, so nothing was changed. Try again.";

export interface KnowledgeSwitchCaller { personId: string; scriptToken?: unknown }
export interface KnowledgeSwitchRequest { method: string; path: string; body?: string | undefined }
export interface KnowledgeSwitchOptions {
  /** The caller's company and their live role in it, from membership. Undefined, malformed or a throw: sign in again. */
  companyOf(caller: KnowledgeSwitchCaller): Promise<{ companyId: string; role: OrgRole } | undefined>;
  /** The document store the knowledge reads and the wiki tools gate read, or a way to get it when it is made late (the deployment's registry). */
  store: DocumentStore | (() => Promise<DocumentStore>);
  /** The install's audit sink (the lessons audit wraps it). */
  audit: AuditSink | (() => Promise<AuditSink>);
  /** Whether the company has the project (the company's own catalog). A throw is "unavailable". */
  projectExists(companyId: OrgId, project: string): Promise<boolean>;
  /** The person's role on the project now (a project admin is a `maintainer`); undefined: none. */
  projectRole(companyId: OrgId, project: string, personId: string): Promise<ProjectRole | undefined>;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}
export type KnowledgeSwitchAnswer = { stays: boolean } | (LocalToolsState & { canChange: boolean });
export interface KnowledgeSwitchApi { answer(request: KnowledgeSwitchRequest, caller: KnowledgeSwitchCaller): Promise<KnowledgeSwitchAnswer> }

function bodyOf<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, body: string | undefined, words: string): T {
  let raw: unknown;
  try { raw = body === undefined || body === "" ? undefined : JSON.parse(body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", words);
  return parsed.data;
}

/** The refusal words for a write that did not happen: fixed, never the cause. */
function refusalOf(code: Extract<LocalToolsSetResult, { ok: false }>["code"]): AgentXError {
  return code === "audit_unavailable" ? agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED) : agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
}

export function createKnowledgeSwitchApi(options: KnowledgeSwitchOptions): KnowledgeSwitchApi {
  const log = (event: string, fields: Record<string, unknown> = {}): void => options.log?.({ component: "knowledge-switch", event, ...fields });

  async function answer(request: KnowledgeSwitchRequest, caller: KnowledgeSwitchCaller): Promise<KnowledgeSwitchAnswer> {
    const projectMatch = PROJECT_PATH.exec(request.path);
    if ((request.path !== KNOWLEDGE_SWITCH_COMPANY_PATH && projectMatch === null) || (request.method !== "GET" && request.method !== "PUT")) throw agentXError("NOT_FOUND", "route not found");
    if (caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS);
    let found: unknown;
    try { found = await options.companyOf(caller); } catch { found = undefined; }
    const record = found as { companyId?: unknown; role?: unknown } | undefined | null;
    const company = OrgIdSchema.safeParse(record?.companyId);
    const parsedRole = OrgRoleSchema.safeParse(record?.role);
    const personId = caller.personId;
    if (!company.success || !parsedRole.success || typeof personId !== "string") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    const companyId: OrgId = company.data;
    const role: OrgRole = parsedRole.data;
    const companyAdmin = role === "owner" || role === "admin";

    let store: DocumentStore;
    let sink: AuditSink;
    try {
      store = typeof options.store === "function" ? await options.store() : options.store;
      sink = typeof options.audit === "function" ? await options.audit() : options.audit;
    } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    const localTools = new DocumentLocalToolsSettings(store);
    const audit = lessonAuditSink(sink, options.now, companyId);
    const deps = { localTools, audit, now: options.now };

    if (projectMatch === null) {
      // The company's switch: an owner or admin reads and sets it (the settings screen is theirs).
      if (!companyAdmin) throw agentXError("FORBIDDEN", COMPANY_SWITCH_NEEDS_ADMIN);
      if (request.method === "GET") {
        try { return { stays: await localTools.readCompany(companyId) }; } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
      }
      const body = bodyOf(LocalToolsCompanyBodySchema, request.body, "the switch takes stays: true or false");
      const done = await setCompanyLocalTools(deps, { workspaceId: companyId, stays: body.stays, by: personId });
      if (!done.ok) throw refusalOf(done.code);
      log("company_switch_set", { companyId, stays: body.stays });
      try { return { stays: await localTools.readCompany(companyId) }; } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    }

    let project: string;
    try { project = decodeURIComponent(projectMatch[1]!); } catch { throw agentXError("NOT_FOUND", NO_SUCH_PROJECT); }
    if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", NO_SUCH_PROJECT);
    let exists: boolean;
    let projectRole: ProjectRole | undefined;
    try { [exists, projectRole] = await Promise.all([options.projectExists(companyId, project), options.projectRole(companyId, project, personId).catch(() => undefined)]); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    // Not there, or not a place this person has any part in: the same words, so another project's name is never confirmed.
    if (!exists || (!companyAdmin && projectRole === undefined)) throw agentXError("NOT_FOUND", NO_SUCH_PROJECT);
    const canChange = companyAdmin || projectRole === "maintainer";
    const read = async (): Promise<LocalToolsState> => {
      try { return await readLocalToolsState({ localTools, settings: documentLearningSettings(store) }, companyId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    };
    if (request.method === "GET") return { ...(await read()), canChange };
    const body = bodyOf(LocalToolsProjectBodySchema, request.body, "the switch takes enabled: true or false");
    if (!canChange) throw agentXError("FORBIDDEN", PROJECT_SWITCH_NEEDS_ADMIN);
    const done = await setProjectLocalTools(deps, { workspaceId: companyId, project, enabled: body.enabled, by: personId });
    if (!done.ok) throw refusalOf(done.code);
    log("project_switch_set", { companyId, enabled: body.enabled });
    return { ...(await read()), canChange };
  }

  return {
    async answer(request, caller) {
      try { return await answer(request, caller); }
      catch (error) {
        if (error instanceof AgentXError) throw error;
        throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
      }
    },
  };
}
