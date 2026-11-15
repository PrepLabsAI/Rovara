// TE-E0 option B (slice A4): per-test reports from GitHub Actions artifacts. The zip is read in memory with fixed limits and refused whole on anything it does not take whole; the worker's report
// adapters (#529) parse it through the broker's `PipelineReportParser` port (names, outcomes, capped failure text; never logs); the client reads only test-result artifacts from GitHub's own storage.
// In a tracking pass the report gives the counts, the detail a fix rests on, the change proof against the base commit's run (added tests keep their sandbox label) and the flaky history.
import { deflateRawSync } from "node:zlib";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CI_EVIDENCE_ASK_PREFIX, CI_EVIDENCE_ENVIRONMENT_PREFIX, DEFAULT_CI_EVIDENCE_SETTINGS, GITHUB_ACTIONS_APP_ID, IMPLICIT_COMPANY_ID, PIPELINE_FAILURE_TEXT_TOTAL_MAX, createCandidateManifest,
  type Check, type CheckRunner, type CiEvidenceSettings, type LatestCheck,
} from "@agentx/contracts";
import { parsePipelineReport } from "../../packages/worker/src/verification/pipeline-report-parser.js";
import { ARTIFACT_ZIP_BYTES_MAX, ZIP_REPORT_FILES_MAX, zipReports } from "../../packages/broker/src/core/ci-evidence/zip.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { registerMergeActionDecider, trackTask, type MergeTrackingDependencies } from "../../packages/broker/src/core/merge/merge-tracking.js";
import { installCiFixDecider, readCiEvidence, uninstallCiFixDecider } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { CLOCK, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

/** A zip of the given files (stored or deflated), with optional damage for the refusal cases. */
function zip(files: Array<{ name: string; text: string | Buffer; method?: 0 | 8; flags?: number; size?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.isBuffer(file.text) ? file.text : Buffer.from(file.text, "utf8");
    const method = file.method ?? 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(file.flags ?? 0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(file.size ?? raw.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(file.flags ?? 0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(file.size ?? raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const junit = (cases: Array<{ name: string; failure?: string; skipped?: boolean }>) => `<?xml version="1.0"?><testsuite name="s" tests="${String(cases.length)}">${cases.map((test) =>
  `<testcase classname="suite" name="${test.name}">${test.failure === undefined ? test.skipped === true ? "<skipped/>" : "" : `<failure message="${test.failure}">trace</failure>`}</testcase>`).join("")}</testsuite>`;

describe("reading an artifact zip", () => {
  it("reads stored and deflated report files and leaves everything else out", () => {
    const read = zipReports(zip([{ name: "junit/a.xml", text: "<a/>" }, { name: "b.JSON", text: "{}", method: 0 }, { name: "screenshot.png", text: "png" }, { name: "dir/", text: "" }]));
    expect(read).toEqual({ kind: "read", files: [{ name: "junit/a.xml", text: "<a/>" }, { name: "b.JSON", text: "{}" }] });
  });
  it.each([
    ["an encrypted entry", zip([{ name: "a.xml", text: "<a/>", flags: 1 }])],
    ["a size that disagrees", zip([{ name: "a.xml", text: "<a/>", size: 99 }])],
    ["text that is not UTF-8", zip([{ name: "a.xml", text: Buffer.from([0xff, 0xfe, 0x3c]) }])],
    ["too many report files", zip(Array.from({ length: ZIP_REPORT_FILES_MAX + 1 }, (_, index) => ({ name: `r${String(index)}.xml`, text: "<a/>" })))],
    ["a truncated archive", zip([{ name: "a.xml", text: "<a/>" }]).subarray(0, 40)],
    ["no archive at all", Buffer.from("not a zip at all, just some text long enough")],
    ["an archive past the size cap", Buffer.alloc(ARTIFACT_ZIP_BYTES_MAX + 1)],
  ])("refuses %s whole", (_label, bytes) => {
    expect(zipReports(bytes)).toEqual({ kind: "unreadable" });
  });
  it("refuses an unknown method and a zip64 marker", () => {
    const unknown = zip([{ name: "a.xml", text: "<a/>", method: 0 }]);
    const central = unknown.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    unknown.writeUInt16LE(12, central + 10);
    expect(zipReports(unknown)).toEqual({ kind: "unreadable" });
    const big = zip([{ name: "a.xml", text: "<a/>" }]);
    big.writeUInt16LE(0xffff, big.length - 22 + 10);
    expect(zipReports(big)).toEqual({ kind: "unreadable" });
  });
});

describe("the worker's report adapters as the port", () => {
  it("gives ids, outcomes and failure text paired with its own case", () => {
    expect(parsePipelineReport(junit([{ name: "ok" }, { name: "bad", failure: "expected 1 to be 2 &amp; more" }, { name: "skip", skipped: true }]))).toEqual({ tests: [
      { id: "suite::ok", outcome: "passed" }, { id: "suite::bad", outcome: "failed", failureText: "expected 1 to be 2 & more" }, { id: "suite::skip", outcome: "skipped" },
    ] });
  });
  it("never puts a failure text on the wrong test: cases it cannot pair give no text at all", () => {
    const text = junit([{ name: "a", failure: "real failure" }]).replace("<testcase", "<!-- <testcase classname=\"old\" name=\"gone\"><failure message=\"stale\"/></testcase> --><testcase");
    const read = parsePipelineReport(text);
    expect(read?.tests).toEqual([{ id: "suite::a", outcome: "failed" }]);
  });
  it("gives no report for text that is not one, and caps failure text in total", () => {
    expect(parsePipelineReport("{\"coverage\": 1}")).toBeUndefined();
    expect(parsePipelineReport("<?xml version=\"1.0\"?><testsuites><testsuite name=\"deploy\" tests=\"0\"/></testsuites>")).toEqual({ tests: [] });
    expect(parsePipelineReport("<coverage line-rate=\"1\"/>")).toBeUndefined();
    const many = parsePipelineReport(junit(Array.from({ length: 30 }, (_, index) => ({ name: `t${String(index)}`, failure: "x".repeat(1_500) }))));
    const texts = many!.tests.flatMap((test) => (test.failureText === undefined ? [] : [test.failureText]));
    expect(texts.join("").length).toBeLessThanOrEqual(PIPELINE_FAILURE_TEXT_TOTAL_MAX);
    expect(many!.tests.filter((test) => test.outcome === "failed")).toHaveLength(30);
  });
});

describe("the client's artifact read", () => {
  function client(routes: Record<string, (url: URL) => Response>) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const asked: string[] = [];
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github", appId: "5002502", getPrivateKey: async () => pem, now: () => CLOCK,
      fetchImplementation: (async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (/^\/repos\/[^/]+\/[^/]+\/installation$/u.test(url.pathname)) return new Response(JSON.stringify({ id: 1, account: { login: "acme" } }), { status: 200 });
        if (url.pathname.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "fake-token", expires_at: "2026-11-15T11:00:00Z" }), { status: 201 });
        asked.push(`${url.hostname}${url.pathname}`);
        const route = Object.entries(routes).find(([path]) => `${url.hostname}${url.pathname}` === path);
        return route === undefined ? new Response("{}", { status: 404 }) : route[1](url);
      }) as typeof fetch,
    });
    return { provider, asked };
  }
  const API = "api.github.com/repos/acme/svc";
  const BLOB = "productionresultssa3.blob.core.windows.net";
  const list = (artifacts: unknown[]) => () => new Response(JSON.stringify({ total_count: artifacts.length, artifacts }), { status: 200 });
  const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
  const ORG = { orgId: IMPLICIT_COMPANY_ID };
  it("reads only test-result artifacts, through GitHub's storage, with no credentials", async () => {
    const { provider, asked } = client({
      [`${API}/actions/runs/9/artifacts`]: list([{ id: 1, name: "junit-results", expired: false, size_in_bytes: 100 }, { id: 2, name: "screenshots", expired: false, size_in_bytes: 100 }, { id: 3, name: "test-results-old", expired: true, size_in_bytes: 1 }]),
      [`${API}/actions/artifacts/1/zip`]: redirect(`https://${BLOB}/a/b.zip?sig=x`),
      [`${BLOB}/a/b.zip`]: () => new Response(zip([{ name: "report.xml", text: "<x/>" }]), { status: 200 }),
    });
    expect(await provider.getRunReportFiles("https://github.com/acme/svc", "9", ORG)).toEqual({ kind: "read", files: [{ name: "report.xml", text: "<x/>" }] });
    expect(asked.some((path) => path.includes("/artifacts/2/") || path.includes("/artifacts/3/"))).toBe(false);
  });
  it("says none for a run with no such artifact, and unreadable for one sent elsewhere or too large", async () => {
    expect(await client({ [`${API}/actions/runs/9/artifacts`]: list([{ id: 2, name: "screenshots", size_in_bytes: 1 }]) }).provider.getRunReportFiles("https://github.com/acme/svc", "9", ORG)).toEqual({ kind: "none" });
    const elsewhere = client({ [`${API}/actions/runs/9/artifacts`]: list([{ id: 1, name: "junit", size_in_bytes: 1 }]), [`${API}/actions/artifacts/1/zip`]: redirect("https://evil.example/x.zip") });
    expect(await elsewhere.provider.getRunReportFiles("https://github.com/acme/svc", "9", ORG)).toEqual({ kind: "unreadable" });
    expect(elsewhere.asked.some((path) => path.startsWith("evil.example"))).toBe(false);
    const large = client({ [`${API}/actions/runs/9/artifacts`]: list([{ id: 1, name: "junit", size_in_bytes: ARTIFACT_ZIP_BYTES_MAX + 1 }]) });
    expect(await large.provider.getRunReportFiles("https://github.com/acme/svc", "9", ORG)).toEqual({ kind: "unreadable" });
    const cut = client({ [`${API}/actions/runs/9/artifacts`]: () => new Response(JSON.stringify({ total_count: 200, artifacts: [] }), { status: 200 }) });
    expect(await cut.provider.getRunReportFiles("https://github.com/acme/svc", "9", ORG)).toEqual({ kind: "unreadable" });
    await expect(cut.provider.getRunReportFiles("https://github.com/acme/svc", "../9", ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

// ---- in a tracking pass

const MIN = 60_000;
const BASE = "e".repeat(40);
const MARKED = { name: "e2e-real", calledAs: "real model", longOrPaid: true };
const settings = (over: Partial<CiEvidenceSettings> = {}): CiEvidenceSettings => ({ ...DEFAULT_CI_EVIDENCE_SETTINGS, markedChecks: [MARKED], ...over });
const unit: Check = { name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" };
const e2e = (over: Partial<Check> = {}): Check => ({ name: "e2e-real", state: "completed", conclusion: "success", required: false, url: "https://github.com/acme/app/actions/runs/5/job/77", runId: "77", source: String(GITHUB_ACTIONS_APP_ID), logReadable: true, ...over });

interface Fake { reports: Record<string, string[]>; reads: string[]; base?: LatestCheck | undefined; attempt?: number }
async function world(answer: unknown, fake: Fake): Promise<{ w: MergeWorld; deps: MergeTrackingDependencies }> {
  const w = await mergeWorld();
  const at = new Date(CLOCK).toISOString();
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: w.prs[0]!.head, treeSha: "b".repeat(40), baseCommitSha: BASE }]);
  const current = (await w.task()).workflow;
  await w.setWorkflow({
    ownerId: "a".repeat(64), createdAt: at, artifacts: [], decisions: [], candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: (current.pullRequests ?? []).map((pr) => ({ ...pr, candidateDigest: candidate.digest })),
  });
  const runner: Partial<CheckRunner> = {
    kind: "github-actions", capabilities: { listByChangeRequest: true, listByRevision: false, logTail: true, start: false, rerun: false },
    listChecks: async () => [], logTail: async () => "a log that must never be read",
    // The head's run belongs to workflow run "head-<runId>"; the base's run to "base".
    runFacts: async (target, check) => ({ attempt: target.kind === "revision" ? 1 : fake.attempt ?? 1, workflowRunId: target.kind === "revision" ? "500" : `${check.runId ?? "0"}00` }),
    latestCheck: async () => fake.base,
    reportFiles: async (_repository, runId) => { fake.reads.push(runId); const texts = fake.reports[runId]; return texts === undefined ? { kind: "none" } : { kind: "read", files: texts.map((text, index) => ({ name: `r${String(index)}.xml`, text })) }; },
  };
  const deps: MergeTrackingDependencies = {
    ...w.tracking, ciEvidence: () => answer, autonomy: () => "run", reportParser: parsePipelineReport,
    repository: async (...args) => { const home = await w.tracking.repository(...args); return home === undefined ? undefined : { ...home, checkRunner: runner as CheckRunner }; },
  };
  return { w, deps };
}
const setChecks = (w: MergeWorld, checks: Check[]) => w.prs[0]!.model.setChecks(w.prs[0]!.head, checks);
const comments = (w: MergeWorld) => w.prs[0]!.model.changeRequests[0]!.comments.map((comment) => comment.body.split("\n")[0]);
const entry = async (w: MergeWorld) => ((await w.trackingOf(w.prs[0]!)) as { ciMarked?: Array<Record<string, unknown>> }).ciMarked?.[0];

beforeEach(() => installCiFixDecider(registerMergeActionDecider));
afterEach(() => uninstallCiFixDecider());

describe("per-test reports in a tracking pass", () => {
  it("says the counts and the change proof: a test that failed on the base run and passes now; an added test is not proof", async () => {
    const fake: Fake = {
      reports: { "7700": [junit([{ name: "fixed" }, { name: "same" }, { name: "new" }])], "500": [junit([{ name: "fixed", failure: "broken" }, { name: "same" }])] }, reads: [],
      base: { revision: BASE, check: e2e({ runId: "55" }) },
    };
    const { w, deps } = await world(settings(), fake);
    setChecks(w, [unit, e2e()]);
    await trackTask(deps, TASK_ID);
    expect(await entry(w)).toMatchObject({ state: "passed", report: "read", counts: { passed: 3, failed: 0, skipped: 0 }, proven: 1, added: 1 });
    expect(comments(w)[0]).toContain("3 passed, 0 failed, 1 proven (failed on the base run)");
    // Read once per run.
    w.now.value += MIN;
    await trackTask(deps, TASK_ID);
    expect(fake.reads).toEqual(["7700", "500"]);
  });
  it("proves nothing when the base run is for another commit", async () => {
    const fake: Fake = { reports: { "7700": [junit([{ name: "fixed" }])], "500": [junit([{ name: "fixed", failure: "broken" }])] }, reads: [], base: { revision: "c".repeat(40), check: e2e({ runId: "55" }) } };
    const { w, deps } = await world(settings(), fake);
    setChecks(w, [unit, e2e()]);
    await trackTask(deps, TASK_ID);
    expect((await entry(w))?.["proven"]).toBeUndefined();
  });
  it("fixes from the report's failure text when logs are off, and never reads the log", async () => {
    const fake: Fake = { reports: { "7700": [junit([{ name: "ok" }, { name: "bad", failure: "expected 1 to be 2" }])] }, reads: [], base: { revision: "c".repeat(40), check: e2e() } };
    const { w, deps } = await world(settings(), fake);
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    const workflow = (await w.task()).workflow;
    expect(workflow.stage).toBe("IMPLEMENT");
    const block = await readCiEvidence(w.store, TASK_ID, IMPLICIT_COMPANY_ID, workflow.revision);
    expect(block).toContain("suite::bad: expected 1 to be 2");
    expect(block).not.toContain("a log that must never be read");
  });
  it("calls a run whose report has no tests the environment, and a report with no failed test a question", async () => {
    const empty: Fake = { reports: { "7700": ["<testsuite name=\"s\" tests=\"0\"></testsuite>"] }, reads: [], base: undefined };
    const first = await world(settings(), empty);
    setChecks(first.w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(first.deps, TASK_ID);
    expect((await first.w.task()).workflow.blockReason).toMatch(new RegExp(`^${CI_EVIDENCE_ENVIRONMENT_PREFIX}e2e-real failed before any test ran`, "u"));
    const green: Fake = { reports: { "7700": [junit([{ name: "ok" }])] }, reads: [], base: undefined };
    const second = await world(settings(), green);
    setChecks(second.w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(second.deps, TASK_ID);
    expect((await second.w.task()).workflow.blockReason).toMatch(new RegExp(`^${CI_EVIDENCE_ASK_PREFIX}e2e-real failed without saying which test failed`, "u"));
  });
  it("keeps a flaky history: a test that failed on an earlier run of this head and passes on the re-run", async () => {
    const fake: Fake = { reports: { "7700": [junit([{ name: "wobbly", failure: "timeout" }])], "7800": [junit([{ name: "wobbly" }])] }, reads: [], base: { revision: "c".repeat(40), check: e2e() } };
    const { w, deps } = await world(settings(), fake);
    await w.setWorkflow({ fixRounds: { ci: 2, conflict: 0, feedbackAuto: 0 } });
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    fake.attempt = 2;
    setChecks(w, [unit, e2e({ runId: "78" })]);
    w.now.value += MIN;
    await trackTask(deps, TASK_ID);
    expect(await entry(w)).toMatchObject({ state: "passed", attempt: 2, flaky: ["suite::wobbly"] });
    expect(comments(w).at(-1)).toContain("passed on run 2");
    expect(comments(w).at(-1)).toContain("1 flaky (failed on an earlier run)");
  });
  it("reads no report when the customer turned per-test reports off, or the host gave no parser", async () => {
    const fake: Fake = { reports: { "7700": [junit([{ name: "ok" }])] }, reads: [] };
    const off = await world(settings({ perTestReports: false }), fake);
    setChecks(off.w, [unit, e2e()]);
    await trackTask(off.deps, TASK_ID);
    const none = await world(settings(), fake);
    setChecks(none.w, [unit, e2e()]);
    const { reportParser: _parser, ...withoutParser } = none.deps;
    void _parser;
    await trackTask(withoutParser, TASK_ID);
    expect(fake.reads).toEqual([]);
    expect((await entry(none.w))?.["report"]).toBeUndefined();
  });
  it("says unreadable for a parser that throws, never a guess", async () => {
    const fake: Fake = { reports: { "7700": [junit([{ name: "ok" }])] }, reads: [] };
    const { w, deps } = await world(settings(), fake);
    setChecks(w, [unit, e2e()]);
    await trackTask({ ...deps, reportParser: () => { throw new Error("boom"); } }, TASK_ID);
    expect(await entry(w)).toMatchObject({ report: "unreadable" });
    expect((await entry(w))?.["counts"]).toBeUndefined();
  });
});
