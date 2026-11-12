// SageMaker recordings (SM5): what Rovara does with an uploaded recording file. It does not trust the recorder's scan: the file is read against the format and every request and answer is scanned again, with the
// personal-data scanner and the synthetic-data guard. A finding refuses the file with a kind and a field, never the text. Every personal-looking value is fake, and key-shaped values are built at runtime.
import { describe, expect, it } from "vitest";
import {
  SAGEMAKER_RECORDING_MAX_BYTES, SageMakerRecordingFileSchema, builtinPiiScanner, rescanSageMakerRecording, sageMakerFixtureDigest, sageMakerRecordingSamples, type PiiScanner, type SageMakerRecordingFile,
} from "../../packages/contracts/src/index.js";
import { SAGEMAKER_INTAKE_REFUSAL_WORDS, intakeSageMakerRecording } from "../../packages/broker/src/core/test-env/sagemaker-recording-intake.js";

const DENY = { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] };
const EMAIL = "pat.quill@fakemail-sample.io";

function file(over: Record<string, unknown> = {}): SageMakerRecordingFile {
  return SageMakerRecordingFileSchema.parse({
    format: "rovara-sagemaker-recording", version: 1, endpointName: "fraud-scorer", recordedAt: "2026-11-20T10:00:00.000Z", recorder: { name: "rovara record sagemaker", version: "1.2.3" },
    scan: { scanners: ["builtin-1"], policy: "refuse", requests: 2, answers: 2, redactions: 0, open: 0 }, pairs: 2,
    fixtures: {
      mode: "canned", source: "recorded", recordedOn: "2026-11-20",
      rules: [
        { match: { operation: "invoke", contentType: "application/json", bodyEquals: "{\"amount\":10}" }, response: { body: "{\"score\":0.2}", contentType: "application/json" } },
        { match: { operation: "invoke", contentType: "application/json", bodySha256: "a".repeat(64) }, response: { error: { code: "ModelError", originalStatusCode: 500 } } },
      ],
    },
    ...over,
  });
}
const upload = (value: unknown) => intakeSageMakerRecording(JSON.stringify(value), DENY);
const withAnswer = (body: string) => { const base = file(); return { ...base, fixtures: { ...base.fixtures, rules: [{ ...base.fixtures.rules![0]!, response: { body, contentType: "application/json" } }, base.fixtures.rules![1]!] } }; };

describe("an upload that is clean", () => {
  it("is accepted, with the document the front serves, its pinned digest and the first pairs for a person to confirm", async () => {
    const result = await upload(file());
    expect(result).toMatchObject({ ok: true, digest: sageMakerFixtureDigest(file().fixtures), binaryBodies: 0 });
    if (!result.ok) throw new Error("not accepted");
    expect(result.document).toEqual(file().fixtures);
    expect(result.samples).toEqual([
      { index: 0, request: "{\"amount\":10}", answer: "{\"score\":0.2}" },
      { index: 1, request: `(request not kept; sha256 ${"a".repeat(12)})`, answer: "(error ModelError)" },
    ]);
  });
  it("counts a body that is not text, for the person who confirms samples", async () => {
    const base = file();
    const binary = { ...base, fixtures: { ...base.fixtures, rules: [{ ...base.fixtures.rules![0]!, response: { bodyBase64: Buffer.from([0xff, 0xfe, 0x01]).toString("base64") } }, base.fixtures.rules![1]!] } };
    expect(await upload(binary)).toMatchObject({ ok: true, binaryBodies: 1 });
    const result = await upload(binary);
    if (result.ok) expect(result.samples[0]!.answer).toBe("(not text)");
  });
});

describe("an upload that is refused", () => {
  it("refuses a recording whose answer holds personal data, even when the recorder says it scanned it, naming kind and path only", async () => {
    const tampered = withAnswer(`{"mail":"${EMAIL}"}`);
    const result = await upload(tampered);
    expect(result).toEqual({ ok: false, reason: "findings", findings: [{ kind: "email", path: "rules[0].response.body" }] });
    expect(JSON.stringify(result)).not.toContain("quill");
    expect(tampered.scan.open).toBe(0);
  });
  it("finds personal data hidden in a base64 body, a request text, a header, a part, an error message and the endpoint name's neighbours", async () => {
    const base = file();
    const hidden = (rule: Record<string, unknown>) => upload({ ...base, fixtures: { ...base.fixtures, rules: [rule, base.fixtures.rules![1]!] } });
    expect(await hidden({ match: { bodyEquals: "x" }, response: { bodyBase64: Buffer.from(`to ${EMAIL}`).toString("base64") } })).toMatchObject({ findings: [{ kind: "email", path: "rules[0].response.bodyBase64" }] });
    expect(await hidden({ match: { bodyEquals: `from ${EMAIL}` }, response: { body: "{}" } })).toMatchObject({ findings: [{ kind: "email", path: "rules[0].match.bodyEquals" }] });
    expect(await hidden({ match: { bodyEquals: "x" }, response: { body: "{}", customAttributes: `u=${EMAIL}` } })).toMatchObject({ findings: [{ kind: "email", path: "rules[0].response.customAttributes" }] });
    expect(await hidden({ match: { bodyEquals: "x" }, response: { parts: ["ok", `1 ${EMAIL}`] } })).toMatchObject({ findings: [{ kind: "email", path: "rules[0].response.parts[1]" }, { kind: "email", path: "rules[0].response.parts" }] });
    expect(await hidden({ match: { bodyEquals: "x" }, response: { error: { code: "ModelError", message: `see ${EMAIL}` } } })).toMatchObject({ findings: [{ kind: "email", path: "rules[0].response.error.message" }] });
  });
  it("finds what the synthetic-data guard finds: a secret, and a name of production on the company's list", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const secret = await upload(withAnswer(`{"k":"aws_access_key_id=${key}"}`));
    expect(secret).toMatchObject({ ok: false, reason: "findings" });
    expect(secret.ok ? [] : secret.findings.map((finding) => [finding.kind, finding.path])).toContainEqual(["secret", "rules[0].response.body"]);
    expect(await upload(withAnswer("{\"host\":\"db.prod.example.com\"}"))).toEqual({ ok: false, reason: "findings", findings: [{ kind: "prod_host", path: "rules[0].response.body" }] });
  });
  it("refuses a file that is not a recording: not JSON, a different format, a recording with an unrecorded set, an unknown field, a rule count that disagrees", async () => {
    expect(await intakeSageMakerRecording("not json", DENY)).toEqual({ ok: false, reason: "not_json", findings: [] });
    expect(await upload({ hello: "world" })).toEqual({ ok: false, reason: "invalid", findings: [] });
    expect(await upload({ ...file(), extra: 1 })).toEqual({ ok: false, reason: "invalid", findings: [] });
    expect(await upload({ ...file(), pairs: 5 })).toEqual({ ok: false, reason: "invalid", findings: [] });
    expect(await upload({ ...file(), fixtures: { ...file().fixtures, source: "handwritten", recordedOn: undefined } })).toEqual({ ok: false, reason: "invalid", findings: [] });
    expect(await upload({ ...file(), scan: { ...file().scan, open: 1 } })).toEqual({ ok: false, reason: "invalid", findings: [] });
    expect(await upload({ ...file(), recorder: { name: "something else", version: "1" } })).toEqual({ ok: false, reason: "invalid", findings: [] });
  });
  it("refuses a file larger than a recording may be, without parsing it", async () => {
    expect(await intakeSageMakerRecording(`"${"x".repeat(SAGEMAKER_RECORDING_MAX_BYTES)}"`, DENY)).toEqual({ ok: false, reason: "too_large", findings: [] });
  });
  it("fails closed when a scanner cannot finish", async () => {
    const broken: PiiScanner = { id: "broken", scan: () => Promise.reject(new Error("down")) };
    expect(await intakeSageMakerRecording(JSON.stringify(file()), DENY, broken)).toEqual({ ok: false, reason: "scan_failed", findings: [] });
  });
  it("has fixed words for every refusal", () => {
    for (const reason of ["too_large", "not_json", "invalid", "findings", "scan_failed"] as const) expect(SAGEMAKER_INTAKE_REFUSAL_WORDS[reason].length).toBeGreaterThan(10);
  });
});

describe("what the upload scan read before it was widened", () => {
  const base = file();
  const withRule = (rule: Record<string, unknown>) => upload({ ...base, fixtures: { ...base.fixtures, rules: [rule, base.fixtures.rules![1]!] } });
  const paths = async (result: ReturnType<typeof upload>) => { const r = await result; return r.ok ? [] : r.findings.map((finding) => `${finding.kind}:${finding.path}`); };

  it("scans every string field of a rule's match, the content type, accept and variant included", async () => {
    for (const field of ["contentType", "accept", "targetVariant", "customAttributes", "targetModel"]) {
      expect(await paths(withRule({ match: { [field]: `x/${EMAIL}`, bodyEquals: "x" }, response: { body: "{}" } })), field).toEqual([`email:rules[0].match.${field}`]);
    }
  });
  it("scans streamed parts joined, so an address split across parts is found", async () => {
    expect(await paths(withRule({ match: { bodyEquals: "x" }, response: { parts: ["pat.quill@", "fakemail-sample.io"] } }))).toEqual(["email:rules[0].response.parts"]);
  });
  it("finds an address written with JSON escapes, or hidden by a zero-width character", async () => {
    expect(await paths(withRule({ match: { bodyEquals: "x" }, response: { body: "{\"e\":\"pat.quill\\u0040fakemail-sample.io\"}" } }))).toEqual(["email:rules[0].response.body"]);
    expect(await paths(withRule({ match: { bodyEquals: "x" }, response: { body: "pat.quill@fake\u200Bmail-sample.io" } }))).toEqual(["email:rules[0].response.body"]);
    expect(await paths(withRule({ match: { bodyEquals: "x" }, response: { json: { customer_name: "Jos\u00e9 Garc\u00eda" } } }))).toEqual(["person_name:rules[0].response.json"]);
  });
  it("finds UTF-16 text in a base64 body, and counts a clean binary body once, however many ways it was read", async () => {
    const hidden = Buffer.from(`{"e":"${EMAIL}"}`, "utf16le").toString("base64");
    expect(await paths(withRule({ match: { bodyEquals: "x" }, response: { bodyBase64: hidden } }))).toEqual(["email:rules[0].response.bodyBase64"]);
    const clean = Buffer.from("{\"score\":1}", "utf16le").toString("base64");
    expect(await withRule({ match: { bodyEquals: "x" }, response: { bodyBase64: clean } })).toMatchObject({ ok: true, binaryBodies: 1 });
    expect(await withRule({ match: { bodyEquals: "x" }, response: { body: "a\u0000b" } })).toMatchObject({ ok: true, binaryBodies: 1 });
  });
});

describe("the re-scan itself", () => {
  it("reports each finding once per field, and never throws on a file that is not valid", async () => {
    expect(await rescanSageMakerRecording(null, builtinPiiScanner)).toEqual({ ok: false, reason: "invalid", findings: [] });
    const result = await rescanSageMakerRecording(withAnswer(`{"a":"${EMAIL}","b":"${EMAIL}"}`), builtinPiiScanner);
    expect(result).toEqual({ ok: false, reason: "findings", findings: [{ kind: "email", path: "rules[0].response.body" }] });
  });
  it("cuts the samples short and clips to the count asked for", () => {
    const base = file();
    const long = { ...base, fixtures: { ...base.fixtures, rules: [{ ...base.fixtures.rules![0]!, response: { body: "y".repeat(500) } }, base.fixtures.rules![1]!] } };
    const samples = sageMakerRecordingSamples(SageMakerRecordingFileSchema.parse(long), 1);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.answer.length).toBe(203);
    expect(sageMakerRecordingSamples(base, 0)).toEqual([]);
  });
});
