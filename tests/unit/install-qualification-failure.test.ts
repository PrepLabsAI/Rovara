import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES } from "../../packages/contracts/src/index.js";
import { main as qualificationCli } from "../../packages/verifier/src/install-qualification-cli.js";
import {
  QUALIFICATION_FAILURE_CODE, QUALIFICATION_FAILURE_MAX_BYTES, QUALIFICATION_FAILURE_MAX_CODES, QualificationStageError, WebApiQualificationRejected,
  boundQualificationCodes, qualificationFailureOf, summarizeProbeObservation,
} from "../../packages/verifier/src/install-qualification-failure.js";
import { qualifyInstalledWebApiRuntime } from "../../packages/verifier/src/install-qualification.js";
import { fakeLinuxEnvironment, fakeProbeRunner, goodWebApiObservation, privateEvidenceRoot, webApiChallenge } from "../support/web-api-qualification.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function scratch() { const dir = await mkdtemp(join(tmpdir(), "qualification-failure-")); dirs.push(dir); return dir; }

/** What api-egress-denial-v1 observed on a Docker 25 host: the app's lookup never reached the sinkhole. */
const docker25Observation = { collectorStatus: "FAILED" as const, runReason: "observed-application-test-failure", failedAssertionKinds: ["http-status"], unmockedCalls: { sinkhole: 0, mocked: 0 } };

describe("the qualification failure report", () => {
  it("passes a rejection's stable reason codes through unchanged, with the facts of the probes it names", async () => {
    const error = await qualifyInstalledWebApiRuntime({ challenge: webApiChallenge(Date.now()), evidenceRoot: await privateEvidenceRoot(), environment: fakeLinuxEnvironment(Date.now()),
      runProbe: fakeProbeRunner({ "api-egress-denial-v1": docker25Observation }).runProbe }).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(WebApiQualificationRejected);
    const failure = qualificationFailureOf(error, "qualification-failed");
    expect(failure).toEqual({ schemaVersion: "runtime-install-failure/v1", stage: "qualification-rejected", reasons: ["probe-wrong-cause:api-egress-denial-v1"],
      summary: ["api-egress-denial-v1:collector-failed", "api-egress-denial-v1:run-observed-application-test-failure", "api-egress-denial-v1:assert-http-status", "api-egress-denial-v1:sinkhole-0", "api-egress-denial-v1:mocked-0"] });
  });

  it("reports the stage of any other error and never its message", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE /home/node/.ssh/id_rsa Bearer abc123";
    for (const [error, fallback, stage] of [
      [new Error(secret), "challenge-invalid", "challenge-invalid"],
      [new QualificationStageError("host-identity-mismatch", new Error(secret)), "qualification-failed", "host-identity-mismatch"],
      ["a thrown string", "runner-config-invalid", "runner-config-invalid"],
      [new QualificationStageError("Not A Code: /etc/passwd", new Error(secret)), "qualification-failed", "internal"],
    ] as const) {
      const failure = qualificationFailureOf(error, fallback);
      expect(failure.stage).toBe(stage);
      expect(failure.reasons).toEqual([]);
      expect(failure.summary).toEqual([]);
      expect(JSON.stringify(failure)).not.toMatch(/AKIA|ssh|Bearer|passwd|string/);
    }
  });

  it("keeps only strings of the code grammar, at most 16 of them", () => {
    const free = ["Free text with spaces", "UPPER:case", "a:b:c", "has/slash", "with\nnewline", "ok:", ":ok", "", "x".repeat(49), "AKIAIOSFODNN7EXAMPLE", "token=abc", 7, null, { a: 1 }];
    const good = Array.from({ length: 30 }, (_, index) => `probe-wrong-cause:probe-${index}`);
    const bounded = boundQualificationCodes([...free, ...good], ["api-egress-denial-v1:sinkhole-0"]);
    expect(bounded.reasons).toEqual(good.slice(0, QUALIFICATION_FAILURE_MAX_CODES - 1));
    // The budget is shared: reasons take it first, the summary gets what is left.
    expect(bounded.summary).toEqual([]);
    const fewer = boundQualificationCodes(["probe-wrong-cause:a", ...free], ["a:sinkhole-0", "bad code"]);
    expect(fewer).toEqual({ reasons: ["probe-wrong-cause:a"], summary: ["a:sinkhole-0"] });
    for (const code of [...bounded.reasons, ...fewer.reasons, ...fewer.summary]) expect(code).toMatch(QUALIFICATION_FAILURE_CODE);
  });

  it("stays inside 2 KB whatever the codes are", () => {
    const longest = (index: number) => `${"a".repeat(40)}${String(index).padStart(2, "0")}:${"b".repeat(48)}`;
    const bounded = boundQualificationCodes(Array.from({ length: 100 }, (_, index) => longest(index)), Array.from({ length: 100 }, (_, index) => longest(index + 100)));
    expect(bounded.reasons.length + bounded.summary.length).toBeLessThanOrEqual(QUALIFICATION_FAILURE_MAX_CODES - 1);
    const codes = [...bounded.reasons, ...bounded.summary];
    expect(Buffer.byteLength(JSON.stringify(codes))).toBeLessThanOrEqual(QUALIFICATION_FAILURE_MAX_BYTES);
    // The code length bound alone keeps 16 codes under 2 KB; the byte bound is the second line of defence for a longer code length.
    expect(codes.length).toBe(QUALIFICATION_FAILURE_MAX_CODES - 1);
  });

  it("summarizes a probe by enums and counters only, never by its free text", () => {
    const base = goodWebApiObservation("web-egress-denial-v1");
    const summary = summarizeProbeObservation("web-egress-denial-v1", { ...base, collectorStatus: null, runUnavailableReason: "Build failed: /home/node/secret", runReason: "unmocked-external-call",
      failedAssertionKinds: ["csv", "http-status", "json", "text"], blockedHosts: ["probe.example.com", "169.254.169.254"], buildExitCode: 7, unmockedCalls: { sinkhole: 2, mocked: 1 } });
    expect(summary).toEqual(["web-egress-denial-v1:collector-none", "web-egress-denial-v1:unavailable-build-failed-home-node-secret", "web-egress-denial-v1:run-unmocked-external-call",
      "web-egress-denial-v1:assert-csv", "web-egress-denial-v1:assert-http-status", "web-egress-denial-v1:assert-json", "web-egress-denial-v1:sinkhole-2", "web-egress-denial-v1:mocked-1", "web-egress-denial-v1:build-exit-7"]);
    for (const code of summary) expect(code).toMatch(QUALIFICATION_FAILURE_CODE);
    expect(summary.join(" ")).not.toMatch(/example\.com|169\.254/);
  });

  it("names every required probe with a code the hook accepts", () => {
    for (const probe of WEB_API_REQUIRED_PROBES) expect(`probe-wrong-cause:${probe.probeId}`).toMatch(QUALIFICATION_FAILURE_CODE);
  });
});

describe("the qualification CLI's --failure-out", () => {
  const web = (extra: Record<string, unknown> = {}) => ({ environment: { EXECUTOR_IMAGE: "executor:test" }, host: { platform: "linux", arch: "arm64" }, ...extra });
  async function files() {
    const dir = await scratch();
    await writeFile(join(dir, "challenge.json"), JSON.stringify(webApiChallenge(Date.now())));
    return { dir, args: ["--profile", "linux-arm64-web-api-v1", "--challenge-file", join(dir, "challenge.json"), "--evidence-root", dir, "--out", join(dir, "proposal.json"), "--failure-out", join(dir, "failure.json")] };
  }

  it("writes the rejection's reason codes and probe facts to a private new file, and still fails", async () => {
    const { dir, args } = await files();
    await expect(qualificationCli(args, web({ qualificationEnvironment: fakeLinuxEnvironment(Date.now()),
      createProbeRunner: () => fakeProbeRunner({ "api-egress-denial-v1": docker25Observation }).runProbe }))).rejects.toThrow(/probe-wrong-cause:api-egress-denial-v1/);
    const text = await readFile(join(dir, "failure.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ schemaVersion: "runtime-install-failure/v1", stage: "qualification-rejected", reasons: ["probe-wrong-cause:api-egress-denial-v1"],
      summary: expect.arrayContaining(["api-egress-denial-v1:sinkhole-0", "api-egress-denial-v1:collector-failed"]) as string[] });
    expect((await stat(join(dir, "failure.json"))).mode & 0o777).toBe(0o600);
    await expect(stat(join(dir, "proposal.json"))).rejects.toThrow();
  });

  it("writes only a stage, never the error's message, for an error that is not a rejection", async () => {
    const { dir, args } = await files();
    const secret = "super-secret-host-detail";
    await expect(qualificationCli(args, web({ createProbeRunner: () => { throw new Error(secret); } }))).rejects.toThrow(secret);
    const text = await readFile(join(dir, "failure.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ schemaVersion: "runtime-install-failure/v1", stage: "runner-config-invalid", reasons: [], summary: [] });
    expect(text).not.toContain(secret);
  });

  it("names the stage a qualifier step failed in, and a malformed challenge", async () => {
    const { dir, args } = await files();
    await expect(qualificationCli(args, web({ qualificationEnvironment: fakeLinuxEnvironment(Date.now(), { assertHostIdentity: () => { throw new Error("secret workspace id mismatch"); } }),
      createProbeRunner: () => fakeProbeRunner().runProbe }))).rejects.toThrow(/secret workspace id mismatch/);
    expect(JSON.parse(await readFile(join(dir, "failure.json"), "utf8"))).toMatchObject({ stage: "host-identity-mismatch", reasons: [] });
    const bad = await files();
    await writeFile(join(bad.dir, "challenge.json"), '{"password":"hunter2"}');
    await expect(qualificationCli(bad.args, web())).rejects.toThrow();
    const text = await readFile(join(bad.dir, "failure.json"), "utf8");
    expect(JSON.parse(text)).toMatchObject({ stage: "challenge-invalid" });
    expect(text).not.toContain("hunter2");
  });

  it("writes nothing without the option, and never overwrites a file that exists", async () => {
    const { dir, args } = await files();
    const without = args.slice(0, -2);
    await expect(qualificationCli(without, web({ createProbeRunner: () => { throw new Error("x"); } }))).rejects.toThrow();
    await expect(stat(join(dir, "failure.json"))).rejects.toThrow();
    await writeFile(join(dir, "failure.json"), "kept");
    await expect(qualificationCli(args, web({ createProbeRunner: () => { throw new Error("x"); } }))).rejects.toThrow("x");
    expect(await readFile(join(dir, "failure.json"), "utf8")).toBe("kept");
  });
});
