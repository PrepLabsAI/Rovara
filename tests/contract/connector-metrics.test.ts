import { describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { emitConnectorMetric, observeConnectorRoute } from "../../packages/broker/src/aws/connector-metrics.js";

const workspace = "0f0e0d0c-0b0a-4908-8706-050403020100";
const response = (body: unknown) => ({ statusCode: 200, headers: {}, body: JSON.stringify(body) });

function metrics(lines: string[]) {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).map((line) => {
    const [name] = ((line._aws as { CloudWatchMetrics: Array<{ Metrics: Array<{ Name: string }> }> }).CloudWatchMetrics[0]!.Metrics).map((metric) => metric.Name);
    return { name, connector: line.connector, value: line[name!] };
  });
}

describe("broker connector metrics", () => {
  it("writes embedded metric format with a connector dimension and a dimensionless copy", () => {
    const lines: string[] = [];
    emitConnectorMetric("ConnectorSchemaDrift", "linear", 1, (line) => lines.push(line));
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed._aws).toMatchObject({ CloudWatchMetrics: [{ Namespace: "AgentX", Dimensions: [["connector"], []], Metrics: [{ Name: "ConnectorSchemaDrift", Unit: "Count" }] }] });
    expect(parsed).toMatchObject({ component: "broker", event: "metric", connector: "linear", ConnectorSchemaDrift: 1 });
  });

  it("counts drift, not-connected and unknown outcomes from call results", async () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const path = `/v1/workspaces/${workspace}/connectors/linear/call`;
    await observeConnectorRoute("POST", path, async () => response({ result: { status: "FAILED", reason: "schema_changed" } }), write);
    await observeConnectorRoute("POST", path, async () => response({ result: { status: "FAILED", reason: "not_connected" } }), write);
    await observeConnectorRoute("POST", path, async () => response({ result: { status: "UNKNOWN" } }), write);
    await observeConnectorRoute("POST", path, async () => response({ result: { status: "SUCCEEDED" } }), write);
    expect(metrics(lines)).toEqual([
      { name: "ConnectorSchemaDrift", connector: "linear", value: 1 },
      { name: "ConnectorNotConnected", connector: "linear", value: 1 },
      { name: "ToolCallUnknownOutcome", connector: "linear", value: 1 },
    ]);
  });

  it("counts skipped tools and not-connected catalogs from discovery, and the legacy github route", async () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    await observeConnectorRoute("GET", `/v1/workspaces/${workspace}/connectors/jira/tools`,
      async () => response({ catalog: { connector: "jira", tools: [], skipped: [{ tool: "a", reason: "r" }, { tool: "b", reason: "r" }] } }), write);
    await observeConnectorRoute("GET", `/v1/workspaces/${workspace}/connectors/jira/tools`,
      async () => response({ catalog: { connector: "jira", notConnected: true, tools: [], skipped: [] } }), write);
    await observeConnectorRoute("POST", `/v1/workspaces/${workspace}/github/call`, async () => response({ result: { status: "UNKNOWN" } }), write);
    expect(metrics(lines)).toEqual([
      { name: "ConnectorToolSkipped", connector: "jira", value: 2 },
      { name: "ConnectorNotConnected", connector: "jira", value: 1 },
      { name: "ToolCallUnknownOutcome", connector: "github", value: 1 },
    ]);
  });

  it("counts a discovery that throws RUNTIME_UNAVAILABLE and rethrows it, but not an authorization refusal", async () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const path = `/v1/workspaces/${workspace}/connectors/linear/tools`;
    await expect(observeConnectorRoute("GET", path, async () => { throw agentXError("RUNTIME_UNAVAILABLE", "vendor down"); }, write)).rejects.toThrow("vendor down");
    await expect(observeConnectorRoute("GET", path, async () => { throw agentXError("FORBIDDEN", "not a member"); }, write)).rejects.toThrow("not a member");
    expect(metrics(lines)).toEqual([{ name: "ConnectorDiscoveryFailed", connector: "linear", value: 1 }]);
  });

  it("ignores other routes and never logs a response body", async () => {
    const lines: string[] = [];
    await observeConnectorRoute("POST", `/v1/workspaces/${workspace}/tasks`, async () => response({ result: { status: "UNKNOWN" } }), (line) => lines.push(line));
    await observeConnectorRoute("POST", `/v1/workspaces/${workspace}/connectors/linear/call`,
      async () => response({ result: { status: "UNKNOWN", text: "secret issue body" } }), (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("secret issue body");
  });

  it("never throws when the write callback fails, and reports the failure by name only", async () => {
    const throwing = () => { throw Object.assign(new Error("stdout closed"), { name: "EPIPE" }); };
    expect(() => emitConnectorMetric("ConnectorSchemaDrift", "linear", 1, throwing)).not.toThrow();
    const path = `/v1/workspaces/${workspace}/connectors/linear/call`;
    // The route's own response must be unaffected by a metric line that could not be written.
    const result = await observeConnectorRoute("POST", path, async () => response({ result: { status: "FAILED", reason: "schema_changed" } }), throwing);
    expect(result).toEqual(response({ result: { status: "FAILED", reason: "schema_changed" } }));
  });

  it("reports a write failure on the fallback log, without the underlying error message", async () => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (line: string) => { lines.push(line); };
    try {
      const throwing = () => { throw Object.assign(new Error("stdout closed: secret detail"), { name: "EPIPE" }); };
      emitConnectorMetric("ConnectorNotConnected", "jira", 1, throwing);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ component: "broker", connector: "jira", metric: "ConnectorNotConnected", error: "EPIPE" });
    expect(lines[0]).not.toContain("stdout closed");
    expect(lines[0]).not.toContain("secret detail");
  });
});
