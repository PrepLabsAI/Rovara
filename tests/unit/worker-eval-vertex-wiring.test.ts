// L4-EVV: the pieces of the eval path that decide which API shape a frame may have: the worker's model pin per row, and the contracts' product rows.
import { describe, expect, it } from "vitest";
import { EVAL_DRAFT_PROVIDERS, EVAL_PRODUCT_ROWS, EVAL_VERTEX_PLACEHOLDER, EvalDiscoverySuiteSchema, evalJudgePinOf } from "@agentx/contracts";
import { evalModelPathPattern } from "../../packages/worker/src/verification/eval-wiring.js";

const MODEL = "gemini-2.5-flash";
const vertex = (over: { version?: string; project?: string; location?: string; publisher?: string; model?: string; op?: string } = {}): string =>
  `/${over.version ?? "v1beta1"}/projects/${over.project ?? EVAL_VERTEX_PLACEHOLDER.projectId}/locations/${over.location ?? EVAL_VERTEX_PLACEHOLDER.location}/publishers/${over.publisher ?? "google"}/models/${over.model ?? MODEL}:${over.op ?? "generateContent"}`;

describe("the worker's model pin per eval row", () => {
  it("a gemini row takes exactly the Gemini API forms it always took, and no Vertex form", () => {
    const gemini = evalModelPathPattern("gemini", MODEL);
    expect(gemini.source).toBe("^\\/v1(?:beta)?\\/models\\/gemini-2\\.5-flash:(?:generateContent|streamGenerateContent)$");
    for (const path of [`/v1/models/${MODEL}:generateContent`, `/v1beta/models/${MODEL}:streamGenerateContent`]) expect(gemini.test(path), path).toBe(true);
    for (const path of [vertex(), vertex({ version: "v1" }), `/v1beta/models/other:generateContent`, `/v1beta/models/${MODEL}:countTokens`]) expect(gemini.test(path), path).toBe(false);
  });
  it("a vertex row takes the Vertex forms for the plan's model only, from the placeholder or any plainly shaped project and location", () => {
    const row = evalModelPathPattern("vertex", MODEL);
    for (const path of [vertex(), vertex({ version: "v1" }), vertex({ op: "streamGenerateContent" }), vertex({ project: "deskbot-prod-1", location: "us-central1" }), vertex({ project: "123456789012", location: "global" })]) expect(row.test(path), path).toBe(true);
  });
});

describe("the eval product rows", () => {
  it("the Gemini API and Vertex AI are both Google rows; nothing else is", () => {
    expect(EVAL_PRODUCT_ROWS).toEqual({ gemini: "google", vertex: "google" });
    expect([...EVAL_DRAFT_PROVIDERS]).toEqual(["gemini", "vertex"]);
    expect(Object.isFrozen(EVAL_PRODUCT_ROWS) && Object.isFrozen(EVAL_VERTEX_PLACEHOLDER)).toBe(true);
  });
  it("the placeholder pair is shaped like a real project and location (it passes the gateway's parsers) and is not a real Google name", () => {
    expect(EVAL_VERTEX_PLACEHOLDER.projectId).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
    expect(EVAL_VERTEX_PLACEHOLDER.location).toMatch(/^(?:global|[a-z]{2,15}-[a-z]{2,15}[0-9]{1,2})$/u);
    expect(EVAL_VERTEX_PLACEHOLDER).toEqual({ projectId: "rovara-eval-project", location: "rovara-eval1" });
  });
  it("a judge pin and a suite accept the vertex row, differ from the gemini row's, and refuse any other row", () => {
    const hash = "a".repeat(64);
    const judge = { kind: "rule" as const, scoringPath: "evals/scoring.py" };
    const pins = (row: string) => evalJudgePinOf({ catalogRowId: row, judge, scoringHash: hash });
    expect(pins("vertex")).not.toBe(pins("gemini"));
    expect(() => pins("openai")).toThrow();
    expect(() => pins("gemini-openai")).toThrow();
    expect(EvalDiscoverySuiteSchema.shape).toBeDefined();
  });
});
