import { agentXError } from "@agentx/contracts";
/** The selected artifact, never the old deployed broker, qualifies an install or repair. */
export function assertBrokerArtifactRunPrices(text: string): void {
  let version: unknown;
  try { version = (JSON.parse(text) as { Outputs?: { ModelRunPriceVersion?: { Value?: unknown } } }).Outputs?.ModelRunPriceVersion?.Value; } catch { /* fail closed */ }
  if (version !== "1") throw agentXError("CONFIG_INVALID", "the release must contain a price-serving broker (ModelRunPriceVersion=1); build a current release before installing or upgrading");
}
/** Deployed broker qualification, read from the completed control-plane stack. */
export function assertBrokerRunPrices(outputs: Record<string, string> | undefined): void {
  if (outputs?.ModelRunPriceVersion !== "1") throw agentXError("CONFIG_INVALID", "the price-serving broker must be installed before worker activation; install gateway, then broker, then worker");
}
/** Release-order guard only: no setting can turn the engine's runtime checks off. */
export async function assertGatewayRunPrices(origin: string, transport: typeof fetch = fetch): Promise<void> {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error();
    const response = await transport(`${origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(4_000), headers: { accept: "application/json" } });
    const body = await response.json() as { runPrice?: { version?: unknown; admissionVersion?: unknown; snapshotVersion?: unknown } } | null;
    if (response.status !== 200 || body?.runPrice?.version !== 1 || body.runPrice.admissionVersion !== 1 || !Number.isSafeInteger(body.runPrice.snapshotVersion) || Number(body.runPrice.snapshotVersion) <= 0) throw new Error();
  } catch {
    throw agentXError("CONFIG_INVALID", `${origin}: the gateway must serve run prices from a signed, versioned snapshot before this engine can be installed or upgraded; install or repair the gateway first`);
  }
}

/**
 * #1583: a self-hosted gateway runs two tasks behind its load balancer, round-robin, and one can start with no prices (it lost the cold-start seeding race) while
 * /healthz still answers 200 for it. So one good answer is not readiness: the wait needs GATEWAY_READY_STREAK good answers in a row, and lasts longer than the
 * gateway's five-minute prices reload, by which time a task that started without prices has them.
 */
export const GATEWAY_READY_STREAK = 3;
export const GATEWAY_READY_TIMEOUT_MS = 420_000;

/** Poll a newly deployed self-hosted gateway until cold-start price seeding finishes and /healthz reports runPrice.snapshotVersion >= 1, GATEWAY_READY_STREAK times in a row. */
export async function waitForGatewayRunPrices(
  origin: string,
  options: { transport?: typeof fetch; timeoutMs?: number; pollMs?: number; streak?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const transport = options.transport ?? fetch;
  const timeoutMs = options.timeoutMs ?? GATEWAY_READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 5_000;
  const streak = Math.max(1, options.streak ?? GATEWAY_READY_STREAK);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let good = 0;
  for (;;) {
    try {
      await assertGatewayRunPrices(origin, transport);
      good += 1;
      if (good >= streak) return;
      // Good answers in a row are asked for at once: they are meant to reach the other task too, not to wait out the poll.
      continue;
    } catch (error) {
      good = 0;
      if (now() >= deadline) throw error;
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  }
}

const TASK_KID = /^[A-Za-z0-9_-]{16}$/u;

/** Fetch the task-token JWKS key IDs (`rovara_purpose: "task"`) published by the deployed control plane. */
export async function fetchControlPlaneTaskKeyIds(controlPlaneUrl: string, transport: typeof fetch = fetch): Promise<string> {
  const origin = controlPlaneUrl.replace(/\/+$/u, "");
  const jwksUrl = `${origin}/v1/auth/.well-known/jwks.json`;
  let response: Response;
  try {
    response = await transport(jwksUrl, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `could not read control plane JWKS at ${jwksUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status !== 200) {
    throw agentXError("CONFIG_INVALID", `control plane JWKS at ${jwksUrl} returned HTTP ${response.status}`);
  }
  let body: { keys?: Array<{ kid?: unknown; rovara_purpose?: unknown }> };
  try {
    body = await response.json() as { keys?: Array<{ kid?: unknown; rovara_purpose?: unknown }> };
  } catch {
    throw agentXError("CONFIG_INVALID", `control plane JWKS at ${jwksUrl} returned invalid JSON`);
  }
  const kids = (body.keys ?? [])
    .filter((entry) => entry.rovara_purpose === "task" && typeof entry.kid === "string" && TASK_KID.test(entry.kid))
    .map((entry) => entry.kid as string);
  const unique = [...new Set(kids)].slice(0, 2);
  if (unique.length === 0) {
    throw agentXError("CONFIG_INVALID", `control plane JWKS at ${jwksUrl} published no task-purpose signing key (rovara_purpose=task)`);
  }
  return unique.join(",");
}
