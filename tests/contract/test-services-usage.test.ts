// Test services, slice 1 T1: the usage record a worker reports (design test-services.md 4.0, 8.1; TS-SEAL-1).
import { describe, expect, it } from "vitest";
import { TestServicesUsageRecordSchema, testServicesUnhealthy, testServicesUnknownCallCount } from "../../packages/contracts/src/test-services-usage.js";

const dependency = (over: Record<string, unknown> = {}) => ({ id: "postgres", started: true, healthy: true, startMs: 840, resetCount: 2, ...over });
const record = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, dependencies: [dependency()], unknownCalls: { domains: [], otherCount: 0 }, ...over });
const ok = (value: unknown) => TestServicesUsageRecordSchema.safeParse(value).success;

describe("the usage record", () => {
  it("round-trips a healthy Postgres with no unknown calls", () => {
    expect(TestServicesUsageRecordSchema.parse(record())).toEqual(record());
    expect(testServicesUnknownCallCount(TestServicesUsageRecordSchema.parse(record()))).toBe(0);
    expect(testServicesUnhealthy(TestServicesUsageRecordSchema.parse(record()))).toEqual([]);
  });

  it("is strict and bounded", () => {
    expect(ok(record({ extra: 1 }))).toBe(false);
    expect(ok(record({ schemaVersion: 2 }))).toBe(false);
    expect(ok(record({ dependencies: [dependency({ extra: 1 })] }))).toBe(false);
    expect(ok(record({ dependencies: [dependency({ startMs: -1 })] }))).toBe(false);
    expect(ok(record({ dependencies: [dependency({ startMs: 86_400_001 })] }))).toBe(false);
    expect(ok(record({ dependencies: [dependency({ resetCount: 1.5 })] }))).toBe(false);
    expect(ok(record({ dependencies: Array.from({ length: 17 }, (_unused, index) => dependency({ id: `d${String(index)}` })) }))).toBe(false);
    expect(ok(record({ dependencies: [dependency(), dependency()] }))).toBe(false);
  });

  it("states a start that failed in a fixed word", () => {
    const failed = dependency({ started: true, healthy: false, startMs: 30_000, resetCount: 0, failure: "not_healthy" });
    expect(ok(record({ dependencies: [failed] }))).toBe(true);
    expect(testServicesUnhealthy(TestServicesUsageRecordSchema.parse(record({ dependencies: [failed] })))).toEqual(["postgres"]);
    expect(ok(record({ dependencies: [{ ...failed, failure: undefined }] }))).toBe(false); // not healthy and no reason
    expect(ok(record({ dependencies: [{ ...failed, failure: "it exploded: connection refused" }] }))).toBe(false);
    expect(ok(record({ dependencies: [dependency({ started: false, healthy: false, startMs: 0, resetCount: 0, failure: "pull_failed" })] }))).toBe(true);
    expect(ok(record({ dependencies: [dependency({ started: false, healthy: true })] }))).toBe(false); // healthy without starting
    expect(ok(record({ dependencies: [dependency({ started: false, healthy: false, startMs: 5, resetCount: 0, failure: "pull_failed" })] }))).toBe(false);
    expect(ok(record({ dependencies: [dependency({ failure: "seed_failed" })] }))).toBe(true); // healthy, but a seed failed
    expect(ok(record({ dependencies: [dependency({ failure: "pull_failed" })] }))).toBe(false);
  });

  it("shows unknown names as registrable domain and count only", () => {
    const parsed = TestServicesUsageRecordSchema.parse(record({ unknownCalls: { domains: [{ domain: "example-pay.com", count: 3 }, { domain: "api.other.test", count: 1 }], otherCount: 2 } }));
    expect(testServicesUnknownCallCount(parsed)).toBe(6);
    const withDomains = (domains: unknown) => ok(record({ unknownCalls: { domains, otherCount: 0 } }));
    expect(withDomains([{ domain: "example-pay.com", count: 0 }])).toBe(false);
    expect(withDomains([{ domain: "example-pay.com", count: 1 }, { domain: "example-pay.com", count: 1 }])).toBe(false);
    expect(withDomains([{ domain: "redis", count: 1 }])).toBe(false); // a bare name is counted, never shown
    expect(withDomains([{ domain: "127.0.0.1", count: 1 }])).toBe(false);
    expect(withDomains([{ domain: "EXAMPLE.com", count: 1 }])).toBe(false);
    expect(withDomains([{ domain: "example.com/path", count: 1 }])).toBe(false);
    expect(withDomains([{ domain: "example.com", count: 1, path: "/x" }])).toBe(false);
    expect(withDomains(Array.from({ length: 51 }, (_unused, index) => ({ domain: `d${String(index)}.example.com`, count: 1 })))).toBe(false);
    expect(withDomains(Array.from({ length: 50 }, (_unused, index) => ({ domain: `d${String(index)}.example.com`, count: 1 })))).toBe(true);
  });

  it("never carries a secret-shaped name", () => {
    // Built at run time: a key-shaped literal in the source would trip the repository's push protection.
    const keyId = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    const longToken = "a1b2c3d4".repeat(5);
    const withDomain = (domain: string) => ok(record({ unknownCalls: { domains: [{ domain, count: 1 }], otherCount: 0 } }));
    // A DNS name arrives lower-cased, which hides an access key id from a case-sensitive check.
    expect(withDomain(`${keyId.toLowerCase()}.attacker.test`)).toBe(false);
    expect(withDomain(`x.${keyId.toLowerCase()}.attacker.test`)).toBe(false);
    expect(withDomain(`${longToken}.attacker.test`)).toBe(false);
    expect(withDomain("attacker.test")).toBe(true);
  });
});
