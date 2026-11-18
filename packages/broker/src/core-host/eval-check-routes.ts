// L4-EVCI2: the setup card's "Eval check from your CI" on the hosted core. The setup run's route family (`/v1/app/projects/{project}/...`), served AS the signed-in person:
//
//   GET /v1/app/projects/{project}/ci-eval-check   { project, canManage, confirmed, proposals, explanation }: any role on the project reads the confirmed check; the people who manage the setup also get the
//                                                  proposals (the project's workflow files, read now, never run, no model)
//   PUT /v1/app/projects/{project}/ci-eval-check   { requestId, check } with `check` one of the proposals just read, or null for none: a live company owner or admin, or the project's administrator
//                                                  (the setup rule, `HostedSetupRunWiring.standing`'s "manage"); answers the view
//
// Rules (the upkeep switch's and the setup run's, reused):
//   - The company is the caller's LIVE membership (the dev routes' `companyOf`), never a header, query, body or token claim; a script token never reaches this route (the dev routes refuse it first). The row is
//     the project's own, keyed by that company AND the project.
//   - Anyone with no role on the project, another company's project, a missing one and a malformed name all answer the same 404 "project not found". A reader's change is 403 in fixed words.
//   - The audit record (naming the person and why they were allowed) is written BEFORE the row: nothing changes when it cannot be written. Refusals are fixed words; nothing a caller sent is echoed.
//   - Advisory: the check only decides which result Rovara SAYS on its pull requests. It is never a gate, a fix or a payer, so it needs no fresh step-up.
import { AgentXError, agentXError, type AuditEvent, type AuditSink, type OrgId } from "@agentx/contracts";
import { createHash } from "node:crypto";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import type { CiDefinitionReader } from "../rovara-code/ci-checks.js";
import { EVAL_CHECK_WORDS, evalCheckView, setEvalCheck, type EvalCheckCardDeps, type EvalCheckRepository } from "../core/ci-evidence/eval-check-card.js";
import { EVAL_CHECK_PROJECT } from "../core/ci-evidence/eval-check-setting.js";
import type { SetupRunBasis, SetupRunStanding } from "./setup-run-routes.js";

export interface HostedEvalCheckWiring {
  /** The person's standing on the project in THIS company, read live (the setup run's own read). Throws when it cannot be read: the route then refuses in fixed words. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** A read-only view of a repository's workflow files on its default branch, through THIS company's own code host. Undefined (or a throw): this install cannot read them, so nothing can be proposed or confirmed. */
  readerFor(companyId: OrgId, repository: EvalCheckRepository): Promise<CiDefinitionReader | undefined>;
}

export interface HostedEvalCheckInput {
  request: BrokerRequest;
  path: string;
  principal: TaskStartCaller["principal"];
  companyId: OrgId;
  flow: TaskFlowDeps;
  wiring: HostedEvalCheckWiring;
  audit: AuditSink;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const EVAL_CHECK_PATH = /^\/v1\/app\/projects\/([^/]+)\/ci-eval-check$/u;

/** Whether this method and path is the eval check card's. */
export function isEvalCheckPath(path: string, method: string): boolean {
  return EVAL_CHECK_PATH.test(path) && (method === "GET" || method === "PUT");
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notFound = (): AgentXError => agentXError("NOT_FOUND", EVAL_CHECK_WORDS.projectNotFound);
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", EVAL_CHECK_WORDS.unreadable);

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", EVAL_CHECK_WORDS.invalid); }
}

/** What a choice is, for the audit record's id: none, or the check's name and reporting app. */
const auditChoice = (check: { name: string; source?: string | undefined } | undefined): string => (check === undefined ? "none" : `check\u0000${check.name}\u0000${check.source ?? ""}`);

const isManage = (standing: SetupRunStanding): standing is Extract<SetupRunStanding, { access: "manage" }> =>
  standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin" || standing.basis === "project-admin");

/** One request on the hosted eval-check path (`isEvalCheckPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedEvalCheck(input: HostedEvalCheckInput): Promise<BrokerResponse> {
  try {
    const match = EVAL_CHECK_PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw notFound(); }
    if (!EVAL_CHECK_PROJECT.test(project)) throw notFound();
    const { flow, companyId, wiring } = input;
    const personId = input.principal.personId;
    let standing: SetupRunStanding;
    try { standing = await wiring.standing(personId, companyId, project); } catch { throw unavailable(); }
    // Anything but the two answers is no answer: read as none (never as manage).
    if (!isManage(standing) && standing?.access !== "view") throw notFound();
    // The project is read in the caller's company only.
    let latest;
    try { latest = await flow.projects.latest(project); } catch { throw unavailable(); }
    if (latest === undefined) throw notFound();
    const repositories: EvalCheckRepository[] = latest.definition.repositories.map((repository) => ({ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch, ...(repository.host === undefined ? {} : { host: { kind: repository.host.kind } }) }));
    const deps: EvalCheckCardDeps = {
      store: flow.store, companyId, now: input.now,
      readerFor: async (repository) => { try { return await wiring.readerFor(companyId, repository); } catch { return undefined; } },
      ...(input.log === undefined ? {} : { log: (event, fields) => input.log?.({ event, ...fields }) }),
    };
    if (input.request.method === "GET") return json(200, await evalCheckView(deps, { project, canManage: isManage(standing), repositories }));
    if (input.request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
    if (!isManage(standing)) throw agentXError("FORBIDDEN", EVAL_CHECK_WORDS.notAllowed);
    const basis: SetupRunBasis = standing.basis;
    const view = await setEvalCheck(deps, {
      project, canManage: true, repositories,
      async record(details) {
        const event: AuditEvent = {
          // The choice AND what it replaced are in the id: the same request id with another choice, or a replay of an old id after a later change, is another act and must not be deduped as a replay.
          eventId: `ci_eval_check.set:${companyId}:${project}:${personId}:${details.requestId}:${createHash("sha256").update(`${auditChoice(details.check)}\u0001${auditChoice(details.previous)}`, "utf8").digest("hex").slice(0, 16)}`,
          companyId, at: new Date(input.now()).toISOString(), actor: { type: "person", id: personId },
          action: "ci_eval_check.set", subject: { type: "project", id: project },
          details: { project, basis, requestId: details.requestId, check: details.check?.name ?? "none", ...(details.check?.source === undefined ? {} : { source: details.check.source }), previous: details.previous?.name ?? "none" },
        };
        await input.audit.record(event);
      },
    }, bodyOf(input.request));
    return json(200, view);
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(unavailable());
  }
}
