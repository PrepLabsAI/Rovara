import { appendFileSync, readFileSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { z } from "zod";
import { E2EExecutorPlanSchema, canonicalJson } from "@agentx/contracts";
import type { BrowserContext } from "playwright-core";
import { createAPIApplicationCliHost, type E2EApiRuntimePorts } from "../api-runtime.js";
import { createWebApplicationCliHost, type E2EWebRuntimePorts } from "../web-runtime.js";
import type { E2EApplicationCliHost, E2EApplicationCliLaunchContext } from "../application-runtime-bootstrap.js";
import { readE2EApplicationInstalledFileFixture } from "../application-runtime-assets.js";
import { createExecutorSessionStore } from "./accounts.js";
import { createFileCaseLedger } from "./case-ledger.js";
import { casePlanFor, resolveE2EExecutorSuite } from "./suite.js";

export const E2E_EXECUTOR_CONTEXT_ENV = "ROVARA_E2E_EXECUTOR_CONTEXT" as const;
export const E2E_EXECUTOR_BLOCKED_LOG = ".blocked-requests.jsonl" as const;
export const E2E_EXECUTOR_OUTPUT_DIR = ".agentx-run-output" as const;
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
  appUpstream: z.string().url().max(512).nullable(),
}).strict();
export type ExecutorHostContext = z.infer<typeof ExecutorHostContextSchema>;

/** The installed read-only state probe: the shape of `GET /api/orders/state` every sample must match before its value is compared. */
const STATE_PROBE_SCHEMAS: Readonly<Record<string, unknown>> = Object.freeze({
  "api-state-positive/v1": { type: "object", required: ["orders", "version"], additionalProperties: false,
    properties: { orders: { type: "string" }, version: { type: "integer" } } },
});

type Declaration = Readonly<{
  preparedEnvironmentDigest: string;
  target: { targetId: string; app: { identity: string } | null };
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
  const store = createExecutorSessionStore({ plan, appUpstream: context.appUpstream });
  const ledger = createFileCaseLedger(context.outDir, plan, { observations: { sessionFacts: store.sessionFacts,
    upstreamRunId: (launch) => readUpstreamRunId(context.projectDir, launch.launchId) } });
  const { launchContext, declaration } = input;
  let activeCaseId: string | null = null;
  let activeSessionRef: string | null = null;

  const casePlans: E2EWebRuntimePorts["casePlans"] = { readCasePlan: async (request, signal) => {
    const result = await ledger.casePlans.readCasePlan(request, signal);
    activeCaseId = request.caseId;
    return result;
  } };
  const shared = {
    casePlans, caseObservations: ledger.caseObservations, evidence: ledger.evidence, actionWindows: ledger.actionWindows,
    openCaseSession: async (request: Parameters<E2EWebRuntimePorts["openCaseSession"]>[0], signal: AbortSignal) => {
      const opened = await store.open(request, signal);
      activeSessionRef = opened.sessionRef;
      return opened;
    },
    closeCaseSession: async (sessionRef: string, signal: AbortSignal) => {
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
    const guarded = new WeakSet<BrowserContext>();
    const blockedLog = join(context.outDir, E2E_EXECUTOR_BLOCKED_LOG);
    const guard = async (browserContext: BrowserContext): Promise<void> => {
      if (guarded.has(browserContext)) return;
      guarded.add(browserContext);
      await browserContext.route("**/*", async (route) => {
        const request = route.request();
        let url: URL;
        try { url = new URL(request.url()); } catch { await route.abort("blockedbyclient"); return; }
        if (url.origin === plan.app.origin || url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
          await route.continue();
          return;
        }
        appendFileSync(blockedLog, `${JSON.stringify({ at: new Date().toISOString(), caseId: activeCaseId, method: request.method(),
          resourceType: request.resourceType(), host: url.host, url: `${url.origin}${url.pathname}` })}\n`);
        await route.abort("blockedbyclient");
      });
    };
    const ports: E2EWebRuntimePorts = Object.freeze({ ...shared,
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
        const cookie = store.cookieFor(sessionRef);
        await browserContext.addCookies([{ name: cookie.name, value: cookie.value, url: cookie.origin, httpOnly: true, sameSite: "Strict" }]);
        await guard(browserContext);
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
    return createWebApplicationCliHost({ launchContext, declaration, ports });
  }

  if (launchContext.selectedTarget.kind === "api") {
    if (declaration.target.app !== null) throw new Error("API declaration must keep the compiler's app:null target");
    const ports: E2EApiRuntimePorts = Object.freeze({ ...shared, request: store.request,
      readApprovedJsonSchema: async () => { throw new Error("no JSON schema assets are installed in this executor"); },
      readApprovedStateProbe: async (request: { caseId: string; assertionIndex: number; probeId: string }) => {
        const schema = STATE_PROBE_SCHEMAS[request.probeId];
        if (!schema) throw new Error("state probe is not in the installed fixed probe inventory");
        const bytes = Buffer.from(canonicalJson(schema), "utf8");
        const ref = await ledger.recordApprovedAsset({ caseId: request.caseId, assetId: request.probeId, bytes });
        return { proof: { ref, bytes: Uint8Array.from(bytes) }, assetBinding: { caseId: request.caseId, assertionIndex: request.assertionIndex,
          kind: "state-probe", id: request.probeId, manifestDigest: sha(canonicalJson({ probeId: request.probeId, assetSha256: ref.sha256 })), ref } };
      },
    });
    return createAPIApplicationCliHost({ launchContext, declaration: { ...declaration, target: { targetId: declaration.target.targetId, app: null } }, ports });
  }
  throw new Error("the executor host supports only its installed web-Chromium and API-HTTP profiles");
}

