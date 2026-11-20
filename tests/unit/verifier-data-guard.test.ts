// Proof and test environment E10: the synthetic data guard (personal data patterns, production names) and the seeded generator.
import { describe, expect, it } from "vitest";
import { type TestEnvProdDeny } from "@agentx/contracts";
import { DATA_GUARD_MAX_BYTES, DataGuardInputTooLarge, createSyntheticGenerator, guardApiSample, guardInputs, guardSeeds, luhnValid, scanText } from "../../packages/verifier/src/data-guard.js";

const DENY: TestEnvProdDeny = { accountIds: ["111122223333"], hosts: ["*.prod.example.com", "billing.corp.net"], arnPrefixes: ["arn:aws:sagemaker:us-east-1:222222222222:"] };
const kinds = (text: string) => scanText(text, DENY).sort();

describe("personal data patterns", () => {
  it("finds international and formatted North American phones, not plain ids or the fictional range", () => {
    expect(kinds("call +44 20 7946 0958 today")).toEqual(["phone"]);
    expect(kinds("(415) 867-5309")).toEqual(["phone"]);
    expect(kinds("415-867-5309")).toEqual(["phone"]);
    expect(kinds("order 4158675309 shipped")).toEqual([]);
    expect(kinds("(415) 555-0123")).toEqual([]);
    expect(kinds("+1 202 555 0143")).toEqual([]);
    expect(kinds("202-555-0143")).toEqual([]);
  });
  it("finds social security, national insurance and Aadhaar-style numbers, not the never-issued ranges", () => {
    expect(kinds("ssn 219-09-9999")).toEqual(["government_id"]);
    expect(kinds("ssn 987-65-4321 and 000-12-3456 and 666-12-3456")).toEqual([]);
    expect(kinds("nino AB 12 34 56 C")).toEqual(["government_id"]);
    expect(kinds("id 2345 6789 0123")).toEqual(["government_id"]);
  });
  it("finds card numbers by the Luhn check, with separators, and ignores digit runs that fail it", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(kinds("card 4111 1111 1111 1111")).toEqual(["card_number"]);
    expect(kinds("card 4111-1111-1111-1111")).toEqual(["card_number"]);
    expect(kinds("trace 4111111111111112")).toEqual([]);
    expect(kinds("created 1730284800000")).toEqual([]);
  });
});

describe("production names", () => {
  it("finds a production ARN by prefix or by account, and a bare account id", () => {
    expect(kinds("arn:aws:sagemaker:us-east-1:222222222222:endpoint/x")).toEqual(["prod_arn"]);
    expect(kinds("arn:aws:iam::111122223333:role/deploy")).toEqual(["prod_account"]);
    expect(kinds("account 111122223333")).toEqual(["prod_account"]);
    expect(kinds("arn:aws:iam::999988887777:role/test account 999988887777")).toEqual([]);
    expect(kinds("version 1.2.3.4 and 10.0.0.1")).toEqual([]);
  });
});

describe("reports never hold the matched text", () => {
  it("refuses input over the size limit instead of half-reading it", () => {
    expect(() => scanText("x".repeat(DATA_GUARD_MAX_BYTES + 1), DENY)).toThrow(DataGuardInputTooLarge);
    const half = "y".repeat(DATA_GUARD_MAX_BYTES / 2 + 1);
    expect(() => guardInputs([{ source: "seed", path: "a", text: half }, { source: "seed", path: "b", text: half }], DENY)).toThrow(DataGuardInputTooLarge);
  });
});

describe("fixtures, seeds and API samples", () => {
  it("scans a seed command and a fixture file, and reads the file only through the caller's reader", async () => {
    const files = new Map([["seed/users.json", '[{"phone":"(415) 867-5309"}]']]);
    const report = await guardSeeds([{ command: { executable: "python", args: ["seed.py", "--host", "db.prod.example.com"] } }, { fixturePath: "seed/users.json" }], DENY, (path) => Promise.resolve(files.get(path) ?? ""));
    expect(report.findings).toEqual([{ kind: "prod_host", source: "seed", path: "seeds[0].command" }, { kind: "phone", source: "seed", path: "seed/users.json" }]);
  });
  it("scans an API sample's request and response", () => {
    expect(guardApiSample({ name: "rank-top5", request: "{}", response: '{"card":"4111 1111 1111 1111"}' }, DENY)).toEqual({ ok: false, findings: [{ kind: "card_number", source: "api_sample", path: "rank-top5.response" }] });
  });
});

describe("the seeded generator", () => {
  it("repeats for a seed, differs between seeds, and stays in range", () => {
    const run = (seed: number) => { const g = createSyntheticGenerator(seed); return [g.email(), g.phone(), g.name(), g.id("user"), g.uuid(), g.int(5, 9)]; };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
    const g = createSyntheticGenerator(1);
    for (let index = 0; index < 500; index += 1) expect(g.int(3, 7)).toBeGreaterThanOrEqual(3);
    expect(() => createSyntheticGenerator(-1)).toThrow(RangeError);
    expect(() => createSyntheticGenerator(1.5)).toThrow(RangeError);
    expect(() => g.int(5, 1)).toThrow(RangeError);
    expect(() => g.pick([])).toThrow(RangeError);
  });
});
