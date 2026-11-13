// TE-F3-b: rovara-measures.json schemaVersion 2 (additive): per-question results (id, category, pass or score, run index) and the seed the runner used. A v1 file still reads exactly as before; a v2 file read by a reader that
// only knows v1 comes back as "newer" (A4's rule), which the eval round turns into "not run" (fail closed).
import { describe, expect, it } from "vitest";
import { MEASURES_FILE_VERSION, MeasuresFileSchema, normalizedQuestions, readMeasuresFile, readMeasuresFileText } from "../../packages/contracts/src/measures-file.js";

const entry = { name: "accuracy", unit: "fraction", value: 0.9, direction: "up_good" };
const q = (over: Record<string, unknown> = {}) => ({ id: "q-1", category: "billing", score: 0.5, ...over });
const v2 = (over: Record<string, unknown> = {}) => ({ schemaVersion: 2, measures: [entry], seed: "seed-7", questions: [q(), q({ id: "q-2", pass: true, score: undefined, run: 1 })], ...over });

describe("measures file version 2", () => {
  it("reads per-question results: id, category, pass or score, and an optional run index", () => {
    const read = readMeasuresFile(v2());
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.file.schemaVersion).toBe(2);
    expect(normalizedQuestions(read.file)).toEqual([
      { id: "q-1", category: "billing", score: 0.5, run: 0 },
      { id: "q-2", category: "billing", score: 1, run: 1 },
    ]);
  });
  it("turns pass false into score 0 and keeps a score as it is", () => {
    const read = readMeasuresFile(v2({ questions: [q({ score: undefined, pass: false }), q({ id: "q-2", score: 0.25 })] }));
    expect(read.status === "ok" ? normalizedQuestions(read.file).map((row) => row.score) : []).toEqual([0, 0.25]);
  });
  it("still reads a v1 file exactly as before, and a v1 file cannot carry questions or a seed", () => {
    expect(readMeasuresFile({ schemaVersion: 1, measures: [entry] })).toEqual({ status: "ok", file: { schemaVersion: 1, source: "project_runner", measures: [entry] } });
    expect(readMeasuresFile({ schemaVersion: 1, measures: [entry], questions: [q()] }).status).toBe("unreadable");
    expect(readMeasuresFile({ schemaVersion: 1, measures: [entry], seed: "x" }).status).toBe("unreadable");
    expect(normalizedQuestions(MeasuresFileSchema.parse({ schemaVersion: 1, measures: [entry] }))).toEqual([]);
  });
  it("reads version 2 now (an older reader's 'newer' is A4's rule for any version above what it knows)", () => {
    expect(readMeasuresFile(v2())).toMatchObject({ status: "ok" });
    expect(MEASURES_FILE_VERSION).toBe(2);
  });
  it("still calls a version above 2 newer without reading its payload", () => {
    expect(readMeasuresFile({ schemaVersion: 3, measures: "unknown" })).toEqual({ status: "newer" });
  });
  it.each([
    ["both pass and score", q({ pass: true })],
    ["neither pass nor score", { id: "q-1", category: "billing" }],
    ["a score above 1", q({ score: 1.01 })],
    ["a negative score", q({ score: -0.01 })],
    ["a NaN score", q({ score: NaN })],
    ["negative zero", q({ score: -0 })],
    ["an unknown key", q({ expected: "the answer" })],
    ["a bad id", q({ id: "has space" })],
    ["an empty category", q({ category: "" })],
    ["a run index below 0", q({ run: -1 })],
    ["a fractional run index", q({ run: 1.5 })],
  ])("refuses a question with %s", (_name, row) => {
    expect(readMeasuresFile(v2({ questions: [row] })).status).toBe("unreadable");
  });
  it("refuses the same question and run twice, and one question id under two categories", () => {
    expect(readMeasuresFile(v2({ questions: [q(), q()] })).status).toBe("unreadable");
    expect(readMeasuresFile(v2({ questions: [q(), q({ run: 1, category: "other" })] })).status).toBe("unreadable");
    expect(readMeasuresFile(v2({ questions: [q(), q({ run: 1 })] })).status).toBe("ok");
  });
  it("refuses a bad seed and too many questions, and never assigns a prototype key", () => {
    expect(readMeasuresFile(v2({ seed: "has space" })).status).toBe("unreadable");
    expect(readMeasuresFile(v2({ seed: "" })).status).toBe("unreadable");
    expect(readMeasuresFile(v2({ questions: Array.from({ length: 50_001 }, (_x, index) => q({ id: `q-${String(index)}` })) })).status).toBe("unreadable");
    expect(readMeasuresFileText('{"schemaVersion":2,"measures":[{"name":"a","unit":"u","value":1,"direction":"up_good"}],"questions":[{"__proto__":{"polluted":1},"id":"q","category":"c","score":1}]}').status).toBe("unreadable");
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
  it("reads a few thousand questions fast", () => {
    const text = JSON.stringify(v2({ questions: Array.from({ length: 20_000 }, (_x, index) => q({ id: `q-${String(index)}` })) }));
    const started = Date.now();
    expect(readMeasuresFileText(text).status).toBe("ok");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
