// Slice 1, s1-sealed T1: the usage record (service-usage-record.ts). Deferred check TS-SEAL-1: a name the program asked for can hold a run secret, so the record never carries a name: a registrable domain and a count
// at most, and not even that when the redactor changes it. Nothing starts Docker.
import { TestServicesUsageRecordSchema } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { SEALED_DNS_STATE_FILE, type SealedDnsRecord } from "../../packages/worker/src/check-sandbox.js";
import { createServiceRedactor } from "../../packages/worker/src/service-env.js";
import type { ServiceSession } from "../../packages/worker/src/service-runner.js";
import { USAGE_UNKNOWN_DOMAINS_MAX, bucketCount, buildServiceUsageRecord, countResets, reduceUnknownNames, type ServiceUsageRecord } from "../../packages/worker/src/service-usage-record.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const PASSWORD = ["Zq8Wv3Lm9", "Xc2Rt5"].join("");
const CONTROL = "Kd4Hn7Bp2Vs6Jf9";
const redactor = createServiceRedactor([PASSWORD, CONTROL]);
const dns = (...unknown: Array<[string, number]>): SealedDnsRecord => ({ unknown: unknown.map(([name, queries]) => ({ name, queries })), dropped: 0, unrecorded: 0 });

/** The test the finished record must pass: no name and no secret anywhere in its JSON, in any case. */
function expectNameFree(record: ServiceUsageRecord, forbidden: readonly string[]): void {
  // The broker's contract accepts what this module builds, byte for byte.
  expect(TestServicesUsageRecordSchema.parse(record)).toEqual(record);
  const text = JSON.stringify(record).toLowerCase();
  for (const value of forbidden) expect(text, value).not.toContain(value.toLowerCase());
}

describe("reduceUnknownNames (TS-SEAL-1)", () => {
  it("keeps the registrable domain and the count, never the name", () => {
    const { domains: unknownDomains, otherCount: otherUnknownCount } = reduceUnknownNames(dns(["api.stripe.com", 2], ["files.stripe.com", 1], ["tracker.example.co.uk", 4]), redactor);
    // 4 and 3 lookups are the same bucket (2 to 5), so the order is by name and the counts show the bucket.
    expect(unknownDomains).toEqual([{ domain: "example.co.uk", count: 2 }, { domain: "stripe.com", count: 2 }]);
    expect(otherUnknownCount).toBe(0);
    expect(JSON.stringify(unknownDomains)).not.toContain("api.");
  });

  it("names at most USAGE_UNKNOWN_DOMAINS_MAX domains, the most asked first, and counts the rest as other", () => {
    const rows: Array<[string, number]> = Array.from({ length: USAGE_UNKNOWN_DOMAINS_MAX + 10 }, (_unused, index) => [`host.site${String(index).padStart(3, "0")}.com`, index + 1]);
    const { domains: unknownDomains, otherCount: otherUnknownCount } = reduceUnknownNames(dns(...rows), redactor);
    expect(unknownDomains).toHaveLength(USAGE_UNKNOWN_DOMAINS_MAX);
    expect(unknownDomains[0]!.count).toBe(21);
    expect(unknownDomains.map((row) => row.count)).toEqual([...unknownDomains.map((row) => row.count)].sort((a, b) => b - a));
    // The ten least asked (counts 1 to 10) fell off the end; their sum (55) is counted in a bucket.
    expect(otherUnknownCount).toBe(21);
  });

  it("skips a row with no lookups, and ignores a non-number count", () => {
    const { domains: unknownDomains, otherCount: otherUnknownCount } = reduceUnknownNames({ unknown: [{ name: "a.example.com", queries: 0 }, { name: "b.example.com", queries: Number.NaN }, { name: "c.example.com", queries: -4 }], dropped: Number.NaN, unrecorded: -1 }, redactor);
    expect(unknownDomains).toEqual([]);
    expect(otherUnknownCount).toBe(0);
  });
});

function fakeSession(ids: string[], health: Record<string, boolean | "throw"> = {}): Pick<ServiceSession, "helpers" | "probe"> & { asked: Array<[string, number | undefined]> } {
  const asked: Array<[string, number | undefined]> = [];
  return {
    asked,
    helpers: ids.map((id) => ({ id, container: `c-${id}`, address: "172.30.1.16", aliases: [id], ports: [5432] })),
    probe: (id, limitMs) => { asked.push([id, limitMs]); const answer = health[id] ?? true; return answer === "throw" ? Promise.reject(new Error("stopped")) : Promise.resolve(answer); },
  };
}

describe("counts are coarse buckets (TS-SEAL-1 bandwidth)", () => {
  it("maps a count to the lower bound of its bucket: 1, 2-5, 6-20, 21+", () => {
    const cases: Array<[number, number]> = [[0, 0], [1, 1], [2, 2], [5, 2], [6, 6], [20, 6], [21, 21], [1_000_000, 21]];
    for (const [count, bucket] of cases) expect(bucketCount(count), String(count)).toBe(bucket);
  });

});

describe("buildServiceUsageRecord", () => {
  it("records, per planned dependency, whether it started, whether it answers, how long it took and how often it was reset", async () => {
    const session = fakeSession(["postgres"]);
    const record = await buildServiceUsageRecord({ planned: ["postgres"], session, startMs: new Map([["postgres", 4_200]]), resetCounts: new Map([["postgres", 3]]), redactor });
    expect(record).toEqual({ schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 4_200, resetCount: 3 }], unknownCalls: { domains: [], otherCount: 0 } });
    expect(session.asked).toEqual([["postgres", 5_000]]);
    expectNameFree(record, []);
  });

  it("a planned dependency with no helper is not started and is never asked", async () => {
    const session = fakeSession(["postgres"]);
    const record = await buildServiceUsageRecord({ planned: ["postgres", "valkey"], session, startMs: 900, resetCounts: new Map([["valkey", 2]]), redactor });
    expect(record.dependencies).toEqual([
      { id: "postgres", started: true, healthy: true, startMs: 900, resetCount: 0 },
      { id: "valkey", started: false, healthy: false, startMs: 0, resetCount: 0, failure: "start_failed" },
    ]);
    expect(session.asked.map(([id]) => id)).toEqual(["postgres"]);
  });

  it("says why a dependency is not healthy, in the contract's fixed words; a healthy one carries only a seed or reset failure", async () => {
    const failures = new Map<string, "pull_failed" | "seed_failed" | "start_failed">([["a", "pull_failed"], ["b", "seed_failed"], ["c", "seed_failed"]]);
    const record = await buildServiceUsageRecord({ planned: ["a", "b", "c", "d"], session: fakeSession(["b", "c"], { b: false }), failures, redactor });
    expect(record.dependencies.map((row) => [row.id, row.started, row.healthy, row.failure])).toEqual([
      ["a", false, false, "pull_failed"], ["b", true, false, "seed_failed"], ["c", true, true, "seed_failed"], ["d", false, false, "start_failed"],
    ]);
    // A told failure that does not fit a healthy dependency is not carried.
    const healthy = await buildServiceUsageRecord({ planned: ["a"], session: fakeSession(["a"]), failures: new Map([["a", "pull_failed"]]), redactor });
    expect(healthy.dependencies[0]).not.toHaveProperty("failure");
    expectNameFree(record, []);
    expectNameFree(healthy, []);
  });

  it("a dependency that does not answer, or whose question throws (the session was stopped), is unhealthy, not an error", async () => {
    const record = await buildServiceUsageRecord({ planned: ["a", "b"], session: fakeSession(["a", "b"], { a: false, b: "throw" }), redactor });
    expect(record.dependencies.map((row) => [row.started, row.healthy, row.failure])).toEqual([[true, false, "not_healthy"], [true, false, "not_healthy"]]);
  });

  it("reads the sealed name server's record through docker when given where it is, and reduces it", async () => {
    const calls: string[][] = [];
    const docker: DockerCli = {
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ unknown: [{ name: "api.stripe.com", queries: 2 }, { name: `${PASSWORD.toLowerCase()}.attacker.test`, queries: 1 }, { name: `${PASSWORD.toLowerCase()}.com`, queries: 1 }], dropped: 1, unrecorded: 0 }), stderr: "" });
      },
    };
    const record = await buildServiceUsageRecord({ planned: ["postgres"], session: fakeSession(["postgres"]), dns: { docker, dnsHelperName: "rovara-svc-0123456789ab-dns" }, redactor });
    expect(calls).toEqual([["exec", "rovara-svc-0123456789ab-dns", "cat", SEALED_DNS_STATE_FILE]]);
    expect(record.unknownCalls.domains).toEqual([{ domain: "stripe.com", count: 2 }]);
    expect(record.unknownCalls.otherCount).toBe(2);
    expectNameFree(record, [PASSWORD, "api.stripe", "attacker"]);
  });

  it("whatever the program asked, the finished record holds no secret and no full name (the case-insensitive scan)", async () => {
    const hostile = dns(
      [`${PASSWORD.toLowerCase()}.attacker.test`, 9], [`${PASSWORD.toUpperCase()}.EVIL.example`, 1], [`${CONTROL.toLowerCase()}.com`, 2],
      [`${PASSWORD.slice(0, 7).toLowerCase()}.${PASSWORD.slice(7).toLowerCase()}.net`, 1], ["db.internal.example.org", 6], ["registry.npmjs.org", 4],
    );
    const record = await buildServiceUsageRecord({ planned: ["postgres"], session: fakeSession(["postgres"]), dns: hostile, redactor });
    expectNameFree(record, [PASSWORD, CONTROL, "attacker", "evil", "db.internal", "registry.", PASSWORD.slice(0, 7), PASSWORD.slice(7)]);
    expect(record.unknownCalls.domains.map((row) => row.domain).sort()).toEqual(["example.org", "npmjs.org"]);
  });
});

describe("countResets", () => {
  it("counts the resets that succeeded, by dependency, and passes the outcome on", async () => {
    let failNext = false;
    const session = {
      reset: (id: string) => (failNext ? Promise.reject(new Error(`no ${id}`)) : Promise.resolve({ keptSeeds: id === "postgres" })),
      seeded: () => Promise.resolve(),
    };
    const counted = countResets(session);
    await expect(counted.session.reset("postgres")).resolves.toEqual({ keptSeeds: true });
    await counted.session.reset("postgres");
    await counted.session.reset("valkey");
    failNext = true;
    await expect(counted.session.reset("postgres")).rejects.toThrow();
    expect(Object.fromEntries(counted.resets)).toEqual({ postgres: 2, valkey: 1 });
    // The other members are the session's own.
    expect(counted.session.seeded).toBe(session.seeded);
    const record = await buildServiceUsageRecord({ planned: ["postgres"], session: fakeSession(["postgres"]), resetCounts: counted.resets, redactor });
    expect(record.dependencies[0]!.resetCount).toBe(2);
  });
});
