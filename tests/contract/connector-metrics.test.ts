import { describe, expect, it } from "vitest";
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

  it("never throws for a write callback that throws, and reports the failure by name only", async () => {
    const throwing = () => { throw Object.assign(new Error("boom"), { name: "WriteFailure" }); };
    expect(() => emitConnectorMetric("ConnectorSchemaDrift", "linear", 1, throwing)).not.toThrow();
    const path = `/v1/workspaces/${workspace}/connectors/linear/call`;
    // The route's own response must be unaffected by a metric line that could not be written.
    const result = await observeConnectorRoute("POST", path, async () => response({ result: { status: "FAILED", reason: "schema_changed" } }), throwing);
    expect(result).toEqual(response({ result: { status: "FAILED", reason: "schema_changed" } }));
  });

  it("never throws even when the fallback diagnostic write also throws", () => {
    const log = console.log;
    console.log = () => { throw new Error("stdout is gone too"); };
    try {
      const throwing = () => { throw new Error("write failed"); };
      expect(() => emitConnectorMetric("ConnectorSchemaDrift", "linear", 1, throwing)).not.toThrow();
    } finally {
      console.log = log;
    }
  });

});
