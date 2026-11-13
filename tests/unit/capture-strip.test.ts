// The screenshot strip of a case (one frame at the end of each step), `screenshots: failed|all`, and its pairing before (baseline) and after (candidate).
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2ECapturePolicySchema, E2EPolicySchema, EVIDENCE_ARTIFACT_RETENTION, EvidencePackSchema, type CheckEntry, type EvidenceEnvironment } from "../../packages/contracts/src/index.js";
import { CAPTURE_ARTIFACTS_FILE, CAPTURE_DIR, CAPTURE_STRIP_MAX_FRAMES, admittedCapturePolicy, captureStripFileName, createCaptureRecorder, encodedBytes, finalizeCaptureArtifacts, stripStepIndexes } from "../../packages/verifier/src/executor/capture.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { snapshotExecutorOutput } from "../../packages/verifier/src/host/executor-readback.js";
import { finishWebStepCapture } from "../../packages/verifier/src/web-runtime.js";
import { buildEvidencePack } from "../../packages/core/src/core/proof/evidence-pack.js";
import { browserEvidenceOf, pairStrips, readCaptureStrips, scenarioStripsOf } from "../../packages/core/src/e2e/capture-strips.js";
import { readCaptureScreenshots } from "../../packages/core/src/e2e/application-display.js";
import { fitGroupEvidence, type OperatorEvidence } from "../../packages/worker/src/workflow-e2e-application-checks.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), "strip-test-"))); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const PASSWORD = "planted-Password-7f3a91c2d4e8b0aa";
const EMAIL = "rovara-orders-owner-ab12cd@example.test";
const redactor = () => createCredentialRedactor([{ profileId: "orders-owner", email: EMAIL, password: PASSWORD }]);
const jpeg = (size: number, fill = 0x41) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
const ALL = { screenshots: true, mode: "all" as const };
const FAILED = { screenshots: true };
const caseIds = ["case-a", "case-b"];

describe("which steps get a frame", () => {
  it("is every step up to six, and six spread across more with the first and last kept", () => {
    expect(stripStepIndexes(1)).toEqual([0]);
    expect(stripStepIndexes(4)).toEqual([0, 1, 2, 3]);
    expect(stripStepIndexes(6)).toEqual([0, 1, 2, 3, 4, 5]);
    const spread = stripStepIndexes(30);
    expect(spread).toHaveLength(CAPTURE_STRIP_MAX_FRAMES);
    expect(spread[0]).toBe(0);
    expect(spread.at(-1)).toBe(29);
    expect(spread).toEqual([...spread].sort((a, b) => a - b));
    expect(new Set(spread).size).toBe(spread.length);
  });
  it("depends on the step count alone, so the baseline and the candidate pick the same steps", () => {
    expect(stripStepIndexes(17)).toEqual(stripStepIndexes(17));
  });
  it("is nothing for no steps or a bad count", () => {
    expect(stripStepIndexes(0)).toEqual([]);
    expect(stripStepIndexes(-3)).toEqual([]);
    expect(stripStepIndexes(2.5)).toEqual([]);
  });
});

describe("the admitted policy", () => {
  it("reads screenshotMode all as a strip only while screenshots are on", () => {
    expect(admittedCapturePolicy({ screenshots: true, traces: false, screenshotMode: "all" })).toEqual({ screenshots: true, mode: "all" });
    expect(admittedCapturePolicy({ screenshots: true, traces: false, screenshotMode: "failed" })).toEqual({ screenshots: true });
    expect(admittedCapturePolicy({ screenshots: true, traces: false })).toEqual({ screenshots: true });
    expect(admittedCapturePolicy({ screenshots: false, traces: false, screenshotMode: "all" })).toEqual({ screenshots: false });
  });
  it("still refuses traces whatever the mode", () => {
    expect(() => admittedCapturePolicy({ screenshots: true, traces: true, screenshotMode: "all" })).toThrow(/trace capture is not supported/);
  });
  it("adds an optional field to the contract: a policy without it parses and hashes as before", () => {
    const old = { screenshots: true, traces: false, video: false, downloads: true };
    expect(E2ECapturePolicySchema.parse(old)).toEqual(old);
    expect(E2ECapturePolicySchema.parse({ ...old, screenshotMode: "all" }).screenshotMode).toBe("all");
    expect(E2ECapturePolicySchema.safeParse({ ...old, screenshotMode: "every" }).success).toBe(false);
    expect(E2EPolicySchema.shape.capture).toBe(E2ECapturePolicySchema);
  });
});

describe("the recorder's strip frames", () => {
  it("writes one file a step, named by case and step, and lists each with its step", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ALL, caseIds, redactor: redactor() });
    expect(recorder.stripEnabled()).toBe(true);
    const first = await recorder.record({ caseId: "case-b", kind: "screenshot", bytes: jpeg(500), step: 0 });
    expect(first).toMatchObject({ caseId: "case-b", step: 0 });
    expect(first?.omitted).toBeUndefined();
    await recorder.record({ caseId: "case-b", kind: "screenshot", bytes: jpeg(600), step: 3 });
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries").sort()).toEqual([captureStripFileName(1, 0), captureStripFileName(1, 3)]);
  });
  it("takes no strip frame in failed mode, and still takes the screenshot of a failed case", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: FAILED, caseIds, redactor: redactor() });
    expect(recorder.stripEnabled()).toBe(false);
    expect(await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(500), step: 0 })).toBeNull();
    expect(await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(500) })).toMatchObject({ caseId: "case-a" });
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries")).toEqual(["case-0-screenshot.jpg"]);
  });
  it("takes nothing with screenshots off, and refuses a step that is not a declared index", async () => {
    const off = createCaptureRecorder({ root: await temp(), policy: { screenshots: false }, caseIds, redactor: redactor() });
    expect(await off.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(500), step: 0 })).toBeNull();
    const on = createCaptureRecorder({ root: await temp(), policy: ALL, caseIds, redactor: redactor() });
    for (const step of [-1, 1.5, 10_000]) await expect(on.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(500), step })).rejects.toThrow(/declared step/);
  });
  it("keeps at most six frames a case: the seventh is a recorded drop with no file", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ALL, caseIds, redactor: redactor() });
    const entries = [];
    for (let step = 0; step < 8; step += 1) entries.push(await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(500, 0x41 + step), step }));
    expect(entries.filter((entry) => entry?.omitted === undefined)).toHaveLength(6);
    expect(entries.slice(6).map((entry) => entry?.omitted)).toEqual(["budget", "budget"]);
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries")).toHaveLength(6);
  });
  it("drops a frame that carries an account credential, in any spelling, and keeps no file for it", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ALL, caseIds, redactor: redactor() });
    const dirty = Buffer.concat([jpeg(100), Buffer.from(`Y${Buffer.from(`ab:${PASSWORD}`).toString("base64")}`)]);
    expect(await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: dirty, step: 1 })).toMatchObject({ omitted: "credential-match", step: 1 });
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries")).toEqual([]);
  });
  it("drops a frame over the file cap", async () => {
    const recorder = createCaptureRecorder({ root: await temp(), policy: ALL, caseIds, redactor: redactor() });
    expect(await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(524_289), step: 0 })).toMatchObject({ omitted: "budget" });
  });
});

describe("settling a group's captures", () => {
  async function runWith(policy: { screenshots: boolean; mode?: "all" }, frames: Array<{ caseId: string; step?: number; size: number }>, budgetBytes?: number) {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy, caseIds, redactor: redactor() });
    let fill = 0x30;
    for (const frame of frames) { fill += 1; await recorder.record({ caseId: frame.caseId, kind: "screenshot", bytes: jpeg(frame.size, fill), ...(frame.step === undefined ? {} : { step: frame.step }) }); }
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy, caseIds, redactor: redactor(), ...(budgetBytes === undefined ? {} : { budgetBytes }) });
    return { root, entries };
  }
  it("lists frames in case then step order, the failed case's own screenshot after its steps", async () => {
    const { entries, root } = await runWith(ALL, [{ caseId: "case-b", size: 300 }, { caseId: "case-a", step: 2, size: 300 }, { caseId: "case-a", step: 0, size: 300 }, { caseId: "case-a", size: 300 }]);
    expect(entries.map((entry) => [entry.caseId, entry.step])).toEqual([["case-a", 0], ["case-a", 2], ["case-a", undefined], ["case-b", undefined]]);
    const listing = JSON.parse(await readFile(join(root, CAPTURE_ARTIFACTS_FILE), "utf8")) as { artifacts: Array<{ step?: number }> };
    expect(listing.artifacts.map((entry) => entry.step)).toEqual([0, 2, undefined, undefined]);
  });
  it("sheds strip frames before the screenshot of a failed case when the budget is short", async () => {
    // One 3000-byte failed screenshot and three 2000-byte frames; room for only the failed screenshot and one frame.
    const budget = encodedBytes(3000) + encodedBytes(2000);
    const { entries, root } = await runWith(ALL, [{ caseId: "case-a", size: 3000 }, { caseId: "case-a", step: 0, size: 2000 }, { caseId: "case-a", step: 1, size: 2000 }, { caseId: "case-a", step: 2, size: 2000 }], budget);
    const kept = entries.filter((entry) => entry.omitted === undefined);
    expect(kept.map((entry) => entry.step)).toContain(undefined);
    expect(entries.filter((entry) => entry.step !== undefined && entry.omitted === "budget")).toHaveLength(2);
    expect((await readdir(join(root, CAPTURE_DIR))).sort()).toHaveLength(2);
  });
  it("removes a strip frame file when the strip is not admitted, whoever put it there", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ALL, caseIds, redactor: redactor() });
    await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(500), step: 0 });
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: FAILED, caseIds, redactor: redactor() });
    expect(entries).toEqual([]);
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries")).toEqual([]);
  });
  it("drops a frame that now carries a credential and lists it as dropped, with its step", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ALL, caseIds, redactor: createCredentialRedactor([]) });
    await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: Buffer.concat([jpeg(100), Buffer.from(PASSWORD)]), step: 4 });
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ALL, caseIds, redactor: redactor() });
    expect(entries).toMatchObject([{ caseId: "case-a", step: 4, omitted: "credential-match" }]);
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries")).toEqual([]);
  });
  it("keeps only six planted frames for a case and records the rest as budget drops", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ALL, caseIds, redactor: redactor() });
    for (let step = 0; step < 6; step += 1) await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(300, 0x50 + step), step });
    await writeFile(join(root, CAPTURE_DIR, captureStripFileName(0, 9)), jpeg(300, 0x70));
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ALL, caseIds, redactor: redactor() });
    expect(entries.filter((entry) => entry.omitted === undefined)).toHaveLength(6);
    expect(entries.find((entry) => entry.step === 9)).toMatchObject({ omitted: "budget" });
  });
});

describe("the web step hook", () => {
  const page = (bytes: Buffer | Error) => ({ screenshot: async () => { if (bytes instanceof Error) throw bytes; return bytes; } }) as never;
  const ports = (record: (input: unknown) => Promise<unknown>, mode?: "all") => ({ screenshots: true, ...(mode === undefined ? {} : { mode }), record }) as never;
  it("takes a frame at a picked step in mode all, naming the step", async () => {
    const seen: unknown[] = [];
    await finishWebStepCapture({ capture: ports(async (input) => { seen.push(input); }, "all"), caseId: "case-a", stepIndex: 2, stepCount: 4, page: page(jpeg(300)) });
    expect(seen).toEqual([{ caseId: "case-a", kind: "screenshot", bytes: Uint8Array.from(jpeg(300)), step: 2 }]);
  });
  it("takes none in failed mode, with no capture port, with no page, or at a step the strip skips", async () => {
    const seen: unknown[] = [];
    const record = async (input: unknown) => { seen.push(input); };
    await finishWebStepCapture({ capture: ports(record), caseId: "case-a", stepIndex: 0, stepCount: 4, page: page(jpeg(300)) });
    await finishWebStepCapture({ capture: undefined, caseId: "case-a", stepIndex: 0, stepCount: 4, page: page(jpeg(300)) });
    await finishWebStepCapture({ capture: ports(record, "all"), caseId: "case-a", stepIndex: 0, stepCount: 4, page: null });
    await finishWebStepCapture({ capture: ports(record, "all"), caseId: "case-a", stepIndex: 1, stepCount: 30, page: page(jpeg(300)) });
    expect(seen).toEqual([]);
  });
  it("absorbs a page that cannot be photographed and a recorder that refuses", async () => {
    await expect(finishWebStepCapture({ capture: ports(async () => undefined, "all"), caseId: "case-a", stepIndex: 0, stepCount: 1, page: page(new Error("page crashed")) })).resolves.toBeUndefined();
    await expect(finishWebStepCapture({ capture: ports(async () => { throw new Error("budget"); }, "all"), caseId: "case-a", stepIndex: 0, stepCount: 1, page: page(jpeg(300)) })).resolves.toBeUndefined();
  });
});

describe("the broker reads strip frames back", () => {
  const frame = (step: number, fill: number, size = 400) => { const data = jpeg(size, fill); return { step, data, sha: sha(data) }; };
  const evidenceOf = (frames: Array<{ caseId: string; step?: number; data: Buffer; name?: string }>, extra: Record<string, unknown> = {}) => ({
    captures: {
      artifacts: frames.map((item) => ({ caseId: item.caseId, kind: "screenshot", sha256: sha(item.data), bytes: item.data.byteLength, ...(item.step === undefined ? {} : { step: item.step }), ...extra })),
      files: frames.map((item) => ({ name: item.name ?? (item.step === undefined ? "case-0-screenshot.jpg" : `case-0-step-${item.step}-screenshot.jpg`), sha256: sha(item.data), bytes: item.data.byteLength, base64: item.data.toString("base64") })),
    },
  });
  const ids = new Set(["case-a"]);
  it("returns each case's frames in step order, checked against their listed size and digest", () => {
    const a = frame(2, 1); const b = frame(0, 2);
    const strips = readCaptureStrips(evidenceOf([{ caseId: "case-a", step: 2, data: a.data }, { caseId: "case-a", step: 0, data: b.data }]), ids);
    expect(strips.get("case-a")?.map((item) => item.step)).toEqual([0, 2]);
    expect(strips.get("case-a")?.[0]?.sha256).toBe(b.sha);
  });
  it("ignores a dropped frame, a foreign case, a frame whose bytes differ from the listing, a file that is no JPEG, and a duplicate step", () => {
    const good = frame(0, 3); const other = frame(1, 4); const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]);
    expect(readCaptureStrips(evidenceOf([{ caseId: "case-a", step: 0, data: good.data }], { omitted: "budget" }), ids).size).toBe(0);
    expect(readCaptureStrips(evidenceOf([{ caseId: "case-z", step: 0, data: good.data }]), ids).size).toBe(0);
    const tampered = evidenceOf([{ caseId: "case-a", step: 0, data: good.data }]);
    tampered.captures.files[0]!.base64 = other.data.toString("base64");
    expect(readCaptureStrips(tampered, ids).size).toBe(0);
    expect(readCaptureStrips(evidenceOf([{ caseId: "case-a", step: 0, data: png }]), ids).size).toBe(0);
    expect(readCaptureStrips(evidenceOf([{ caseId: "case-a", step: 0, data: good.data }, { caseId: "case-a", step: 0, data: other.data, name: "case-0-step-0-screenshot.jpg" }]), ids).get("case-a")).toHaveLength(1);
  });
  it("refuses a file named for another step than its listing and a name that is not a strip frame's", () => {
    const good = frame(1, 5);
    expect(readCaptureStrips(evidenceOf([{ caseId: "case-a", step: 1, data: good.data, name: "case-0-step-2-screenshot.jpg" }]), ids).size).toBe(0);
    expect(readCaptureStrips(evidenceOf([{ caseId: "case-a", step: 1, data: good.data, name: "../etc/passwd" }]), ids).size).toBe(0);
  });
  it("keeps at most six frames a case", () => {
    const frames = Array.from({ length: 9 }, (_, step) => ({ caseId: "case-a", step, data: jpeg(300, 0x10 + step) }));
    expect(readCaptureStrips(evidenceOf(frames), ids).get("case-a")).toHaveLength(6);
  });
  it("is not what the failed-case screenshot reader keeps: a strip frame is never taken for the failed case's screenshot", () => {
    const f = frame(0, 6);
    expect(readCaptureScreenshots(evidenceOf([{ caseId: "case-a", step: 0, data: f.data }]), ids).size).toBe(0);
    const failed = frame(0, 7);
    const mixed = evidenceOf([{ caseId: "case-a", step: 0, data: f.data }, { caseId: "case-a", data: failed.data }]);
    expect(readCaptureScreenshots(mixed, ids).get("case-a")?.sha256).toBe(failed.sha);
  });
  it("is nothing for evidence of the wrong shape", () => {
    for (const value of [undefined, null, 3, "x", {}, { captures: null }, { captures: { artifacts: 1, files: [] } }]) expect(readCaptureStrips(value, ids).size).toBe(0);
  });
});

describe("pairing the baseline's strip with the candidate's", () => {
  const f = (step: number, fill: number) => { const data = new Uint8Array(jpeg(300, fill)); return { step, data, sha256: sha(data) }; };
  it("puts the same steps side by side, and leaves out a step only one side has", () => {
    const paired = pairStrips({ before: [f(0, 1), f(1, 2), f(3, 3)], after: [f(1, 12), f(2, 13), f(3, 14), f(0, 11)] });
    expect(paired.before.map((item) => item.step)).toEqual([0, 1, 3]);
    expect(paired.after.map((item) => item.step)).toEqual([0, 1, 3]);
  });
  it("has no before frames with no baseline, and keeps every after frame", () => {
    expect(pairStrips({ before: undefined, after: [f(0, 1), f(1, 2)] })).toMatchObject({ before: [], after: [{ step: 0 }, { step: 1 }] });
    expect(pairStrips({ before: [], after: [f(0, 1)] }).before).toEqual([]);
  });
  it("falls back to the unpaired form when the two share no step", () => {
    const paired = pairStrips({ before: [f(5, 1)], after: [f(0, 2), f(1, 3)] });
    expect(paired.before).toEqual([]);
    expect(paired.after).toHaveLength(2);
  });
  it("builds the pack's browser rows by approved scenario id, one row a scenario, one stored artifact a distinct frame", () => {
    const shared = f(0, 9);
    const candidate = scenarioStripsOf([{ cases: [{ caseId: "c2", scenarioId: "checkout" }, { caseId: "c1", scenarioId: "checkout" }, { caseId: "c3", scenarioId: "login" }], strips: new Map([["c2", [f(0, 21)]], ["c1", [shared, f(1, 22)]], ["c3", [f(0, 23)]]]) }]);
    expect(candidate.map((item) => [item.scenarioId, item.frames.length])).toEqual([["checkout", 2], ["login", 1]]);
    const baseline = scenarioStripsOf([{ cases: [{ caseId: "b1", scenarioId: "checkout" }], strips: new Map([["b1", [shared, f(1, 31)]]]) }]);
    const built = browserEvidenceOf({ candidate, baseline });
    expect(built.browser.map((row) => row.scenarioId)).toEqual(["checkout", "login"]);
    expect(built.browser[0]?.strip.before.map((ref) => ref.sha256)).toEqual([shared.sha256, sha(new Uint8Array(jpeg(300, 31)))]);
    expect(built.browser[0]?.strip.after).toHaveLength(2);
    expect(built.browser[1]?.strip).toEqual({ before: [], after: [expect.objectContaining({ kind: "jpeg" })] });
    // The shared frame is one stored artifact, though it is in both strips.
    expect(built.artifacts.filter((item) => item.ref.sha256 === shared.sha256)).toHaveLength(1);
    expect(built.artifacts.every((item) => item.ref.retentionClass === EVIDENCE_ARTIFACT_RETENTION.jpeg)).toBe(true);
  });
  it("makes rows the evidence pack accepts, and the pack drops a frame the store does not hold", () => {
    const candidate = scenarioStripsOf([{ cases: [{ caseId: "c1", scenarioId: "checkout" }], strips: new Map([["c1", [f(0, 41), f(1, 42)]]]) }]);
    const built = browserEvidenceOf({ candidate });
    const DIGEST = "c".repeat(64);
    const environment: EvidenceEnvironment = { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [{ profileId: "buyer", kind: "run_scoped" }] };
    const checks: CheckEntry[] = [];
    const common = { candidateDigest: DIGEST, checks, environment, rawText: JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [], browser: built.browser }) };
    const whole = buildEvidencePack({ ...common, storedArtifacts: new Map(built.artifacts.map((item) => [item.ref.sha256, { kind: item.ref.kind, bytes: item.ref.bytes }])) });
    expect(whole.problems).toEqual([]);
    expect(EvidencePackSchema.safeParse(whole.pack).success).toBe(true);
    expect(whole.pack?.browser[0]?.strip.after).toHaveLength(2);
    const missing = buildEvidencePack({ ...common, storedArtifacts: new Map() });
    expect(missing.problems).toContain("artifact_missing");
    expect(missing.pack?.browser[0]?.strip.after).toEqual([]);
  });
});

describe("shedding a group's evidence", () => {
  it("drops strip frame files before the screenshot of a failed case", () => {
    const file = (name: string, bytes: number) => ({ name, sha256: sha(Buffer.from(name)), bytes, base64: "A".repeat(bytes) });
    const files = [file("case-0-screenshot.jpg", 3000), file("case-0-step-0-screenshot.jpg", 1000), file("case-0-step-1-screenshot.jpg", 1000)];
    const whole: OperatorEvidence = { notice: "n", rawReportIn: null, observationsIn: null, observations: [], executorLogHead: null,
      captures: { artifacts: files.map((item) => ({ caseId: "case-a", kind: "screenshot" as const, sha256: item.sha256, bytes: item.bytes })), files } };
    const build = (operator: OperatorEvidence | null) => Buffer.from(JSON.stringify({ operator }));
    const shed = { ...whole, captures: { artifacts: whole.captures!.artifacts.map((item, index) => (index === 0 ? item : { ...item, omitted: "budget" as const })), files: [files[0]!] } };
    const result = fitGroupEvidence({ limit: build(shed).byteLength, whole, build });
    expect(result).not.toBeNull();
    const kept = result!.operator!.captures!.files.map((item) => item.name);
    expect(kept).toContain("case-0-screenshot.jpg");
    expect(kept.some((name) => name.includes("-step-"))).toBe(false);
    expect(result!.operator!.captures!.artifacts.filter((item) => item.omitted === "budget")).toHaveLength(2);
  });
});

describe("the host reads strip frames back from the executor's out directory", () => {
  const result = { schemaVersion: "e2e-executor-result/v1", exitCode: 0, reason: null, startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:01:00.000Z",
    node: { version: "v22.23.2", execPath: "/usr/local/bin/node", platform: "linux", arch: "arm64" }, runId: "r", groupId: "g", shards: [] } as never;
  it("hands on a strip frame with its name and step, and holds back one that carries a credential", async () => {
    const out = await temp();
    await mkdir(join(out, "observations"), { recursive: true });
    await mkdir(join(out, CAPTURE_DIR), { recursive: true });
    const clean = jpeg(2_000, 0x61); const dirty = Buffer.concat([jpeg(100), Buffer.from(PASSWORD)]);
    await writeFile(join(out, CAPTURE_DIR, "case-0-step-1-screenshot.jpg"), clean);
    await writeFile(join(out, CAPTURE_DIR, "case-0-step-2-screenshot.jpg"), dirty);
    const entry = (bytes: Buffer, step: number) => ({ caseId: "case-a", kind: "screenshot", sha256: sha(bytes), bytes: bytes.byteLength, step });
    await writeFile(join(out, CAPTURE_ARTIFACTS_FILE), JSON.stringify({ schemaVersion: "e2e-executor-artifacts/v1", artifacts: [entry(clean, 1), entry(dirty, 2)] }));
    const snapshot = await snapshotExecutorOutput(out, result, { containsCredential: (bytes) => redactor().contains(bytes) });
    const captures = snapshot.executorEvidence.captures!;
    expect(captures.files.map((file) => file.name)).toEqual(["case-0-step-1-screenshot.jpg"]);
    expect(captures.artifacts).toMatchObject([{ step: 1 }, { step: 2, omitted: "credential-match" }]);
  });
});
