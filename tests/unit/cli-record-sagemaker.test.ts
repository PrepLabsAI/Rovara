// `rovara record sagemaker` (SM5): the recorder runs in the customer's own environment against their own endpoint, scans before anything is written, redacts or refuses each finding, and sends nothing anywhere but the
// endpoint. These tests run it with a scripted invoker (no AWS, no network) and hold it to every rule at the top of `record/sagemaker.ts`.
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SageMakerRecordingFileSchema, builtinPiiScanner, rescanSageMakerRecording, type PiiScanner } from "../../packages/contracts/src/index.js";
import { createCliProgram, executeCli } from "../../packages/cli/src/main.js";
import { INVOKE_FAILURES, awsCliInvoker, failureFromAwsCliError, type InvokeOutcome, type InvokeRequest, type SageMakerInvoker } from "../../packages/cli/src/record/invoker.js";
import { PRESIDIO_ENTITY_KINDS, presidioScanner, presidioUrl, sliceText } from "../../packages/cli/src/record/presidio.js";
import { parseRecordInputs, recordSageMakerEndpoint, type RecordInput, type RecordOptions } from "../../packages/cli/src/record/sagemaker.js";

let directory = "";
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "record-sagemaker-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const NOW = new Date("2026-11-20T10:00:00.000Z");
const EMAIL = "pat.quill@fakemail-sample.io";
const bytes = (text: string) => new TextEncoder().encode(text);
const bodyText = (init: RequestInit): string => (typeof init.body === "string" ? init.body : "");
const answer = (text: string, extra: Partial<Extract<InvokeOutcome, { kind: "answer" }>> = {}): InvokeOutcome => ({ kind: "answer", body: bytes(text), contentType: "application/json", ...extra });

/** An invoker that answers from a function of the request and counts what it was sent. */
function scripted(reply: (request: InvokeRequest, index: number) => InvokeOutcome): SageMakerInvoker & { calls: InvokeRequest[] } {
  const calls: InvokeRequest[] = [];
  return { calls, invoke: (request) => { calls.push(request); return Promise.resolve(reply(request, calls.length - 1)); } };
}
const options = (inputs: RecordInput[], over: Partial<RecordOptions> = {}): RecordOptions => ({ endpointName: "fraud-scorer", inputs, out: join(directory, "recording.json"), ...over });
const deps = (invoker: SageMakerInvoker, scanner: PiiScanner = builtinPiiScanner) => ({ invoker, scanner, now: () => NOW, version: "1.2.3" });
const read = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;
const files = async () => (await readdir(directory)).sort();

describe("a recording", () => {
  it("writes the answers as a fixture file the front accepts, readable by its owner only, and sends only to the endpoint", async () => {
    const invoker = scripted((request, index) => answer(JSON.stringify({ score: index / 10, echoed: request.body.length }), { variant: "AllTraffic", customAttributes: "trace=1" }));
    const result = await recordSageMakerEndpoint(options([{ json: { amount: 10 } }, { body: "{\"amount\": 99}" }]), deps(invoker));
    expect(result).toMatchObject({ ok: true, pairs: 2, duplicates: 0, redactions: 0, modelErrors: 0, scanners: "builtin-1" });
    expect(invoker.calls.map((call) => [call.endpointName, call.contentType])).toEqual([["fraud-scorer", "application/json"], ["fraud-scorer", "application/json"]]);
    const file = SageMakerRecordingFileSchema.parse(await read(join(directory, "recording.json")));
    expect(file).toMatchObject({ format: "rovara-sagemaker-recording", endpointName: "fraud-scorer", recordedAt: NOW.toISOString(), recorder: { name: "rovara record sagemaker", version: "1.2.3" }, scan: { policy: "refuse", open: 0, redactions: 0 } });
    expect(file.fixtures).toMatchObject({ mode: "canned", source: "recorded", recordedOn: "2026-11-20" });
    expect(file.fixtures.rules?.[0]).toEqual({
      match: { operation: "invoke", contentType: "application/json", bodyEquals: "{\"amount\":10}" },
      response: { body: "{\"score\":0,\"echoed\":13}", contentType: "application/json", variant: "AllTraffic", customAttributes: "trace=1" },
    });
    expect((await stat(join(directory, "recording.json"))).mode & 0o777).toBe(0o600);
    expect(await files()).toEqual(["recording.json"]);
    // what is written passes the scan Rovara runs on upload
    expect((await rescanSageMakerRecording(await read(join(directory, "recording.json")), builtinPiiScanner)).ok).toBe(true);
  });
  it("records the model's own error, skips a repeated request, and keeps a large or binary request by its hash", async () => {
    const big = JSON.stringify({ data: "x".repeat(70_000) });
    const invoker = scripted((request) => (request.body.length === 2 ? { kind: "model_error", originalStatusCode: 500 } : answer("{\"ok\":true}")));
    const result = await recordSageMakerEndpoint(options([{ body: "{}" }, { body: "{\"a\":1}" }, { body: "{\"a\":1}" }, { body: big }, { bodyBase64: Buffer.from([0xff, 0xfe, 3]).toString("base64"), contentType: "application/octet-stream" }], { allowBinary: true }), deps(invoker));
    expect(result).toMatchObject({ ok: true, pairs: 4, duplicates: 1, modelErrors: 1 });
    expect(invoker.calls).toHaveLength(4);
    const rules = SageMakerRecordingFileSchema.parse(await read(join(directory, "recording.json"))).fixtures.rules!;
    expect(rules[0]).toMatchObject({ response: { error: { code: "ModelError", originalStatusCode: 500 } } });
    expect(rules[2]!.match.bodyEquals).toBeUndefined();
    expect(rules[2]!.match.bodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(rules[3]!.match).toMatchObject({ contentType: "application/octet-stream" });
    expect(rules[3]!.match.bodySha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("matches the request's header fields too, and a default content type and accept apply", async () => {
    const invoker = scripted(() => answer("{}"));
    await recordSageMakerEndpoint(options([{ body: "q", contentType: "Text/CSV; charset=utf-8", targetVariant: "B", customAttributes: "k=v", targetModel: "m.tar.gz" }, { body: "r" }], { defaultContentType: "application/x-npy", defaultAccept: "application/json" }), deps(invoker));
    const rules = SageMakerRecordingFileSchema.parse(await read(join(directory, "recording.json"))).fixtures.rules!;
    expect(rules[0]!.match).toMatchObject({ contentType: "text/csv", accept: "application/json", targetVariant: "B", customAttributes: "k=v", targetModel: "m.tar.gz" });
    expect(rules[1]!.match).toMatchObject({ contentType: "application/x-npy", accept: "application/json" });
  });
});

describe("personal data in a request: nothing is sent", () => {
  it("refuses before the first call, names the kind and the field, and never writes", async () => {
    const invoker = scripted(() => answer("{}"));
    const result = await recordSageMakerEndpoint(options([{ body: "{\"ok\":1}" }, { json: { contact: EMAIL } }]), deps(invoker));
    expect(result).toEqual({ ok: false, reason: "request_findings", findings: [{ kind: "email", field: "inputs[1].body" }] });
    expect(invoker.calls).toHaveLength(0);
    expect(await files()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("quill");
  });
  it("also checks the header fields a request carries", async () => {
    const invoker = scripted(() => answer("{}"));
    const result = await recordSageMakerEndpoint(options([{ body: "x", customAttributes: `owner=${EMAIL}` }]), deps(invoker));
    expect(result).toMatchObject({ ok: false, reason: "request_findings", findings: [{ kind: "email", field: "inputs[0].customAttributes" }] });
    expect(invoker.calls).toHaveLength(0);
  });
  it("applies even when the policy is to redact answers", async () => {
    const invoker = scripted(() => answer("{}"));
    const result = await recordSageMakerEndpoint(options([{ json: { contact: EMAIL } }], { policy: "redact" }), deps(invoker));
    expect(result).toMatchObject({ ok: false, reason: "request_findings" });
    expect(invoker.calls).toHaveLength(0);
  });
});

describe("personal data in an answer", () => {
  const echo = scripted((request) => answer(JSON.stringify({ echo: `reply to ${EMAIL}`, n: request.body.length })));

  it("refuses the whole recording by default, naming kind and field and never the text, and writes nothing", async () => {
    const result = await recordSageMakerEndpoint(options([{ body: "{}" }, { body: "{\"b\":2}" }]), deps(echo));
    expect(result).toMatchObject({ ok: false, reason: "answer_findings", findings: [{ kind: "email", field: "answers[0].body" }], index: 0 });
    expect(JSON.stringify(result)).not.toContain("quill");
    expect(await files()).toEqual([]);
  });
  it("redacts each found span when asked, scans the redacted text again, and writes a file that passes the upload scan", async () => {
    const result = await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact" }), deps(echo));
    expect(result).toMatchObject({ ok: true, redactions: 1 });
    const text = await readFile(join(directory, "recording.json"), "utf8");
    expect(text).not.toContain("quill");
    expect(text).toContain("[REDACTED:EMAIL]");
    const file = SageMakerRecordingFileSchema.parse(JSON.parse(text));
    expect(file.scan).toMatchObject({ policy: "redact", redactions: 1, open: 0 });
    expect(JSON.parse(file.fixtures.rules![0]!.response.body!)).toEqual({ echo: "reply to [REDACTED:EMAIL]", n: 2 });
  });
  it("refuses when redaction would break the answer's JSON, and when a binary answer holds a finding", async () => {
    const card = scripted(() => answer("{\"card\": 4111111111111111}"));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact" }), deps(card))).toMatchObject({ ok: false, reason: "redaction_failed" });
    const binary = scripted(() => ({ kind: "answer", body: new Uint8Array([0xff, ...bytes(EMAIL)]), contentType: "application/octet-stream" }));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact", allowBinary: true }), deps(binary))).toMatchObject({ ok: false, reason: "redaction_failed" });
    expect(await files()).toEqual([]);
  });
  it("refuses when a finding is still there after redaction, because the redacted text is scanned again", async () => {
    // a scanner that only ever reports the first "ZZZ" of a text: one redaction leaves the second one behind
    const first: PiiScanner = { id: "first-only", scan: (text) => (text.includes("ZZZ") ? [{ kind: "person_name", start: text.indexOf("ZZZ"), end: text.indexOf("ZZZ") + 3 }] : []) };
    const invoker = scripted(() => answer("ZZZ and ZZZ", { contentType: "text/plain" }));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact" }), deps(invoker, first))).toMatchObject({ ok: false, reason: "redaction_failed", findings: [{ kind: "person_name", field: "answers[0].body" }] });
    expect(await files()).toEqual([]);
  });
  it("scans the file once more as a whole before it writes, so what is written is what was scanned", async () => {
    // a scanner that reports nothing while the answers are scanned and a finding once the file is being put together (`now` is read between the two)
    let final = false;
    const late: PiiScanner = { id: "late", scan: (text) => (final && text.includes("\"v\":1") ? [{ kind: "person_name", start: 0, end: 1 }] : []) };
    const invoker = scripted(() => answer("{\"v\":1}"));
    const result = await recordSageMakerEndpoint(options([{ body: "{}" }]), { invoker, scanner: late, now: () => { final = true; return NOW; }, version: "1.2.3" });
    expect(result).toMatchObject({ ok: false, reason: "answer_findings", findings: [{ kind: "person_name", field: "rules[0].response.body" }] });
    expect(await files()).toEqual([]);
  });
  it("refuses a finding in a header the reply carries, even when redacting", async () => {
    const header = scripted(() => answer("{}", { customAttributes: `user=${EMAIL}` }));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact" }), deps(header))).toMatchObject({ ok: false, reason: "redaction_failed", findings: [{ kind: "email", field: "answers[0].customAttributes" }] });
  });
  it("stops at a binary answer unless it was allowed, then stores its bytes", async () => {
    const binary = scripted(() => ({ kind: "answer", body: new Uint8Array([0xff, 0xfe, 0x01]), contentType: "application/octet-stream" }));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }]), deps(binary))).toMatchObject({ ok: false, reason: "binary_not_allowed" });
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { allowBinary: true }), deps(binary))).toMatchObject({ ok: true });
    expect(SageMakerRecordingFileSchema.parse(await read(join(directory, "recording.json"))).fixtures.rules![0]!.response.bodyBase64).toBe(Buffer.from([0xff, 0xfe, 0x01]).toString("base64"));
    expect(await recordSageMakerEndpoint(options([{ bodyBase64: Buffer.from([0xff]).toString("base64") }], { out: join(directory, "other.json") }), deps(binary))).toMatchObject({ ok: false, reason: "binary_not_allowed" });
  });
});

describe("failures stop the recording", () => {
  it("never records a credential, throttle or other failure as the model's answer", async () => {
    for (const failure of INVOKE_FAILURES) {
      const invoker = scripted((_request, index) => (index === 1 ? { kind: "failed", failure } : answer("{}")));
      const result = await recordSageMakerEndpoint(options([{ body: "a" }, { body: "b" }]), deps(invoker));
      expect(result).toEqual({ ok: false, reason: "invoke_failed", failure, index: 1 });
    }
    expect(await files()).toEqual([]);
  });
  it("treats an invoker that throws as a failed call", async () => {
    const invoker: SageMakerInvoker = { invoke: () => Promise.reject(new Error(`secret ${EMAIL}`)) };
    const result = await recordSageMakerEndpoint(options([{ body: "a" }]), deps(invoker));
    expect(result).toMatchObject({ ok: false, reason: "invoke_failed" });
    expect(JSON.stringify(result)).not.toContain("quill");
  });
  it("fails closed when the scanner cannot finish, before and after the call", async () => {
    const broken: PiiScanner = { id: "broken", scan: () => Promise.reject(new Error("down")) };
    const invoker = scripted(() => answer("{}"));
    expect(await recordSageMakerEndpoint(options([{ body: "a" }]), deps(invoker, broken))).toEqual({ ok: false, reason: "scan_failed" });
    expect(invoker.calls).toHaveLength(0);
    let first = true;
    const late: PiiScanner = { id: "late", scan: (text) => { if (first && text === "a") { first = false; return []; } return Promise.reject(new Error("down")); } };
    expect(await recordSageMakerEndpoint(options([{ body: "a" }]), deps(invoker, late))).toMatchObject({ ok: false, reason: "scan_failed" });
    expect(await files()).toEqual([]);
  });
  it("refuses a bad endpoint name, no inputs, and an existing file unless --force", async () => {
    const invoker = scripted(() => answer("{\"v\":1}"));
    expect(await recordSageMakerEndpoint({ ...options([{ body: "a" }]), endpointName: "-x" }, deps(invoker))).toEqual({ ok: false, reason: "bad_endpoint_name" });
    expect(await recordSageMakerEndpoint(options([]), deps(invoker))).toEqual({ ok: false, reason: "bad_inputs" });
    await writeFile(join(directory, "recording.json"), "keep me");
    expect(await recordSageMakerEndpoint(options([{ body: "a" }]), deps(invoker))).toEqual({ ok: false, reason: "exists" });
    expect(await readFile(join(directory, "recording.json"), "utf8")).toBe("keep me");
    expect(invoker.calls).toHaveLength(0);
    expect(await recordSageMakerEndpoint(options([{ body: "a" }], { force: true }), deps(invoker))).toMatchObject({ ok: true });
    expect((await readFile(join(directory, "recording.json"), "utf8")).startsWith("{")).toBe(true);
    expect(await files()).toEqual(["recording.json"]);
  });
  it("leaves nothing behind when the folder cannot be written", async () => {
    const invoker = scripted(() => answer("{}"));
    const result = await recordSageMakerEndpoint(options([{ body: "a" }], { out: join(directory, "missing", "recording.json") }), deps(invoker));
    expect(result).toEqual({ ok: false, reason: "write_failed" });
    await mkdir(join(directory, "missing"));
    expect(await files()).toEqual(["missing"]);
  });
});

describe("the input file", () => {
  it("reads a JSON array or JSON Lines, and says in fixed words what is wrong", () => {
    expect(parseRecordInputs("[{\"body\":\"a\"},{\"json\":{\"x\":1}}]")).toMatchObject({ ok: true, inputs: [{ body: "a" }, { json: { x: 1 } }] });
    expect(parseRecordInputs("{\"body\":\"a\"}\n\n{\"bodyBase64\":\"AAEC\",\"contentType\":\"application/octet-stream\"}\n")).toMatchObject({ ok: true });
    expect(parseRecordInputs("  ")).toEqual({ ok: false, problem: "empty" });
    expect(parseRecordInputs("[]")).toEqual({ ok: false, problem: "empty" });
    expect(parseRecordInputs("not json")).toEqual({ ok: false, problem: "not_json" });
    expect(parseRecordInputs("[{\"body\":\"a\"},{\"body\":\"a\",\"json\":1}]")).toEqual({ ok: false, problem: "invalid_input", index: 1 });
    expect(parseRecordInputs("[{\"bodyy\":\"a\"}]")).toEqual({ ok: false, problem: "invalid_input", index: 0 });
    expect(parseRecordInputs(JSON.stringify(Array.from({ length: 501 }, () => ({ body: "a" }))))).toEqual({ ok: false, problem: "too_many" });
  });
});

describe("the AWS CLI invoker", () => {
  const request = (over: Partial<InvokeRequest> = {}): InvokeRequest => ({ endpointName: "fraud-scorer", contentType: "application/json", body: bytes("{}"), ...over });
  const signal = () => new AbortController().signal;
  /** A runner that writes the answer file the AWS CLI would write (its last argument). */
  const runner = (result: { code: number; stdout?: string; stderr?: string; missing?: boolean }, body = "{\"score\":1}") => {
    const seen: string[][] = [];
    return { seen, run: async (_file: string, args: readonly string[]) => { seen.push([...args]); if (result.code === 0) await writeFile(args[args.length - 1]!, body); return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.missing === true ? { missing: true } : {}) }; } };
  };

  it("calls `aws sagemaker-runtime invoke-endpoint` with each value as one argument, and reads the reply", async () => {
    const fake = runner({ code: 0, stdout: JSON.stringify({ ContentType: "application/json", InvokedProductionVariant: "AllTraffic", CustomAttributes: "a=b" }) });
    const outcome = await awsCliInvoker({ region: "us-west-2", profile: "my-profile", run: fake.run }).invoke(request({ accept: "application/json", customAttributes: "x=y", targetVariant: "A" }), signal());
    expect(outcome).toMatchObject({ kind: "answer", contentType: "application/json", variant: "AllTraffic", customAttributes: "a=b" });
    expect(new TextDecoder().decode((outcome as { body: Uint8Array }).body)).toBe("{\"score\":1}");
    const args = fake.seen[0]!;
    expect(args.slice(0, 4)).toEqual(["sagemaker-runtime", "invoke-endpoint", "--endpoint-name", "fraud-scorer"]);
    expect(args).toEqual(expect.arrayContaining(["--content-type", "application/json", "--accept", "application/json", "--custom-attributes", "x=y", "--target-variant", "A", "--region", "us-west-2", "--profile", "my-profile"]));
    expect(args[args.indexOf("--body") + 1]).toMatch(/^fileb:\/\//u);
  });
  it("reads the error code and nothing of the message, and a model error's status", async () => {
    const model = runner({ code: 254, stderr: "An error occurred (ModelError) when calling the InvokeEndpoint operation: Received server error (503) from primary with message \"user pat.quill@fakemail-sample.io\"" });
    expect(await awsCliInvoker({ run: model.run }).invoke(request(), signal())).toEqual({ kind: "model_error", originalStatusCode: 503 });
    expect(failureFromAwsCliError("Unable to locate credentials. You can configure credentials by running \"aws login\".")).toEqual({ failure: "no_credentials" });
    expect(failureFromAwsCliError("An error occurred (AccessDeniedException) when calling x")).toEqual({ failure: "access_denied" });
    expect(failureFromAwsCliError("An error occurred (ValidationError) when calling x: Endpoint fraud-scorer of account 1 not found.")).toEqual({ failure: "endpoint_not_found" });
    expect(failureFromAwsCliError("An error occurred (ThrottlingException) when calling x")).toEqual({ failure: "throttled" });
    expect(failureFromAwsCliError("An error occurred (ServiceUnavailable) when calling x")).toEqual({ failure: "unavailable" });
    expect(failureFromAwsCliError("something unreadable")).toEqual({ failure: "failed" });
  });
  it("says when the AWS CLI is missing, and refuses a region, profile or header that could be read as an option", async () => {
    expect(await awsCliInvoker({ run: runner({ code: 127, missing: true }).run }).invoke(request(), signal())).toEqual({ kind: "failed", failure: "aws_cli_missing" });
    expect(() => awsCliInvoker({ region: "--profile" })).toThrow(RangeError);
    expect(() => awsCliInvoker({ profile: "-x" })).toThrow(RangeError);
    const fake = runner({ code: 0 });
    expect(await awsCliInvoker({ run: fake.run }).invoke(request({ customAttributes: "a\nb" }), signal())).toEqual({ kind: "failed", failure: "failed" });
    expect(fake.seen).toHaveLength(0);
  });
  it("removes the temporary files it made", async () => {
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("rovara-record-")).length;
    await awsCliInvoker({ run: runner({ code: 0, stdout: "{}" }).run }).invoke(request(), signal());
    await awsCliInvoker({ run: runner({ code: 255, stderr: "x" }).run }).invoke(request(), signal());
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("rovara-record-")).length).toBe(before);
  });
});

describe("what the reviewer's probes could do before", () => {
  const ESCAPED_EMAIL = "{\"e\":\"pat.quill\\u0040fakemail-sample.io\"}";
  const ESCAPED_NAME = "{\"customer_name\":\"Jos\\u00e9 Garc\\u00eda\"}";
  const utf16 = (text: string) => Buffer.from(text, "utf16le").toString("base64");

  it("refuses values the AWS CLI would read as a file, an address or an option, in the input file and in the invoker", async () => {
    const probes: Array<[string, string]> = [["contentType", "file://~/.git-credentials"], ["customAttributes", "https://169.254.169.254/latest/meta-data/"], ["accept", "--debug"], ["targetVariant", " FILE://x"], ["targetModel", "FileB://x"], ["contentType", "HTTP://x"], ["accept", "-x"]];
    for (const [field, value] of probes) {
      expect(parseRecordInputs(JSON.stringify([{ body: "a", [field]: value }])), `${field}: ${value}`).toMatchObject({ ok: false, problem: "invalid_input", index: 0 });
      const seen: string[][] = [];
      const invoker = awsCliInvoker({ run: (_file, args) => { seen.push([...args]); return Promise.resolve({ code: 0, stdout: "{}", stderr: "" }); } });
      const request: InvokeRequest = { endpointName: "fraud-scorer", contentType: "application/json", body: bytes("{}"), [field]: value };
      expect(await invoker.invoke(request, new AbortController().signal)).toEqual({ kind: "failed", failure: "failed" });
      expect(seen).toEqual([]);
    }
    // a value that merely contains such text is a value
    expect(parseRecordInputs(JSON.stringify([{ body: "a", customAttributes: "note=see https://x and file://y and -z" }]))).toMatchObject({ ok: true });
    // and so are the defaults given on the command line
    const invoker = scripted(() => answer("{}"));
    expect(await recordSageMakerEndpoint(options([{ body: "a" }], { defaultContentType: "file://~/.git-credentials" }), deps(invoker))).toEqual({ ok: false, reason: "bad_inputs" });
    expect(await recordSageMakerEndpoint(options([{ body: "a" }], { defaultAccept: "--debug" }), deps(invoker))).toEqual({ ok: false, reason: "bad_inputs" });
    expect(invoker.calls).toHaveLength(0);
  });

  it("finds an email or a name written with JSON escapes, in a request (nothing sent) and in an answer", async () => {
    const invoker = scripted(() => answer("{}"));
    expect(await recordSageMakerEndpoint(options([{ body: ESCAPED_EMAIL }]), deps(invoker))).toEqual({ ok: false, reason: "request_findings", findings: [{ kind: "email", field: "inputs[0].body" }] });
    expect(await recordSageMakerEndpoint(options([{ body: ESCAPED_NAME }]), deps(invoker))).toEqual({ ok: false, reason: "request_findings", findings: [{ kind: "person_name", field: "inputs[0].body" }] });
    expect(invoker.calls).toHaveLength(0);
    const email = scripted(() => answer(ESCAPED_EMAIL));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }]), deps(email))).toMatchObject({ ok: false, reason: "answer_findings", findings: [{ kind: "email", field: "answers[0].body" }] });
    expect(await files()).toEqual([]);
  });
  it("redacts an escaped email and an escaped name, writes JSON that still parses, and the file passes the upload scan", async () => {
    for (const [reply, expected] of [[ESCAPED_EMAIL, { e: "[REDACTED:EMAIL]" }], [ESCAPED_NAME, { customer_name: "[REDACTED:PERSON_NAME]" }]] as const) {
      const invoker = scripted(() => answer(reply));
      expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact", force: true }), deps(invoker))).toMatchObject({ ok: true, redactions: 1 });
      const written = await readFile(join(directory, "recording.json"), "utf8");
      expect(written).not.toContain("quill");
      expect(written).not.toContain("Garc");
      expect(JSON.parse(SageMakerRecordingFileSchema.parse(JSON.parse(written)).fixtures.rules![0]!.response.body!)).toEqual(expected);
      expect((await rescanSageMakerRecording(JSON.parse(written), builtinPiiScanner)).ok).toBe(true);
    }
  });
  it("refuses, rather than redact, an address split across two values", async () => {
    const invoker = scripted(() => answer("{\"a\":\"pat.quill@\",\"b\":\"fakemail-sample.io\"}"));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact" }), deps(invoker))).toMatchObject({ ok: false, reason: "redaction_failed", findings: [{ kind: "email", field: "answers[0].body" }] });
    expect(await files()).toEqual([]);
  });

  it("scans a request's accept and content type, not only its body", async () => {
    const invoker = scripted(() => answer("{}"));
    expect(await recordSageMakerEndpoint(options([{ body: "a", accept: `x/${EMAIL}` }]), deps(invoker))).toMatchObject({ ok: false, reason: "request_findings", findings: [{ kind: "email", field: "inputs[0].accept" }] });
    expect(await recordSageMakerEndpoint(options([{ body: "a", contentType: `x/${EMAIL}` }]), deps(invoker))).toMatchObject({ ok: false, reason: "request_findings", findings: [{ kind: "email", field: "inputs[0].contentType" }] });
    expect(await recordSageMakerEndpoint(options([{ body: "a" }], { defaultAccept: `x/${EMAIL}` }), deps(invoker))).toMatchObject({ ok: false, reason: "request_findings", findings: [{ kind: "email", field: "inputs[0].accept" }] });
    expect(invoker.calls).toHaveLength(0);
  });

  it("treats UTF-16 text as binary: it needs --allow-binary, and is then scanned as the text it is", async () => {
    const request = { bodyBase64: utf16(`{"e":"${EMAIL}"}`) };
    const invoker = scripted(() => answer("{}"));
    expect(await recordSageMakerEndpoint(options([request]), deps(invoker))).toMatchObject({ ok: false, reason: "binary_not_allowed", index: 0 });
    expect(await recordSageMakerEndpoint(options([request], { allowBinary: true }), deps(invoker))).toMatchObject({ ok: false, reason: "request_findings", findings: [{ kind: "email", field: "inputs[0].body" }] });
    const reply = scripted(() => ({ kind: "answer", body: new Uint8Array(Buffer.from(`{"e":"${EMAIL}"}`, "utf16le")), contentType: "application/json" }));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }]), deps(reply))).toMatchObject({ ok: false, reason: "binary_not_allowed" });
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { allowBinary: true }), deps(reply))).toMatchObject({ ok: false, reason: "answer_findings", findings: [{ kind: "email", field: "answers[0].body" }] });
    expect(invoker.calls).toHaveLength(0);
    expect(await files()).toEqual([]);
  });
  it("sees through zero-width characters in an answer", async () => {
    const invoker = scripted(() => answer("{\"m\":\"pat.quill@fake​mail-sample.io\"}"));
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }]), deps(invoker))).toMatchObject({ ok: false, reason: "answer_findings", findings: [{ kind: "email", field: "answers[0].body" }] });
    expect(await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact" }), deps(invoker))).toMatchObject({ ok: false, reason: "redaction_failed" });
  });

  it("removes its temporary folder when the process is told to stop, then raises the signal again", async () => {
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("rovara-record-"));
    let path = "";
    let release: (() => void) | undefined;
    const raised: string[] = [];
    const invoker = awsCliInvoker({
      exit: (signal) => { raised.push(signal); },
      run: (_file, args) => { path = args[args.indexOf("--body") + 1]!.replace("fileb://", ""); return new Promise((resolve) => { release = () => resolve({ code: 255, stdout: "", stderr: "x" }); }); },
    });
    const done = invoker.invoke({ endpointName: "fraud-scorer", contentType: "application/json", body: bytes("{\"secret\":1}") }, new AbortController().signal);
    while (path === "") await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await stat(path)).isFile()).toBe(true);
    // only this call's handler hears the signal: the test runner's own handlers are set aside for a moment
    const all = process.listeners("SIGTERM");
    const others = all.slice(0, -1);
    for (const listener of others) process.off("SIGTERM", listener);
    process.emit("SIGTERM", "SIGTERM");
    for (const listener of others) process.on("SIGTERM", listener);
    expect(raised).toEqual(["SIGTERM"]);
    await expect(stat(path)).rejects.toThrow();
    release?.();
    await done;
    // the handlers are gone once the call ends
    const listeners = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    await awsCliInvoker({ run: () => Promise.resolve({ code: 255, stdout: "", stderr: "x" }) }).invoke({ endpointName: "fraud-scorer", contentType: "application/json", body: bytes("{}") }, new AbortController().signal);
    expect(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM")).toBe(listeners);
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("rovara-record-"))).toEqual(before);
  });
});

describe("the optional Presidio scanner", () => {
  const reply = (entries: unknown) => (async () => new Response(JSON.stringify(entries), { status: 200 })) as unknown as typeof fetch;

  it("takes an analyzer on this computer, and an analyzer elsewhere only when the customer says so", () => {
    expect(presidioUrl("http://localhost:5002", false)).toMatchObject({ ok: true });
    expect(presidioUrl("http://127.0.0.1:5002", false)).toMatchObject({ ok: true });
    expect(presidioUrl("http://[::1]:5002", false)).toMatchObject({ ok: true });
    expect(presidioUrl("http://analyzer.internal:5002", false)).toEqual({ ok: false, problem: "remote_not_allowed" });
    expect(presidioUrl("http://analyzer.internal:5002", true)).toMatchObject({ ok: true });
    expect(presidioUrl("ftp://localhost", false)).toEqual({ ok: false, problem: "not_http" });
    expect(presidioUrl("http://user:pw@localhost", false)).toEqual({ ok: false, problem: "has_credentials" });
    expect(presidioUrl("nonsense", false)).toEqual({ ok: false, problem: "not_a_url" });
    expect(() => presidioScanner({ url: "http://analyzer.internal:5002" })).toThrow(RangeError);
  });
  it("maps the analyzer's entity types to kinds, shifts offsets by the slice, and ignores types it was not asked for", async () => {
    const scanner = presidioScanner({ url: "http://localhost:5002", fetch: reply([{ entity_type: "PERSON", start: 3, end: 9, score: 0.9 }, { entity_type: "US_SSN", start: 10, end: 14, score: 0.9 }, { entity_type: "DATE_TIME", start: 0, end: 2, score: 0.9 }]) });
    expect(await scanner.scan("by Alice Smyth 1234 end")).toEqual([{ kind: "person_name", start: 3, end: 9 }, { kind: "national_id", start: 10, end: 14 }]);
    expect(Object.values(PRESIDIO_ENTITY_KINDS)).not.toContain(undefined);
  });
  it("sends the text only to the analyzer address, with no redirect followed", async () => {
    const sent: Array<{ url: string; body: string; redirect: unknown }> = [];
    const fetchSpy = (async (url: URL, init: RequestInit) => { sent.push({ url: String(url), body: bodyText(init), redirect: init.redirect }); return new Response("[]"); }) as unknown as typeof fetch;
    await presidioScanner({ url: "http://localhost:5002", fetch: fetchSpy }).scan("hello there");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("http://localhost:5002/analyze");
    expect(sent[0]!.redirect).toBe("error");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ text: "hello there", language: "en" });
  });
  it("fails the scan when the analyzer is down, errors, or answers something unexpected", async () => {
    const down = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    await expect(presidioScanner({ url: "http://localhost:5002", fetch: down }).scan("x")).rejects.toThrow("could not be reached");
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(presidioScanner({ url: "http://localhost:5002", fetch: bad }).scan("x")).rejects.toThrow();
    for (const wrong of [{ nope: 1 }, [{ entity_type: "PERSON", start: 5, end: 3, score: 1 }], [{ entity_type: "PERSON", start: 0, end: 999, score: 1 }], ["x"]]) {
      await expect(presidioScanner({ url: "http://localhost:5002", fetch: reply(wrong) }).scan("short text")).rejects.toThrow("did not answer as expected");
    }
  });
  it("cuts a long text into slices at whitespace, each repeating the end of the one before, and loses no character", () => {
    const text = `${"word ".repeat(30)}tail`;
    const parts = sliceText(text, 50, 10);
    expect(parts.every((part) => part.text.length <= 50)).toBe(true);
    expect(parts.every((part) => text.slice(part.offset, part.offset + part.text.length) === part.text)).toBe(true);
    // every part but the first starts inside the one before it (the overlap), and together they cover the text
    expect(parts.slice(1).every((part, index) => part.offset < parts[index]!.offset + parts[index]!.text.length)).toBe(true);
    expect(parts[0]!.offset).toBe(0);
    const last = parts[parts.length - 1]!;
    expect(last.offset + last.text.length).toBe(text.length);
    expect(sliceText("short", 50, 10)).toEqual([{ offset: 0, text: "short" }]);
    expect(sliceText("", 50, 10)).toEqual([]);
  });
  it("sees a two-word name that straddles a cut, because the slices overlap", async () => {
    const name = "Zyx Qwerty";
    const text = `${"filler ".repeat(12)}${name} ${"after ".repeat(12)}`;
    const cut = text.indexOf(name) + 4;
    // an analyzer that only knows the name when both words are in one slice
    const analyzer = (async (_url: URL, init: RequestInit) => {
      const slice = (JSON.parse(bodyText(init)) as { text: string }).text;
      const at = slice.indexOf(name);
      return new Response(JSON.stringify(at < 0 ? [] : [{ entity_type: "PERSON", start: at, end: at + name.length, score: 0.9 }]));
    }) as unknown as typeof fetch;
    const noOverlap = presidioScanner({ url: "http://localhost:5002", fetch: analyzer, sliceChars: cut + 1, overlapChars: 0 });
    expect(await noOverlap.scan(text)).toEqual([]);
    const overlapping = presidioScanner({ url: "http://localhost:5002", fetch: analyzer, sliceChars: cut + 1, overlapChars: 20 });
    expect(await overlapping.scan(text)).toEqual([{ kind: "person_name", start: text.indexOf(name), end: text.indexOf(name) + name.length }]);
  });
  it("turns Presidio's code-point offsets into UTF-16 offsets before it slices, so text after an emoji is not shifted", async () => {
    const text = "\u{1F600}\u{1F600} Alice Smyth wrote";
    // Python counts the two emoji as two characters: the name starts at 3 and ends at 14
    const reply = (async () => new Response(JSON.stringify([{ entity_type: "PERSON", start: 3, end: 14, score: 0.9 }]))) as unknown as typeof fetch;
    const found = await presidioScanner({ url: "http://localhost:5002", fetch: reply }).scan(text);
    expect(found).toHaveLength(1);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe("Alice Smyth");
    // an offset past the end, counted in code points, is still refused
    const past = (async () => new Response(JSON.stringify([{ entity_type: "PERSON", start: 3, end: 22, score: 0.9 }]))) as unknown as typeof fetch;
    await expect(presidioScanner({ url: "http://localhost:5002", fetch: past }).scan(text)).rejects.toThrow("did not answer as expected");
  });
  it("never cuts a character outside the basic plane in two", () => {
    const text = "\u{1F600}".repeat(40);
    for (const part of sliceText(text, 15, 4)) {
      expect(part.text.charCodeAt(0) >= 0xdc00 && part.text.charCodeAt(0) <= 0xdfff).toBe(false);
      const end = part.text.charCodeAt(part.text.length - 1);
      expect(end >= 0xd800 && end <= 0xdbff).toBe(false);
    }
  });
  it("adds what Presidio finds to what the built-in scanner finds, so the recording is refused or redacted for the union", async () => {
    const presidio = presidioScanner({ url: "http://localhost:5002", fetch: (async (_url: URL, init: RequestInit) => {
      const text = (JSON.parse(bodyText(init)) as { text: string }).text;
      const at = text.indexOf("Zyx Qwerty");
      return new Response(JSON.stringify(at < 0 ? [] : [{ entity_type: "PERSON", start: at, end: at + 10, score: 0.9 }]));
    }) as unknown as typeof fetch });
    const { combinePiiScanners } = await import("../../packages/contracts/src/index.js");
    const invoker = scripted(() => answer(JSON.stringify({ who: "Zyx Qwerty", mail: EMAIL })));
    const result = await recordSageMakerEndpoint(options([{ body: "{}" }], { policy: "redact" }), deps(invoker, combinePiiScanners([builtinPiiScanner, presidio])));
    expect(result).toMatchObject({ ok: true, scanners: "builtin-1+presidio" });
    const text = await readFile(join(directory, "recording.json"), "utf8");
    expect(text).not.toContain("Qwerty");
    expect(text).not.toContain("quill");
  });
});

describe("the command", () => {
  const run = async (args: string[], reply: (request: InvokeRequest) => InvokeOutcome = () => answer("{\"score\":2}")) => {
    let stdout = "";
    let stderr = "";
    const invoker = scripted(reply);
    const code = await executeCli(["record", "sagemaker", ...args], {
      stdout: { write: (text: string) => { stdout += text; return true; } }, stderr: { write: (text: string) => { stderr += text; return true; } },
      record: { invoker: () => invoker, now: () => NOW },
      // a command that needs no sign-in must not touch the network or a token store
      fetchImplementation: () => { throw new Error("the recorder must not use the network"); },
      tokenStore: { get: () => { throw new Error("the recorder must not read a token"); }, put: () => { throw new Error("no"); }, delete: () => { throw new Error("no"); } } as never,
    });
    return { code, stdout, stderr, invoker };
  };
  const inputs = async (content: string) => { const path = join(directory, "inputs.json"); await writeFile(path, content); return path; };

  it("records with no Rovara sign-in, prints a summary that names no request or answer, and says nothing was sent to Rovara", async () => {
    const result = await run(["--endpoint", "fraud-scorer", "--inputs", await inputs("[{\"json\":{\"amount\":5}}]"), "--out", join(directory, "out.json"), "--region", "us-east-1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Recorded 1 answer from endpoint fraud-scorer");
    expect(result.stdout).toContain("Nothing was sent to Rovara.");
    expect(result.stdout).not.toContain("amount");
    expect(result.stdout).not.toContain("\"score\"");
    expect(result.invoker.calls).toHaveLength(1);
    expect(SageMakerRecordingFileSchema.safeParse(await read(join(directory, "out.json"))).success).toBe(true);
  });
  it("prints stable JSON with --json", async () => {
    const result = await run(["--json", "--endpoint", "fraud-scorer", "--inputs", await inputs("[{\"body\":\"a\"}]"), "--out", join(directory, "out.json")]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { answers: 1, redactions: 0, scanners: "builtin-1" } });
  });
  it("exits with a failure and writes nothing when an answer holds personal data, naming kind and field only", async () => {
    const result = await run(["--endpoint", "fraud-scorer", "--inputs", await inputs("[{\"body\":\"a\"}]"), "--out", join(directory, "out.json")], () => answer(`{"mail":"${EMAIL}"}`));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("answers[0].body: an email address");
    expect(result.stderr).toContain("Nothing was written.");
    expect(result.stderr).not.toContain("quill");
    expect(await files()).toEqual(["inputs.json"]);
  });
  it("redacts with --on-finding redact", async () => {
    const result = await run(["--endpoint", "fraud-scorer", "--inputs", await inputs("[{\"body\":\"a\"}]"), "--out", join(directory, "out.json"), "--on-finding", "redact"], () => answer(`{"mail":"${EMAIL}"}`));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Redactions: 1");
    expect(await readFile(join(directory, "out.json"), "utf8")).not.toContain("quill");
  });
  it("refuses an unreadable or invalid input file, and a Presidio analyzer that is not on this computer, before any call", async () => {
    const missing = await run(["--endpoint", "fraud-scorer", "--inputs", join(directory, "nope.json"), "--out", join(directory, "out.json")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("The input file could not be read.");
    const invalid = await run(["--endpoint", "fraud-scorer", "--inputs", await inputs("[{\"bodyy\":1}]"), "--out", join(directory, "out.json")]);
    expect(invalid.stderr).toContain("A request in the input file is not valid");
    expect(invalid.stderr).toContain("(request number 1)");
    const remote = await run(["--endpoint", "fraud-scorer", "--inputs", await inputs("[{\"body\":\"a\"}]"), "--out", join(directory, "out.json"), "--presidio-url", "http://analyzer.internal:5002"]);
    expect(remote.code).toBe(1);
    expect(remote.stderr).toContain("would leave it");
    expect(remote.invoker.calls).toHaveLength(0);
  });
  it("takes no Rovara credential, project or environment option of its own", () => {
    const record = createCliProgram().commands.find((command) => command.name() === "record");
    const sagemaker = record?.commands.find((command) => command.name() === "sagemaker");
    const flags = sagemaker?.options.map((option) => option.long) ?? [];
    expect(flags).toEqual(expect.arrayContaining(["--endpoint", "--inputs", "--out", "--on-finding", "--presidio-url"]));
    expect(flags.filter((flag) => /project|token|deployment|admin|env|login|credential|secret/u.test(flag ?? ""))).toEqual([]);
  });
});
