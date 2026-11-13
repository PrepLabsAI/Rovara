export type ConnectorMetric =
  | "ConnectorDiscoveryFailed"
  | "ConnectorSchemaDrift"
  | "ConnectorToolSkipped"
  | "ConnectorNotConnected"
  | "ToolCallUnknownOutcome";

type Write = (line: string) => void;
const stdout: Write = (line) => console.log(line);

function metricsNamespace(): string {
  return process.env.AGENTX_METRICS_NAMESPACE || "AgentX";
}

// The connector routes and their feature 007 github aliases; the query string is not part of the path.
const CONNECTOR_ROUTE = /^\/v1\/workspaces\/[0-9a-f-]+\/(?:connectors\/([a-z][a-z0-9-]{0,19})|(github))\/(tools|call)$/;

/**
 * One CloudWatch embedded metric format line. Lambda turns stdout lines like this into metrics with no
 * IAM permission. The empty dimension set also publishes the metric without dimensions, which the
 * "any connector" alarm reads. Never carries request or response content.
 *
 * The write itself is guarded: a metric must never break the route it was derived from, but a write
 * failure must not be silent either, so it is reported on a fallback line naming only the metric, the
 * connector and the error's class name (never its message, which could quote request content).
 */
export function emitConnectorMetric(metric: ConnectorMetric, connector: string, count = 1, write: Write = stdout, namespace = metricsNamespace()): void {
  if (count <= 0) return;
  try {
    write(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [["connector"], []], Metrics: [{ Name: metric, Unit: "Count" }] }],
      },
      component: "broker",
      event: "metric",
      connector,
      [metric]: count,
    }));
  } catch (error) {
    try {
      console.log(JSON.stringify({
        component: "broker",
        event: "metric_emit_failed",
        metric,
        connector,
        error: error instanceof Error ? error.name : "unknown",
      }));
    } catch {
      // The diagnostic channel is unavailable too (stdout itself is gone); nothing left to report to.
    }
  }
}

/**
 * Runs a service route and derives connector metrics from its response, so the metrics follow the
 * route's public contract rather than code inside it. Non-connector routes pass straight through.
 */
export async function observeConnectorRoute<T extends { statusCode: number; body: string }>(
  method: string,
  pathname: string,
  route: () => Promise<T>,
  write: Write = stdout,
): Promise<T> {
  const match = CONNECTOR_ROUTE.exec(pathname);
  if (!match) return route();
  const connector = match[1] ?? match[2]!;
  const discovery = match[3] === "tools" && method === "GET";
  let response: T;
  try {
    response = await route();
  } catch (error) {
    // Only a modeled RUNTIME_UNAVAILABLE failure is the connector's fault; a code-less error (an AWS
    // SDK throttle, for example) and an authorization or input error are not counted here.
    const code = (error as { code?: unknown } | null)?.code;
    if (discovery && code === "RUNTIME_UNAVAILABLE") emitConnectorMetric("ConnectorDiscoveryFailed", connector, 1, write);
    throw error;
  }
  const body = parseObject(response.body);
  if (discovery) {
    const catalog = asObject(body.catalog);
    if (catalog.notConnected === true) emitConnectorMetric("ConnectorNotConnected", connector, 1, write);
    if (Array.isArray(catalog.skipped)) emitConnectorMetric("ConnectorToolSkipped", connector, catalog.skipped.length, write);
  } else {
    const result = asObject(body.result);
    // A replayed ledger result is the same outcome the original request already counted; counting
    // it again would double-count every idempotent retry and hosted redelivery.
    if (result.replayed !== true) {
      if (result.reason === "schema_changed") emitConnectorMetric("ConnectorSchemaDrift", connector, 1, write);
      if (result.reason === "not_connected") emitConnectorMetric("ConnectorNotConnected", connector, 1, write);
      if (result.status === "UNKNOWN") emitConnectorMetric("ToolCallUnknownOutcome", connector, 1, write);
    }
  }
  return response;
}

function parseObject(text: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
