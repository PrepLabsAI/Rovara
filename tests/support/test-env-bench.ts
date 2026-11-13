// A bench for the test environment's tests: one registered project on an in-memory store, the approval gate over the local owner's session, and the three calls a person makes (propose, prove, approve).
// The Prove report is made from the body the way a passing run would report it, so a test only says what differs.
import { randomUUID } from "node:crypto";
import { IMPLICIT_COMPANY_ID, type OrgId, type TestEnvironmentBody } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/core/src/ports/policy-defaults.js";
import { createDecisionGate, type DecisionAttempt } from "../../packages/core/src/core/decisions/approval-gate.js";
import type { TestEnvDeps } from "../../packages/core/src/core/test-env/deps.js";
import { TEST_ENVIRONMENT_KIND, createTestEnvironmentSubject, proposeTestEnvironment, recordTestEnvProveReport, testEnvironmentSubjectId, type TestEnvironmentDecisionDetails } from "../../packages/core/src/core/test-env/environment.js";
import { projectStore } from "./test-env-world.js";

export const BENCH_ORG: OrgId = IMPLICIT_COMPANY_ID;
export const BENCH_OWNER = localOwnerPrincipal();
/** Built at run time: nothing in a test file looks like a key. */
export const BENCH_SESSION = ["local", "session", "secret", "for", "tests"].join("-");

export interface BenchOptions {
  project?: string;
  env?: NodeJS.ProcessEnv;
  startMs?: number;
  serviceCatalog?: TestEnvDeps["serviceCatalog"];
  fixtureStore?: TestEnvDeps["fixtureStore"];
  devcontainer?: boolean;
  /** False: no settings are stored for the project (a project whose settings cannot be read). Default true. */
  registered?: boolean;
  /** A store of the caller's (for example one with the task flow's indexes). */
  store?: MemoryDocumentStore;
}

export async function bench(options: BenchOptions = {}) {
  const project = options.project ?? "service";
  const clock = { now: options.startMs ?? Date.UTC(2026, 10, 3, 10, 0, 0) };
  const store: MemoryDocumentStore = options.registered === false ? options.store ?? new MemoryDocumentStore() : await projectStore(BENCH_ORG, project, { ...(options.devcontainer === undefined ? {} : { devcontainer: options.devcontainer }), ...(options.store === undefined ? {} : { store: options.store }) });
  const deps: TestEnvDeps = {
    store, now: () => clock.now, env: options.env ?? { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" },
    ...(options.serviceCatalog === undefined ? {} : { serviceCatalog: options.serviceCatalog }), ...(options.fixtureStore === undefined ? {} : { fixtureStore: options.fixtureStore }),
  };
  const approvers = createLocalOwnerApprovers({ owner: BENCH_OWNER, now: () => new Date(clock.now), verifySession: (token) => token === BENCH_SESSION });
  const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [createTestEnvironmentSubject(deps, { companyId: BENCH_ORG })], now: () => new Date(clock.now) });

  const propose = (body: unknown, extra: Partial<Parameters<typeof proposeTestEnvironment>[1]> = {}) => proposeTestEnvironment(deps, { orgId: BENCH_ORG, project, proposedBy: "owner", body, ...extra });
  /** The report a passing run of this body would make: setup and the full suite, and the two dependency steps when it has dependencies. */
  const passing = (digest: string, body: TestEnvironmentBody, over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, proposalDigest: digest,
    steps: [{ step: "setup", status: "passed", durationMs: 0 }, { step: "full_suite", status: "passed", durationMs: 0 }, ...((body.dependencies?.length ?? 0) > 0 ? [{ step: "dependencies", status: "passed", durationMs: 0 }, { step: "dependency_usage", status: "passed", durationMs: 0 }] : [])],
    services: body.services.map((service) => ({ name: service.name, modeUsed: "mocked" })), finishedAt: "2026-11-03T10:00:00.000Z", ...over,
  });
  const prove = (digest: string, body: TestEnvironmentBody, over: Record<string, unknown> = {}) => recordTestEnvProveReport(deps, { orgId: BENCH_ORG, project, report: passing(digest, body, over) });
  const proposeAndProve = async (body: TestEnvironmentBody, extra: Partial<Parameters<typeof proposeTestEnvironment>[1]> = {}) => {
    const proposed = await propose(body, extra);
    await prove(proposed.digest, body);
    return proposed;
  };
  /** An approval attempt for the revision after `current` (0 when none is approved). */
  const attempt = (digest: string, current = 0, over: Partial<DecisionAttempt> & { details?: TestEnvironmentDecisionDetails } = {}): DecisionAttempt => ({
    companyId: BENCH_ORG, kind: TEST_ENVIRONMENT_KIND, subjectId: testEnvironmentSubjectId(project, digest), requestId: randomUUID(), outcome: "approve", seen: { revision: current + 1, artifactDigest: digest },
    credentials: [{ method: LOCAL_SESSION_METHOD, token: BENCH_SESSION }], ...over,
  });
  const approve = (digest: string, current = 0, over: Partial<DecisionAttempt> & { details?: TestEnvironmentDecisionDetails } = {}) => gate.decide(attempt(digest, current, over));
  return { project, clock, store, deps, gate, propose, prove, proposeAndProve, attempt, approve };
}
