// The `realtime` point (lane K1): the in-process adapter passes the contract, it is Code's default, and a listener hears only its company and audience.
import { describe, expect, it } from "vitest";
import { PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, isRealtimeAudience, isRealtimeNotice } from "@agentx/contracts";
import { createAdapterRegistry, createInProcessRealtime, registerCodeDefaults } from "../../packages/broker/src/ports/index.js";
import { runRealtimeConformance } from "../support/ports/realtime-conformance.js";

runRealtimeConformance("the in-process adapter", {
  async create() {
    const publisher = createInProcessRealtime();
    return { publisher, heard: () => publisher.published(), setDown: (down) => publisher.setDown(down) };
  },
});

describe("the realtime point", () => {
  it("is a point of one adapter, and Code's default is the in-process adapter", () => {
    expect(PLUGIN_POINTS).toContain("realtime");
    expect(PLUGIN_POINT_CARDINALITY.realtime).toBe("one");
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("realtime")).toEqual(["in-process"]);
    expect(registry.require("realtime").capabilities.remoteListeners).toBe(false);
    registry.register("realtime", "hosted", createInProcessRealtime());
    expect(registry.names("realtime")).toEqual(["hosted"]);
  });

  it("tells a listener only its company's notices, and only its audience's when it names one; a listener that throws fails nothing", async () => {
    const hub = createInProcessRealtime();
    const company: string[] = [];
    const session: string[] = [];
    hub.listen("org_00000000000000000000", (heard) => { company.push(heard.notice.type); });
    hub.listen("org_00000000000000000000", (heard) => { session.push(String(heard.notice["revision"])); }, { kind: "session", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" });
    hub.listen("org_00000000000000000000", () => { throw new Error("a broken page"); });
    const other: string[] = [];
    const stop = hub.listen("org_11111111111111111111", (heard) => { other.push(heard.notice.type); });
    const result = await hub.publish({ companyId: "org_00000000000000000000", entries: [
      { audience: { kind: "session", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" }, notice: { type: "session.updated", revision: 4 } },
      { audience: { kind: "person", personId: "p1" }, notice: { type: "home.changed", revision: 4 } },
    ] });
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(company).toEqual(["session.updated", "home.changed"]);
    expect(session).toEqual(["4"]);
    expect(other).toEqual([]);
    stop();
    await hub.publish({ companyId: "org_11111111111111111111", entries: [{ audience: { kind: "person", personId: "p1" }, notice: { type: "home.changed", revision: 5 } }] });
    expect(other).toEqual([]);
  });

  it("carries the notices of the hosted product's pages and refuses free text", () => {
    expect(isRealtimeNotice({ type: "session.updated", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", revision: 7 })).toBe(true);
    expect(isRealtimeNotice({ type: "session.event", sessionId: "crn_aaaaaaaaaaaaaaaaaaaa", eventId: "evt_0001" })).toBe(true);
    expect(isRealtimeNotice({ type: "home.changed", revision: 0 })).toBe(true);
    expect(isRealtimeNotice({ type: "session.updated", title: "a person's words" })).toBe(false);
    expect(isRealtimeNotice({ type: "home.changed", revision: Number.NaN })).toBe(false);
    expect(isRealtimeNotice({ type: "home.changed", list: [1] })).toBe(false);
    expect(isRealtimeNotice({ type: "home.changed", blob: "x".repeat(129) })).toBe(false);
    expect(isRealtimeAudience({ kind: "project", project: "web", extra: 1 })).toBe(false);
    expect(isRealtimeAudience({ kind: "person", personId: "d".repeat(64) })).toBe(true);
  });
});
