import { appendFileSync, readFileSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { z } from "zod";
import { E2E_EXECUTOR_COMPILED_ORIGIN, E2EExecutorPlanSchema, canonicalJson } from "@agentx/contracts";
import type { BrowserContext } from "playwright-core";
import { createAPIApplicationCliHost, type E2EApiRuntimePorts } from "../api-runtime.js";
import { createWebApplicationCliHost, type E2EWebRuntimePorts } from "../web-runtime.js";
import type { E2EApplicationCliHost, E2EApplicationCliLaunchContext } from "../application-runtime-bootstrap.js";
import { readE2EApplicationInstalledFileFixture } from "../application-runtime-assets.js";
import { e2eApplicationStateProbeManifestDigest, installedE2EApplicationStateProbeAsset } from "../application-state-probes.js";
import { isPinnedRovaraHttpEngine } from "../rovara-http-engine-descriptor.js";
import { createExecutorSessionStore } from "./accounts.js";
import { createRovaraE2EAgentExecutor } from "./agent-executor.js";
import { createE2EAgentCaptureStore, persistE2EAgentTrace } from "./agent-capture-store.js";
import type { E2EAgentLedgerWriter } from "./agent-ledger.js";
import { createE2EAgentStepDriver } from "./agent-step-driver.js";
import { createE2EAgentModelAdapter } from "./agent-model-adapter.js";
import { installRefusingE2EDefaultProvider } from "./ai-default-provider.js";
import { createE2EReplayState, createE2EReplayStepDriver, createE2EReplayStore, createRovaraE2EReplayExecutor } from "./agent-replay.js";
import { createE2EModelChannelClient } from "./model-channel.js";
import { createCredentialRedactor } from "./redact.js";
import { createFileCaseLedger, type FileCaseLedger } from "./case-ledger.js";
import { createPlaywrightFormLoginDriver, isSessionCookieSecret, isSessionStorageSecret, parseSetCookie } from "./form-login.js";
import { casePlanFor, resolveE2EExecutorSuite } from "./suite.js";

export const E2E_EXECUTOR_CONTEXT_ENV = "ROVARA_E2E_EXECUTOR_CONTEXT" as const;
export const E2E_EXECUTOR_BLOCKED_LOG = ".blocked-requests.jsonl" as const;
export const E2E_EXECUTOR_OUTPUT_DIR = ".agentx-run-output" as const;
/**
 * Two private files the CLI process leaves in its shard's project directory (never in the out directory) for the executor parent: the session values it must scrub from the
 * text it writes (JSON strings, one per line), and the account profiles whose form login did not complete (JSON strings, one per line).
 */
export const E2E_EXECUTOR_SESSION_SECRETS_FILE = ".session-secrets.jsonl" as const;
export const E2E_EXECUTOR_LOGIN_FAILED_FILE = ".login-failed.jsonl" as const;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_PLAN_BYTES = 20 * 1024 * 1024;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** The private per-shard hand-off from the executor parent to the CLI process that loads this host. It holds no credentials. */
export const ExecutorHostContextSchema = z.object({
  schemaVersion: z.literal("e2e-executor-host-context/v1"),
  planPath: z.string().min(1).max(4096),
  outDir: z.string().min(1).max(4096),
  projectDir: z.string().min(1).max(4096),
  cdpEndpoint: z.string().min(1).max(1024).nullable(),
  browserPid: z.number().int().nonnegative().nullable(),
  /** Test seam, set only from `E2EExecutorRunInput.modelSocketPath` and never from a plan: where the model socket really is when it is not at the plan's fixed path (a developer's machine). */
  modelSocketPath: z.string().min(1).max(4096).optional(),
}).strict();
export type ExecutorHostContext = z.infer<typeof ExecutorHostContextSchema>;

type Declaration = Readonly<{
  modelRoute: Readonly<{ routeId: string; routeRevision: string }> | null;
  preparedEnvironmentDigest: string;
  target: { targetId: string; app: { identity: string } | null; engine: { name: string; version: string; spiVersion: number; platform: string; workers?: number; capabilities: readonly string[] } | null };
  originByApplicationId: readonly { applicationId: string; origin: string }[];
  cases: readonly { caseId: string; upstreamTestId: string; targetId: string; assertionBindings: readonly { index: number; kind: string; digest: string }[] }[];
}>;

function readContext(): ExecutorHostContext {
  const path = process.env[E2E_EXECUTOR_CONTEXT_ENV];
  if (!path) throw new Error("the executor host context is not attached to this process");
  return ExecutorHostContextSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function safeRelativeDownloadPath(path: string): string {
  if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("download path is not a plain relative path");
  return path;
}

/**
 * Finds the one file the SDK just saved for a download. The SDK reports the path relative to its attempt directory, which sits
 * somewhere under the run's output directory; the newest file that ends with exactly that relative path is this download.
 */
async function readSdkDownload(outputRoot: string, relativePath: string): Promise<Uint8Array> {
  const wanted = safeRelativeDownloadPath(relativePath);
  const root = await realpath(outputRoot);
  const matches: { path: string; mtimeMs: number }[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 20_000) throw new Error("download search exceeded its directory bound");
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        const rel = full.slice(root.length + 1).split(sep).join("/");
        if (rel === wanted || rel.endsWith(`/${wanted}`)) matches.push({ path: full, mtimeMs: (await lstat(full)).mtimeMs });
      }
    }
  };
  await walk(root, 0);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = matches[0];
  if (!newest) throw new Error("the SDK download is not under the run output directory");
  if (matches[1]?.mtimeMs === newest.mtimeMs) throw new Error("the SDK download path is ambiguous");
  const handle = await open(newest.path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_DOWNLOAD_BYTES || await realpath(newest.path) !== newest.path) {
      throw new Error("the SDK download is empty, too large or not a regular file");
    }
    return new Uint8Array(await handle.readFile());
  } finally { await handle.close(); }
}

/** The first-party reporter writes the upstream run id once, before any test body runs. */
async function readUpstreamRunId(projectDir: string, launchId: string): Promise<string> {
  const text = readFileSync(join(projectDir, ".agentx", "e2e", `run-start-${launchId}.jsonl`), "utf8").trim();
  const row = JSON.parse(text) as { runId?: unknown; challenge?: unknown };
  if (row.challenge !== launchId || typeof row.runId !== "string") throw new Error("the run-start capture does not bind this launch");
  return row.runId;
}

/**
 * The executor's CLI host: the fixed web and API case adapters wired to the file ledger, the in-memory session store, the
 * Chromium the parent launched, and (for web) a context guard that blocks every request outside the app origin.
 * The module that re-exports this factory is the one the installed host registry names.
 */
export function createE2EApplicationCliHost(input: { launchContext: E2EApplicationCliLaunchContext; declaration: Declaration }):
  Omit<E2EApplicationCliHost, "launchContext" | "installedModule"> {
  const context = readContext();
  const planBytes = readFileSync(context.planPath);
  if (planBytes.byteLength > MAX_PLAN_BYTES) throw new Error("executor plan exceeds its fixed bound");
  const plan = E2EExecutorPlanSchema.parse(JSON.parse(planBytes.toString("utf8")));
  const resolved = resolveE2EExecutorSuite(plan);
  const { launchContext, declaration } = input;
  let activeCaseId: string | null = null;
  let activeSessionRef: string | null = null;
  let ledger: FileCaseLedger | null = null;
  const ownedContexts = new Map<string, BrowserContext>();

  // Every browser context the executor opens, the form login's included, may reach the application's origin and nothing else.
  const guarded = new WeakSet<BrowserContext>();
  const blockedLog = join(context.outDir, E2E_EXECUTOR_BLOCKED_LOG);
  const guard = async (browserContext: BrowserContext): Promise<void> => {
    if (guarded.has(browserContext)) return;
    guarded.add(browserContext);
    await browserContext.route("**/*", async (route) => {
      const request = route.request();
      let url: URL;
      try { url = new URL(request.url()); } catch { await route.abort("blockedbyclient"); return; }
      if (url.origin === E2E_EXECUTOR_COMPILED_ORIGIN || url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
        await route.continue();
        return;
      }
      appendFileSync(blockedLog, `${JSON.stringify({ at: new Date().toISOString(), caseId: activeCaseId, method: request.method(),
        resourceType: request.resourceType(), host: url.host, url: `${url.origin}${url.pathname}` })}\n`);
      await route.abort("blockedbyclient");
    });
    // `route` never sees a WebSocket: without this the candidate's own page could open one to any host of the run network, a mock included, and fabricate a call. Only the
    // application's own origin may; every other WebSocket opened from the page is closed before it connects and recorded like a blocked request.
    // This does not cover a WebSocket opened from a Worker: Playwright replaces `WebSocket` with an init script, and init scripts do not run in workers. Such a socket is neither
    // blocked nor in the blocked log. It still cannot count as a consumption or hide a call: it reaches a mock from the executor's address, so the host's caller check (only the
    // application container's address may consume) makes it a `foreign-caller` unmatched line, and the case is UNKNOWN.
    await browserContext.routeWebSocket(/.*/, (socket) => {
      let url: URL | null = null;
      try { url = new URL(socket.url()); } catch { /* an unreadable address is blocked below */ }
      if (url !== null && url.host === new URL(E2E_EXECUTOR_COMPILED_ORIGIN).host) { socket.connectToServer(); return; }
      appendFileSync(blockedLog, `${JSON.stringify({ at: new Date().toISOString(), caseId: activeCaseId, method: "GET", resourceType: "websocket",
        host: url?.host ?? "unreadable", url: url === null ? "unreadable" : `${url.origin}${url.pathname}` })}\n`);
      void socket.close({ code: 1008, reason: "blocked" });
    });
  };
  // The credentials an agent step's trace is held to: the run's accounts, and every session value this process learned (the same ones the model channel's scan is told at a step's start).
  const agentRedactor = createCredentialRedactor(plan.accounts);
  const sessionSecrets: string[] = [];
  // A session value is told to the ledger (so evidence and captures that carry it are caught) and left for the parent (so the text it writes is scrubbed of it).
  const registerSecret = (value: string): void => {
    agentRedactor.addSessionSecret(value);
    if (typeof value === "string" && value.length >= 8 && !sessionSecrets.includes(value)) sessionSecrets.push(value);
    ledger?.registerSessionSecret(value);
    appendFileSync(join(context.projectDir, E2E_EXECUTOR_SESSION_SECRETS_FILE), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  };
  const store = createExecutorSessionStore({ plan, registerSecret,
    onLoginFailed: (profileId) => appendFileSync(join(context.projectDir, E2E_EXECUTOR_LOGIN_FAILED_FILE), `${JSON.stringify(profileId)}\n`, { mode: 0o600 }),
    ...(context.cdpEndpoint ? { formLogin: createPlaywrightFormLoginDriver({ cdpEndpoint: context.cdpEndpoint, guard }) } : {}) });
  const fileLedger = createFileCaseLedger(context.outDir, plan, { observations: { sessionFacts: store.sessionFacts,
    upstreamRunId: (launch) => readUpstreamRunId(context.projectDir, launch.launchId) } });
  ledger = fileLedger;


  // The agent step driver (Task 4.3b): only for a plan that carries a model channel. The model is the worker's channel and nothing else; the executor, the ledger and the capture store are
  // this process's, and the begin and end markers tell the worker which step each model call belongs to.
  // A group's model channel belongs only to shards whose declaration names a route.
  // Other accounts in the group may have deterministic cases and must get no model.
  const channelPlan = declaration.modelRoute === null ? undefined : plan.modelChannel;
  // This process loads the AI SDK (the CLI process, not the executor's parent that `entry.ts` guards): a model given as a string must still never reach its default gateway.
  const replayPlan = plan.replay;
  if (channelPlan !== undefined || replayPlan !== undefined) installRefusingE2EDefaultProvider();
  const agent = channelPlan === undefined ? null : (() => {
    const client = createE2EModelChannelClient({ socketPath: context.modelSocketPath ?? channelPlan.socketPath, runId: plan.runId });
    const current: { position: { caseId: string; stepIndex: number } | null; ledger: E2EAgentLedgerWriter | null } = { position: null, ledger: null };
    // The adapter's own scan covers what the worker's cannot: a session value learned during a step (the begin marker, sent once per step, carries only what was known then).
    const adapter = createE2EAgentModelAdapter({ client, routeId: channelPlan.routeId, position: () => current.position, scan: (bytes) => agentRedactor.contains(bytes) });
    // The goals of the steps run so far: a trace's typed value that is text of one stays as it is, the ledger's rule (the runner writes a trace after its step has ended).
    const goals: string[] = [];
    const origin = declaration.originByApplicationId.find((item) => item.applicationId === launchContext.selectedTarget.applicationId)?.origin ?? E2E_EXECUTOR_COMPILED_ORIGIN;
    const store = createE2EAgentCaptureStore({
      scan: (bytes) => agentRedactor.contains(bytes),
      persist: (keyHash, bytes) => persistE2EAgentTrace(context.outDir, keyHash, bytes),
      valueKey: channelPlan.valueKey, goals: () => goals, origin,
    });
    const executor = createRovaraE2EAgentExecutor({ position: () => current.position, ledger: () => current.ledger, origin: () => origin });
    const driveStep = createE2EAgentStepDriver({ client, adapter, current, runId: plan.runId, valueKey: channelPlan.valueKey, outDir: context.outDir, sessionSecrets: () => sessionSecrets });
    const runStep: typeof driveStep = (request) => { if (!goals.includes(request.goal)) goals.push(request.goal); return driveStep(request); };
    return { adapter, store, executor, runStep };
  })();
  // An audit replay (Task 4.6b): the recordings of the plan behind a store that never writes, the executor that holds no model and the step port that runs the runner's `act` with no
  // channel marker and no ledger. There is no channel client, no model adapter and no model factory, whatever else the process could do; the plan schema refuses `replay` with `modelChannel`.
  const replay = replayPlan === undefined ? null : (() => {
    const state = createE2EReplayState();
    return { store: createE2EReplayStore(replayPlan.traces, state), executor: createRovaraE2EReplayExecutor(state), runStep: createE2EReplayStepDriver(state) };
  })();
  const agentParts = agent !== null ? { modelFactory: () => agent.adapter as never, agentExecutor: agent.executor, agentCacheStore: agent.store }
    : replay !== null ? { agentExecutor: replay.executor, agentCacheStore: replay.store } : {};

  const casePlans: E2EWebRuntimePorts["casePlans"] = { readCasePlan: async (request, signal) => {
    const result = await fileLedger.casePlans.readCasePlan(request, signal);
    activeCaseId = request.caseId;
    return result;
  } };
  const shared = {
    casePlans, caseObservations: fileLedger.caseObservations, evidence: fileLedger.evidence, actionWindows: fileLedger.actionWindows,
    openCaseSession: async (request: Parameters<E2EWebRuntimePorts["openCaseSession"]>[0], signal: AbortSignal) => {
      const opened = await store.open(request, signal);
      activeSessionRef = opened.sessionRef;
      return opened;
    },
    closeCaseSession: async (sessionRef: string, signal: AbortSignal) => {
      // What the case's browser holds at the end, whoever put it there (the application's headers, or its scripts): any cookie, and any local storage value, that looks like a secret
      // (the same rules the sign-in's were held to) is registered, so a value the application replaced or wrote after the sign-in is scrubbed from what the parent writes and is
      // caught by the out scan. Best effort: a closed page has nothing to ask.
      const owned = ownedContexts.get(sessionRef);
      ownedContexts.delete(sessionRef);
      // The signed-out visitor has no credential, and what an application sets for a visitor (a visitor id, a cart) is not a secret: nothing of it is registered.
      if (owned && !store.isAnonymous(sessionRef)) {
        try {
          const kept = await owned.storageState();
          for (const cookie of kept.cookies) if (isSessionCookieSecret(cookie)) registerSecret(cookie.value);
          for (const item of kept.origins) for (const entry of item.localStorage) if (isSessionStorageSecret(entry.value)) registerSecret(entry.value);
        } catch { /* the context is gone */ }
      }
      const result = await store.close(sessionRef, signal);
      if (result.confirmed && activeSessionRef === sessionRef) { activeSessionRef = null; activeCaseId = null; }
      return result;
    },
    originFor(applicationId: string, preparedEnvironmentDigest: string): string {
      if (preparedEnvironmentDigest !== declaration.preparedEnvironmentDigest) throw new Error("origin requested under a foreign prepared environment");
      const origin = declaration.originByApplicationId.find((item) => item.applicationId === applicationId)?.origin;
      if (!origin) throw new Error("prepared application origin is unavailable");
      return origin;
    },
  };

  if (launchContext.selectedTarget.kind === "web") {
    // Screenshots and traces of failed cases follow the admitted capture policy and nothing else; with both off the case adapter is given no capture port at all.
    const screenshots = fileLedger.capture.enabled("screenshot");
    const ports: E2EWebRuntimePorts = Object.freeze({ ...shared,
      ...(agent !== null ? { agent: { runStep: agent.runStep } } : replay !== null ? { agent: { runStep: replay.runStep } } : {}),
      ...(screenshots ? { capture: { screenshots, record: (item: { caseId: string; kind: "screenshot"; bytes: Uint8Array }) => fileLedger.capture.record(item) } } : {}),
      resolveOwnedCdpEndpoint: async () => {
        if (!context.cdpEndpoint) throw new Error("the executor launched no browser for this shard");
        return context.cdpEndpoint;
      },
      readOwnedDownload: (download: { path: string; suggestedFilename: string }) => readSdkDownload(join(context.projectDir, E2E_EXECUTOR_OUTPUT_DIR), download.path),
      readApprovedFileFixture: async (request) => {
        if (activeCaseId !== request.caseId || !activeSessionRef) throw new Error("file fixture requires the current case and its bound browser session");
        const facts = store.sessionFacts(activeSessionRef, "browser");
        if (facts.subject.kind !== "browser") throw new Error("file fixture requires a browser subject");
        const fixture = await readE2EApplicationInstalledFileFixture(request.fixtureFileId);
        const casePlan = casePlanFor(resolved, { shardId: launchContext.shardId, caseId: request.caseId });
        return { fixture, casePlanDigest: sha(canonicalJson(casePlan)), browserContextId: facts.subject.contextId };
      },
      applyToOwnedBrowserContext: async (sessionRef: string, browserContext: BrowserContext) => {
        // The session's cookies (the fixed orders cookie, or what the form login's context kept) and the local storage that context kept.
        const state = store.browserStateFor(sessionRef);
        // A form login's values were told to the ledger when it signed in. The fixed orders cookie is told to it here only when screenshots are taken: it is then a secret the
        // captures are scanned for. Either way it is registered with the executor parent like any session cookie (this context's responses, and the cookie jar when the case
        // closes), so the parent redacts it wherever it appears as text and a page that echoes it ends the run `credential-leak`; the orders-auth/v1 cookie is a session secret like
        // the form login's, and qualification pins no probe that echoes it.
        if (screenshots) for (const cookie of state.cookies) fileLedger.registerSessionSecret(cookie.value);
        await browserContext.addCookies(state.cookies.map((cookie) => ({ ...cookie })));
        for (const item of state.localStorage) {
          // Once per tab, before the page's own scripts, as Playwright's own storage state does it.
          await browserContext.addInitScript(({ origin, entries }) => {
            // Runs in the page, where these globals exist; this package is compiled without the DOM types.
            type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void };
            const page = globalThis as unknown as { location: { origin: string }; sessionStorage: Store; localStorage: Store };
            if (page.location.origin !== origin || page.sessionStorage.getItem("__rovara_storage_restored") !== null) return;
            page.sessionStorage.setItem("__rovara_storage_restored", "1");
            for (const entry of entries) page.localStorage.setItem(entry.name, entry.value);
          }, { origin: item.origin, entries: item.entries.map((entry) => ({ ...entry })) });
        }
        await guard(browserContext);
        ownedContexts.set(sessionRef, browserContext);
        // A session cookie the application swaps in while the case runs is registered when its answer arrives.
        const anonymous = store.isAnonymous(sessionRef);
        browserContext.on("response", (response) => {
          if (anonymous) return;
          void response.headersArray().then((headers) => {
            for (const header of headers) {
              if (header.name.toLowerCase() !== "set-cookie") continue;
              const issued = parseSetCookie(header.value);
              if (issued !== null && isSessionCookieSecret(issued)) registerSecret(issued.value);
            }
          }, () => undefined);
        });
        const page = browserContext.pages()[0];
        if (!page) throw new Error("the owned browser context has no page to identify");
        const session = await browserContext.newCDPSession(page);
        try {
          const { targetInfo } = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string; browserContextId?: string } };
          if (!targetInfo.browserContextId) throw new Error("the owned browser context has no DevTools context identity");
          store.bindSubject(sessionRef, { kind: "browser", processId: `chromium-${context.browserPid ?? 0}`,
            contextId: targetInfo.browserContextId, pageId: targetInfo.targetId });
        } finally { await session.detach().catch(() => undefined); }
      },
    });
    // The engine is as capable as the admission says: its declared artifact and state capabilities, which the compiler validated against the admitted capture policy and runtime row.
    const launchTarget = resolved.suite.runtimeAdmissionContext.launchTargets.find((item) => item.targetId === launchContext.selectedTarget.targetId);
    if (!launchTarget) throw new Error("the admitted launch declaration has no entry for the selected web target");
    const inner = createWebApplicationCliHost({ launchContext, declaration, ports,
      engineAdmission: { artifactCapabilities: launchTarget.artifactCapabilities, stateCapability: launchTarget.stateCapability } });
    // The case adapter opens its own first page and its assertion steps; nothing may run before them.
    return { ...inner, ...agentParts };
  }

  if (launchContext.selectedTarget.kind === "api") {
    if (declaration.target.app !== null) throw new Error("API declaration must keep the compiler's app:null target");
    if (!isPinnedRovaraHttpEngine(declaration.target.engine)) throw new Error("API declaration must name Rovara's pinned HTTP engine");
    const ports: E2EApiRuntimePorts = Object.freeze({ ...shared, request: store.request,
      readApprovedJsonSchema: async () => { throw new Error("no JSON schema assets are installed in this executor"); },
      readApprovedStateProbe: async (request: { caseId: string; assertionIndex: number; probeId: string }) => {
        const installed = installedE2EApplicationStateProbeAsset(request.probeId);
        if (!installed) throw new Error("state probe is not in the installed fixed probe inventory");
        const bytes = installed.bytes;
        const ref = await fileLedger.recordApprovedAsset({ caseId: request.caseId, assetId: request.probeId, bytes });
        const assetBinding = { caseId: request.caseId, assertionIndex: request.assertionIndex, kind: "state-probe" as const, id: request.probeId,
          manifestDigest: e2eApplicationStateProbeManifestDigest(request.probeId, ref.sha256), ref };
        await fileLedger.recordAssetBinding(assetBinding);
        return { proof: { ref, bytes: Uint8Array.from(bytes) }, assetBinding };
      },
    });
    return { ...createAPIApplicationCliHost({ launchContext, declaration: { ...declaration, target: { targetId: declaration.target.targetId, app: null } }, ports }), ...agentParts };
  }
  throw new Error("the executor host supports only its installed web-Chromium and API-HTTP profiles");
}

