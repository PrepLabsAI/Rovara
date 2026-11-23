import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { E2EApplicationPlanIntentSchema, canonicalJson, e2eAnonymousRuntimeAccountRef, e2eApiSchemaComponentId, readE2EApplicationProjectContract, workflowSendBackOffered, type E2EScenario } from "@agentx/contracts";

import { accountRegistryEntriesFromRows, latestAccountRef } from "../../packages/broker/src/e2e/application-account-registry.js";



import { MAYA } from "../support/developer-task-broker.js";

import { PROFILE } from "../support/e2e-application-plan-fixtures.js";
import { ACCOUNTS_APP_FILES, ACCOUNTS_FIXTURE_ROOT, webAccountScenarios } from "../support/e2e-accounts-fixture.js";
import { planOwnerWebAndApi } from "../support/e2e-web-and-api-plan.js";
import { INFERRED_APP_FILES, INFERRED_FIXTURE_ROOT, anonymousWebScenarios } from "../support/e2e-inferred-fixture.js";
import { JOURNEY_COMPANY as TEST_ORG, journeyProjectPk as testProjectPk, startCoreBrowserJourney, readJourneyTask, readJourneyResults, journeyNoticeBlocks, journeyPublicationChecks, flushJourneyNotices, type JourneyInput } from "../support/core-browser-journey.js";

// M1.3 native journeys. Each case is a whole path of an application round on a real Docker host, gated like `m1-web-journey.test.ts`: it needs Docker and the executor image, so it runs
// where the CI `linux-runtime` job provides them (ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE) and skips cleanly everywhere else. Locally, colima's Docker works too
// (DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock), with TMPDIR and CONTAINED_FOUNDATION_EVIDENCE_DIR under the home folder, because the run directories are shared with the VM.
const dockerReady = process.env.ROVARA_DOCKER === "1";
const FIXTURE_ROOT = join(import.meta.dirname, "../fixtures/e2e-web-api-app");
/** The process Docker CLI, with each command's arguments shown to `observe` just before it runs. */
/** The files of the fixture app a candidate carries: the app itself, and the inventory service's OpenAPI document and mock fixture that the project approves. */
const APP_FILES = ["package.json", "server.mjs", "public", "fixtures", "defects", "inventory", "e2e"];
/** The fixture app with one of its fixed defect records as its default, as a coder's candidate carries a defect: in its source. */
const DEFECT_HOOK = "const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE);";
const withDefaultDefect = (name: "dependency-route" | "extra-order") => (server: string) => {
  if (!server.includes(DEFECT_HOOK)) throw new Error("the fixture's defect hook moved; update the journey's candidates");
  return server.replace(DEFECT_HOOK, `const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE) ?? JSON.parse(readFileSync(join(root, "defects/${name}.json"), "utf8"));`);
};
/**
 * The viewer's refused export answers 401 instead of 403: the fixture's own `viewer-access` defect would let the viewer download a file that no assertion of a refusal references
 * (the collector rightly calls that round incomplete), but a different refusal status fails the viewer's `text` assertion cleanly, with no download.
 */
const VIEWER_REFUSAL = 'if (account.role !== "owner" && !viewerBypass) return json(403, { error: "owner role required" });';
const withViewerRefusedAs401 = (server: string) => {
  if (!server.includes(VIEWER_REFUSAL)) throw new Error("the fixture's viewer refusal moved; update the journey's candidates");
  return server.replace(VIEWER_REFUSAL, VIEWER_REFUSAL.replace("json(403", "json(401"));
};
/** Every spelling an encoder could leave of a secret: as is, base64 and base64url, percent-encoded, hex (either case), and JSON-escaped. */
const spellingsOf = (secret: string) => [["as is", secret], ["base64", Buffer.from(secret).toString("base64")], ["base64url", Buffer.from(secret).toString("base64url")],
  ["percent-encoded", encodeURIComponent(secret)], ["hex", Buffer.from(secret).toString("hex")], ["HEX", Buffer.from(secret).toString("hex").toUpperCase()], ["JSON", JSON.stringify(secret).slice(1, -1)]] as const;
/**
 * The plan file the host mounts into the executor holds the run's accounts, passwords included. The arguments of the executor's `docker run` name it (`-v <host path>:/run/rovara/plan.json:ro`),
 * and the host wrote it before it ran the command: the passwords are read from it at that moment, by the journey and not by the code under test, so the journey has an oracle of its own.
 */
const PLAN_MOUNT_SUFFIX = ":/run/rovara/plan.json:ro";
const seededPasswordsOf = (args: string[]): string[] => {
  const mount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(PLAN_MOUNT_SUFFIX));
  if (mount === undefined) return [];
  const plan = JSON.parse(readFileSync(mount.slice(0, -PLAN_MOUNT_SUFFIX.length), "utf8")) as { accounts?: Array<{ password?: unknown }> };
  return (plan.accounts ?? []).flatMap((account) => (typeof account.password === "string" && account.password.length > 0 ? [account.password] : []));
};
/** A candidate that copies the password of the last sign-in into the first row of the owner's export: a bare credential value in an asserted observation. */
const SIGN_IN_FAILURE = 'if (!matches) return json(401, { error: "invalid credentials" });';
const OWNER_ROWS = "let rows = orders.orders.filter((item) => item.tenantId === account.tenantId);";
const withPasswordEchoedIntoExport = (server: string) => {
  if (!server.includes(SIGN_IN_FAILURE) || !server.includes(OWNER_ROWS)) throw new Error("the fixture's sign-in or export moved; update the journey's candidates");
  return server.replace(SIGN_IN_FAILURE, `${SIGN_IN_FAILURE} globalThis.lastSignInPassword = body.password;`)
    .replace(OWNER_ROWS, "let rows = orders.orders.filter((item) => item.tenantId === account.tenantId).map((item, index) => (index === 0 && globalThis.lastSignInPassword ? { ...item, customer: globalThis.lastSignInPassword } : item));");
};
async function stageCandidate(root: string, name: string, edit?: (server: string) => string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const file of APP_FILES) await cp(join(FIXTURE_ROOT, file), join(dir, file), { recursive: true });
  if (edit) await writeFile(join(dir, "server.mjs"), edit(await readFile(join(dir, "server.mjs"), "utf8")));
  return dir;
}

/** The M1.3 orders web fixture (Task 3.8): one app whose contract names a web and an API target, with the `/api/tenants/:tenantId/orders` route the web-and-api journey asks. */
const M13_FIXTURE_ROOT = join(import.meta.dirname, "../fixtures/orders-web-m13");
const M13_APP_FILES = ["package.json", "server.mjs", "public", "fixtures", "inventory", "e2e", "scripts"];
/** The tenant check of the orders-web fixture's API, which the leaky candidate of the web-and-api journey leaves out. */
const TENANT_CHECK = 'if (tenantPath[1] !== account.tenantId) return json(403, { error: "tenant access refused" });';
const withTenantCheckRemoved = (server: string) => {
  if (!server.includes(TENANT_CHECK)) throw new Error("the fixture's tenant check moved; update the journey's candidates");
  return server.replace(TENANT_CHECK, "");
};

// Manual native proof is enabled; CI registration awaits a passing controller Linux run.
describe.runIf(dockerReady)("M1.3 native core journeys", () => {
  const roots: string[] = [];
  afterAll(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }, 120_000);

  /**
   * Everything the journeys share, up to a planned and approved task waiting for its coder: a repository with the app's project contract (and whatever else setup approval reads), the broker
   * with the project registered and its setup approved on the qualified web profile, a task whose plan is the one `input.plan` writes from the planning context, and the worker (the real task
   * runner behind the real server, delivery and callbacks; only the model transport is scripted). It hands back the closures that drive an operation through the ordinary route.
   */
  const startJourney = (input: JourneyInput) => startCoreBrowserJourney(input, roots);

  /**
   * One planned scenario on the owner account of the fixture app, whose inventory service is an external origin: the plan approves the app's own OpenAPI document and mock fixture for
   * that service, the coder's candidate is the fixture app (optionally with a defect in the call it makes to the service), the broker admits one round, the worker runs it on the
   * production Docker host with the approved mock and the sinkhole, and the broker verifies what came back on its own.
   */
  async function inventoryJourney(variant: "mocked-origin" | "unmocked-call" | "results" | "credential-echo") {
    // `credential-echo`: the passwords the host seeded, read from the plan file it mounts into the executor (see `seededPasswordsOf`), for the oracle of the journey's own.
    const seededPasswords: string[] = [];
    const journey = await startJourney({ fixtureRoot: FIXTURE_ROOT, planningFiles: ["package.json", "inventory/openapi.json", "e2e/mocks/inventory-v1.json"],
      instructions: "Show each order's stock status from the inventory service",
      ...(variant === "credential-echo" ? { observeDocker: (args: string[]) => { seededPasswords.push(...seededPasswordsOf(args)); } } : {}),
      ...(variant === "results" ? { baseline: { stageBase: (root: string) => stageCandidate(root, "base", (server) => withViewerRefusedAs401(withDefaultDefect("extra-order")(server))) } } : {}),
      plan: async (context) => {
        const targetOf = (profileId: string) => context.targets.find((item) => item.kind === "web" && item.accountProfileId === profileId);
        const target = targetOf("orders-owner");
        expect(target, JSON.stringify(context.targets)).toBeDefined();
        const viewerTarget = variant === "results" ? targetOf("orders-viewer") : undefined;
        if (variant === "results") expect(viewerTarget, JSON.stringify(context.targets)).toBeDefined();
        // The planner is offered the inventory mock because the app's OpenAPI document and a source-backed fixture for it are in the repository.
        const mock = context.mockFixtures.find((item) => item.requestedTargetIds.includes(target!.targetId));
        expect(mock, JSON.stringify(context.mockFixtures)).toMatchObject({ componentId: e2eApiSchemaComponentId("inventory/openapi.json"), contractPath: "inventory/openapi.json", sourcePath: "e2e/mocks/inventory-v1.json" });
        const scenario: E2EScenario = { scenarioId: "show-stock-status", requirementId: "orders-stock-status", requestedTargetIds: [target!.targetId], required: true, accountProfileId: target!.accountProfileId,
          minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "navigate", path: "/" }, { kind: "click", testId: "check-inventory" }],
          assertions: [{ kind: "text", testId: "inventory-status", equals: "in-stock" }] };
        const ordersOfOwner = (JSON.parse(await readFile(join(FIXTURE_ROOT, "fixtures/orders.json"), "utf8")) as { orders: Array<{ id: string; tenantId: string; customer: string; total: number; state: string }> }).orders
          .filter((order) => order.tenantId === "tenant-a").map((order) => [order.id, order.customer, String(order.total), order.state]);
        // `results`: five scenarios of the export, on the owner's account and the viewer's, with no external origin.
        const web = (scenarioId: string, requirementId: string, who: NonNullable<typeof target>, steps: E2EScenario["steps"], assertions: E2EScenario["assertions"]): E2EScenario =>
          ({ scenarioId, requirementId, requestedTargetIds: [who.targetId], required: true, accountProfileId: who.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [], steps, assertions });
        const openAndExport: E2EScenario["steps"] = [{ kind: "navigate", path: "/" }, { kind: "click", testId: "download-orders" }];
        const resultsScenarios: E2EScenario[] = variant !== "results" ? [] : [
          web("owner-export", "orders-export", target!, openAndExport, [{ kind: "csv", downloadName: "orders.csv", columns: ["id", "customer", "total", "state"], rows: ordersOfOwner }]),
          web("viewer-access", "orders-export-viewer", viewerTarget!, openAndExport, [{ kind: "text", testId: "orders-access-error", equals: "Access refused (403)" }]),
          web("owner-sees-export-button", "orders-export-visible-owner", target!, [{ kind: "navigate", path: "/" }], [{ kind: "visible", testId: "download-orders", equals: true }]),
          web("viewer-sees-export-button", "orders-export-visible", viewerTarget!, [{ kind: "navigate", path: "/" }], [{ kind: "visible", testId: "download-orders", equals: true }]),
          web("owner-export-status", "orders-export-status", target!, openAndExport, [{ kind: "text", testId: "orders-export-status", equals: "Orders exported" }]),
        ];
        const planTargets = variant === "results" ? [target!, viewerTarget!] : [target!];
        // `credential-echo`: the owner's export, whose first row the candidate fills with the password the owner signed in with.
        const echoScenarios = variant !== "credential-echo" ? [] : [web("owner-export", "orders-export", target!, openAndExport, [{ kind: "csv", downloadName: "orders.csv", columns: ["id", "customer", "total", "state"], rows: ordersOfOwner }])];
        const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: planTargets.map((item) => item.targetId), portableOperationRefs: [],
          mockFixtureRefs: variant === "results" || variant === "credential-echo" ? [] : [{ componentId: mock!.componentId, requestedTargetId: target!.targetId, operationId: mock!.operationId, sourcePath: mock!.sourcePath, sourceSha256: mock!.sourceSha256 }],
          accountContextRefs: planTargets.flatMap((who) => context.accountContextRefs.filter((ref) => ref.applicationId === who.applicationId && ref.profileId === who.accountProfileId)),
          scenarios: variant === "results" ? resultsScenarios : variant === "credential-echo" ? echoScenarios : [scenario], semanticExportDeltas: [],
          applicationRuntimeRefs: planTargets.flatMap((who) => context.runtimeRefs!.filter((ref) => ref.targetId === who.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! }))),
          runtimeAccountRefs: planTargets.flatMap((who) => context.runtimeAccountRefs!.filter((ref) => ref.applicationId === who.applicationId && ref.profileId === who.accountProfileId)), unavailableTargetRefs: [] });
        const { portableOperationRefs: _portable, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
        void _portable; void _unavailable;
        return { title: "Show each order's stock status", claims: [{ id: "1", text: "The orders page shows an order's stock status from the inventory service." }], plannerIntent };
      } });
    const { root, harness, taskId, taskKey, faux, workflowNow, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind } = journey;
    const candidate = variant === "mocked-origin" || variant === "results" ? await stageCandidate(root, "candidate")
      : variant === "credential-echo" ? await stageCandidate(root, "candidate", withPasswordEchoedIntoExport)
      // The coder's call to the inventory service goes to a path that service's contract does not have (the fixture app's own dependency-route defect, as its default).
      : await stageCandidate(root, "candidate", withDefaultDefect("dependency-route"));
    if (variant === "unmocked-call") expect(await readFile(join(candidate, "server.mjs"), "utf8")).toContain("defects/dependency-route.json");

    /**
     * `results`: what the task page and Slack show, round by round, in real Chromium on the Docker host. The same five scenarios run on three states of the code:
     *  - the unchanged code, the app as the task starts with two defects (the extra order in the owner's export, and the viewer's refusal answering 401 where the plan approved 403).
     *    The broker's baseline round (owner decision D2) runs it by itself, once, right after the coding run and before the candidate's CHECKS: two rows FAILED, each with a screenshot.
     *    It is for information only: it sets no `failedRound` or `qualifiedRound`, offers no send-back, and the candidate's CHECKS go on as if it were not there;
     *  - candidate 1, whose export is right but whose refusal of the viewer's export still answers 401: FAILED on `viewer-access`, on the viewer's account, with a screenshot and expected
     *    versus actual (see `withViewerRefusedAs401` for why it is not the fixture's own `viewer-access` defect), and the baseline beside it;
     *  - candidate 2, as the fixture ships: PASS, publishable; the baseline recorded beside it changed nothing.
     */
    async function resultsFlow() {

      const resultsNow = () => readJourneyResults(harness, journey.taskId);
      const presentation = () => readJourneyTask(harness, journey.taskId).then((task) => task.e2ePresentation);
      const byScenario = (rows: Array<{ scenarioId: string }>) => Object.fromEntries(rows.map((row) => [row.scenarioId, row])) as Record<string, (typeof rows)[number] & { status: string; reason?: string; screenshotRef?: { sha256: string; contentType: string }; failedAssertion?: { kind: string; expected: string; actual: string }; mockedOrigins: string[] }>;
      const sessionId = randomUUID();
      harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: MAYA.developerId, amr: MAYA.provider, startedAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: Math.floor(Date.now() / 1000) + 3600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
      const getArtifact = async (sha256: string) => (await harness.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${taskId}/task/api/e2e/artifacts/${sha256}`, rawQueryString: "",
        headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}` }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } })) as unknown as
        { statusCode: number; body: string; headers: Record<string, string> };
      /** The coding run, and the compute warm-up the broker waits for before it admits a round. */
      const implementCode = async (dir: string, message: string) => {
        faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${dir}/." repo/demo/` })]), fauxAssistantMessage(message)]);
        const done = await runOperation("IMPLEMENT");
        expect(done.operation.status, JSON.stringify(done.operation)).toBe("SUCCEEDED");
        expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY" }); expect(["WAITING", "RUNNING"], "the round is queued, or the core already started it").toContain(workflowNow().state);
        await completeReadiness();
      };
      const purposeOf = (run: Awaited<ReturnType<typeof runOperation>>) => (run.invocation as { payload: { workflowE2EAdmission?: { purpose?: string } } }).payload.workflowE2EAdmission?.purpose;
      const implement = async (dir: string, message: string) => {
        await implementCode(dir, message);
        const checks = await runOperation("CHECKS");
        expect(purposeOf(checks)).toBeUndefined();
        expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
        return checks;
      };
      const e2eNow = () => workflowNow().e2e as { contractDigest: string; failedRound?: { status: string }; qualifiedRound?: unknown; displayRef?: unknown };
      const sendBack = async (instructions: string) => {
        const sentBack = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision, instructions });
        expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
        expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "IMPLEMENT" });
      };
      const first = await stageCandidate(root, "candidate-1", withViewerRefusedAs401);
      const fixed = await stageCandidate(root, "candidate-2");
      const baselineKey = { pk: `DEVTASK#${taskId}`, sk: `E2E_BASELINE#${e2eNow().contractDigest}` };

      // Approval asked for the informational round, once, for this plan, and the coding run was asked to export the unchanged code.
      expect(harness.db.get(baselineKey.pk, baselineKey.sk)).toMatchObject({ state: "REQUESTED", purpose: "baseline", attempt: 1 });
      await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));

      // Candidate 1's coding run ends; the broker runs the baseline on the unchanged code first, in a round of its own kind.
      await implementCode(first, "I fixed the export.");
      const baselineRun = await runOperation("CHECKS", undefined, "baseline");
      expect(purposeOf(baselineRun)).toBe("baseline");
      expect(baselineRun.operation.status, JSON.stringify({ operation: baselineRun.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
      const recorded = harness.db.get(baselineKey.pk, baselineKey.sk) as { state: string; baseline: { status: string; scenarios: Array<{ scenarioId: string; status: string; screenshotRef?: { sha256: string } }> } };
      expect(recorded.state, JSON.stringify(recorded)).toBe("RECORDED");
      expect(recorded.baseline.status).toBe("FAILED");
      expect(recorded.baseline.scenarios.filter((row) => row.status === "FAILED").map((row) => row.scenarioId).sort()).toEqual(["owner-export", "viewer-access"]);
      for (const row of recorded.baseline.scenarios.filter((item) => item.status === "FAILED")) {
        expect(row.screenshotRef, `a screenshot of ${row.scenarioId}`).toBeDefined();
        expect((await getArtifact(row.screenshotRef!.sha256)).statusCode).toBe(200);
      }
      // Review Focus 6: a baseline with failures never gates. No failed or qualified round, no display of its own, no send-back, nothing for publication; the workflow goes on to the candidate.
      expect(e2eNow().failedRound).toBeUndefined();
      expect(e2eNow().qualifiedRound).toBeUndefined();
      expect(e2eNow().displayRef).toBeUndefined();
      expect(workflowNow().blockReason).toBeUndefined();
      expect(workflowSendBackOffered(workflowNow() as never)).toBe(false);
      expect(await journeyPublicationChecks(harness, journey.taskId)).toBeUndefined();
      expect(JSON.stringify(workflowNow())).not.toMatch(/baseline/iu);
      // And the page already says what the unchanged code did, with no row of the candidate's yet.
      const beforeCandidate = (await resultsNow())!;
      expect(beforeCandidate.scenarios).toEqual([]);
      expect(beforeCandidate.baseline?.status).toBe("FAILED");
      const firstRun = await runOperation("CHECKS");
      expect(purposeOf(firstRun)).toBeUndefined();
      expect(firstRun.operation.status, JSON.stringify({ operation: firstRun.operation, workflow: workflowNow() })).toBe("SUCCEEDED");

      // Candidate 1: the export is right, but the viewer's refusal answers 401 where 403 is approved. FAILED on that one row, on the viewer's account, with expected versus actual
      // and a screenshot of the page as it was.
      expect(workflowNow().blockReason).toBe("one or more admitted E2E groups failed");
      expect(e2eNow().failedRound).toMatchObject({ status: "FAILED" });
      expect(e2eNow().qualifiedRound).toBeUndefined();
      const firstRows = (await resultsNow())!;
      expect(firstRows.scenarios).toHaveLength(5);
      const stateRow = byScenario(firstRows.scenarios)["viewer-access"]!;
      expect(stateRow).toMatchObject({ status: "FAILED", kind: "web", accountLabel: "orders-viewer",
        reason: 'expected "Access refused (403)", received "Access refused (401)"', failedAssertion: { kind: "text", expected: "Access refused (403)", actual: "Access refused (401)" } });
      expect(stateRow.screenshotRef).toMatchObject({ contentType: "image/jpeg" });
      expect(firstRows.scenarios.filter((row) => row.status === "FAILED").map((row) => row.scenarioId)).toEqual(["viewer-access"]);
      expect(byScenario(firstRows.scenarios)["owner-export"]).toMatchObject({ status: "PASSED", accountLabel: "orders-owner" });
      expect(firstRows.baseline?.status).toBe("FAILED");
      expect(byScenario(firstRows.baseline!.scenarios)["owner-export"]!.screenshotRef).toBeDefined();
      // The screenshots are behind the page's session: the owner reads them as JPEGs, someone else is refused.
      const shot = await getArtifact(stateRow.screenshotRef!.sha256);
      expect(shot.statusCode, shot.body.slice(0, 200)).toBe(200);
      expect(shot.headers["content-type"]).toBe("image/jpeg");
      expect(Buffer.from(shot.body, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect((await getArtifact("0".repeat(64))).statusCode).toBe(404);
      const delivered = await flushJourneyNotices(harness);
      expect(delivered.length, "the actual core notice service delivered to its local channel sink").toBeGreaterThan(0);
      expect(JSON.stringify(delivered)).toContain("4 passed");
      const slackText = JSON.stringify(await journeyNoticeBlocks(harness, journey.taskId));
      expect(slackText).toContain("Browser and API checks: 4 passed, 1 failed, 0 incomplete");
      expect(slackText).toContain("Viewer access — failed: expected");
      expect(slackText).toContain("Access refused (401)");
      expect(slackText).toContain("(orders-viewer)");
      expect(slackText).toContain("Before the change: 2 of 5 failed, as expected for new behaviour.");
      // The baseline's failures did not make the candidate's round a failure, and the candidate's failure is the candidate's alone: the send-back is offered for it.
      expect(workflowSendBackOffered(workflowNow() as never)).toBe(true);
      await sendBack("The viewer's refused export must answer 403.");

      // Candidate 2: as the fixture ships. Every row passes; the page lists five rows and the baseline apart; the task goes on to review. The baseline changed nothing about that.
      await implement(fixed, "I made the refusal a 403 again.");
      expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "REVIEW" });
      expect(e2eNow().qualifiedRound).toBeDefined();
      expect(e2eNow().failedRound).toBeUndefined();
      const lastRows = (await resultsNow())!;
      expect(lastRows.scenarios.map((row) => row.status)).toEqual(Array(5).fill("PASSED"));
      expect(lastRows.baseline?.status).toBe("FAILED");
      const page = (await presentation())!.pageHtml;
      expect(page.match(/<tr[^>]*data-e2e-row=/gu)).toHaveLength(5);
      expect(page.match(/<tr[^>]*data-e2e-baseline-row=/gu)).toHaveLength(5);
      expect(page).toContain("Browser and API checks: 5 passed, 0 failed, 0 incomplete");
      expect((await presentation())!.shared.e2e.status).toBe("PASS");
      // The baseline's screenshot is still the task's to read.
      const baselineShot = byScenario(lastRows.baseline!.scenarios)["owner-export"]!.screenshotRef!;
      expect((await getArtifact(baselineShot.sha256)).statusCode).toBe(200);
    }

    /**
     * `credential-echo`: the broker redacts by pattern and cannot know a run's passwords; what keeps a bare password out of a row, the stored display and Slack is the chain upstream
     * of it, in two layers. First the executor, which refuses to record evidence that carries an account credential (so the case has no value to show), then the Docker host's own
     * scan, which holds back the operator evidence (captures, log heads) that does. Both hold the run's passwords, which nothing else does. A candidate copies the password the owner
     * signed in with into the first row of the owner's export, which the CSV assertion observes.
     * Two things are proved. The echo reached the run's output and was withheld: the run's raw output carries the credential or the executor's refusal of it (a round that failed for
     * another reason, and so never put a credential through the chain, would otherwise pass for a proof). And whatever the round makes of that, no surface the broker stores or shows
     * carries the password, by the host's own predicate (every spelling it knows, base64 included).
     */
    async function credentialEchoFlow() {

      faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]), fauxAssistantMessage("I added the export.")]);
      await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
      const implemented = await runOperation("IMPLEMENT");
      expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
      await completeReadiness();
      const checks = await runOperation("CHECKS");
      expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
      const scan = journey.hostCredentialScan();
      // N1: positive evidence that a credential was withheld, from whichever layer withheld it. (1) The run's raw output, as the host saw it before anything was handed out, shows the
      // echo: the credential itself (which the host's scan then held back from the operator evidence), the executor's refusal to record evidence that carries one, its removal of an
      // output file that did, or its result file's "credential-leak". (2) A run the executor ended for a leak (exit code 2) is not read by the host at all, so there is no raw output
      // to see; the broker's stored evidence of the group then keeps the executor's log line. One of the two must show it.
      const groupRuns = ((checks.operation.workflowE2EGroupEvidenceRefs ?? []) as Array<{ evidenceRef: { key: string } }>).map((ref) =>
        JSON.parse(harness.s3.objects.get(ref.evidenceRef.key) ?? "{}") as { groupRun?: { diagnostics?: { executorLogTail?: string } | null } });
      const storedLogShowsIt = groupRuns.some((item) => (item.groupRun?.diagnostics?.executorLogTail ?? "").includes(journey.executorRemovedFile));
      const withheldCredential = journey.withheldCredential();
      expect(withheldCredential?.carriedCredential === true || withheldCredential?.executorRefusal === true || storedLogShowsIt,
        `nothing shows a credential reached the run and was withheld: ${JSON.stringify({ withheldCredential, storedLogShowsIt })}`).toBe(true);
      // The echo took effect: the export no longer holds the owner's orders, so the round is not a pass.
      expect((workflowNow().e2e as { qualifiedRound?: unknown }).qualifiedRound).toBeUndefined();

      const rows = await readJourneyResults(harness, journey.taskId);
      expect(rows?.scenarios.map((row) => row.status), JSON.stringify(rows)).not.toContain("PASSED");
      const presentation = (await readJourneyTask(harness, journey.taskId).then((task) => task.e2ePresentation))!;
      const displayRef = (workflowNow().e2e as { displayRef?: { key: string } }).displayRef;
      const slack = await journeyNoticeBlocks(harness, journey.taskId);
      const deliveries = await flushJourneyNotices(harness);
      const surfaces: Record<string, string> = { deliveredNotices: JSON.stringify(deliveries), rows: JSON.stringify(rows), page: presentation.pageHtml, slack: JSON.stringify(slack), presentationSlack: JSON.stringify(presentation.slackBlocks),
        shared: JSON.stringify(presentation.shared), workflow: JSON.stringify(workflowNow()), display: displayRef === undefined ? "" : harness.s3.objects.get(displayRef.key) ?? "" };
      expect(surfaces.display, "a display was stored").not.toBe("");
      // The host's predicate exists only for a run it read; a run the executor ended for a leak has none, and then the executor's removal of the file is the proof.
      if (scan !== undefined) for (const [name, text] of Object.entries(surfaces)) expect(scan(Buffer.from(text, "utf8")), `the ${name} carries a run credential`).toBe(false);
      // The journey's own oracle, which does not depend on the host's scan (that scan exists only for a run the host read, and it is the code under test). The passwords are the ones the host
      // wrote to the plan file it mounted into the executor. At least one was captured, or the check below would pass for nothing; and none, in any spelling, is in anything the broker stored
      // or shows: the rows, the page, Slack, the stored display, and the stored evidence of each group.
      const passwords = [...new Set(seededPasswords)];
      expect(passwords.length, "the plan file the host mounted into the executor was read, and it held a password").toBeGreaterThan(0);
      const groupEvidence = ((checks.operation.workflowE2EGroupEvidenceRefs ?? []) as Array<{ evidenceRef: { key: string } }>).map((ref) => harness.s3.objects.get(ref.evidenceRef.key) ?? "");
      expect(groupEvidence.length, "the round stored evidence for at least one group").toBeGreaterThan(0);
      expect(groupEvidence.every((text) => text.length > 0), "every group's stored evidence was read").toBe(true);
      const oracleSurfaces: Record<string, string> = { deliveredNotices: surfaces.deliveredNotices!, rows: surfaces.rows!, page: surfaces.page!, slack: surfaces.slack!, "stored display": surfaces.display!,
        ...Object.fromEntries(groupEvidence.map((text, index) => [`stored group evidence ${index + 1}`, text])) };
      for (const password of passwords) {
        for (const [form, spelling] of spellingsOf(password)) {
          for (const [name, text] of Object.entries(oracleSurfaces)) expect(text.includes(spelling), `the ${name} holds a seeded password (${password.length} characters) as ${form}`).toBe(false);
        }
      }
    }

    if (variant === "credential-echo") {
      await credentialEchoFlow();
      await nothingLeftBehind();
      return;
    }

    if (variant === "results") {
      await resultsFlow();
      await nothingLeftBehind();
      return;
    }

    // The coder implements the feature (the fixture app as it ships, or with its dependency-route defect); the broker admits one round; the worker runs it; the broker verifies the evidence itself.
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]), fauxAssistantMessage("I added the stock status.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const implemented = await runOperation("IMPLEMENT");
    expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY" }); expect(["WAITING", "RUNNING"], "the round is queued, or the core already started it").toContain(workflowNow().state);
    await completeReadiness();
    const checks = await runOperation("CHECKS");
    expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    const refs = checks.operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>;
    const stored = refs.map((ref) => JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { diagnostics: unknown; collection: { result: { status: string; reason: string; mockedOrigins?: string[]; cases: Array<{
      status: string; reason: string; mockedOrigins?: string[]; assertionReceipts: Array<{ assertionIndex: number; status: string }>; coverage: { observedMockedComponentIds: string[] } }> } } } });

    const presentation = () => readJourneyTask(harness, journey.taskId).then((task) => task.e2ePresentation);

    if (variant === "mocked-origin") {
      // PASS: the page showed what the inventory mock answered, the mock is named on the case and on the round, and the broker's own verdict stands on the ledger of the mock itself.
      expect(workflowNow(), JSON.stringify({ blockReason: workflowNow().blockReason, diagnostics: stored.map((item) => item.groupRun.diagnostics) })).toMatchObject({ stage: "REVIEW" });
      expect((workflowNow().e2e as { qualifiedRound?: unknown }).qualifiedRound).toBeDefined();
      const result = stored[0]!.groupRun.collection.result;
      expect(result).toMatchObject({ status: "passed", mockedOrigins: ["inventory-v1"] });
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0]).toMatchObject({ status: "passed", mockedOrigins: ["inventory-v1"] });
      expect(result.cases[0]!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, "passed"]]);
      const shared = (await presentation())?.shared.e2e;
      expect(shared?.status).toBe("PASS");
      expect(shared?.mockedComponentIds).toEqual([e2eApiSchemaComponentId("inventory/openapi.json")]);
      expect(shared?.observedMockedComponentIds).toEqual([e2eApiSchemaComponentId("inventory/openapi.json")]);
    } else {
      // UNKNOWN, never PASS and never FAILED: a call that no approved mock matched blocks publication, and names its reason; no round is recorded as failed or as qualified.
      const result = stored[0]!.groupRun.collection.result;
      expect(result.cases[0]).toMatchObject({ status: "unavailable", reason: "unmocked-external-call" });
      expect(workflowNow().blockReason, JSON.stringify(workflowNow())).not.toBe("one or more admitted E2E groups failed");
      expect(workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect((workflowNow().e2e as { qualifiedRound?: unknown; failedRound?: unknown }).qualifiedRound).toBeUndefined();
      expect((workflowNow().e2e as { failedRound?: unknown }).failedRound).toBeUndefined();
      expect(JSON.stringify(workflowNow())).toContain("unmocked-external-call");
      expect((await presentation())?.shared.e2e.status).toBe("UNKNOWN");
    }
    await nothingLeftBehind();
  }

  /** A copy of the accounts fixture app a coder would produce, optionally edited (the viewer-access defect on by default is how candidate 1 differs from candidate 2). */
  async function stageAccountsCandidate(root: string, name: string, edit?: (server: string) => string) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    for (const file of ACCOUNTS_APP_FILES) await cp(join(ACCOUNTS_FIXTURE_ROOT, file), join(dir, file), { recursive: true });
    if (edit) await writeFile(join(dir, "server.mjs"), edit(await readFile(join(dir, "server.mjs"), "utf8")));
    return dir;
  }

  /**
   * Task 3.2, whole: three accounts in two tenants (a viewer and an owner of tenant-a, the owner of tenant-b) planned as three scenarios of one application, all in one group of one round.
   * The accounts are seeded by the app's own recipe from the accounts file the host writes, and sign in through the app's own form. Candidate 1 lets a viewer export (the
   * viewer-access defect): the viewer's case is FAILED on its visible assertion, the other two pass, and the broker offers send-back. Candidate 2 is fixed: PASS. Each case's account ref
   * is the one the registry resolves for (applicationId, accountProfileId). No byte the broker or the worker stored holds a seeded password, email or email local part.
   */
  async function accountsJourney() {
    const secrets: string[] = [];
    const accountsFileOf = (args: string[]): string | null => {
      if (!args.some((value, index) => args[index - 1] === "--name" && value.startsWith("rovara-seed-"))) return null;
      const mount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(":/app/.owned:ro"));
      return mount === undefined ? null : join(mount.slice(0, -":/app/.owned:ro".length), "rovara-accounts.json");
    };
    let plannedRefs: Array<{ applicationId: string; profileId: string; revision: number; definitionDigest: string }> = [];
    const journey = await startJourney({ fixtureRoot: ACCOUNTS_FIXTURE_ROOT, planningFiles: ["package.json"], instructions: "Only owners may export orders, and each tenant sees only its own",
      // What the seeded accounts are, read from the accounts file at the moment the seed container is started (the host removes the file with the run).
      observeDocker: (args) => {
        const file = accountsFileOf(args);
        if (file === null) return;
        for (const account of (JSON.parse(readFileSync(file, "utf8")) as { accounts: Array<{ email: string; password: string }> }).accounts) secrets.push(account.password, account.email, account.email.slice(0, account.email.indexOf("@")));
      },
      plan: (context) => {
        const profiles = ["orders-viewer", "orders-owner", "orders-owner-b"] as const;
        const targets = profiles.map((profileId) => context.targets.find((item) => item.kind === "web" && item.accountProfileId === profileId));
        for (const target of targets) expect(target, JSON.stringify(context.targets)).toBeDefined();
        const scenarios = [webAccountScenarios.viewer, webAccountScenarios.owner, webAccountScenarios.ownerB].map((item, index) => item.scenario(targets[index]!.targetId));
        const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: targets.map((item) => item!.targetId), portableOperationRefs: [], mockFixtureRefs: [],
          accountContextRefs: targets.flatMap((item) => context.accountContextRefs.filter((ref) => ref.applicationId === item!.applicationId && ref.profileId === item!.accountProfileId)),
          scenarios, semanticExportDeltas: [],
          applicationRuntimeRefs: targets.flatMap((item) => context.runtimeRefs!.filter((ref) => ref.targetId === item!.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! }))),
          runtimeAccountRefs: targets.flatMap((item) => context.runtimeAccountRefs!.filter((ref) => ref.applicationId === item!.applicationId && ref.profileId === item!.accountProfileId)), unavailableTargetRefs: [] });
        plannedRefs = [...intent.runtimeAccountRefs];
        const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
        void _portable; void _mocks; void _unavailable;
        return { title: "Only owners export orders", claims: [{ id: "1", text: "A viewer cannot export orders; an owner exports its tenant's orders; one tenant never sees another's." }], plannerIntent };
      } });
    const { root, harness, snapshot, taskKey, faux, workflowNow, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind, evidenceRoot } = journey;
    // Candidate 1: the app with the viewer-access defect as its default; candidate 2: the app as it ships.
    const defective = await stageAccountsCandidate(root, "candidate-defective", (server) => server.replace("defect: readDefect() });", 'defect: readDefect() ?? JSON.parse(readFileSync(join(root, "defects/viewer-access.json"), "utf8")) });'));
    expect(await readFile(join(defective, "server.mjs"), "utf8")).toContain("defects/viewer-access.json");
    const fixed = await stageAccountsCandidate(root, "candidate-fixed");
    const implementation = (candidate: string) => fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]);

    const presentation = () => readJourneyTask(harness, journey.taskId).then((task) => task.e2ePresentation);
    type CaseResult = { caseId: string; status: string; reason: string; accountContextId: string; accountContextDigest: string; assertionReceipts: Array<{ assertionIndex: number; status: string }> };
    const casesOf = (operation: Record<string, unknown>): CaseResult[] => (operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>).flatMap((ref) =>
      (JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { collection: { result: { cases: CaseResult[] } } } }).groupRun.collection.result.cases);

    // Round 1: candidate 1.
    faux.setResponses([implementation(defective), fauxAssistantMessage("I added the orders export.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const first = await runOperation("IMPLEMENT");
    expect(first.operation.status, JSON.stringify(first.operation)).toBe("SUCCEEDED");
    const firstCandidateDigest = workflowNow().candidate!.digest;
    await completeReadiness();
    const checks1 = await runOperation("CHECKS");
    expect(checks1.operation.status, JSON.stringify({ operation: checks1.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow().blockReason, "round 1 must be FAILED by the broker (an assertion mismatch), not UNKNOWN").toBe("one or more admitted E2E groups failed");
    expect(workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const e2e1 = workflowNow().e2e as { failedRound?: { status: string; candidateDigest: string; roundId: string }; qualifiedRound?: unknown };
    expect(e2e1.failedRound).toMatchObject({ status: "FAILED", candidateDigest: firstCandidateDigest });
    expect(e2e1.qualifiedRound).toBeUndefined();
    expect(workflowSendBackOffered(workflowNow() as never)).toBe(true);
    const cases1 = casesOf(checks1.operation);
    expect(cases1, "three accounts, three cases, one group").toHaveLength(3);
    expect((checks1.operation.workflowE2EGroupEvidenceRefs as unknown[]), "one group").toHaveLength(1);
    // Exactly one case failed, on its one assertion; the other two (the owner exporting, the other tenant's owner seeing none of tenant-a's rows) passed.
    expect(cases1.filter((item) => item.status === "failed").map((item) => item.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status]))).toEqual([[[0, "failed"]]]);
    expect(cases1.filter((item) => item.status === "passed")).toHaveLength(2);
    expect((await presentation())?.shared.e2e.status).toBe("FAILED");

    // Each case's account ref is the registry's own for (applicationId, accountProfileId): three different accounts of one application.
    const contract = readE2EApplicationProjectContract(snapshot, plannedRefs[0]!.applicationId)!;
    const entries = accountRegistryEntriesFromRows(TEST_ORG, "payments", harness.db.find((row) => row.pk === testProjectPk("payments")));
    expect(plannedRefs.map((ref) => ref.profileId).sort()).toEqual(["orders-owner", "orders-owner-b", "orders-viewer"]);
    expect(new Set(plannedRefs.map((ref) => ref.applicationId)).size).toBe(1);
    for (const ref of plannedRefs) {
      expect(latestAccountRef({ contract, entries, applicationId: ref.applicationId, profileId: ref.profileId, now: Date.now() }), ref.profileId).toEqual(ref);
    }
    expect(new Set(plannedRefs.map((ref) => ref.definitionDigest)).size).toBe(3);
    expect(new Set(cases1.map((item) => item.accountContextId)).size, "each case has its own account context").toBe(3);
    // And each is the context of the right account: the registry's ref for (applicationId, accountProfileId) gives the context id the collector must attribute to that account's case.
    // The failed case is the viewer's (and no one else's), and the three contexts are exactly the three accounts' own, so no two cases were given each other's.
    const contextIdOf = (ref: { applicationId: string; profileId: string; revision: number; definitionDigest: string }) =>
      `app-account-${createHash("sha256").update(canonicalJson([ref.applicationId, ref.profileId, ref.revision, ref.definitionDigest])).digest("hex")}`.slice(0, 120);
    const refOf = (profileId: string) => plannedRefs.find((ref) => ref.profileId === profileId)!;
    expect(cases1.find((item) => item.status === "failed")!.accountContextId, "the failed case is the viewer's").toBe(contextIdOf(refOf("orders-viewer")));
    expect(cases1.filter((item) => item.status === "passed").map((item) => item.accountContextId).sort(), "the two passing cases are the two owners'")
      .toEqual([contextIdOf(refOf("orders-owner")), contextIdOf(refOf("orders-owner-b"))].sort());

    // Round 2: send it back, and candidate 2 passes all three.
    const sentBack = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${journey.taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision,
      instructions: "A viewer can export. Only an owner may." });
    expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
    faux.setResponses([implementation(fixed), fauxAssistantMessage("Only owners can export now.")]);
    const second = await runOperation("IMPLEMENT");
    expect(second.operation.status, JSON.stringify(second.operation)).toBe("SUCCEEDED");
    const secondCandidateDigest = workflowNow().candidate!.digest;
    expect(secondCandidateDigest).not.toBe(firstCandidateDigest);
    await completeReadiness();
    const checks2 = await runOperation("CHECKS", checks1.invocation.operationId);
    expect(checks2.operation.status, JSON.stringify({ operation: checks2.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "REVIEW" });
    const e2e2 = workflowNow().e2e as { failedRound?: unknown; qualifiedRound?: { candidateDigest: string; roundId: string } };
    expect(e2e2.qualifiedRound).toMatchObject({ candidateDigest: secondCandidateDigest });
    expect(e2e2.failedRound).toBeUndefined();
    const cases2 = casesOf(checks2.operation);
    expect(cases2).toHaveLength(3);
    expect(cases2.every((item) => item.status === "passed" && item.assertionReceipts.every((receipt) => receipt.status === "passed"))).toBe(true);
    expect(cases2.map((item) => item.accountContextId).sort(), "round 2 attributes the same three accounts").toEqual(plannedRefs.map(contextIdOf).sort());
    expect([...new Set(cases2.map((item) => item.accountContextId))].sort()).toEqual([...new Set(cases1.map((item) => item.accountContextId))].sort());
    expect((await presentation())?.shared.e2e.status).toBe("PASS");

    // The credentials the host seeded appear in no byte either round stored: not in the group evidence, not in any row, not in the worker's own evidence files.
    expect(secrets.length, "the seed's accounts file was read for both rounds").toBeGreaterThanOrEqual(12);
    const stored = [JSON.stringify(harness.db.find(() => true)), ...[...harness.s3.objects.values()].map((value) => (typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("latin1")))];
    for (const entry of await readdir(evidenceRoot, { recursive: true, withFileTypes: true })) if (entry.isFile()) stored.push((await readFile(join(entry.parentPath, entry.name))).toString("latin1"));
    expect(stored.join("\n").length).toBeGreaterThan(10_000);
    for (const secret of new Set(secrets)) {
      for (const [form, spelling] of spellingsOf(secret)) {
        for (const text of stored) expect(text.includes(spelling), `a stored byte holds a seeded credential (${secret.length} characters, ${secret.startsWith("rovara-") ? "an email part" : "a password"}) as ${form}`).toBe(false);
      }
    }
    await nothingLeftBehind();
  }

  /**
   * Task 3.3 (Ruling AZ), whole: an application with no `agentx.e2e` project contract (a start script and a lockfile; Rovara infers `npm ci` and `npm start`) planned with two signed-out
   * scenarios on the implicit `rovara-anonymous` variant of its web target. The base target of the same app stays unavailable with `needs-project-contract`, so a signed-in scenario
   * could not run there. The anonymous cases have no account binding: one account context, the fixed anonymous reference, no seed and no data volume. The round is PASS, the task
   * goes on to review, and publication has checks.
   */
  async function anonymousInferredJourney() {
    let plannedRef: { applicationId: string; profileId: string; revision: number; definitionDigest: string } | undefined;
    const journey = await startJourney({ fixtureRoot: INFERRED_FIXTURE_ROOT, planningFiles: ["package.json", "package-lock.json"], instructions: "Show every visitor a welcome page",
      plan: (context) => {
        const anonymous = context.targets.find((item) => item.kind === "web" && item.accountProfileId === "rovara-anonymous");
        expect(anonymous, JSON.stringify(context.targets)).toBeDefined();
        // The inferred app's own (signed-in) target is not executable, and the planner is told why; only its signed-out variant is.
        expect(context.unavailableReasons, JSON.stringify(context)).toEqual([{ targetId: "web-1", reason: "needs-project-contract" }]);
        const scenarios = [anonymousWebScenarios.welcome, anonymousWebScenarios.noAdmin].map((item) => item.scenario(anonymous!.targetId));
        const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [anonymous!.targetId], portableOperationRefs: [], mockFixtureRefs: [],
          accountContextRefs: context.accountContextRefs.filter((ref) => ref.applicationId === anonymous!.applicationId && ref.profileId === "rovara-anonymous"),
          scenarios, semanticExportDeltas: [],
          applicationRuntimeRefs: context.runtimeRefs!.filter((ref) => ref.targetId === anonymous!.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! })),
          runtimeAccountRefs: context.runtimeAccountRefs!.filter((ref) => ref.applicationId === anonymous!.applicationId && ref.profileId === "rovara-anonymous"), unavailableTargetRefs: [] });
        plannedRef = intent.runtimeAccountRefs[0];
        const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
        void _portable; void _mocks; void _unavailable;
        return { title: "Welcome every visitor", claims: [{ id: "1", text: "A signed-out visitor sees the welcome page and no admin link." }], plannerIntent };
      } });
    const { root, harness, taskKey, faux, workflowNow, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind } = journey;
    expect(plannedRef, "the plan carries the fixed anonymous reference").toEqual(e2eAnonymousRuntimeAccountRef(plannedRef!.applicationId));
    // The coder's candidate: the fixture app as it ships (the repository held only its manifest and lockfile).
    const candidate = join(root, "candidate-inferred");
    await mkdir(candidate, { recursive: true });
    for (const file of INFERRED_APP_FILES) await cp(join(INFERRED_FIXTURE_ROOT, file), join(candidate, file), { recursive: true });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]), fauxAssistantMessage("I added the welcome page.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const implemented = await runOperation("IMPLEMENT");
    expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
    const candidateDigest = workflowNow().candidate!.digest;
    await completeReadiness();
    const checks = await runOperation("CHECKS");
    expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "REVIEW" });
    const e2e = workflowNow().e2e as { failedRound?: unknown; qualifiedRound?: { candidateDigest: string } };
    expect(e2e.qualifiedRound).toMatchObject({ candidateDigest });
    expect(e2e.failedRound).toBeUndefined();
    type CaseResult = { caseId: string; status: string; accountContextId: string; assertionReceipts: Array<{ assertionIndex: number; status: string }> };
    const cases = (checks.operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>).flatMap((ref) =>
      (JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { collection: { result: { cases: CaseResult[] } } } }).groupRun.collection.result.cases);
    expect(cases, "two scenarios, two cases, one group").toHaveLength(2);
    expect(cases.every((item) => item.status === "passed" && item.assertionReceipts.every((receipt) => receipt.status === "passed"))).toBe(true);
    // Both cases are the anonymous profile's: one account context, the one the fixed reference gives, since a signed-out visitor is nobody's account.
    const contextId = `app-account-${createHash("sha256").update(canonicalJson([plannedRef!.applicationId, plannedRef!.profileId, plannedRef!.revision, plannedRef!.definitionDigest])).digest("hex")}`.slice(0, 120);
    expect(cases.map((item) => item.accountContextId)).toEqual([contextId, contextId]);

    const presentation = await readJourneyTask(harness, journey.taskId).then((task) => task.e2ePresentation);
    expect(presentation?.shared.e2e.status).toBe("PASS");
    const publicationChecks = await journeyPublicationChecks(harness, journey.taskId);
    expect(publicationChecks?.length, "a passing signed-out round gives publication checks").toBeGreaterThan(0);
    // The app has no seed, no account and no volume: nothing of it is left on the Docker host.
    await nothingLeftBehind();
  }

  /** A copy of the orders-web fixture app a coder would produce, optionally edited (the tenant leak is how candidate 1 differs from candidate 2). */
  async function stageOrdersWebCandidate(root: string, name: string, edit?: (server: string) => string) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    for (const file of M13_APP_FILES) await cp(join(M13_FIXTURE_ROOT, file), join(dir, file), { recursive: true });
    if (edit) await writeFile(join(dir, "server.mjs"), edit(await readFile(join(dir, "server.mjs"), "utf8")));
    return dir;
  }

  /**
   * Task 3.4, whole: one app that serves its page and its API, planned with a web scenario and an API scenario on the owner of tenant-a. The web scenario asserts the orders table shows
   * only tenant-a's rows (`text`); the API scenario asks `GET /api/tenants/tenant-b/orders` and expects 403 (`http-status`). The broker admits ONE admission (schema version 2) with a runtime
   * row per kind (`<profile>#api`, `<profile>#web`) and two groups, the worker runs the two groups on the Docker host, and the broker verifies each against its own kind's row.
   * Candidate 1 leaves the tenant check out of the API: the web group passes and the API group FAILS, so the round is FAILED and sent back. Candidate 2 is the fixture as it ships: PASS.
   */
  async function webAndApiJourney() {
    let plannedRef: { applicationId: string; profileId: string; revision: number; definitionDigest: string } | undefined;
    const journey = await startJourney({ fixtureRoot: M13_FIXTURE_ROOT, planningFiles: ["package.json"], apiRuntime: true,
      // The setup is approved on the contract alone: with the inventory contract and its mock in the repository too, the planner's context for this app's ten targets is over its 12,000-byte bound
      // (see tests/unit/e2e-orders-web-and-api-plan.test.ts), and the candidate carries those files either way.
      instructions: "An owner sees only its own tenant's orders, in the page and through the API",
      plan: (context) => {
        const planned = planOwnerWebAndApi(context);
        plannedRef = planned.intent.runtimeAccountRefs[0];
        return { title: "Owners see only their tenant", claims: [{ id: "1", text: "An owner's page lists only its tenant's orders, and the API refuses another tenant's." }], plannerIntent: planned.plannerIntent };
      } });
    const { root, harness, taskKey, faux, workflowNow, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind } = journey;
    expect(plannedRef, "the plan carries the owner's registry reference").toBeDefined();
    const leaky = await stageOrdersWebCandidate(root, "candidate-leaky", withTenantCheckRemoved);
    const fixed = await stageOrdersWebCandidate(root, "candidate-fixed");
    const implementation = (candidate: string) => fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]);

    const presentation = () => readJourneyTask(harness, journey.taskId).then((task) => task.e2ePresentation);
    type GroupCase = { caseId: string; status: string; accountContextId: string; assertionReceipts: Array<{ assertionIndex: number; status: string }> };
    type GroupRun = { binding: { groupId: string; expectedCases: Array<{ targetId: string }> }; collection: { status: string; result: { cases: GroupCase[] } } };
    const groupsOf = (operation: Record<string, unknown>): GroupRun[] => (operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>).map((ref) =>
      (JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: GroupRun }).groupRun);
    const admissionOf = (operation: Record<string, unknown>) => JSON.parse(harness.s3.objects.get((operation.workflowE2EAdmission as { admissionRef: { key: string } }).admissionRef.key)!) as
      { schemaVersion: string; runtimeBindings: Array<{ key: string; value: { capabilities: { kind: string } } }>; groups: unknown[]; applicationBindings: unknown[]; executionPlan: { effectiveTargets: Array<{ targetId: string; kind: string }> } };

    // Round 1: the leaky candidate. The page is right, the API answers tenant-b's orders to tenant-a's owner.
    faux.setResponses([implementation(leaky), fauxAssistantMessage("I added the tenant orders API.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const first = await runOperation("IMPLEMENT");
    expect(first.operation.status, JSON.stringify(first.operation)).toBe("SUCCEEDED");
    await completeReadiness();
    const checks1 = await runOperation("CHECKS");
    expect(checks1.operation.status, JSON.stringify({ operation: checks1.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    // One admission of version 2 for both kinds: a row per kind under `<profile>#<kind>`, one application built for both, and a group for each kind.
    const admission1 = admissionOf(checks1.operation);
    expect(admission1.schemaVersion).toBe("workflow-e2e-application-admission/v2");
    expect(admission1.runtimeBindings.map((item) => [item.key, item.value.capabilities.kind])).toEqual([[`${PROFILE}#api`, "api"], [`${PROFILE}#web`, "web"]]);
    expect(admission1.applicationBindings).toHaveLength(1);
    expect(admission1.groups).toHaveLength(2);
    const groups1 = groupsOf(checks1.operation);
    expect(groups1, "a group per kind").toHaveLength(2);
    const kindOfTarget = (targetId: string) => admission1.executionPlan.effectiveTargets.find((target) => target.targetId === targetId)!.kind;
    const byKind = Object.fromEntries(groups1.map((group) => [kindOfTarget(group.binding.expectedCases[0]!.targetId), group])) as Record<"web" | "api", GroupRun>;
    expect(Object.keys(byKind).sort()).toEqual(["api", "web"]);
    // The web group passes, the API group fails on its one assertion: the round is FAILED, and send-back is offered.
    expect(byKind.web.collection.status).toBe("PASS");
    expect(byKind.api.collection.status).toBe("FAILED");
    expect(byKind.api.collection.result.cases.map((item) => [item.status, item.assertionReceipts.map((receipt) => receipt.status)])).toEqual([["failed", ["failed"]]]);
    expect(byKind.web.collection.result.cases.map((item) => item.status)).toEqual(["passed"]);
    expect(workflowNow().blockReason).toBe("one or more admitted E2E groups failed");
    const e2e1 = workflowNow().e2e as { failedRound?: { status: string }; qualifiedRound?: unknown };
    expect(e2e1.failedRound).toMatchObject({ status: "FAILED" });
    expect(e2e1.qualifiedRound).toBeUndefined();
    expect(workflowSendBackOffered(workflowNow() as never)).toBe(true);
    expect((await presentation())?.shared.e2e.status).toBe("FAILED");

    // Round 2: send it back; the fixture as it ships answers 403 to the other tenant, and both groups pass.
    const sentBack = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${journey.taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision,
      instructions: "The API must refuse another tenant's orders." });
    expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
    faux.setResponses([implementation(fixed), fauxAssistantMessage("The tenant check is back.")]);
    const second = await runOperation("IMPLEMENT");
    expect(second.operation.status, JSON.stringify(second.operation)).toBe("SUCCEEDED");
    const secondCandidateDigest = workflowNow().candidate!.digest;
    await completeReadiness();
    const checks2 = await runOperation("CHECKS", checks1.invocation.operationId);
    expect(checks2.operation.status, JSON.stringify({ operation: checks2.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "REVIEW" });
    const e2e2 = workflowNow().e2e as { failedRound?: unknown; qualifiedRound?: { candidateDigest: string } };
    expect(e2e2.qualifiedRound).toMatchObject({ candidateDigest: secondCandidateDigest });
    expect(e2e2.failedRound).toBeUndefined();
    const groups2 = groupsOf(checks2.operation);
    expect(groups2).toHaveLength(2);
    expect(groups2.every((group) => group.collection.status === "PASS" && group.collection.result.cases.every((item) => item.status === "passed"
      && item.assertionReceipts.every((receipt) => receipt.status === "passed")))).toBe(true);
    // Both groups run as the one owner account: the case of each is bound to the registry's reference for that account.
    const contextId = `app-account-${createHash("sha256").update(canonicalJson([plannedRef!.applicationId, plannedRef!.profileId, plannedRef!.revision, plannedRef!.definitionDigest])).digest("hex")}`.slice(0, 120);
    expect(groups2.flatMap((group) => group.collection.result.cases.map((item) => item.accountContextId))).toEqual([contextId, contextId]);
    expect((await presentation())?.shared.e2e.status).toBe("PASS");
    await nothingLeftBehind();
  }

  it("mocked-origin: the round is PASS with the inventory origin served by its approved mock, named on the result as mockedOrigins [inventory-v1]", async () => {
    await inventoryJourney("mocked-origin");
  }, 600_000);

  it("unmocked-call: a candidate that calls a path the inventory contract does not have gets UNKNOWN for unmocked-external-call, never PASS", async () => {
    await inventoryJourney("unmocked-call");
  }, 600_000);

  it("credential-echo: a password the candidate copies into an observed export reaches no row, no stored display and no Slack text (the executor's refusal and the host's scan, end to end, with proof the echo reached them)", async () => {
    await inventoryJourney("credential-echo");
  }, 600_000);

  it("results: five scenarios on three states of the code show a row each with its account and kind, a failure with a screenshot and expected versus actual, the baseline apart, and a passing round publishes", async () => {
    await inventoryJourney("results");
  }, 1_800_000);

  it("anonymous-inferred: an app with no project contract runs two signed-out scenarios on its anonymous variant; the plan is approved, the round is PASS with no account binding, and publication has checks", async () => {
    await anonymousInferredJourney();
  }, 1_800_000);

  it("web-and-api: one app planned with a web scenario and an API scenario runs as one version 2 admission with a row and a group per kind; the tenant leak in the API is FAILED and sent back, the fixed candidate is PASS", async () => {
    await webAndApiJourney();
  }, 1_800_000);

  it("accounts: three accounts in two tenants in one group; the viewer-access defect is FAILED and sent back, the fixed candidate is PASS, and no seeded credential is stored anywhere", async () => {
    await accountsJourney();
  }, 1_800_000);
});
