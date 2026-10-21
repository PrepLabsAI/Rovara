import { join } from "node:path";
import type { E2EScenario } from "@agentx/contracts";
import { createWebApiProbePlan, type WebApiProbePlan } from "../../packages/verifier/src/host/web-api-probe-plan.js";

const repoRoot = join(import.meta.dirname, "../..");
/**
 * The Task 3.2 fixture app: a small orders app whose users come from the recipe's seed command (`rovara-accounts-file/v1`, records in /data) and who sign in through its own
 * form (`rovara-form-login/v1`; the test ids are the ones orders-web-m14 keeps, so Task 3.8 can reconcile the two). Three accounts in two tenants:
 * `orders-viewer` and `orders-owner` in tenant-a, `orders-owner-b` in tenant-b.
 */
export const ACCOUNTS_FIXTURE_ROOT = join(repoRoot, "tests/fixtures/e2e-accounts-app");
/** The files a candidate carries (the fixture app as it ships, and its seed). */
export const ACCOUNTS_APP_FILES = ["package.json", "server.mjs", "seed.mjs", "public", "fixtures", "defects"];
export const ACCOUNT_PROFILES = { viewer: "orders-viewer", owner: "orders-owner", ownerB: "orders-owner-b" } as const;

const base = (scenarioId: string, targetId: string, accountProfileId: string) => ({ scenarioId, requirementId: `${scenarioId}-requirement`, requestedTargetIds: [targetId], required: true,
  accountProfileId, minimumEvidence: "runtime" as const, requiredRealComponentIds: [] as string[] });

/** Web scenarios, one per account: the viewer has no export button, the owner exports its tenant's orders, the other tenant's owner sees none of tenant-a's rows. */
export const webAccountScenarios = {
  viewer: { accountProfileId: ACCOUNT_PROFILES.viewer, scenario: (targetId: string): E2EScenario => ({ ...base("viewer-cannot-export", targetId, ACCOUNT_PROFILES.viewer),
    steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "export-csv", equals: false }] }) },
  owner: { accountProfileId: ACCOUNT_PROFILES.owner, scenario: (targetId: string): E2EScenario => ({ ...base("owner-exports-orders", targetId, ACCOUNT_PROFILES.owner),
    steps: [{ kind: "navigate", path: "/" }, { kind: "click", testId: "export-csv" }],
    assertions: [{ kind: "csv", downloadName: "orders.csv", columns: ["id", "customer", "total", "state"], rows: [["a1", "Ada", "12.5", "ready"], ["a2", "Grace", "23", "ready"]] }] }) },
  /** What the page says about the signed-in owner: its name and role (never an email or a token); an assertion on text puts the page's actual text into the observations. */
  ownerIdentity: { accountProfileId: ACCOUNT_PROFILES.owner, scenario: (targetId: string): E2EScenario => ({ ...base("owner-identity-text", targetId, ACCOUNT_PROFILES.owner),
    steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "text", testId: "identity", equals: "Rovara orders-owner (owner)" }] }) },
  ownerB: { accountProfileId: ACCOUNT_PROFILES.ownerB, scenario: (targetId: string): E2EScenario => ({ ...base("other-tenant-sees-no-orders-of-a", targetId, ACCOUNT_PROFILES.ownerB),
    steps: [{ kind: "navigate", path: "/" }],
    assertions: [{ kind: "visible", testId: "order-row-a1", equals: false }, { kind: "visible", testId: "order-row-b1", equals: true }] }) },
} as const;

/** API scenarios on the same accounts: the export is refused to the viewer (403) and given to the owner (200), through the session the form login made. */
export const apiAccountScenarios = {
  viewer: { accountProfileId: ACCOUNT_PROFILES.viewer, scenario: (targetId: string): E2EScenario => ({ ...base("api-viewer-refused", targetId, ACCOUNT_PROFILES.viewer),
    steps: [{ kind: "request", requestId: "export", path: "/api/orders.csv", method: "GET", body: {} }], assertions: [{ kind: "http-status", path: "/api/orders.csv", method: "GET", equals: 403 }] }) },
  owner: { accountProfileId: ACCOUNT_PROFILES.owner, scenario: (targetId: string): E2EScenario => ({ ...base("api-owner-allowed", targetId, ACCOUNT_PROFILES.owner),
    steps: [{ kind: "request", requestId: "export", path: "/api/orders.csv", method: "GET", body: {} }], assertions: [{ kind: "http-status", path: "/api/orders.csv", method: "GET", equals: 200 }] }) },
} as const;

export type AccountsPlanOptions = Partial<Pick<Parameters<typeof createWebApiProbePlan>[0], "deadlineMs" | "healthTimeoutMs" | "recipeStart" | "recipeBuild" | "recipeSeed">> & {
  /** Which web scenarios to plan; all three by default. */
  web?: readonly (keyof typeof webAccountScenarios)[];
  /** Plan the API scenarios (owner and viewer) instead of the web ones. */
  api?: boolean;
};

/** A real executor plan for the fixture app: its `package.json` contract through discovery, selection and the compiler, one group, one case per account. */
export function createAccountsExecutorPlan(options: AccountsPlanOptions = {}): WebApiProbePlan {
  const { web, api, ...rest } = options;
  const accountScenarios = api ? [apiAccountScenarios.viewer, apiAccountScenarios.owner]
    : (web ?? ["viewer", "owner", "ownerB"]).map((key) => webAccountScenarios[key]);
  return createWebApiProbePlan({ probe: api ? "api-state-positive-v1" : "web-csv-positive-v1", appRoot: ACCOUNTS_FIXTURE_ROOT, accountScenarios, ...rest });
}
