// Lane L10 (review N2): what a worker is sent for the credential the code host gave. It must be usable now: not expired, not valid for longer than an hour, a shape the worker takes.
import { describe, expect, it } from "vitest";
import { usableWorkerCredential } from "../../packages/broker/src/local/app/push-credential.js";

const host = { capabilities: { perPersonCredentials: false } } as never;
const now = Date.parse("2026-11-09T12:00:00.000Z");
const at = (minutes: number): string => new Date(now + minutes * 60_000).toISOString();

describe("the credential a worker is sent", () => {
  it("is the token the code host gave, while it is valid for no more than an hour", () => {
    expect(usableWorkerCredential(host, { kind: "token", token: "t-1", expiresAt: at(50) }, now)).toEqual({ token: "t-1" });
    expect(usableWorkerCredential(host, { kind: "basic", username: "x-access-token", password: "p-1", expiresAt: at(50) }, now)).toEqual({ token: "p-1" });
  });

  it("is refused when it has expired", () => {
    expect(() => usableWorkerCredential(host, { kind: "token", token: "t-1", expiresAt: at(-1) }, now)).toThrow(/usable credential/u);
  });

  it("is refused when it is valid for longer than an hour", () => {
    expect(() => usableWorkerCredential(host, { kind: "token", token: "t-1", expiresAt: at(120) }, now)).toThrow(/usable credential/u);
  });

  it("is refused when it is a helper, which has no shape a worker takes", () => {
    expect(() => usableWorkerCredential(host, { kind: "helper", helper: "aws-codecommit", expiresAt: at(30) }, now)).toThrow();
  });
});
