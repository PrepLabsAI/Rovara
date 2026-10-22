import { join } from "node:path";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, type E2EScenario } from "@agentx/contracts";
import { createWebApiProbePlan, type WebApiProbePlan } from "../../packages/verifier/src/host/web-api-probe-plan.js";

const repoRoot = join(import.meta.dirname, "../..");
/**
 * The Task 3.3 fixture app: a storefront with a start script and a lockfile and no `agentx.e2e` project contract, so discovery infers its launch recipe (`npm ci`, `npm start`
 * with the port in PORT, health on `/`). It has no accounts: its scenarios are signed-out ones (`rovara-anonymous`).
 */
export const INFERRED_FIXTURE_ROOT = join(repoRoot, "tests/fixtures/e2e-inferred-web-app");
/** The files a candidate carries (the fixture app as it ships). */
export const INFERRED_APP_FILES = ["package.json", "package-lock.json", "server.mjs"];

const base = (scenarioId: string, targetId: string) => ({ scenarioId, requirementId: `${scenarioId}-requirement`, requestedTargetIds: [targetId], required: true,
  accountProfileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, minimumEvidence: "runtime" as const, requiredRealComponentIds: [] as string[] });

/** Signed-out web scenarios: the welcome page shows, no admin link is offered, and (the failing one) a claim the page cannot meet. */
export const anonymousWebScenarios = {
  welcome: { accountProfileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, scenario: (targetId: string): E2EScenario => ({ ...base("visitor-sees-welcome", targetId),
    steps: [{ kind: "navigate", path: "/" }],
    assertions: [{ kind: "visible", testId: "welcome", equals: true }, { kind: "text", testId: "visitor", equals: "You are browsing as a visitor." }] }) },
  noAdmin: { accountProfileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, scenario: (targetId: string): E2EScenario => ({ ...base("visitor-has-no-admin-link", targetId),
    steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "admin-link", equals: false }] }) },
  /**
   * A scenario the page fails on purpose, so that its observation holds the page's own text: the visitor id the storefront prints (36 characters, also in a cookie and in local
   * storage). A visitor id is no credential, so the case must be FAILED, never a credential leak.
   */
  echoesVisitorId: { accountProfileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, scenario: (targetId: string): E2EScenario => ({ ...base("visitor-id-is-shown", targetId),
    steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "text", testId: "visitor-id", equals: "no visitor id" }] }) },
  /** A claim the storefront cannot meet: the case must be FAILED (an assertion that does not hold), never UNKNOWN. */
  expectsAdmin: { accountProfileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, scenario: (targetId: string): E2EScenario => ({ ...base("visitor-expects-admin-link", targetId),
    steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "admin-link", equals: true }] }) },
} as const;

export type InferredPlanOptions = Partial<Pick<Parameters<typeof createWebApiProbePlan>[0], "deadlineMs" | "healthTimeoutMs">> & {
  /** Which scenarios to plan; the first two by default. All of them are in one group, one case each, with no account. */
  scenarios?: readonly (keyof typeof anonymousWebScenarios)[];
};

/** A real executor plan for the fixture app: no project contract, discovery's inferred recipe, selection with the qualified runtime row, the compiler. One group, one anonymous case per scenario. */
export function createInferredExecutorPlan(options: InferredPlanOptions = {}): WebApiProbePlan {
  const { scenarios, ...rest } = options;
  return createWebApiProbePlan({ probe: "web-csv-positive-v1", appRoot: INFERRED_FIXTURE_ROOT, inferred: true,
    accountScenarios: (scenarios ?? ["welcome", "noAdmin"]).map((key) => anonymousWebScenarios[key]), ...rest });
}
