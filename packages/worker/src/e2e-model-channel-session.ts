import type { E2EModelReceipt } from "@agentx/contracts";
import {
  assertE2EEnvironmentCannotRedirect,
  assertE2ESharedAwsConfigCannotRedirect,
  createE2EProviderInvoke,
  createGovernedE2EModelRoute,
  resolveE2EAgentRouteForAdmission,
  type E2EDayBudget,
  type E2EInvoke,
} from "@agentx/model-runtime";
import type { E2ECredentialSet } from "./e2e-model-credential-guard.js";
import { startE2EModelProxy, type E2EModelEvidenceSink, type E2EModelReceiptSummary, type E2EModelTranscript } from "./e2e-model-proxy.js";

/**
 * The per-group model channel session (M1.4 Task 4.3a): everything the worker does to give one group's executor a governed model, in order, and nothing else.
 *
 * 1. It re-derives the route from the worker's own settings and holds it to the revision the admission names (`resolveE2EAgentRouteForAdmission`); a route that is not the
 *    worker's is `model-route-changed-reapprove` (or `agent-route-not-approved`) and nothing starts.
 * 2. It checks that neither the process environment nor the shared AWS files can redirect or re-authenticate the call (a scripted route calls no provider and is exempt).
 * 3. It builds the governed route over the project's day budget and starts the proxy on the socket, which is listening before the caller starts any container.
 * 4. `close()` stops accepting, unlinks the socket and returns the receipts. It is safe to call again.
 *
 * It opens only for a group that has an agent step: with no `allowedSteps` it throws, and the checks never call it for a group without one.
 */

export class E2EModelChannelUnavailableError extends Error {
  constructor(readonly code: "model-route-changed-reapprove" | "agent-route-not-approved" | "model-environment-unsafe" | "model-channel-not-needed", message: string) {
    super(`${code}: ${message}`);
    this.name = "E2EModelChannelUnavailableError";
  }
}

export interface OpenE2EModelChannelSessionOptions {
  runId: string;
  /** The route the admission names. The definition is never taken from it. */
  modelRoute: { routeId: string; routeRevision: string };
  policyScope: "standard" | "qualification";
  socketPath: string;
  /** The agent steps of the group, which the executor's markers are held to. */
  allowedSteps: ReadonlyArray<{ caseId: string; stepIndex: number }>;
  credentialSet: E2ECredentialSet;
  /** Epoch ms: the run's deadline. */
  deadlineAt: number;
  dayBudget: E2EDayBudget;
  evidence: E2EModelEvidenceSink;
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  socketOwner?: { uid: number; gid: number };
  /**
   * The provider call. A scripted route has no provider: CI and qualification pass the scripted double here, and a scripted route without one does not start. A real route
   * builds its own provider call from the route (this is a test seam for the real ones).
   */
  invoke?: E2EInvoke;
  now?: () => number;
  /** Test seam for the shared AWS files check (a temporary home). */
  assertSharedConfig?: () => void;
}

export interface E2EModelChannelSession {
  readonly socketPath: string;
  close(): Promise<E2EModelReceiptSummary>;
}

/** The executor container runs as the unprivileged `node` user (1000); a root worker hands the socket and its directory to it. */
export function defaultE2EModelSocketOwner(): { uid: number; gid: number } | undefined {
  return typeof process.getuid === "function" && process.getuid() === 0 ? { uid: 1000, gid: 1000 } : undefined;
}

export async function openE2EModelChannelSession(options: OpenE2EModelChannelSessionOptions): Promise<E2EModelChannelSession> {
  if (options.allowedSteps.length === 0) throw new E2EModelChannelUnavailableError("model-channel-not-needed", "the model channel opens only for a group that has an agent step");
  const environment = options.environment ?? process.env;
  const resolved = resolveE2EAgentRouteForAdmission(options.modelRoute, { environment, policyScope: options.policyScope });
  if (!resolved.ok) throw new E2EModelChannelUnavailableError(resolved.code, resolved.detail);
  const definition = resolved.definition;
  let invoke: E2EInvoke;
  if (definition.provider === "rovara-scripted") {
    if (options.invoke === undefined) throw new E2EModelChannelUnavailableError("agent-route-not-approved", "the scripted model route has no script in this process");
    invoke = options.invoke;
  } else {
    // A real route is judged on the environment it would call out from, before anything listens.
    try {
      assertE2EEnvironmentCannotRedirect(environment);
      (options.assertSharedConfig ?? (() => assertE2ESharedAwsConfigCannotRedirect()))();
    } catch (error) {
      throw new E2EModelChannelUnavailableError("model-environment-unsafe", error instanceof Error ? error.message : "this worker's environment can redirect model calls");
    }
    invoke = options.invoke ?? await createE2EProviderInvoke(definition, { environment });
  }
  const now = options.now ?? Date.now;
  const socketOwner = options.socketOwner ?? defaultE2EModelSocketOwner();
  const route = createGovernedE2EModelRoute(definition, { invoke, now, dayBudget: options.dayBudget });
  const proxy = await startE2EModelProxy({
    socketPath: options.socketPath, runId: options.runId, route, credentialSet: options.credentialSet, evidence: options.evidence, deadlineAt: options.deadlineAt,
    signal: options.signal, policyScope: options.policyScope, environment, allowedSteps: options.allowedSteps, now,
    ...(socketOwner === undefined ? {} : { socketOwner }),
  });
  return { socketPath: proxy.socketPath, close: () => proxy.close() };
}

/**
 * Where a group's receipts and transcripts go in this process: kept in memory for the life of the group and read back once at close. Receipts hold digests only; transcript bodies are
 * already redacted by the proxy. Reading them into the round's evidence is Task 4.4's; here they exist so a run's calls can be counted and checked.
 */
export function createE2EModelEvidenceCollector(): E2EModelEvidenceSink & { receipts(): E2EModelReceipt[]; transcripts(): E2EModelTranscript[] } {
  const receipts: E2EModelReceipt[] = [];
  const transcripts: E2EModelTranscript[] = [];
  return {
    writeReceipt: (receipt) => { receipts.push(receipt); },
    writeTranscript: (transcript) => { transcripts.push(transcript); },
    receipts: () => [...receipts],
    transcripts: () => [...transcripts],
  };
}
