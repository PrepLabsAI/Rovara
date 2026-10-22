import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_MODEL_CHANNEL_SCHEMA_VERSION, E2E_MODEL_CHANNEL_SOCKET_PATH, E2EExecutorPlanSchema, e2eModelRouteRevision, generateE2EAgentValueKey, readE2EApplicationProjectContract,
  type E2EExecutorPlan, type E2EScenario } from "@agentx/contracts";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { e2eAgentRoutePolicyLimits } from "../../packages/broker/src/e2e/model-route-registry.js";
import { createWebApiProbePlan, type WebApiProbePlan, type WebApiProbeRunner } from "../../packages/verifier/src/host/web-api-probe-plan.js";

/**
 * Task 4.3b's fixture app and plans: `tests/fixtures/orders-web-m14` (the m13 orders app rebuilt for AI navigation: its export buttons are "Download orders" (test id `download-orders`) and
 * a decoy "Download invoices", and nothing is labelled "Export CSV"), a plan whose one case has an agent step, and the scripted route that drives it.
 */
export const ORDERS_M14_ROOT = join(import.meta.dirname, "../fixtures/orders-web-m14");
/** The files a candidate carries: what the app runs from. */
export const ORDERS_M14_APP_FILES = ["package.json", "server.mjs", "scripts", "public", "fixtures", "inventory", "e2e"];
/** A fixed runtime dating for the tests that run a round and then its replay: one stored registry row gives both the same case ids. */
export const FIXED_RUNTIME_AT = Math.floor(Date.now() / 3_600_000) * 3_600_000;
export const AGENT_GOAL = "Export the orders as a CSV file";
export const SCRIPTED_ROUTE = Object.freeze({ routeId: "rovara-scripted/v1", routeRevision: e2eModelRouteRevision(scriptedE2ERouteDefinition()) });
/** The limits a project that pins this route runs under: the broker derives them from the route's budgets, so the collector accepts the model calls the route allows (Task 4.4a). */
export const SCRIPTED_ROUTE_LIMITS = e2eAgentRoutePolicyLimits(scriptedE2ERouteDefinition().budgets);
export const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** What the owner's CSV holds when the app's inventory service is not reachable (a run with no mock): the page and the export both read an order's stock as unavailable. */
export const ORDERS_CSV_COLUMNS = ["id", "customer", "total", "state", "inventory"];
export const ORDERS_CSV_ROWS = [["a1", "Ada", "12.5", "ready", "unavailable"], ["a2", "Grace", "23", "ready", "unavailable"]];
/** With the approved inventory mock (the Docker host serves it): the mock answers `a1` with in-stock and refuses `a2`. */
export const ORDERS_CSV_ROWS_MOCKED = [["a1", "Ada", "12.5", "ready", "in-stock"], ["a2", "Grace", "23", "ready", "unavailable"]];

export type AgentPlanOptions = {
  goal?: string;
  maxActions?: number;
  /** Steps before the agent step. Default: open the page. */
  before?: E2EScenario["steps"];
  /** Steps after the agent step. */
  after?: E2EScenario["steps"];
  assertions?: E2EScenario["assertions"];
  deadlineMs?: number;
  /** Approve the app's inventory mock for the plan (what a Docker host serves; the local runs have no mock). */
  mock?: boolean;
  /** The task the admission names (a UUID); a journey that signs an invocation for it needs one. */
  taskId?: string;
  /** Adds a second case to the group: a plain one with no agent step (open the page, see the identity), for the cases a group's deterministic and AI-navigated cases share. */
  withDeterministicCase?: boolean;
  /** An audit replay of the case (Task 4.6b): the recordings it serves, as the verified round's upload carried them. The plan pins the scripted route's limits and names no route. */
  replay?: NonNullable<Parameters<typeof createWebApiProbePlan>[0]["replay"]>;
  /** The time the registered runtime row is dated from: a round and its replay pass the same one, so they have the same case ids (a case id is bound to the runtime row). */
  runtimeAt?: number;
  /** The runner the plan's registered runtime records: what the executor image reports on a real host, so the broker's re-collection sees the runtime the run was on. */
  runner?: WebApiProbeRunner;
};

/** A plan with one web case: open the page, an agent step with `goal`, and (by default) the CSV assertion on the owner's orders export. */
export function createOrdersM14AgentPlan(options: AgentPlanOptions = {}): WebApiProbePlan {
  const goal = options.goal ?? AGENT_GOAL;
  return createWebApiProbePlan({ probe: "web-csv-positive-v1", appRoot: ORDERS_M14_ROOT, modelRoute: SCRIPTED_ROUTE, routeLimits: SCRIPTED_ROUTE_LIMITS, ...(options.runner === undefined ? {} : { runner: options.runner }), ...(options.replay === undefined ? {} : { replay: options.replay }), ...(options.runtimeAt === undefined ? {} : { runtimeAt: options.runtimeAt }), healthTimeoutMs: 20_000, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }), ...(options.mock === true ? { mock: true } : {}), ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    accountScenarios: [{ accountProfileId: "orders-owner", scenario: (targetId: string): E2EScenario => ({ scenarioId: "agent-export", requirementId: "orders-export", requestedTargetIds: [targetId], required: true,
      accountProfileId: "orders-owner", minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [...(options.before ?? [{ kind: "navigate" as const, path: "/" }]), { kind: "agent" as const, goal, maxActions: options.maxActions ?? 4 }, ...(options.after ?? [])],
      assertions: options.assertions ?? [{ kind: "csv" as const, downloadName: "orders.csv", columns: ORDERS_CSV_COLUMNS, rows: options.mock === true ? ORDERS_CSV_ROWS_MOCKED : ORDERS_CSV_ROWS }] }) },
    ...(options.withDeterministicCase === true ? [{ accountProfileId: "orders-owner", scenario: (targetId: string): E2EScenario => ({ scenarioId: "plain-identity", requirementId: "orders-identity", requestedTargetIds: [targetId], required: true,
      accountProfileId: "orders-owner", minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "identity", equals: true }] }) }] : [])] });
}

/** The plan as the Docker host writes it for such a group: the fixture's plan plus the model channel (fixed socket path, the admission's route, a fresh value key). */
export function withModelChannel(plan: E2EExecutorPlan, valueKey = generateE2EAgentValueKey()): E2EExecutorPlan {
  return E2EExecutorPlanSchema.parse({ ...plan, modelChannel: { protocol: E2E_MODEL_CHANNEL_SCHEMA_VERSION, socketPath: E2E_MODEL_CHANNEL_SOCKET_PATH, ...SCRIPTED_ROUTE, valueKey } });
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

export type OrdersM14AppProcess = Readonly<{ upstream: string; directory: string; stop(): Promise<void> }>;

/**
 * The m14 app as the host would run it, but on this machine: the accounts file written for the plan's accounts, the recipe's seed command run for real against it, then the app on a
 * loopback port reading the records the seed built. For executor tests that run the real CLI and a real local Chromium without Docker.
 */
export async function startOrdersM14App(fixture: WebApiProbePlan, options: { renamed?: boolean } = {}): Promise<OrdersM14AppProcess> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "orders-m14-app-")));
  const app = join(directory, "app");
  await mkdir(app, { recursive: true });
  for (const file of ORDERS_M14_APP_FILES) await cp(join(ORDERS_M14_ROOT, file), join(app, file), { recursive: true });
  // The candidate of a replay that went stale (Task 4.6b): the owner's download button renamed, so the recorded tap no longer finds its target.
  if (options.renamed === true) {
    const server = join(app, "server.mjs");
    const source = await readFile(server, "utf8");
    const renamed = source.replace('data-testid="download-orders"', 'data-testid="get-orders-file"').replace(">Download orders<", ">Fetch the orders file<");
    if (renamed === source) throw new Error("the m14 app has no download button to rename");
    await writeFile(server, renamed);
  }
  const applicationId = fixture.compiled.originByApplicationId[0]!.applicationId;
  const contract = readE2EApplicationProjectContract(fixture.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot, applicationId)!;
  const accountsFile = join(directory, "rovara-accounts.json");
  await writeFile(accountsFile, JSON.stringify({ schemaVersion: "rovara-accounts/v1", accounts: fixture.plan.accounts.map((account) => {
    const profile = contract.accountProfiles.find((item) => item.profileId === account.profileId)!;
    return { profileId: account.profileId, email: account.email, password: account.password, tenantRef: profile.tenantRef, roleRef: profile.roleRef };
  }) }));
  const data = join(directory, "data");
  await mkdir(data);
  const env = { PATH: process.env.PATH ?? "", ROVARA_ACCOUNTS_FILE: accountsFile, ROVARA_DATA_DIR: data };
  execFileSync(process.execPath, ["scripts/seed.mjs"], { cwd: app, env, stdio: "pipe" });
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["server.mjs"], { cwd: app, env: { ...env, APP_PORT: String(port) }, stdio: "ignore" });
  const upstream = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${upstream}/health`)).status === 200) break; } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { upstream, directory, async stop() { child.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); } };
}
