// Proof and test environment E10: the synthetic data guard (personal data patterns, production names) and the seeded generator.
import { describe, expect, it } from "vitest";
import { DataGuardReportSchema, ServiceMockFixtureSetSchema, type ServiceMockFixtureSet, type TestEnvProdDeny } from "@rovara-code/contracts";
import { DATA_GUARD_MAX_BYTES, DataGuardInputTooLarge, createSyntheticGenerator, guardApiSample, guardFixtureSet, guardInputs, guardSeeds, luhnValid, scanText } from "../../packages/verifier/src/data-guard.js";

const DENY: TestEnvProdDeny = { accountIds: ["111122223333"], hosts: ["*.prod.example.com", "billing.corp.net"], arnPrefixes: ["arn:aws:sagemaker:us-east-1:222222222222:"] };
const kinds = (text: string) => scanText(text, DENY).sort();

describe("personal data patterns", () => {
  it("finds an email at a real domain and passes reserved ones", () => {
    expect(kinds('{"owner":"jane.roe@acme-corp.com"}')).toEqual(["email"]);
    expect(kinds("a@example.com b@x.example.org c@mail.test d@y.invalid e@thing.example")).toEqual([]);
  });
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

describe("credentials (review I7)", () => {
  // Built at runtime: the public repository refuses key-shaped strings in source.
  const awsKey = `AKIA${"ABCDEFGHIJKLMNOP"}`;
  const jwt = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"sub":"1234567890","name":"x"}').toString("base64url")}.${"s".repeat(43)}`;
  const github = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
  it("finds cloud keys, provider tokens, bearer tokens and JWTs, private keys, and passwords in URLs or pairs", () => {
    expect(kinds(`{"access":"${awsKey}"}`)).toEqual(["secret"]);
    expect(kinds(`token ${github}`)).toEqual(["secret"]);
    expect(kinds(`Authorization: Bearer ${jwt}`)).toEqual(["secret"]);
    expect(kinds(`{"id_token":"${jwt}"}`)).toEqual(["secret"]);
    expect(kinds(`-----BEGIN ${"RSA"} PRIVATE KEY-----\nMIIEabc\n-----END ${"RSA"} PRIVATE KEY-----`)).toEqual(["secret"]);
    expect(kinds("postgres://app:hunter2secret@db.internal.test:5432/app")).toEqual(["secret"]);
    expect(kinds('{"password": "correct-horse-battery"}')).toEqual(["secret"]);
  });
  it("leaves ordinary synthetic text alone", () => {
    expect(kinds('{"score":0.91,"model":"v3","partner":"p1","region":"emea"}')).toEqual([]);
    expect(kinds("id-0a1b2c3d and a uuid 3f2a9c1e-1111-4222-8333-222222222222")).toEqual([]);
  });
  it("blocks a fixture whose recorded response echoes a token, naming only the entry", () => {
    const report = guardFixtureSet(fixtureSet(`{"echo":"Bearer ${jwt}"}`), DENY);
    expect(report).toEqual({ ok: false, findings: [{ kind: "secret", source: "fixture", path: "entries[0].response" }] });
    expect(JSON.stringify(report)).not.toContain(jwt.slice(0, 12));
  });
});

describe("production names", () => {
  it("uses the one matcher: wildcard ARNs, trailing dots, userinfo and case all match", () => {
    const wild: TestEnvProdDeny = { accountIds: [], hosts: ["*.prod.example.com", "billing.corp.net."], arnPrefixes: ["arn:aws:iam::*:role/prod-", "arn:aws:sagemaker:*:210987654321:endpoint/*"] };
    expect(scanText("arn:aws:iam::999988887777:role/prod-deploy", wild)).toEqual(["prod_arn"]);
    expect(scanText("arn:aws:sagemaker:eu-west-1:210987654321:endpoint/x", wild)).toEqual(["prod_arn"]);
    expect(scanText("https://user@API.PROD.example.com./x and billing.corp.net.", wild)).toEqual(["prod_host"]);
  });
  it("finds a deny-listed host, wildcard or exact, case-insensitively", () => {
    expect(kinds("GET https://API.Prod.Example.com/v1")).toEqual(["prod_host"]);
    expect(kinds("host billing.corp.net")).toEqual(["prod_host"]);
    expect(kinds("https://staging.example.com and prod.example.com")).toEqual([]);
  });
  it("finds a production ARN by prefix or by account, and a bare account id", () => {
    expect(kinds("arn:aws:sagemaker:us-east-1:222222222222:endpoint/x")).toEqual(["prod_arn"]);
    expect(kinds("arn:aws:iam::111122223333:role/deploy")).toEqual(["prod_account"]);
    expect(kinds("account 111122223333")).toEqual(["prod_account"]);
    expect(kinds("arn:aws:iam::999988887777:role/test account 999988887777")).toEqual([]);
    expect(kinds("version 1.2.3.4 and 10.0.0.1")).toEqual([]);
  });
});

describe("reports never hold the matched text", () => {
  it("names the kind, the source and a path, and nothing else", () => {
    const secret = "jane.roe@acme-corp.com";
    const report = guardInputs([{ source: "seed", path: "seeds/users.json", text: `{"email":"${secret}"}` }, { source: "seed", path: "seeds/ok.json", text: "{}" }], DENY);
    expect(report).toEqual({ ok: false, findings: [{ kind: "email", source: "seed", path: "seeds/users.json" }] });
    expect(JSON.stringify(report)).not.toContain("acme-corp");
    expect(DataGuardReportSchema.safeParse(report).success).toBe(true);
  });
  it("is ok with no findings, caps at 100 findings, and cleans a path of control characters", () => {
    expect(guardInputs([{ source: "fixture", path: "a", text: "nothing here" }], DENY)).toEqual({ ok: true, findings: [] });
    const many = Array.from({ length: 150 }, (_, index) => ({ source: "fixture" as const, path: `f${String(index)}`, text: "x@real-domain.com" }));
    const report = guardInputs(many, DENY);
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(100);
    expect(guardInputs([{ source: "fixture", path: "bad\u0000‮path", text: "x@real-domain.com" }], DENY).findings[0]?.path).toBe("bad??path");
  });
  it("refuses input over the size limit instead of half-reading it", () => {
    expect(() => scanText("x".repeat(DATA_GUARD_MAX_BYTES + 1), DENY)).toThrow(DataGuardInputTooLarge);
    const half = "y".repeat(DATA_GUARD_MAX_BYTES / 2 + 1);
    expect(() => guardInputs([{ source: "seed", path: "a", text: half }, { source: "seed", path: "b", text: half }], DENY)).toThrow(DataGuardInputTooLarge);
  });
  it("scans hostile text in linear time", () => {
    const started = Date.now();
    scanText(`${"1 ".repeat(200_000)}${"a.".repeat(100_000)}${"+1".repeat(100_000)}${"9".repeat(500_000)}`, DENY);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

const fixtureSet = (responseBody: string): ServiceMockFixtureSet => ServiceMockFixtureSetSchema.parse({
  schemaVersion: 1, service: { name: "partner-scorer", kind: "sagemaker_runtime", target: "partner-scorer" }, revision: 1, recordedAt: "2026-10-30T00:00:00.000Z", syntheticOnly: true, requestSchema: null, responseSchema: null,
  entries: [{ requestHash: "a".repeat(64), request: { contentType: "application/json", body: '{"partner":"p1"}' }, response: { status: 200, contentType: "application/json", body: responseBody, latencyMs: 5 } }], faults: [],
});

describe("fixtures, seeds and API samples", () => {
  it("blocks a fixture set whose response holds personal data, naming the entry", () => {
    expect(guardFixtureSet(fixtureSet('{"score":0.9}'), DENY).ok).toBe(true);
    expect(guardFixtureSet(fixtureSet('{"contact":"jane.roe@acme-corp.com"}'), DENY)).toEqual({ ok: false, findings: [{ kind: "email", source: "fixture", path: "entries[0].response" }] });
  });
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
  it("makes nothing the guard blocks, over many values", () => {
    const g = createSyntheticGenerator(2026);
    const text = Array.from({ length: 2_000 }, () => `${g.email()} ${g.phone()} ${g.name()} ${g.id()} ${g.uuid()}`).join("\n");
    expect(scanText(text, DENY)).toEqual([]);
  });
});
