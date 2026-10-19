import { join } from "node:path";
import { WEB_API_PROBE_APP_ORIGIN, createWebApiProbePlan, type WebApiProbeName, type WebApiProbePlan } from "../../packages/verifier/src/host/web-api-probe-plan.js";

const repoRoot = join(import.meta.dirname, "../..");
/** The source fixture app; a test keeps it byte-identical to the installed qualification app the production runner uses. */
export const ORDERS_FIXTURE_ROOT = join(repoRoot, "tests/fixtures/e2e-web-api-app");
/** The loopback origin compiled suites name; the plan itself reaches the app at http://app:4317. */
export const ORDERS_APP_ORIGIN = WEB_API_PROBE_APP_ORIGIN;

/** The scenarios a probe runs. Each is an ordinary source-style scenario that the real compiler turns into a CLI suite. */
export type OrdersProbeName = WebApiProbeName;
export type OrdersExecutorFixture = WebApiProbePlan;

/** The production probe plan builder, pointed at the source fixture. */
export function createOrdersExecutorPlan(options: Omit<Parameters<typeof createWebApiProbePlan>[0], "appRoot">): OrdersExecutorFixture {
  return createWebApiProbePlan({ ...options, appRoot: ORDERS_FIXTURE_ROOT });
}
