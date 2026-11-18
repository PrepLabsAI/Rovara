// L4-EVCI2: the setup card's "Eval check from your CI" on `rovara up`. The same path and answers as the hosted core (core-host/eval-check-routes.ts):
//
//   GET /v1/app/projects/{project}/ci-eval-check   { project, canManage, confirmed, proposals, explanation }
//   PUT /v1/app/projects/{project}/ci-eval-check   { requestId, check }: one of the proposals just read, or null for none
//
// Who: the owner of this install, on the API session (the owner manages every project of the install). A script token never reaches this route. A project that does not exist answers 404 "project not found".
// The install has one company (`IMPLICIT_COMPANY_ID`); the row is still keyed by it AND the project. The audit record is written before the row, as on the hosted core.
import { AgentXError, IMPLICIT_COMPANY_ID, agentXError, type AdapterRegistry, type AuditSink, type OrgId } from "@agentx/contracts";
import { createHash } from "node:crypto";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import { EVAL_CHECK_WORDS, ciDefinitionReaderOf, evalCheckView, setEvalCheck, type EvalCheckCardDeps, type EvalCheckRepository } from "../../core/ci-evidence/eval-check-card.js";
import { codeHostForRecord } from "../../plugins/routing.js";

const ROUTE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/ci-eval-check$/u;
const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const bodyOf = (request: BrokerRequest): unknown => {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", EVAL_CHECK_WORDS.invalid); }
};
const auditChoice = (check: { name: string; source?: string | undefined } | undefined): string => (check === undefined ? "none" : `check\u0000${check.name}\u0000${check.source ?? ""}`);

export interface LocalEvalCheckOptions {
  flow: TaskFlowDeps;
  registry: AdapterRegistry;
  companyId?: OrgId | undefined;
  audit: AuditSink;
  now: () => number;
  /** The workflow-file reader of a repository. Default: the registry's code host (`ciDefinitionReaderOf`). A test or an embedding host may give its own. */
  readerFor?: EvalCheckCardDeps["readerFor"] | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface LocalEvalCheck { routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> }

export function createLocalEvalCheck(options: LocalEvalCheckOptions): LocalEvalCheck {
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const { flow } = options;
  return {
    async routes(request, caller) {
      const match = ROUTE.exec(request.path.split("?")[0] ?? request.path);
      if (match === null || (request.method !== "GET" && request.method !== "PUT")) return undefined;
      try {
        if (caller.scriptToken !== undefined || !caller.principal.roles.includes("owner")) throw agentXError("FORBIDDEN", EVAL_CHECK_WORDS.notAllowed);
        const project = match[1]!;
        const latest = await flow.projects.latest(project);
        if (latest === undefined) throw agentXError("NOT_FOUND", EVAL_CHECK_WORDS.projectNotFound);
        const personId = caller.principal.personId;
        const repositories: EvalCheckRepository[] = latest.definition.repositories.map((repository) => ({ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch, ...(repository.host === undefined ? {} : { host: { kind: repository.host.kind } }) }));
        const deps: EvalCheckCardDeps = {
          store: flow.store, companyId, now: options.now,
          readerFor: options.readerFor ?? (async (repository) => {
            try { return await ciDefinitionReaderOf(codeHostForRecord(options.registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }), repository, { orgId: companyId }); } catch { return undefined; }
          }),
          ...(options.log === undefined ? {} : { log: (event, fields) => options.log?.({ component: "eval_check", event, ...fields }) }),
        };
        if (request.method === "GET") return json(200, await evalCheckView(deps, { project, canManage: true, repositories }));
        return json(200, await setEvalCheck(deps, {
          project, canManage: true, repositories,
          async record(details) {
            await options.audit.record({
              eventId: `ci_eval_check.set:${companyId}:${project}:${personId}:${details.requestId}:${createHash("sha256").update(`${auditChoice(details.check)}\u0001${auditChoice(details.previous)}`, "utf8").digest("hex").slice(0, 16)}`,
              companyId, at: new Date(options.now()).toISOString(), actor: { type: "person", id: personId }, action: "ci_eval_check.set", subject: { type: "project", id: project },
              details: { project, basis: "install-owner", requestId: details.requestId, check: details.check?.name ?? "none", ...(details.check?.source === undefined ? {} : { source: details.check.source }), previous: details.previous?.name ?? "none" },
            });
          },
        }, bodyOf(request)));
      } catch (error) {
        if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        return json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: EVAL_CHECK_WORDS.unreadable } });
      }
    },
  };
}
