// L4-EINT (owner DEC 254zzz71): the FIXED telemetry list. A call to one of its hosts gets a plain `OK` from the eval stand-in and is not a gap; the PR names the entries answered; a repository cannot extend the list; a list edit trips this
// guard; and when most failing questions are still dropped the eval reads "Not run: outside calls were made up".
import { request as httpRequest } from "node:http";
import type net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_NOT_RUN_SENTENCES, EVAL_TELEMETRY_HOSTS, evalStandInMostDropped, EvalAnswerBook, EvalStandInDescriptorSchema, evalStandInLines, evalStandInResultOf, evalTelemetryEntryOf, evalTelemetryLine, isEvalTelemetryId,
  type EvalStandInPlan, EMPTY_EVAL_STAND_IN_COUNTS,
} from "@agentx/contracts";
import { createEvalStandInServers, type EvalStandInServers } from "../../packages/worker/src/eval-standin-server.js";
import { EvalStandInRound } from "../../packages/worker/src/eval-standin-round.js";
import { planEvalStandInsFromCheckout } from "../../packages/worker/src/eval-stand-in-plan.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("the fixed list is pinned by this guard", () => {
  it("is exactly this list (a change to it is a code change that edits this test)", () => {
    expect(EVAL_TELEMETRY_HOSTS.map((entry) => [entry.id, [...entry.domains]])).toEqual([
      ["sentry.io", ["sentry.io"]],
      ["posthog.com", ["posthog.com"]],
      ["datadoghq.com", ["datadoghq.com", "datadoghq.eu"]],
      ["segment.io", ["segment.io", "segment.com"]],
      ["mixpanel.com", ["mixpanel.com"]],
      ["amplitude.com", ["amplitude.com"]],
      ["honeycomb.io", ["honeycomb.io"]],
      ["newrelic.com", ["newrelic.com", "nr-data.net"]],
      ["grafana.net", ["grafana.net"]],
      ["bugsnag.com", ["bugsnag.com"]],
      ["rollbar.com", ["rollbar.com"]],
      ["google-analytics.com", ["google-analytics.com"]],
    ]);
  });
  it("is frozen: nothing can push a host onto it at run time", () => {
    expect(Object.isFrozen(EVAL_TELEMETRY_HOSTS)).toBe(true);
    expect(() => { (EVAL_TELEMETRY_HOSTS as unknown as unknown[]).push({ id: "evil.test", domains: ["evil.test"] }); }).toThrow();
    expect(() => { (EVAL_TELEMETRY_HOSTS[0]!.domains as unknown as string[]).push("evil.test"); }).toThrow();
    expect(evalTelemetryEntryOf("evil.test")).toBeUndefined();
  });
});

describe("which hosts are telemetry", () => {
  it("matches the name and its sub-domains on a label boundary, and nothing else", () => {
    expect(evalTelemetryEntryOf("sentry.io")).toBe("sentry.io");
    expect(evalTelemetryEntryOf("o123.ingest.us.sentry.io")).toBe("sentry.io");
    expect(evalTelemetryEntryOf("us.i.posthog.com")).toBe("posthog.com");
    expect(evalTelemetryEntryOf("api.datadoghq.eu")).toBe("datadoghq.com");
    expect(evalTelemetryEntryOf("otlp.nr-data.net")).toBe("newrelic.com");
    for (const host of ["notsentry.io", "sentry.io.evil.test", "sentry.iox", "evilsentry.io", "posthog.com.attacker.test", "sentry-io", "xsentry.io", "", "sentry.io.", "SENTRY.IO", "1.2.3.4", "localhost"]) expect(evalTelemetryEntryOf(host), host).toBeUndefined();
    expect(evalTelemetryEntryOf(undefined)).toBeUndefined();
    expect(evalTelemetryEntryOf(42)).toBeUndefined();
  });
  it("names only entries of the list in a result and a line", () => {
    expect(isEvalTelemetryId("sentry.io")).toBe(true);
    expect(isEvalTelemetryId("o123.ingest.sentry.io")).toBe(false);
    expect(evalTelemetryLine(["sentry.io", "posthog.com", "evil.test", "sentry.io"])).toBe("Telemetry calls answered with OK: posthog.com, sentry.io.");
    expect(evalTelemetryLine(["evil.test"])).toBeUndefined();
    const result = evalStandInResultOf(EMPTY_EVAL_STAND_IN_COUNTS, 0, { telemetry: ["sentry.io", "evil.test", "posthog.com"] });
    expect(result.telemetry).toEqual(["posthog.com", "sentry.io"]);
    expect(evalStandInLines(result)).toEqual(["Telemetry calls answered with OK: posthog.com, sentry.io."]);
  });
});

describe("a repository cannot extend the list", () => {
  it("a descriptor that names a telemetry host is refused, and a planned round leaves it out", async () => {
    expect(EvalStandInDescriptorSchema.safeParse({ version: 1, hosts: [{ name: "o1.ingest.sentry.io" }] }).success).toBe(false);
    expect(EvalStandInDescriptorSchema.safeParse({ version: 1, hosts: [{ name: "api.example.test" }] }).success).toBe(true);
    const root = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "telemetry-plan-"));
    try {
      // The repository's own cassette and OpenAPI file both name a telemetry host and a collector of its own: neither is added to the list.
      await mkdir(join(root, "cassettes"), { recursive: true });
      await writeFile(join(root, "cassettes", "t.har"), JSON.stringify({ log: { entries: [{ request: { method: "POST", url: "https://o1.ingest.sentry.io/api/1/envelope/" }, response: { status: 200, content: { mimeType: "text/plain", text: "recorded" } } }, { request: { method: "GET", url: "https://api.example.test/v1/a" }, response: { status: 200, content: { mimeType: "application/json", text: "{\"a\":1}" } } }] } }));
      await writeFile(join(root, "openapi.json"), JSON.stringify({ openapi: "3.0.3", servers: [{ url: "https://collector.vendor.test" }], paths: { "/x": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } } } } } } } } }));
      const planned = await planEvalStandInsFromCheckout({
        descriptor: { version: 1, hosts: [{ name: "api.example.test" }, { name: "collector.vendor.test" }] }, checkoutRoot: root,
        workspaceId: "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11", operationId: "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50",
      });
      expect(planned?.round.plan.map((entry) => entry.host)).toEqual(["api.example.test", "collector.vendor.test"]);
      expect(planned?.round.setContent().recorded.map((entry) => entry.host)).toEqual(["api.example.test"]);
      // Even a hand-made plan that names a telemetry host does not change what the server does with it (see the server test below).
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("the stand-in server answers telemetry with OK and counts no gap", () => {
  const servers: EvalStandInServers[] = [];
  afterEach(() => { for (const server of servers.splice(0)) { server.http.closeAllConnections(); server.http.close(); } });
  const listening = async (server: EvalStandInServers["http"]): Promise<number> => { await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); }); return (server.address() as net.AddressInfo).port; };
  const send = (port: number, host: string, path: string, method = "POST"): Promise<{ status: number; headers: Record<string, unknown>; body: string }> => new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { host }, agent: false }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") })); });
    req.on("error", reject); req.end(method === "GET" ? undefined : "{}");
  });

  it("answers 200 OK, labelled, with no entry in the book, no gap and no new host; a collector the list does not name is a gap", async () => {
    // A plan that (wrongly) names a telemetry host with a recording still gets OK: only the fixed list decides.
    const plan: EvalStandInPlan = [{ host: "o1.ingest.sentry.io", reads: ["data.x"] }];
    const book = new EvalAnswerBook();
    const stand = createEvalStandInServers({ plan, book });
    servers.push(stand);
    const port = await listening(stand.http);
    const ok = await send(port, "o1.ingest.sentry.io", "/api/1/envelope/");
    expect(ok).toMatchObject({ status: 200, body: "OK" });
    expect(ok.headers["x-rovara-label"]).toBe("madeByRovara");
    expect(ok.headers["x-rovara-standin"]).toBe("telemetry");
    expect((await send(port, "us.i.posthog.com", "/e/", "GET")).body).toBe("OK");
    expect(book.size()).toBe(0);
    expect(book.counts()).toMatchObject({ generated: 0, generatedNoContract: 0, newConnections: 0, gapCalls: 0 });
    expect(stand.stats()).toMatchObject({ telemetry: ["sentry.io", "posthog.com"], gaps: [], newHosts: [] });
    // Control: a collector of the repository's own is NOT on the list: an ordinary made-up answer, counted as a gap.
    const own = await send(port, "collector.vendor.test", "/ingest");
    expect(own.headers["x-rovara-standin"]).toBe("new_connection");
    expect(book.counts().gapCalls).toBe(1);
    expect(stand.stats().newHosts).toEqual(["collector.vendor.test"]);
    expect(stand.stats().telemetry).toEqual(["sentry.io", "posthog.com"]);
  });

  it("a round never counts a telemetry call as a gap, and names the entries for the PR", () => {
    const round = new EvalStandInRound({ workspaceId: "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11", operationId: "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50", plan: [] });
    const digest = "a".repeat(64);
    const summary = { schemaVersion: 1 as const, trusted: true as const, workspaceId: "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11", operationId: "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50", digest, counts: { ...EMPTY_EVAL_STAND_IN_COUNTS, served: 3 }, foreign: 0, refused: 0, tlsFailed: 0, additions: [], gaps: [], newHosts: [], telemetry: ["sentry.io"] };
    const run = round.absorb(summary);
    expect(run.hitGap).toBe(false);
    expect(round.telemetry()).toEqual(["sentry.io"]);
    expect(EVAL_NOT_RUN_SENTENCES.outside_calls_made_up).toBe("Not run: outside calls were made up");
  });
});

describe("most of the failing questions dropped is a Not run (DEC 254zzz71)", () => {
  it("is a majority only when MORE than half were dropped: exactly half is not", () => {
    expect(evalStandInMostDropped(1, 0)).toBe(true);
    expect(evalStandInMostDropped(2, 1)).toBe(true);
    expect(evalStandInMostDropped(3, 2)).toBe(true);
    expect(evalStandInMostDropped(1, 1)).toBe(false);
    expect(evalStandInMostDropped(2, 2)).toBe(false);
    expect(evalStandInMostDropped(1, 2)).toBe(false);
    expect(evalStandInMostDropped(0, 0)).toBe(false);
    expect(evalStandInMostDropped(0, 5)).toBe(false);
    expect(evalStandInMostDropped(-1, 0)).toBe(false);
    expect(evalStandInMostDropped(Number.NaN, 0)).toBe(false);
  });
});
