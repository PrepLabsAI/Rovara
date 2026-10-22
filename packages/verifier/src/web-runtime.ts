import { createHash, randomUUID } from "node:crypto";
import { E2EApplicationCliHostDescriptorSchema, E2EScenarioSchema, E2ERunBindingSchema, E2ERuntimeAccountRefSchema,
  canonicalJson, type E2ERuntimeAccountRef, type E2EScenario, type E2EApplicationAccountPorts, type E2EApplicationPreparedEnvironment,
  type E2EApplicationSupervisorPorts } from "@agentx/contracts";
import type { TestFixtures } from "e2e";
import type { EngineHandle } from "e2e/engine";
import { ASSERTION_FIXTURE, assertionStepFixture, assertionStepsOf, runInsideAssertionSteps, type AssertionSteps } from "./assertion-steps.js";
import { surfaceOf, web } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import type { BrowserContext, FileChooser, Page } from "playwright-core";
import type { E2EApplicationInstalledFileFixture } from "./application-runtime-assets.js";
import { createE2EApplicationCaseCaptureFrame, createE2EApplicationAssertionObservationHeader,
  readValidatedE2EApplicationCliCasePlan, recordE2EApplicationCliEvidence,
  readValidatedE2EApplicationCaseObservation, type E2EApplicationCliCasePlanReader, type E2EApplicationCliEvidenceWriter,
  type E2EApplicationProtectedCaseObservationReader } from "./application-services.js";
import { E2EApplicationAssertionObservationSchema,
  evaluateE2EApplicationAssertionObservation, type E2EApplicationCaseCapture, type E2EApplicationObservationBinding,
  type E2EApplicationProofBytes } from "./application-result-adapter.js";
import type { E2EApplicationCliHost, E2EApplicationCliLaunchContext } from "./application-runtime-bootstrap.js";
import { prepareE2EApplicationEnvironment, sealE2EApplicationEnvironment, type E2EApplicationEnvironmentPorts,
  type E2EApplicationPreparationInputs } from "./application-services.js";
import { runIsolatedE2EApplication, type E2EApplicationRuntimePorts } from "./application-runtime.js";
import { createE2EApplicationRuntimePorts } from "./application-services.js";
import type { E2ERunInput, ProjectSetupRunnerToolchain } from "@agentx/contracts";
import type { E2ECompiledApplicationSuite } from "./application-scenarios.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const utc = () => new Date().toISOString();

/**
 * Screenshots of failed cases (owner decision D3). Supplied only by the executor host, from the capture policy the admission approved (Ruling BZ), and only when screenshots
 * are approved. There is no trace capture (Ruling CJ). Capture is best effort and never changes what a case reports.
 */
export type E2EWebCapturePorts = Readonly<{
  screenshots: boolean;
  /** Stores one capture of one case under the executor's budget and credential scan. */
  record(input: { caseId: string; kind: "screenshot"; bytes: Uint8Array }): Promise<unknown>;
}>;
/** What the case adapter made of the case, for capture: a failed assertion is FAILED, a case that could not be observed is UNKNOWN. */
export type WebCaseCaptureOutcome = "passed" | "failed" | "unknown";
const SCREENSHOT_QUALITY = 70;
const SCREENSHOT_TIMEOUT_MS = 5_000;

/**
 * Takes the screenshot a FAILED or UNKNOWN case earns; a PASS case gets none. Best effort: a page that crashed or a recorder that refuses is absorbed, so capture can
 * never turn a case into a failure or change its verdict.
 */
export async function finishWebCaseCapture(input: { capture: E2EWebCapturePorts | undefined; caseId: string; outcome: WebCaseCaptureOutcome; page: Pick<Page, "screenshot"> | null }): Promise<void> {
  const { capture, caseId, outcome, page } = input;
  if (!capture?.screenshots || outcome === "passed" || !page) return;
  try {
    const bytes = await page.screenshot({ type: "jpeg", quality: SCREENSHOT_QUALITY, timeout: SCREENSHOT_TIMEOUT_MS });
    if (bytes.byteLength > 0) await capture.record({ caseId, kind: "screenshot", bytes: Uint8Array.from(bytes) });
  } catch { /* a page that cannot be photographed leaves no screenshot */ }
}

/**
 * How an agent step ended, as the executor's ledger recorded it: `concluded` when `agent.act` resolved, `failed` when it threw an `AgentError` (the stop code says which). Both are facts
 * about the executor's own run; whether the case passes is the deterministic assertions' (and Task 4.4's).
 */
export type E2EWebAgentStepOutcome = Readonly<{ verdict: "concluded" | "failed"; stopCode: string | null; receiptIds: readonly string[] }>;
/** The governed agent step driver, supplied only by the executor host and only for a group whose plan carries a model channel. */
export type E2EWebAgentPorts = Readonly<{
  /**
   * Runs one agent step: opens it on the model channel, writes its ledger, runs `act` (the pinned runner's `agent.act`, with Rovara's executor behind it) and closes the step. An
   * `AgentError` from `act` is an outcome (`failed`), never a throw; anything else that goes wrong (the channel refusing a marker, the ledger not writable) throws.
   */
  runStep(input: { caseId: string; stepIndex: number; goal: string; maxActions: number; timeoutMs: number; signal: AbortSignal;
    act(goal: string, options: { maxSteps: number; maxModelCalls: number; timeout: number }): Promise<unknown> }): Promise<E2EWebAgentStepOutcome>;
}>;

export type E2EWebRuntimePorts = Readonly<{
  /** Screenshots of failed cases; absent when the admission approves none. */
  capture?: E2EWebCapturePorts;
  /** Present only when the executor was given a model channel (a group with an agent step). */
  agent?: E2EWebAgentPorts;
  casePlans: E2EApplicationCliCasePlanReader;
  caseObservations: E2EApplicationProtectedCaseObservationReader;
  evidence: E2EApplicationCliEvidenceWriter;
  /** One authenticated protected window per admitted action; never replayed. */
  actionWindows: Readonly<{
    begin(input: { caseId: string; actionIndex: number; actionDigest: string }, signal: AbortSignal): Promise<{ actionId: string }>;
    finish(input: { caseId: string; actionIndex: number; actionDigest: string }, signal: AbortSignal): Promise<{ confirmed: true }>;
  }>;
  /** Supplied only by the installed owned-browser composition; never from project metadata. */
  resolveOwnedCdpEndpoint(signal: AbortSignal): Promise<string>;
  /** Resolves only the SDK's current attempt download under its protected artifact root. */
  readOwnedDownload(download: { path: string; suggestedFilename: string }, signal: AbortSignal): Promise<Uint8Array>;
  /** Resolves one installed fixture only after the protected case/action/assignment join succeeds. */
  readApprovedFileFixture(input: { caseId: string; actionIndex: number; actionDigest: string; actionWindowId: string; fixtureFileId: string }, signal: AbortSignal): Promise<{
    fixture: E2EApplicationInstalledFileFixture; casePlanDigest: string; browserContextId: string;
  }>;
  openCaseSession(input: { binding: unknown; applicationId: string; profileId: string; approvedAccountRef: E2ERuntimeAccountRef; origin: string }, signal: AbortSignal): Promise<{
    sessionRef: string; accountIdDigest: string;
  }>;
  applyToOwnedBrowserContext(sessionRef: string, context: BrowserContext, signal: AbortSignal): Promise<void>;
  closeCaseSession(sessionRef: string, signal: AbortSignal): Promise<{ confirmed: boolean }>;
  originFor(applicationId: string, preparedEnvironmentDigest: string): string;
}>;

type WebDeclaration = Readonly<{
  preparedEnvironmentDigest: string;
  target: { targetId: string; app: { identity: string } | null };
  originByApplicationId: readonly { applicationId: string; origin: string }[];
  cases: readonly { caseId: string; upstreamTestId: string; targetId: string; assertionBindings: readonly { index: number; kind: string; digest: string }[] }[];
}>;

type WebFixtures = TestFixtures & Readonly<{ browser: Browser; [ASSERTION_FIXTURE]: AssertionSteps }>;
function fixturesOf(value: unknown): WebFixtures {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("owned web fixture set is unavailable");
  const row = value as Partial<WebFixtures>;
  if (!row.app || typeof row.app.open !== "function" || !row.screen || typeof row.screen.getByTestId !== "function"
    || !row.browser || typeof row.browser.goto !== "function" || typeof row.browser.waitForDownload !== "function") {
    throw new Error("installed web engine did not provide its exact app, screen, and browser fixtures");
  }
  assertionStepsOf(row);
  return row as WebFixtures;
}

/**
 * What the admission allows the web engine to do, as the launch declaration states it: the artifact kinds it may record and whether it has a state hook. Both come
 * from the admitted capture policy and the admitted runtime row, never from the engine.
 */
export type WebEngineAdmission = Readonly<{ artifactCapabilities: readonly ("screenshot" | "video")[]; stateCapability: boolean }>;

/**
 * The pinned web engine, made exactly as capable as the admission says. The runner reports an engine's artifact and state capabilities from the hooks it has, so an
 * engine that keeps a screenshot or a video hook when capture is off, or a state hook the runtime row does not list, would report more than was admitted and the oracle
 * would (rightly) refuse the run. Without `artifacts` it records nothing; without `startVideo` it records no video; without `state` it has no state hook. Its capability
 * list follows its hooks, as the runner computes it. A video without a screenshot is not something this engine can be (its video hook belongs to `artifacts`), so a
 * policy asking for that is held against an engine that reports both and is refused by the oracle.
 */
export function admitWebEngine(base: ReturnType<typeof web>, admitted: WebEngineAdmission) {
  const screenshot = admitted.artifactCapabilities.includes("screenshot");
  const video = admitted.artifactCapabilities.includes("video");
  const { artifacts, state, capabilities, ...rest } = base;
  const kept = new Set(capabilities);
  if (!screenshot && !video) kept.delete("artifacts");
  if (!admitted.stateCapability) kept.delete("state");
  return Object.freeze({ ...rest, capabilities: kept,
    ...(artifacts !== undefined && (screenshot || video) ? { artifacts: video ? artifacts : { screenshot: artifacts.screenshot.bind(artifacts) } } : {}),
    ...(admitted.stateCapability ? { state } : {}) }) as typeof base;
}

/** The engine as the runner sees it: the admitted web engine plus the shared assertion-step fixture. Its live surface stays on the original. */
function withAssertionSteps(base: ReturnType<typeof web>) {
  return Object.freeze({ ...base, fixtures: Object.freeze({ ...base.fixtures, [ASSERTION_FIXTURE]: assertionStepFixture }) });
}

async function recordJson(ports: E2EWebRuntimePorts, caseId: string, kind: "case-capture" | "step-observation" | "assertion-observation" | "download", value: unknown, signal: AbortSignal) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  return recordE2EApplicationCliEvidence({ writer: ports.evidence, caseId, kind, bytes,
    mediaType: kind === "download" ? "application/octet-stream" : "application/json", signal });
}

function sameOriginPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")
    || [...path].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new Error("web application operation must use its exact same-origin admitted path");
  }
  return path;
}

const maxUploadedFixtureBytes = 65_536;

/** Fixed read-only page function for the exact FileChooser element; no scenario-provided code or selector is evaluated. */
type SelectedFileLike = Readonly<{ name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
type FileChooserInputLike = Readonly<{ type: string; files: Readonly<{ length: number; item(index: number): SelectedFileLike | null }> | null }>;
function readSelectedFileFromOwnedChooser(element: unknown, maximumBytes: number) {
  if (!element || typeof element !== "object" || Object.prototype.toString.call(element) !== "[object HTMLInputElement]") {
    throw new Error("owned file chooser element is unavailable");
  }
  const input = element as Partial<FileChooserInputLike>;
  if (input.type !== "file" || !input.files || typeof input.files.item !== "function" || input.files.length !== 1) {
    throw new Error("owned file chooser does not contain exactly one selected file");
  }
  const file = input.files.item(0);
  if (!file || typeof file.name !== "string" || typeof file.type !== "string" || typeof file.arrayBuffer !== "function"
    || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > maximumBytes) {
    throw new Error("selected file is empty, malformed, or exceeds the installed fixture bound");
  }
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { name: file.name, mimeType: file.type, byteLength: bytes.byteLength, bytesBase64: btoa(binary) };
  });
}

function decodeSelectedFile(raw: unknown): { name: string; mimeType: string; bytes: Uint8Array } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("owned chooser readback is malformed");
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "byteLength,bytesBase64,mimeType,name" || typeof row.name !== "string"
    || typeof row.mimeType !== "string" || typeof row.bytesBase64 !== "string" || !Number.isSafeInteger(row.byteLength)
    || (row.byteLength as number) < 1 || (row.byteLength as number) > maxUploadedFixtureBytes) throw new Error("owned chooser readback exceeds its exact bounded schema");
  const bytes = Buffer.from(row.bytesBase64, "base64");
  if (bytes.byteLength !== row.byteLength || bytes.toString("base64") !== row.bytesBase64) throw new Error("owned chooser returned noncanonical bytes");
  return { name: row.name, mimeType: row.mimeType, bytes: new Uint8Array(bytes) };
}


/** What came of the download an agent step was expected to trigger (it is the last step that can). `captured` is the one download of the step; the others are why there is none to use. */
export type WebAgentDownloadStatus = "captured" | "agent-no-download" | "ambiguous-download";
/** How long an agent step that concluded is given for a download it caused to start, after its last action returned. */
const AGENT_DOWNLOAD_GRACE_MS = 2_000;
const AGENT_STEP_MAX_MS = 90_000;
class NoAgentDownload extends Error { constructor() { super("the agent step caused no download"); this.name = "NoAgentDownload"; } }

/** Counts the downloads the owned page, and any page it opens, starts while it is watched. */
function watchDownloads(page: Page) {
  let count = 0;
  const waiting: Array<() => void> = [];
  const onDownload = () => { count += 1; for (const wake of waiting.splice(0)) wake(); };
  const tracked = new Set<Page>();
  const track = (target: Page) => { if (!tracked.has(target)) { tracked.add(target); target.on("download", onDownload); } };
  const onPage = (opened: Page) => track(opened);
  track(page);
  page.context().on("page", onPage);
  return {
    count: () => count,
    /** Resolves when a download has started, or after `ms`. */
    async first(ms: number): Promise<void> {
      if (count > 0) return;
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); waiting.push(() => { clearTimeout(timer); resolve(); }); });
    },
    stop(): void { page.context().off("page", onPage); for (const target of tracked) target.off("download", onDownload); },
  };
}

export async function executeWebSteps(input: { caseId: string; scenario: E2EScenario; fixtures: WebFixtures; ports: E2EWebRuntimePorts;
  page: Page; signal: AbortSignal; deadlineAt?: number; origin?: string }) {
  const csvAssertions = input.scenario.assertions.filter((item) => item.kind === "csv");
  let download: { suggestedFilename: string; bytes: Uint8Array; contentRef: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>> } | null = null;
  const steps: E2EApplicationCaseCapture["steps"] = [];
  /** Set only when an agent step was the last step that can trigger the CSV download: what came of it. */
  let agentDownloadStatus: WebAgentDownloadStatus | null = null;
  let pendingChooser: { chooser: FileChooser; page: Page; triggerIndex: number; triggerActionDigest: string; triggerActionId: string } | null = null;
  for (let stepIndex = 0; stepIndex < input.scenario.steps.length; stepIndex += 1) {
    const step = input.scenario.steps[stepIndex]!;
    const signal = input.signal;
    if (signal.aborted) throw new Error("application case was cancelled before its next admitted web step");
    const actionTimeout = Math.max(1, Math.min(30_000, (input.deadlineAt ?? Date.now() + 30_000) - Date.now()));
    if (actionTimeout <= 1 && (input.deadlineAt ?? Date.now() + 30_000) <= Date.now()) throw new Error("web action is outside the original case deadline");
    // The download trigger is the last approved click or tap, as before agent steps existed, wherever an agent step stands; only a case with no click or tap at all has its last
    // agent step for its trigger. An agent step after the trigger click runs without a download waiter, and one before it cannot take the click's download.
    const lastClick = input.scenario.steps.findLastIndex((candidate) => candidate.kind === "click" || candidate.kind === "tap");
    const finalDownloadTrigger = csvAssertions.length !== 1 ? -1
      : lastClick >= 0 ? lastClick : input.scenario.steps.findLastIndex((candidate) => candidate.kind === "agent");
    const action = { caseId: input.caseId, actionIndex: stepIndex, actionDigest: sha(canonicalJson(step)) };
    const window = await input.ports.actionWindows.begin(action, signal);
    if (!window || typeof window.actionId !== "string" || window.actionId.length < 1 || window.actionId.length > 160) {
      throw new Error("protected action window did not return its exact current identity");
    }
    let actionError: unknown;
    let finishError: unknown;
    try {
    const nextStep = input.scenario.steps[stepIndex + 1];
    const opensFileChooser = (step.kind === "click" || step.kind === "tap") && nextStep?.kind === "choose-file";
    if (opensFileChooser && pendingChooser !== null) throw new Error("an earlier file chooser is still unresolved on this page");
    if (step.kind === "choose-file") {
      if (!pendingChooser || pendingChooser.page !== input.page || pendingChooser.triggerIndex !== stepIndex - 1
        || input.scenario.steps[stepIndex - 1]?.kind !== "click" && input.scenario.steps[stepIndex - 1]?.kind !== "tap") {
        throw new Error("file selection requires its exact immediately preceding click or tap on the same owned page");
      }
      const approved = await input.ports.readApprovedFileFixture({ caseId: input.caseId, actionIndex: stepIndex,
        actionDigest: sha(canonicalJson(step)), actionWindowId: window.actionId, fixtureFileId: step.fixtureFileId }, signal);
      const fixture = approved?.fixture;
      if (!fixture || fixture.fixtureFileId !== step.fixtureFileId || !(fixture.bytes instanceof Uint8Array)
        || fixture.bytes.byteLength < 1 || fixture.bytes.byteLength > maxUploadedFixtureBytes
        || !/^[a-f0-9]{64}$/u.test(fixture.sha256) || sha(fixture.bytes) !== fixture.sha256
        || !/^[a-f0-9]{64}$/u.test(fixture.sourceManifestDigest) || !/^[a-f0-9]{64}$/u.test(approved.casePlanDigest)
        || !approved.browserContextId || approved.browserContextId.length > 256
        || !fixture.name || fixture.name.length > 160 || [...fixture.name].some((character) => {
          const code = character.codePointAt(0)!;
          return code < 0x20 || code === 0x7f || character === "/" || character === "\\";
        })
        || fixture.mimeType !== "text/csv") throw new Error("protected installed fixture readback is unavailable or differs from its exact fixed manifest");
      if (pendingChooser.chooser.page() !== input.page || pendingChooser.chooser.isMultiple()) throw new Error("file chooser is foreign to the current page or accepts ambiguous multiple files");
      await pendingChooser.chooser.setFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: Buffer.from(fixture.bytes) });
      const selected = decodeSelectedFile(await pendingChooser.chooser.element().evaluate(readSelectedFileFromOwnedChooser, maxUploadedFixtureBytes));
      if (selected.name !== fixture.name || selected.mimeType !== fixture.mimeType || sha(selected.bytes) !== fixture.sha256
        || selected.bytes.byteLength !== fixture.bytes.byteLength || !Buffer.from(selected.bytes).equals(Buffer.from(fixture.bytes))) {
        throw new Error("selected browser file differs from the exact installed fixture bytes or metadata");
      }
      const sourceRef = await recordE2EApplicationCliEvidence({ writer: input.ports.evidence, caseId: input.caseId,
        kind: "assertion-observation", bytes: selected.bytes, mediaType: "application/octet-stream", signal });
      const receipt = { schemaVersion: "e2e-application-file-selection-observation/v1", caseId: input.caseId, index: stepIndex,
        declaredStepIndex: stepIndex, kind: step.kind, fixtureFileId: fixture.fixtureFileId, sourceManifestDigest: fixture.sourceManifestDigest,
        casePlanDigest: approved.casePlanDigest, sourceSha256: fixture.sha256, selectedSha256: sha(selected.bytes), byteLength: selected.bytes.byteLength,
        name: selected.name, mimeType: selected.mimeType, browserContextId: approved.browserContextId, sameOwnedPage: true,
        chooserElementType: "file", chooserAllowsMultiple: false, trigger: { actionIndex: pendingChooser.triggerIndex,
          actionDigest: pendingChooser.triggerActionDigest, actionId: pendingChooser.triggerActionId },
        selectionActionId: window.actionId, observedAt: utc(), sourceRef };
      const stepRef = await recordJson(input.ports, input.caseId, "step-observation", receipt, signal);
      const observationId = randomUUID();
      steps.push({ index: stepIndex, declaredStepIndex: stepIndex, kind: step.kind, actionDigest: action.actionDigest, observationId,
        at: receipt.observedAt, outcome: "completed", evidenceRefs: [stepRef, sourceRef], agentOperationRefs: [] });
      pendingChooser = null;
      continue;
    }
    if (step.kind === "agent") {
      const agent = input.ports.agent;
      if (!agent) throw new Error("governed web agent execution is unavailable until the installed model-operation channel is present");
      if (pendingChooser !== null) throw new Error("an agent step cannot start while a file chooser is unresolved on this page");
      const timeoutMs = Math.max(1, Math.min(AGENT_STEP_MAX_MS, (input.deadlineAt ?? Date.now() + AGENT_STEP_MAX_MS) - Date.now()));
      const act = (goal: string, options: { maxSteps: number; maxModelCalls: number; timeout: number }) => input.fixtures.agent.act(goal, options);
      const runAgent = () => agent.runStep({ caseId: input.caseId, stepIndex, goal: step.goal, maxActions: step.maxActions, timeoutMs, signal, act });
      let outcome: E2EWebAgentStepOutcome | undefined;
      let captured: { suggestedFilename: string; bytes: Uint8Array; contentRef: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>> } | null = null;
      let status: WebAgentDownloadStatus | null = null;
      if (csvAssertions.length > 0 && stepIndex === finalDownloadTrigger) {
        if (download !== null) throw new Error("CSV download trigger association is ambiguous");
        // The download is the one the step caused. The pinned browser fixture arms its waiter before the step runs and keeps it for the whole step, then saves the first download it saw;
        // a second one is counted here, and makes the association ambiguous. A step that concluded without a download, or failed, ends the wait at once instead of running it out.
        const watching = watchDownloads(input.page);
        let saved: { path: string; suggestedFilename: string } | undefined;
        try {
          saved = await input.fixtures.browser.waitForDownload(async () => {
            outcome = await runAgent();
            if (outcome.verdict !== "concluded") throw new NoAgentDownload();
            await watching.first(AGENT_DOWNLOAD_GRACE_MS);
            if (watching.count() === 0) throw new NoAgentDownload();
          }, { timeout: timeoutMs + 10_000 });
        } catch (error) { if (!(error instanceof NoAgentDownload)) throw error; }
        finally { watching.stop(); }
        if (outcome === undefined) throw new Error("the agent step did not report how it ended");
        if (outcome.verdict === "failed") status = null;
        else if (saved === undefined) status = "agent-no-download";
        else if (watching.count() > 1) status = "ambiguous-download";
        else {
          const bytes = Uint8Array.from(await input.ports.readOwnedDownload(saved, signal));
          const contentRef = await recordE2EApplicationCliEvidence({ writer: input.ports.evidence, caseId: input.caseId, kind: "download", bytes, mediaType: "text/csv", signal });
          captured = { suggestedFilename: saved.suggestedFilename, bytes, contentRef };
          status = "captured";
        }
      } else {
        outcome = await runAgent();
      }
      // A step that did not conclude stops the case here: its facts are in the ledger and the report, and no assertion is observed on a page it left half-way.
      if (outcome.verdict === "failed") throw new Error(`the web agent step did not conclude (${outcome.stopCode ?? "unknown"})`);
      if (captured) download = captured;
      if (status !== null) agentDownloadStatus = status;
      const observationId = randomUUID();
      const stepRef = await recordJson(input.ports, input.caseId, "step-observation", { schemaVersion: "e2e-application-step-observation/v1",
        caseId: input.caseId, index: stepIndex, declaredStepIndex: stepIndex, kind: step.kind, observationId, at: utc(), outcome: "completed",
        agent: { verdict: outcome.verdict, stopCode: outcome.stopCode, download: status ?? "not-applicable" },
        ...(captured ? { downloadName: captured.suggestedFilename, byteLength: captured.bytes.byteLength, sha256: sha(captured.bytes), contentRef: captured.contentRef } : {}) }, signal);
      steps.push({ index: stepIndex, declaredStepIndex: stepIndex, kind: step.kind, actionDigest: sha(canonicalJson(step)), observationId, at: utc(), outcome: "completed",
        evidenceRefs: captured ? [stepRef, captured.contentRef] : [stepRef], agentOperationRefs: [] });
      continue;
    }
    if (csvAssertions.length > 0 && (step.kind === "click" || step.kind === "tap") && stepIndex === finalDownloadTrigger) {
      if (opensFileChooser) throw new Error("one click cannot be the ambiguous trigger for both file selection and download");
      if (download !== null) throw new Error("CSV download trigger association is ambiguous");
      const result = await input.fixtures.browser.waitForDownload(async () => {
        if (step.kind === "click") await input.fixtures.screen.getByTestId(step.testId).click({ timeout: actionTimeout });
        else await input.fixtures.screen.getByTestId(step.testId).tap({ timeout: actionTimeout });
      }, { timeout: actionTimeout });
      const bytes = Uint8Array.from(await input.ports.readOwnedDownload(result, signal));
      const contentRef = await recordE2EApplicationCliEvidence({ writer: input.ports.evidence, caseId: input.caseId, kind: "download", bytes,
        mediaType: "text/csv", signal });
      download = { suggestedFilename: result.suggestedFilename, bytes, contentRef };
      const observationId = randomUUID();
      const stepRef = await recordJson(input.ports, input.caseId, "step-observation", { schemaVersion: "e2e-application-step-observation/v1",
        caseId: input.caseId, index: stepIndex, declaredStepIndex: stepIndex, kind: step.kind, observationId,
        at: utc(), outcome: "completed", downloadName: result.suggestedFilename, byteLength: bytes.byteLength, sha256: sha(bytes), contentRef }, signal);
      steps.push({ index: stepIndex, declaredStepIndex: stepIndex, kind: step.kind, actionDigest: sha(canonicalJson(step)), observationId,
        at: utc(), outcome: "completed", evidenceRefs: [stepRef, contentRef], agentOperationRefs: [] });
      continue;
    }
    let handledByFileChooserTrigger = false;
    if (opensFileChooser) {
      let chooserEvent: Promise<FileChooser>;
      try {
        chooserEvent = input.page.waitForEvent("filechooser", { timeout: actionTimeout });
      } catch (error) { throw new Error("installed owned page cannot arm its fixed file chooser event", { cause: error }); }
      void chooserEvent.catch(() => undefined);
      if (step.kind === "click") await input.fixtures.screen.getByTestId(step.testId).click({ timeout: actionTimeout });
      else await input.fixtures.screen.getByTestId(step.testId).tap({ timeout: actionTimeout });
      const chooser = await chooserEvent;
      if (chooser.page() !== input.page || chooser.isMultiple()) throw new Error("preceding action opened a foreign or ambiguous file chooser");
      pendingChooser = { chooser, page: input.page, triggerIndex: stepIndex, triggerActionDigest: action.actionDigest, triggerActionId: window.actionId };
      handledByFileChooserTrigger = true;
    }
    if (!handledByFileChooserTrigger) switch (step.kind) {
      case "navigate": {
        if (!input.origin) throw new Error("web navigation has no exact prepared origin");
        await input.fixtures.browser.goto(new URL(sameOriginPath(step.path), input.origin).toString(), { timeout: actionTimeout });
        break;
      }
      case "launch-app": {
        if (!input.origin) throw new Error("web launch has no exact prepared origin");
        await input.fixtures.browser.goto(input.origin, { timeout: actionTimeout });
        break;
      }
      case "restart-app": await input.fixtures.browser.reload({ timeout: actionTimeout }); break;
      case "fill": await input.fixtures.screen.getByTestId(step.testId).fill(step.value, { timeout: actionTimeout }); break;
      case "click": await input.fixtures.screen.getByTestId(step.testId).click({ timeout: actionTimeout }); break;
      case "tap": await input.fixtures.screen.getByTestId(step.testId).tap({ timeout: actionTimeout }); break;
      case "swipe": await input.fixtures.screen.swipe({ direction: step.direction }); break;
      default: throw new Error(`web step ${step.kind} has no installed fixed web driver`);
    }
    const observationId = randomUUID();
    const stepRef = await recordJson(input.ports, input.caseId, "step-observation", { schemaVersion: "e2e-application-step-observation/v1",
      caseId: input.caseId, index: stepIndex, declaredStepIndex: stepIndex, kind: step.kind, observationId, at: utc(), outcome: "completed" }, signal);
    steps.push({ index: stepIndex, declaredStepIndex: stepIndex, kind: step.kind, actionDigest: sha(canonicalJson(step)), observationId,
      at: utc(), outcome: "completed", evidenceRefs: [stepRef], agentOperationRefs: [] });
    } catch (error) {
      actionError = error;
    } finally {
      try {
        const finished = await input.ports.actionWindows.finish(action, signal);
        if (!finished || finished.confirmed !== true) finishError = new Error("protected action window finish was not confirmed");
      } catch (error) { finishError = error; }
    }
    if (finishError !== undefined) throw new Error("protected action result is uncertain because its action window could not be durably finished", { cause: finishError });
    if (actionError instanceof Error) throw actionError;
    if (actionError !== undefined) throw new Error("web action failed with a non-error rejection", { cause: actionError });
  }
  if (pendingChooser !== null) throw new Error("owned file chooser was opened without its exact following approved fixture selection");
  if (csvAssertions.length > 0 && !download && agentDownloadStatus === null) throw new Error("CSV assertion has no exact preceding admitted download trigger");
  return { download, steps, agentDownloadStatus };
}

async function observeWebAssertions(input: { caseId: string; scenario: E2EScenario; fixtures: WebFixtures; engine: EngineHandle;
  ports: E2EWebRuntimePorts; plan: Parameters<typeof createE2EApplicationAssertionObservationHeader>[0]["plan"];
  binding: E2EApplicationObservationBinding;
  download: { suggestedFilename: string; bytes: Uint8Array; contentRef: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>> } | null;
  /** Why an agent step that was to cause the download left none to use; absent for any other step. */
  agentDownloadStatus?: WebAgentDownloadStatus | null;
  signal: AbortSignal }): Promise<{ assertions: E2EApplicationCaseCapture["assertions"]; refs: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>>[] }> {
  const surface = surfaceOf(input.engine);
  if (!surface) throw new Error("installed web engine did not expose its own live Playwright surface");
  const page = surface.page();
  const assertions: E2EApplicationCaseCapture["assertions"] = [];
  const refs: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>>[] = [];
  let stoppedReason: string | null = null;
  for (let index = 0; index < input.scenario.assertions.length; index += 1) {
    if (input.signal.aborted) throw new Error("application assertion observation was cancelled");
    const assertion = input.scenario.assertions[index]!;
    const observedAt = utc(); const observationId = randomUUID();
    const header = createE2EApplicationAssertionObservationHeader({ plan: input.plan, binding: input.binding, index, observedAt, observationId });
    if (stoppedReason) {
      assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId: null,
        value: null, evidenceRef: null, outcome: "unavailable", reason: stoppedReason, producer: header.producer });
      continue;
    }
    let observation: unknown; const proofBytes = new Map<string, E2EApplicationProofBytes>();
    if (assertion.kind === "text") {
      const locator = page.getByTestId(assertion.testId);
      const text = (await locator.textContent()) ?? "";
      const evidenceRef = await recordE2EApplicationCliEvidence({ writer: input.ports.evidence, caseId: input.caseId,
        kind: "assertion-observation", bytes: Buffer.from(text, "utf8"), mediaType: "text/plain", signal: input.signal });
      proofBytes.set(evidenceRef.artifactId, { ref: evidenceRef, bytes: Buffer.from(text, "utf8") });
      observation = { ...header, kind: "text", testId: assertion.testId, text, observationRef: evidenceRef };
    } else if (assertion.kind === "visible") {
      const visible = await page.getByTestId(assertion.testId).isVisible();
      const bytes = Buffer.from(String(visible), "utf8");
      const evidenceRef = await recordE2EApplicationCliEvidence({ writer: input.ports.evidence, caseId: input.caseId,
        kind: "assertion-observation", bytes, mediaType: "text/plain", signal: input.signal });
      proofBytes.set(evidenceRef.artifactId, { ref: evidenceRef, bytes });
      observation = { ...header, kind: "visible", testId: assertion.testId, visible, observationRef: evidenceRef };
    } else if (assertion.kind === "csv") {
      if (!input.download) {
        assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId: null,
          value: null, evidenceRef: null, outcome: "unavailable", reason: input.agentDownloadStatus === "agent-no-download" || input.agentDownloadStatus === "ambiguous-download" ? input.agentDownloadStatus : "download-not-observed",
          producer: header.producer });
        stoppedReason = "prior-assertion-observation-unavailable";
        continue;
      }
      proofBytes.set(input.download.contentRef.artifactId, { ref: input.download.contentRef, bytes: input.download.bytes });
      observation = { ...header, kind: "csv", downloadId: input.download.contentRef.artifactId,
        downloadName: input.download.suggestedFilename, contentRef: input.download.contentRef };
    } else {
      assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId: null,
        value: null, evidenceRef: null, outcome: "unavailable", reason: `unsupported-web-${assertion.kind}`, producer: header.producer });
      stoppedReason = "prior-assertion-observation-unavailable";
      continue;
    }
    const checked = E2EApplicationAssertionObservationSchema.parse(observation);
    const result = evaluateE2EApplicationAssertionObservation({ assertion, observation: checked, proofBytes, assetBinding: null });
    const evidenceRef = await recordJson(input.ports, input.caseId, "assertion-observation", checked, input.signal);
    refs.push(...[...proofBytes.values()].map((proof) => proof.ref), evidenceRef);
    assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId,
      value: result.value, evidenceRef, outcome: !result.supported ? "unavailable" : result.passed ? "passed" : "failed",
      reason: !result.supported ? "observation-not-supported" : result.passed ? "assertion-observed" : "source-approved-value-mismatch",
      producer: header.producer });
    if (!result.supported || !result.passed) stoppedReason = result.supported ? "prior-assertion-failed" : "prior-assertion-observation-unavailable";
  }
  return { assertions, refs };
}

/** Construct an effect-free fixed Chromium host; browser endpoint resolution stays lazy until the first SDK connection. */
export function createWebApplicationCliHost(input: { launchContext: E2EApplicationCliLaunchContext; declaration: WebDeclaration; ports: E2EWebRuntimePorts; engineAdmission: WebEngineAdmission }): Omit<E2EApplicationCliHost, "launchContext" | "installedModule"> {
  const { launchContext, declaration, ports, engineAdmission } = input;
  if (launchContext.selectedTarget.kind !== "web" || launchContext.selectedTarget.browser !== "chromium"
    || declaration.target.app === null || declaration.target.app.identity !== launchContext.selectedTarget.applicationId) {
    throw new Error("web host requires the exact selected Chromium target and its source-bound application identity");
  }
  const liveEngine = web({ browser: "chromium", viewport: launchContext.selectedTarget.viewport,
    connect: { cdpEndpoint: (signal) => ports.resolveOwnedCdpEndpoint(signal) } });
  const engine = withAssertionSteps(admitWebEngine(liveEngine, engineAdmission));
  const descriptor = E2EApplicationCliHostDescriptorSchema.parse(launchContext.cliHost.descriptor);
  return Object.freeze({ profileId: launchContext.cliHost.profileId, descriptor, engine,
    async runCase(caseId: string, rawFixtures: unknown): Promise<void> {
      const caseStartedAt = Date.now();
      const launchSignal = AbortSignal.timeout(Math.max(1, Date.parse(launchContext.deadlineAt) - caseStartedAt));
      const plan = await readValidatedE2EApplicationCliCasePlan({ reader: ports.casePlans, launchContext, declaration,
        caseId, signal: launchSignal });
      const scenario = E2EScenarioSchema.parse(plan.scenario);
      const caseDeadline = Math.min(Date.parse(launchContext.deadlineAt), caseStartedAt + plan.round.limits.caseTimeoutMs);
      const operationSignal = AbortSignal.any([launchSignal, AbortSignal.timeout(Math.max(1, caseDeadline - Date.now()))]);
      if (operationSignal.aborted) throw new Error("web case exceeded its original launch or approved case deadline before opening a session");
      const fixtures = fixturesOf(rawFixtures);
      const origin = ports.originFor(launchContext.selectedTarget.applicationId, plan.preparedEnvironmentDigest);
      const preparedOrigin = declaration.originByApplicationId.find((item) => item.applicationId === launchContext.selectedTarget.applicationId)?.origin;
      let parsedOrigin: URL;
      try { parsedOrigin = new URL(origin); } catch { throw new Error("prepared web origin is not a concrete canonical origin"); }
      if (!preparedOrigin || origin !== preparedOrigin || !["http:", "https:"].includes(parsedOrigin.protocol)
        || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== "/"
        || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.hostname.includes("*") || parsedOrigin.hostname.includes("%")) {
        throw new Error("web host origin differs from the exact source-compiled prepared owned origin");
      }
      const session = await ports.openCaseSession({ binding: plan.binding, applicationId: launchContext.selectedTarget.applicationId,
        profileId: plan.runtimeAccountRef.profileId, approvedAccountRef: plan.runtimeAccountRef, origin }, operationSignal);
      if (!session.sessionRef || !/^[a-f0-9]{64}$/.test(session.accountIdDigest)) {
        throw new Error("installed web account driver did not return an app-issued session and account digest");
      }
      let caseFailed = false;
      let caseError: unknown;
      let sessionClosed: boolean;
      // For capture only: the live page once the case has one, and what the case turned out to be.
      let ownedPage = null as Page | null;
      let captureOutcome: WebCaseCaptureOutcome = "unknown";
      try {
        const chain = await runInsideAssertionSteps(fixtures[ASSERTION_FIXTURE], scenario.assertions.length, async () => {
        // The fresh attempt context has no page, and the case needs a live one before approved authentication can be applied. The one
        // non-network page (about:blank) gives it one without touching the application.
        await fixtures.browser.goto("about:blank");
        const surface = surfaceOf(liveEngine) ?? surfaceOf(engine);
        if (!surface) throw new Error("web engine live surface is unavailable before approved authentication can be applied");
        const context = surface.context();
        const page = surface.page();
        await ports.applyToOwnedBrowserContext(session.sessionRef, context, operationSignal);
        ownedPage = page;
        const protectedObservation = await readValidatedE2EApplicationCaseObservation({ reader: ports.caseObservations,
          launchContext, plan, ownedClientRef: session.sessionRef, expectedSubjectKind: "browser", signal: operationSignal });
        if (protectedObservation.binding.sessionRef !== session.sessionRef || protectedObservation.binding.accountIdDigest !== session.accountIdDigest
          || protectedObservation.identityEvidence.length < 3 || protectedObservation.identityEvidence.length > 4) {
          throw new Error("protected web observation binding differs from the just-opened app-issued session");
        }
        const stepResult = await executeWebSteps({ caseId, scenario, fixtures, ports, page, signal: operationSignal, deadlineAt: caseDeadline, origin });
        const assertionResult = await observeWebAssertions({ caseId, scenario, fixtures, engine: liveEngine, ports, plan,
          binding: protectedObservation.binding, download: stepResult.download, agentDownloadStatus: stepResult.agentDownloadStatus, signal: operationSignal });
        const failedIndex = assertionResult.assertions.findIndex((item) => item.outcome === "failed");
        const unavailableIndex = assertionResult.assertions.findIndex((item) => item.outcome === "unavailable");
        const at = utc();
        const terminal = failedIndex >= 0 ? { kind: "assertion-failed" as const, lastDeclaredStepIndex: stepResult.steps.at(-1)?.declaredStepIndex ?? null,
          failedAssertionIndex: failedIndex, at, reason: "source-approved-assertion-mismatch" }
          : unavailableIndex >= 0 ? { kind: "unavailable" as const, lastDeclaredStepIndex: stepResult.steps.at(-1)?.declaredStepIndex ?? null,
            failedAssertionIndex: unavailableIndex, at, reason: "assertion-observation-unavailable" }
            : { kind: "completed" as const, lastDeclaredStepIndex: stepResult.steps.at(-1)?.declaredStepIndex ?? null,
              failedAssertionIndex: null, at, reason: "all-source-approved-assertions-passed" };
        const artifacts = [...protectedObservation.identityEvidence.map((item) => item.ref),
          ...stepResult.steps.flatMap((item) => item.evidenceRefs), ...assertionResult.refs,
          ...(stepResult.download ? [stepResult.download.contentRef] : [])];
        const capture = createE2EApplicationCaseCaptureFrame({ plan, launchContext, binding: protectedObservation.binding,
          upstreamRunId: protectedObservation.upstreamRunId, observedAt: at, steps: stepResult.steps,
          assertions: assertionResult.assertions, artifacts, terminal });
        await recordJson(ports, caseId, "case-capture", capture, operationSignal);
        return { failedIndex, unavailableIndex };
        });
        if (chain.outcome === null) throw chain.error;
        const { failedIndex, unavailableIndex } = chain.outcome;
        captureOutcome = failedIndex >= 0 ? "failed" : unavailableIndex >= 0 ? "unknown" : "passed";
        if (failedIndex >= 0) throw new Error(`web assertion ${failedIndex} failed against the actual owned browser observation`);
        if (unavailableIndex >= 0) throw new Error(`web assertion ${unavailableIndex} is unavailable on the installed fixed browser surface`);
      } catch (error) {
        caseFailed = true;
        caseError = error;
      } finally {
        // Before the session closes, while the page is still the case's own; best effort, so it can change neither the verdict nor the cleanup below.
        await finishWebCaseCapture({ capture: ports.capture, caseId, outcome: captureOutcome, page: ownedPage });
        try { sessionClosed = (await ports.closeCaseSession(session.sessionRef, AbortSignal.timeout(5_000))).confirmed; }
        catch { sessionClosed = false; }
      }
      if (!sessionClosed) throw new Error("installed web account session cleanup is unconfirmed");
      if (caseFailed) throw caseError;
    } });
}

/** Compose the fixed web case adapter with the established lifecycle and protected preparation/account/supervisor ports. */
export function createWebRuntime(input: { compiled: E2ECompiledApplicationSuite; runInput: E2ERunInput;
  prepared: E2EApplicationPreparedEnvironment;
  admissionDigest: string; runnerToolchain: ProjectSetupRunnerToolchain; accountSessionRefs: readonly string[]; modelProxyRef: string | null;
  readActualRun(signal: AbortSignal): ReturnType<E2EApplicationRuntimePorts["readActualRun"]>;
  environment: E2EApplicationEnvironmentPorts;
  accounts: E2EApplicationAccountPorts; supervisor: E2EApplicationSupervisorPorts;
  casePorts: Omit<E2EWebRuntimePorts, "openCaseSession" | "applyToOwnedBrowserContext" | "closeCaseSession">;
  resolveOwnedBrowserContextRef(context: BrowserContext): string }) {
  const ports: E2EWebRuntimePorts = Object.freeze({ ...input.casePorts,
    openCaseSession: ({ binding, applicationId, approvedAccountRef, origin }, signal) => input.accounts.open({
      binding: E2ERunBindingSchema.parse(binding), applicationId, approvedAccountRef: E2ERuntimeAccountRefSchema.parse(approvedAccountRef), origin,
    }, signal),
    applyToOwnedBrowserContext: (sessionRef, context, signal) => {
      const ownedClientRef = input.resolveOwnedBrowserContextRef(context);
      if (!ownedClientRef) throw new Error("the current web BrowserContext has no protected owned-client identity");
      return input.accounts.applyToOwnedClient(sessionRef, ownedClientRef, signal);
    },
    closeCaseSession: (sessionRef, signal) => input.accounts.close(sessionRef, signal),
  });
  const lifecycle = createE2EApplicationRuntimePorts({ compiled: input.compiled, runInput: input.runInput, prepared: input.prepared,
    admissionDigest: input.admissionDigest, runnerToolchain: input.runnerToolchain, accountSessionRefs: input.accountSessionRefs,
    modelProxyRef: input.modelProxyRef, supervisor: input.supervisor, readActualRun: (signal) => input.readActualRun(signal) });
  return Object.freeze({ lifecycle, supervisor: input.supervisor,
    run: (signal: AbortSignal) => runIsolatedE2EApplication({ input: input.runInput, compiled: input.compiled, ports: lifecycle, signal }),
    prepare: (preparation: E2EApplicationPreparationInputs, signal: AbortSignal) => prepareE2EApplicationEnvironment(preparation, input.environment, signal),
    seal: (request: Parameters<typeof sealE2EApplicationEnvironment>[0], signal: AbortSignal) => sealE2EApplicationEnvironment(request, input.environment, signal),
    createCliHost: (host: { launchContext: E2EApplicationCliLaunchContext; declaration: WebDeclaration; engineAdmission: WebEngineAdmission }) =>
      createWebApplicationCliHost({ ...host, ports }),
  });
}
