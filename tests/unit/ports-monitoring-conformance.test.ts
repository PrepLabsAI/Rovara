// The `monitoring` point (lane K1): the fake and an adapter Code ships pass the monitoring conformance suite.
import { createFakeMonitoringAdapter } from "../../packages/core/src/ports/index.js";
import { nativeMonitoringAdapters } from "../../packages/core/src/monitoring/native-adapters.js";
import { runMonitoringConformance } from "../support/ports/monitoring-conformance.js";

const answer = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const TOKEN = ["sntrys", "x".repeat(8), "TOKENTHATMUSTNOTLEAK123"].join("_");

runMonitoringConformance("the fake", {
  async create() {
    return { adapter: createFakeMonitoringAdapter(), settings: {}, secret: "fake-secret-value-123", origins: ["https://monitoring.example.test"], works: answer(200, { account: "acct_1" }), refuses: answer(401, {}) };
  },
});

runMonitoringConformance("Code's Sentry adapter", {
  async create() {
    return {
      adapter: nativeMonitoringAdapters().find((adapter) => adapter.kind === "sentry")!,
      settings: { connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "sentry", label: "S", access: "read", region: "us", orgSlug: "acme" },
      secret: JSON.stringify({ authToken: TOKEN }),
      origins: ["https://us.sentry.io"],
      works: answer(200, { slug: "acme" }),
      refuses: answer(401, {}),
    };
  },
});
