// The `email` point (lane K1): the fake passes the contract; Code's default sends nothing and says so; the refusal rule every adapter shares.
import { describe, expect, it } from "vitest";
import { EmailError, PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, emailRefusal, isPlainEmailAddress } from "@agentx/contracts";
import { createAdapterRegistry, createFakeEmailSender, createUnavailableEmailSender, registerCodeDefaults } from "../../packages/broker/src/ports/index.js";
import { runEmailConformance } from "../support/ports/email-conformance.js";

runEmailConformance("the in-memory fake", {
  async create() {
    const sender = createFakeEmailSender();
    return { sender, sent: () => sender.sent(), setDown: (down) => sender.setDown(down) };
  },
});

runEmailConformance("the in-memory fake without HTML or the unsubscribe header", {
  async create() {
    const sender = createFakeEmailSender({ capabilities: { html: false, unsubscribeHeader: false } });
    return { sender, sent: () => sender.sent(), setDown: (down) => sender.setDown(down) };
  },
});

describe("the email point", () => {
  it("is a point of one adapter; Code's default refuses what any adapter refuses and otherwise says no sender is set up", async () => {
    expect(PLUGIN_POINTS).toContain("email");
    expect(PLUGIN_POINT_CARDINALITY.email).toBe("one");
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("email")).toEqual(["none"]);
    const none = createUnavailableEmailSender();
    const message = { companyId: "org_00000000000000000000", purpose: "invite", to: "dev@example.test", subject: "You are invited", text: "Open the link." };
    await expect(none.send(message)).rejects.toMatchObject({ name: "EmailError", code: "unavailable" });
    await expect(none.send({ ...message, to: "two@example.test, three@example.test" })).rejects.toMatchObject({ code: "refused" });
    registry.register("email", "hosted", createFakeEmailSender());
    expect(registry.names("email")).toEqual(["hosted"]);
  });

  it("keeps the unsubscribe link only where the adapter can set it", async () => {
    const withHeader = createFakeEmailSender();
    const without = createFakeEmailSender({ capabilities: { unsubscribeHeader: false } });
    const message = { companyId: "org_00000000000000000000", purpose: "attention", to: "dev@example.test", subject: "1 task needs you", text: "Stop: https://rovara.example.test/stop", unsubscribeUrl: "https://rovara.example.test/stop" };
    await withHeader.send(message);
    await without.send(message);
    expect(withHeader.sent()[0]?.unsubscribeUrl).toBe("https://rovara.example.test/stop");
    expect(without.sent()[0]?.unsubscribeUrl).toBeUndefined();
  });

  it("checks one plain address the way the hosted sender does", () => {
    expect(isPlainEmailAddress("a.b+c@example.test")).toBe(true);
    for (const value of ["a@b", "a b@example.test", "<a@example.test>", "\"a\"@example.test", `${"x".repeat(250)}@example.test`]) expect(isPlainEmailAddress(value), value).toBe(false);
    expect(emailRefusal({ companyId: "c", purpose: "attention", to: "a@example.test", subject: "ok", text: "ok" })).toBeUndefined();
    expect(new EmailError("unavailable", "x").retryable).toBe(true);
  });
});
