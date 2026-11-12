// SageMaker endpoints (design: SageMaker endpoint shim, lane SM5): the file `rovara record sagemaker` writes, and the scan that reads it again. The rule behind both: nothing about a request leaves the customer's
// environment unscanned. The recorder runs in the customer's own account or CI, replays a synthetic input file against the customer's real endpoint, scans every request and every answer for personal data, and writes a
// file only when no finding is left open (a finding is redacted or, by default, refuses the whole recording). When the file is uploaded to Rovara, Rovara scans it again (`rescanSageMakerRecording`), because a file
// is only a file: it could have been edited, or made by another tool, or scanned by a weaker scanner. A person then confirms samples (`sageMakerRecordingSamples`).
//
// The file is an envelope around the fixture document the SageMaker Runtime front accepts (`sagemaker-fixtures.ts`). The envelope says what was recorded, when, by what, and what the scan did; the front reads only the
// `fixtures` member. The envelope's scan summary is for a reader to see; Rovara never trusts it, and decides from its own scan.
// Nothing here imports a Node module.
import { z } from "zod";
import { deepScan, type PiiKind, type PiiScanner } from "./pii-scan.js";
import { SageMakerEndpointNameSchema } from "./sagemaker-endpoint.js";
import { SageMakerFixtureDocumentSchema, sageMakerDocumentTexts, sageMakerFixtureDigest } from "./sagemaker-fixtures.js";

export const SAGEMAKER_RECORDING_FORMAT = "rovara-sagemaker-recording";
export const SAGEMAKER_RECORDER_NAME = "rovara record sagemaker";
/** The most a recording file weighs; the fixture document inside is held to 8 MiB, and the envelope is small. */
export const SAGEMAKER_RECORDING_MAX_BYTES = 12 * 1_048_576;
/** The most request and answer pairs one recording holds (the fixture document's own rule limit). */
export const SAGEMAKER_RECORDING_MAX_PAIRS = 500;
export const SAGEMAKER_RECORDING_POLICIES = ["refuse", "redact"] as const;

const Count = z.number().int().min(0).max(10_000_000);

export const SageMakerRecordingFileSchema = z
  .object({
    format: z.literal(SAGEMAKER_RECORDING_FORMAT),
    version: z.literal(1),
    endpointName: SageMakerEndpointNameSchema,
    recordedAt: z.string().datetime(),
    recorder: z.object({ name: z.literal(SAGEMAKER_RECORDER_NAME), version: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/u) }).strict(),
    /** What the recorder's scan did: for a reader, never trusted by Rovara. */
    scan: z
      .object({
        scanners: z.array(z.string().regex(/^[a-z0-9+.-]{1,80}$/u)).min(1).max(8),
        policy: z.enum(SAGEMAKER_RECORDING_POLICIES),
        requests: Count,
        answers: Count,
        redactions: Count,
        /** Findings left open when the file was written: always 0 (a recorder writes no file with an open finding). */
        open: z.literal(0),
      })
      .strict(),
    pairs: z.number().int().min(0).max(SAGEMAKER_RECORDING_MAX_PAIRS),
    fixtures: SageMakerFixtureDocumentSchema,
  })
  .strict()
  .superRefine((file, context) => {
    if (file.fixtures.source !== "recorded") context.addIssue({ code: "custom", path: ["fixtures", "source"], message: "a recording's fixtures are recorded" });
    if (file.fixtures.rules?.length !== file.pairs) context.addIssue({ code: "custom", path: ["pairs"], message: "one rule for each pair" });
  });
export type SageMakerRecordingFile = z.infer<typeof SageMakerRecordingFileSchema>;

/** Where one finding is, and what kind: the path names the field (`rules[3].response.body`), never what was found. */
export interface SageMakerRecordingFinding { kind: PiiKind; path: string }

export type SageMakerRescan =
  | { ok: true; file: SageMakerRecordingFile; digest: string; /** Bodies that are not text, so the scan read them only as bytes: a person looks at those. */ binaryBodies: number }
  | { ok: false; reason: "invalid" | "findings"; findings: SageMakerRecordingFinding[] };

const FINDINGS_MAX = 100;

/**
 * The re-scan on upload: the file is parsed against the contract, then every request text and every answer text in its fixture document is scanned with Rovara's scanner. Any finding refuses the file, with the kind and the
 * path of each (never the text). A non-text body cannot be read as text, so it is counted and shown to the person who confirms samples; it is not by itself a refusal. Never throws on a bad file.
 */
export async function rescanSageMakerRecording(input: unknown, scanner: PiiScanner): Promise<SageMakerRescan> {
  const parsed = SageMakerRecordingFileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", findings: [] };
  const findings: SageMakerRecordingFinding[] = [];
  const binary = new Set<string>();
  for (const item of [{ path: "endpointName", text: parsed.data.endpointName, binary: false }, ...sageMakerDocumentTexts(parsed.data.fixtures)]) {
    if (item.binary) binary.add(item.path);
    // Each text is scanned as written, as a reader sees it, and (JSON) decoded: an escape does not hide what it spells.
    for (const kind of (await deepScan(scanner, item.text)).kinds) if (findings.length < FINDINGS_MAX && !findings.some((found) => found.kind === kind && found.path === item.path)) findings.push({ kind, path: item.path });
  }
  if (findings.length > 0) return { ok: false, reason: "findings", findings };
  return { ok: true, file: parsed.data, digest: sageMakerFixtureDigest(parsed.data.fixtures), binaryBodies: binary.size };
}

/** The pairs a person looks at to confirm a recording: the first `count` rules, as one line for the request and one for the answer, each cut short. Text only; a body that is not text says so. */
export function sageMakerRecordingSamples(file: SageMakerRecordingFile, count = 3): Array<{ index: number; request: string; answer: string }> {
  const cut = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}...` : text).replace(/[\p{Cc}\p{Cf}]/gu, " ");
  const texts = sageMakerDocumentTexts(file.fixtures);
  return (file.fixtures.rules ?? []).slice(0, Math.max(0, count)).map((rule, index) => {
    const at = (suffix: string): { text: string; binary: boolean } | undefined => texts.find((item) => item.path === `rules[${String(index)}].${suffix}`);
    const request = at("match.bodyEquals");
    const answer = at("response.body") ?? at("response.json") ?? at("response.bodyBase64");
    return {
      index,
      request: request === undefined ? (rule.match.bodySha256 === undefined ? "(any request)" : `(request not kept; sha256 ${rule.match.bodySha256.slice(0, 12)})`) : cut(request.text),
      answer: rule.response.error !== undefined ? `(error ${rule.response.error.code ?? "ModelError"})` : answer === undefined ? "(empty)" : answer.binary ? "(not text)" : cut(answer.text),
    };
  });
}

/** The fixed words of a refusal, for the recorder and for the upload. */
export const SAGEMAKER_RECORDING_REFUSAL_WORDS = {
  invalid: "This is not a Rovara SageMaker recording file, or it does not match the format.",
  findings: "The file holds data that looks personal, so it was not accepted. Record again from synthetic inputs, or let the recorder redact the answers.",
} as const;
