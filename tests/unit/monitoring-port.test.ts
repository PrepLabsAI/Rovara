// The monitoring port: the adapters Code ships, how they are registered, and how a connection's check is answered by whatever adapter the registry holds.
import { describe, expect, it } from "vitest";
import { SecretValue, type MonitoringAdapter, type OrgConnection } from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { connectionChecksFromRegistry, nativeMonitoringAdapters, registerNativeMonitoring } from "../../packages/broker/src/monitoring/native-adapters.js";

const ORG = "org_00000000000000000000";
const SENTRY: OrgConnection = { connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "sentry", label: "S", access: "read", region: "us", orgSlug: "acme" };
const TOKEN = ["sntrys", "x".repeat(8), "TOKENTHATMUSTNOTLEAK123"].join("_");
const sentryAnswer = (status: number, body: unknown = { slug: "acme" }): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the adapters Code ships", () => {
  it("serve the five vendors, read only, each with tools whose arguments are closed", () => {
    const adapters = nativeMonitoringAdapters();
    expect(adapters.map((adapter) => adapter.kind).sort()).toEqual(["datadog", "grafana", "pagerduty", "sentry", "vercel"]);
    for (const adapter of adapters) {
      expect(adapter.readOnly, adapter.kind).toBe(true);
      expect(adapter.takesSecret, adapter.kind).toBe(true);
      expect(adapter.tools().length, adapter.kind).toBeGreaterThan(0);
      for (const tool of adapter.tools()) expect(tool.inputSchema, `${adapter.kind} ${tool.name}`).toMatchObject({ additionalProperties: false });
    }
    expect(adapters.find((adapter) => adapter.kind === "sentry")!.tools().map((tool) => tool.name)).toEqual(["list_issues", "get_issue", "get_latest_event", "list_releases"]);
  });

  it("are registered under their kind, and a kind a plug-in already holds is left alone", () => {
    const registry = createAdapterRegistry();
    const own: MonitoringAdapter = { kind: "sentry", vendor: "Mine", readOnly: true, takesSecret: true, tools: () => [], check: async () => ({ ok: true }) };
    registry.register("monitoring", "sentry", own);
    registerNativeMonitoring(registry);
    expect(registry.names("monitoring").sort()).toEqual(["datadog", "grafana", "pagerduty", "sentry", "vercel"]);
    expect(registry.get("monitoring", "sentry")).toBe(own);
  });

  it("cannot be added once the registry is sealed: the install registers them before it seals", () => {
    const registry = createAdapterRegistry();
    registry.seal();
    expect(() => registerNativeMonitoring(registry)).toThrow();
  });
});

describe("a connection's check, answered by the adapter of its kind", () => {
  const checks = (fetchImplementation: typeof fetch) => {
    const registry = createAdapterRegistry();
    registerNativeMonitoring(registry);
    return { registry, check: connectionChecksFromRegistry(registry).sentry!({ orgId: ORG, connection: SENTRY, secret: { authToken: TOKEN }, fetch: fetchImplementation }) };
  };

  it("passes the connection's settings and its secret to the adapter and answers what the vendor said", async () => {
    expect(await checks(sentryAnswer(200)).check).toEqual({ ok: true });
    expect(await checks(sentryAnswer(401, {})).check).toMatchObject({ ok: false });
  });

  it("answers that a kind with no adapter cannot be checked here", async () => {
    const registry = createAdapterRegistry();
    const answer = await connectionChecksFromRegistry(registry).sentry!({ orgId: ORG, connection: SENTRY, secret: { authToken: TOKEN }, fetch: sentryAnswer(200) });
    expect(answer).toEqual({ ok: false, message: "checking a sentry connection is not available on this install" });
  });

  it("refuses settings of another kind and a secret it cannot read, without quoting either", async () => {
    const registry = createAdapterRegistry();
    registerNativeMonitoring(registry);
    const adapter = registry.get("monitoring", "sentry")!;
    const wrong = await adapter.check({ companyId: ORG, settings: { type: "datadog", site: "datadoghq.com" }, secret: new SecretValue(JSON.stringify({ authToken: TOKEN })), fetch: sentryAnswer(200) });
    expect(wrong.ok).toBe(false);
    const unreadable = await adapter.check({ companyId: ORG, settings: SENTRY, secret: new SecretValue(`not json ${TOKEN}`), fetch: sentryAnswer(200) });
    expect(unreadable).toEqual({ ok: false, message: "the saved secret could not be read; save it again" });
    expect(JSON.stringify([wrong, unreadable])).not.toContain(TOKEN);
  });

  it("holds a check to the fetch it is given: an adapter never builds its own", async () => {
    const seen: string[] = [];
    await checks(async (input) => { seen.push(String(input instanceof Request ? input.url : input)); return new Response(JSON.stringify({ slug: "acme" }), { status: 200 }); }).check;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((url) => new URL(url).hostname === "us.sentry.io")).toBe(true);
  });
});
