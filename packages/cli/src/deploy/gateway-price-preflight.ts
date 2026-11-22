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
