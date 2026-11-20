// The two-company isolation set for a chat adapter (packages/testing/src/channel/isolation.ts): two companies, each with its own workspace and its own token, sharing the space, thread and account ids, behind one adapter,
// through the core's own channel code. It passes on the real Slack adapter and on the fake, and fails on a router, a tenant lookup, a token reader or a fail-closed lookup that leaks.
import { describe, expect, it } from "vitest";
import { COMPANY_A, COMPANY_B, assertSurfacesIsolated, assertTwoCompanyIsolation } from "../../packages/testing/src/isolation/index.js";
import {
  channelChecks, fakeChannelCompanies, fakeChannelWorld, routeEverythingToTheFirst, slackChannelCompanies, slackChannelWorld, type ChannelWorld,
} from "../../packages/testing/src/channel/index.js";
import { runContract } from "../../packages/testing/src/ports/plugin-contract-kit.js";

// The channel suite's own two checks run on the isolation set of each adapter.
runContract("the Slack channel adapter keeps two companies apart", channelChecks.slice(-2), (): ChannelWorld => ({ ...slackChannelWorld(), isolation: slackChannelCompanies().isolation }));
runContract("FakeChannelAdapter keeps two companies apart", channelChecks.slice(-2), (): ChannelWorld => ({ ...fakeChannelWorld(), isolation: fakeChannelCompanies().isolation }));

describe("what the set observes", () => {
  it("on Slack: each workspace shows its own notes, card and credential, and each company's press decided its own card (positive control for every leak below)", async () => {
    const companies = slackChannelCompanies();
    await assertTwoCompanyIsolation(companies.isolation);
    expect(companies.decided.map((entry) => entry.orgId).sort()).toEqual([COMPANY_A.orgId, COMPANY_B.orgId]);
    expect(new Set(companies.decided.map((entry) => entry.requestId)).size).toBe(2);
    // The token of each company was read for that company, and never for the other while a call was made for this one (the ledger would have thrown).
    expect(companies.ledger.reads.length).toBeGreaterThan(0);
    // The surfaces are all there: events, secrets and approvals.
    expect(companies.isolation.surfaces.map((surface) => surface.name)).toEqual(expect.arrayContaining([
      expect.stringContaining("a message for each company"), expect.stringContaining("each company's token"), expect.stringContaining("a card and the decision"),
    ]));
  });

});

describe("a leaking host fails the set", () => {
  it("a router that delivers every company's events through the first company's adapter", async () => {
    await expect(assertSurfacesIsolated(slackChannelCompanies({ router: routeEverythingToTheFirst }).isolation.surfaces)).rejects.toThrow();
    await expect(assertSurfacesIsolated(fakeChannelCompanies({ router: routeEverythingToTheFirst }).isolation.surfaces)).rejects.toThrow(/saw company/);
  });

});
