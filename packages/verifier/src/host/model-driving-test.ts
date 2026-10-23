import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DRIVING_TEST_BUDGET, WEB_API_AGENT_PROBE_GOAL, e2eModelRouteRevision, type E2EModelFailure, type E2EModelReceipt, type E2EModelRouteDefinition } from "@agentx/contracts";
import { collectE2EApplicationRun } from "../application-collection.js";
import { qualifyE2EApplicationCollection } from "../application-result-adapter.js";
import { runIsolatedE2EApplication } from "../application-runtime.js";
import { e2eApplicationGroupAgentSteps } from "../application-scenarios.js";
import { resolveE2EExecutorSuite } from "../executor/suite.js";
import { createDockerApplicationHost, type DockerApplicationModelChannel, type DockerCli } from "./docker-application-host.js";
import { webApiDrivingTestPlan, webApiProbeRunInput } from "./web-api-probe-plan.js";
import { clearEarlierAttempt } from "./web-api-probe-runner.js";
import { installedWebApiQualificationAppRoot, stageWebApiQualificationApp, verifyWebApiQualificationApp } from "./web-api-qualification-app.js";

/**
 * The on-account driving test (M1.4 Task 4.10C): a short, bounded, real navigation of the built-in fixture app by the model the installation chose, through the real executor and
 * the governed model channel, judged by the deterministic oracle and never by a model.
 *
 * `runModelDrivingTest` is the sequence and nothing else, with the model calls injected so it can be tested without Docker or a provider:
 * 1. the single first call of a fixed prompt (the old canary). A failure ends the test with that call's class, except `request-rejected`, which gets ONE retry in the minimal request
 *    shape (the plan's D-3). A failed retry ends the test.
 * 2. the navigation, in whichever shape passed.
 * It passes only when the oracle's verdict on the navigation case is PASS. The whole test's budget (`DRIVING_TEST_BUDGET`) is enforced by the worker on the routes it hands in.
 */
export { DRIVING_TEST_BUDGET };

export type DrivingShape = "standard" | "minimal";

/** What the navigation showed: the oracle's verdict on the one case, and the executor's own account of it, beside the receipts the worker wrote. */
export interface NavigationOutcome {
  /** `none` when no navigation verdict exists (the run was not available, or the collector had nothing to say). */
  caseVerdict: "passed" | "failed" | "unknown" | "none";
  /** A fixed reason code of an unknown or failed case, or null. */
  caseCode: string | null;
  /** Every receipt the worker wrote for the navigation, whatever its outcome. */
  receipts: readonly E2EModelReceipt[];
  /** The oracle's facts: the model calls its collector verified against the executor's report, the downloads its CSV check saw, and whether that check passed. Null without a verdict. */
  reported: { modelCalls: number; downloads: number; csvPassed: boolean } | null;
}

export interface DrivingTestDependencies {
  /** One governed call of the fixed prompt in `shape`, as call number `callIndex` of the first phase. Never throws: a failure is its receipt. */
  firstCall(shape: DrivingShape, callIndex: number): Promise<E2EModelReceipt>;
  /** The navigation in `shape`. It must not throw for anything the model or the app did; a thrown error is the test's failure. */
  navigate(shape: DrivingShape): Promise<NavigationOutcome>;
}

export interface DrivingTestOutcome {
  payloadShape: DrivingShape;
  outcome: "passed" | "failed";
  failure: E2EModelFailure | null;
  caseVerdict: NavigationOutcome["caseVerdict"];
  caseCode: string | null;
  receipts: E2EModelReceipt[];
  reported: NavigationOutcome["reported"];
}

const byTime = (left: E2EModelReceipt, right: E2EModelReceipt) => left.startedAt.localeCompare(right.startedAt) || left.callIndex - right.callIndex;

/** The failure of the last call that failed, by time, or null when none has a class. */
export function lastFailureOf(receipts: readonly E2EModelReceipt[]): E2EModelFailure | null {
  const failed = [...receipts].sort(byTime).filter((item) => item.outcome !== "ok").at(-1);
  return failed?.failure ?? null;
}

export async function runModelDrivingTest(deps: DrivingTestDependencies): Promise<DrivingTestOutcome> {
  const receipts: E2EModelReceipt[] = [];
  let shape: DrivingShape = "standard";
  const stopped = (): DrivingTestOutcome => ({ payloadShape: shape, outcome: "failed", failure: lastFailureOf(receipts), caseVerdict: "none", caseCode: null, receipts, reported: null });
  const first = await deps.firstCall("standard", 0);
  receipts.push(first);
  if (first.outcome !== "ok") {
    // Only a request the provider refused as malformed is worth one more try, in the shape that sends the least. Nothing else is retried.
    if (first.failure?.class !== "request-rejected") return stopped();
    shape = "minimal";
    const retry = await deps.firstCall("minimal", 1);
    receipts.push(retry);
    if (retry.outcome !== "ok") return stopped();
  }
  const navigation = await deps.navigate(shape);
  receipts.push(...navigation.receipts);
  const passed = navigation.caseVerdict === "passed" && !receipts.some((item) => item.outcome === "budget");
  return { payloadShape: shape, outcome: passed ? "passed" : "failed", failure: passed ? null : lastFailureOf(receipts), caseVerdict: navigation.caseVerdict, caseCode: navigation.caseCode, receipts, reported: navigation.reported };
}

// ---------------------------------------------------------------------------------------------------------------------
// The navigation on a Docker host
// ---------------------------------------------------------------------------------------------------------------------

export interface DrivingChannelRequest {
  runId: string;
  goal: string;
  modelRoute: Readonly<{ routeId: string; routeRevision: string }>;
  allowedSteps: ReadonlyArray<Readonly<{ caseId: string; stepIndex: number }>>;
}

export interface DrivingNavigatorDependencies {
  docker: DockerCli;
  executorImage: string;
  buildImage: string;
  /** A directory on the Docker host at the same path inside this process. */
  runRoot: string;
  /** The model channel of the run: the worker's, on the chosen route, under the test's budget. */
  modelChannelFor(request: DrivingChannelRequest): DockerApplicationModelChannel;
  /** The receipts the worker's evidence collector holds for the run, read after it. */
  receiptsOf(): readonly E2EModelReceipt[];
  roundScope?: "standard" | "qualification";
  qualificationAppRoot?: string;
  now?: () => number;
  collect?: typeof collectE2EApplicationRun;
}

const CODE = /^[a-z][a-z0-9-]{0,63}$/;
/** The fixed code a case's reason starts with (`agent-no-download: ...`), or `unspecified`; never any of the rest. */
export function reasonCodeOf(reason: string | undefined): string {
  const head = (reason ?? "").split(":")[0]?.trim() ?? "";
  return CODE.test(head) ? head : "unspecified";
}

/** The navigation of the driving test as the runner does it: stage the pinned app, run the real plan on the Docker host, collect, and read the oracle's verdict. */
export function createDrivingNavigator(deps: DrivingNavigatorDependencies): (input: { definition: E2EModelRouteDefinition; runId: string; signal: AbortSignal }) => Promise<NavigationOutcome> {
  const collect = deps.collect ?? collectE2EApplicationRun;
  const now = deps.now ?? (() => Date.now());
  const scope = deps.roundScope ?? "standard";
  return async ({ definition, runId, signal }) => {
    const staged = join(deps.runRoot, `candidate-${runId}`);
    const appRoot = deps.qualificationAppRoot ?? installedWebApiQualificationAppRoot();
    const unavailable = (code: string): NavigationOutcome => ({ caseVerdict: "none", caseCode: code, receipts: [...deps.receiptsOf()], reported: null });
    await verifyWebApiQualificationApp(appRoot);
    await clearEarlierAttempt({ docker: deps.docker, executorImage: deps.executorImage, runRoot: deps.runRoot } as never, runId, staged);
    await stageWebApiQualificationApp(appRoot, staged);
    try {
      const plan = webApiDrivingTestPlan(definition, { appRoot: staged, runId });
      const host = createDockerApplicationHost({ docker: deps.docker, executorImage: deps.executorImage, buildImage: deps.buildImage, runRoot: deps.runRoot, now,
        admission: plan.plan.admission, groupId: plan.plan.groupId, candidateSourceDir: staged,
        modelChannel: deps.modelChannelFor({ runId, goal: WEB_API_AGENT_PROBE_GOAL, modelRoute: { routeId: definition.routeId, routeRevision: e2eModelRouteRevision(definition) }, allowedSteps: e2eApplicationGroupAgentSteps(plan.compiled) }) });
      const run = await runIsolatedE2EApplication({ input: webApiProbeRunInput(plan) as never, compiled: plan.compiled, ports: host, signal });
      if (run.unavailableReason !== null || run.actualRun === null) return unavailable(reasonCodeOf(run.unavailableReason ?? undefined));
      const inputs = await host.readCollectionInputs(signal);
      const resolved = resolveE2EExecutorSuite(plan.plan);
      const collected = collect({ actual: run.actualRun, compiled: resolved.suite, binding: resolved.binding, round: resolved.round, ...inputs, roundScope: scope });
      if (collected.collection === null || collected.oracle === null) return unavailable(reasonCodeOf(collected.unavailableReason ?? undefined));
      const qualification = qualifyE2EApplicationCollection({ ...collected.oracle, roundScope: scope }, collected.collection);
      const verdict = qualification.result?.cases[0];
      if (qualification.result === null || verdict === undefined) return { caseVerdict: "unknown", caseCode: reasonCodeOf(qualification.reason), receipts: [...deps.receiptsOf()], reported: null };
      const csv = verdict.assertionReceipts.filter((item) => plan.scenario.assertions[item.assertionIndex]?.kind === "csv");
      const verified = new Set(qualification.result.modelReceiptIds);
      const receipts = [...deps.receiptsOf()];
      return {
        caseVerdict: verdict.status === "passed" ? "passed" : verdict.status === "failed" ? "failed" : "unknown",
        caseCode: verdict.status === "passed" ? null : reasonCodeOf(verdict.reason),
        receipts,
        reported: { modelCalls: receipts.filter((item) => item.outcome === "ok" && verified.has(item.receiptId)).length,
          downloads: csv.filter((item) => item.status !== "unavailable").length, csvPassed: csv.length > 0 && csv.every((item) => item.status === "passed") },
      };
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  };
}
