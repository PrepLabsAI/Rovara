// A project's test environment on `rovara up`: the owner routes (the CLI and the MCP tools call them), the local page and its Approve button, and the pieces the task flow takes (the environment the tasks pin,
// the approval subject the gate decides).
//
// Authority: a test environment is approved on its page, by the owner, with the proof the page signs for exactly one request, revision and digest. The session token a tool holds is not an approval proof, so a
// tool that asks to approve is told to open the page (as for a plan). Proposing is the owner's own act through the API: a proposal changes nothing until it is proved and approved.
import { randomUUID } from "node:crypto";
import { AgentXError, agentXError, type ApprovalProof, type AuditSink, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import { localResultOf } from "../../core/decisions/local-actions.js";
import type { DecisionGate } from "../../core/decisions/approval-gate.js";
import type { LocalActionResult, TestEnvironmentPageView } from "../../core/local-pages/views.js";
import type { TestEnvDeps } from "../../core/test-env/deps.js";
import { TEST_ENVIRONMENT_KIND, createTestEnvironmentSubject, proposeTestEnvironment, testEnvironmentSubjectId } from "../../core/test-env/environment.js";
import { testEnvironmentView, type TestEnvironmentView } from "../../core/test-env/local-view.js";
import { createTaskTestEnvironment, type TaskTestEnvironment } from "../../core/test-env/seam.js";
import { testEnvironmentEnabled } from "../../core/test-env/switch.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { listProjects } from "./projects.js";

export const APPROVE_TEST_ENVIRONMENT_ON_THE_PAGE = "A test environment is approved on its local page, by you. Run `rovara test-env open <project>` to open it; an assistant cannot approve for you.";
const PATH = /^\/v1\/app\/projects\/([A-Za-z0-9._-]{1,100})\/test-environment(?:\/(propose|open))?$/u;
const OPEN_NOT_AVAILABLE = "Rovara could not open a browser. Open the review pages from the terminal where `rovara up` runs.";

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

export interface LocalTestEnvironmentOptions {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  audit: AuditSink;
  env?: NodeJS.ProcessEnv | undefined;
  /** The decision gate, once it exists (it is built with this module's subject). */
  gate: () => DecisionGate;
  /** Opens a page in the owner's browser, from this process. */
  openPage: (path: string) => Promise<void>;
  /** Lines other features add to a project's page (the nightly run's last night, the saved image), plain text. */
  extraLines?: (project: string) => Promise<string[]>;
  /** Called after an approval was recorded (the nightly schedule follows the approved environment). A failure here never undoes the approval. */
  onApproved?: (project: string) => Promise<void>;
  serviceCatalog?: TestEnvDeps["serviceCatalog"];
  fixtureStore?: TestEnvDeps["fixtureStore"];
  log?: (entry: Record<string, unknown>) => void;
}

export interface LocalTestEnvironment {
  deps: TestEnvDeps;
  /** What the task flow pins and plans from. */
  taskEnvironment: TaskTestEnvironment;
  /** For the approval gate's `subjects`. */
  subject: ReturnType<typeof createTestEnvironmentSubject>;
  routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined>;
  pageData: {
    listTestEnvironments(): Promise<string[] | undefined>;
    getTestEnvironmentPage(project: string): Promise<TestEnvironmentPageView | undefined>;
  };
  decideTestEnvironment(input: { project: string; approval: { requestId: string; revision: number; artifactDigest: string }; proof: ApprovalProof }): Promise<LocalActionResult>;
}

export function createLocalTestEnvironment(options: LocalTestEnvironmentOptions): LocalTestEnvironment {
  const env = options.env ?? process.env;
  const deps: TestEnvDeps = {
    store: options.store, now: options.now, audit: options.audit, env,
    ...(options.serviceCatalog === undefined ? {} : { serviceCatalog: options.serviceCatalog }), ...(options.fixtureStore === undefined ? {} : { fixtureStore: options.fixtureStore }),
  };
  const enabled = (): boolean => testEnvironmentEnabled(env);
  const knownProject = async (project: string): Promise<boolean> => (await listProjects(options.store, options.companyId)).some((entry) => entry.name === project);

  const pageView = async (project: string): Promise<TestEnvironmentPageView> => {
    const view = await testEnvironmentView(deps, options.companyId, project);
    const extra = await options.extraLines?.(project).catch(() => []);
    return {
      project,
      ...(view.approved === undefined ? {} : { approved: { revision: view.approved.revision, approvedAt: view.approved.approvedAt, ...(view.approved.approvedBy === undefined ? {} : { approvedBy: view.approved.approvedBy }), lines: view.approved.lines, checks: view.approved.checks } }),
      ...(view.proposal === undefined ? {} : { proposal: { digest: view.proposal.digest, proposedAt: view.proposal.proposedAt, risk: view.proposal.risk, lessSafe: view.proposal.lessSafe, changes: view.proposal.changes, proved: view.proposal.proved, ...(view.proposal.expiresAt === undefined ? {} : { expiresAt: view.proposal.expiresAt }) } }),
      // Only a proposal that passed a Prove run can be approved, so only it gets an Approve button.
      ...(view.proposal?.proved === true ? { approval: { requestId: randomUUID(), revision: view.proposal.nextRevision, artifactDigest: view.proposal.digest, kind: "test-environment" as const, risk: view.proposal.risk } } : {}),
      ...(extra === undefined || extra.length === 0 ? {} : { extra }),
    };
  };

  return {
    deps,
    taskEnvironment: createTaskTestEnvironment(deps, { orgId: options.companyId }),
    subject: createTestEnvironmentSubject(deps, { companyId: options.companyId }),
    pageData: {
      async listTestEnvironments() {
        if (!enabled()) return undefined;
        return (await listProjects(options.store, options.companyId)).map((project) => project.name);
      },
      async getTestEnvironmentPage(project) {
        if (!enabled() || !(await knownProject(project))) return undefined;
        return pageView(project);
      },
    },
    async decideTestEnvironment(input) {
      if (!enabled()) return { ok: false, reason: "not_found", message: "That is no longer there." };
      // The proof names the request, revision and digest the person saw; the gate checks them against the stored state.
      if (input.proof.requestId !== input.approval.requestId || input.proof.revision !== input.approval.revision || input.proof.artifactDigest !== input.approval.artifactDigest) return { ok: false, reason: "invalid", message: "That was not understood." };
      const result = await options.gate().decide({
        companyId: options.companyId, kind: TEST_ENVIRONMENT_KIND, subjectId: testEnvironmentSubjectId(input.project, input.approval.artifactDigest), requestId: input.approval.requestId, outcome: "approve",
        seen: { revision: input.approval.revision, artifactDigest: input.approval.artifactDigest },
        credentials: [{ method: input.proof.method, token: input.proof.token, ...(input.proof.claimedAccount === undefined ? {} : { claimedAccount: input.proof.claimedAccount }) }],
        details: {},
      });
      if (result.status === "decided") await options.onApproved?.(input.project).catch((error: unknown) => options.log?.({ event: "test_environment.after_approval_failed", error: error instanceof Error ? error.name : "unknown" }));
      // A refusal for a reason of the environment itself says it in the gate's words (production named, not proved yet, a seed file not checked); the gate never puts a value in them.
      if (result.status === "refused" && result.reason === "invalid") return { ok: false, reason: "invalid", message: result.detail };
      return localResultOf(result, "Approved. Tasks that start from now on use it.");
    },
    async routes(request, caller) {
      const url = new URL(request.path, "http://local");
      const match = PATH.exec(url.pathname);
      if (match === null) return undefined;
      const project = match[1] ?? "";
      const action = match[2];
      try {
        if (!enabled()) throw agentXError("NOT_AVAILABLE_HERE", "The test environment is switched off on this install.");
        if (!(await knownProject(project))) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
        if (action === undefined && request.method === "GET") return json(200, await testEnvironmentView(deps, options.companyId, project) satisfies TestEnvironmentView);
        if (action === "propose" && request.method === "POST") {
          const body = bodyOf(request) as { environment?: unknown; valueSources?: unknown };
          if (typeof body !== "object" || body === null || body.environment === undefined) throw agentXError("CONFIG_INVALID", "environment: send the test environment to propose");
          const proposed = await proposeTestEnvironment(deps, { orgId: options.companyId, project, proposedBy: caller.principal.displayName, proposer: { provider: caller.principal.provider, personId: caller.principal.personId, displayName: caller.principal.displayName }, client: caller.client ?? "api", body: body.environment, ...(body.valueSources === undefined ? {} : { valueSources: body.valueSources }) });
          return json(200, { proposal: proposed, state: await testEnvironmentView(deps, options.companyId, project), approve: APPROVE_TEST_ENVIRONMENT_ON_THE_PAGE });
        }
        if (action === "open" && request.method === "POST") {
          try { await options.openPage(`/test-environment/${encodeURIComponent(project)}`); } catch { throw agentXError("RUNTIME_UNAVAILABLE", OPEN_NOT_AVAILABLE); }
          return json(200, { opened: true });
        }
        return undefined;
      } catch (error) {
        if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        throw error;
      }
    },
  };
}
