import { describe, expect, it } from "vitest";
import { MeasuresFileSchema, readMeasuresFile, readMeasuresFileText } from "../../packages/contracts/src/measures-file.js";
import { EvidenceMeasureSchema } from "../../packages/contracts/src/evidence.js";

const entry = { name: "accuracy", unit: "fraction", value: 0.9, direction: "up_good" };
const file = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, measures: [entry], ...over });

describe("measures file", () => {
  it("shares the evidence measure constraints and reads head-side values without inventing a baseline", () => {
    const read = readMeasuresFile(file({ eval_set_hash: "a".repeat(64), measures: [{ ...entry, spread: 0.01, count: 10 }] }));
    expect(read).toEqual({ status: "ok", file: { schemaVersion: 1, source: "project_runner", eval_set_hash: "a".repeat(64), measures: [{ ...entry, spread: 0.01, count: 10 }] } });
    expect(EvidenceMeasureSchema.safeParse({ name: entry.name, unit: entry.unit, base: 0.8, head: entry.value, direction: entry.direction }).success).toBe(true);
    expect(readMeasuresFileText(`\uFEFF${JSON.stringify(file())}\r\n`).status).toBe("ok");
  });
  it.each([NaN, Infinity, -Infinity, -0, 1e12 + 1, -1e12 - 1])("refuses invalid measure value %s", (value) => {
    expect(readMeasuresFile(file({ measures: [{ ...entry, value }] })).status).toBe("unreadable");
  });
  it.each([NaN, Infinity, -1, -0, 1e12 + 1])("refuses invalid spread %s", (spread) => {
    expect(readMeasuresFile(file({ measures: [{ ...entry, spread }] })).status).toBe("unreadable");
  });
  it.each([NaN, Infinity, -1, -0, 1.5, 100_000_001])("refuses invalid sample count %s", (count) => {
    expect(readMeasuresFile(file({ measures: [{ ...entry, count }] })).status).toBe("unreadable");
  });
  it("accepts finite bounds and refuses unknown keys, empty names, hidden text, excess entries, bad hashes and long labels", () => {
    for (const value of [-1e12, 0, 1e12]) expect(MeasuresFileSchema.safeParse(file({ measures: [{ ...entry, value }] })).success).toBe(true);
    for (const input of [file({ surprise: true }), file({ measures: [{ ...entry, extra: 1 }] }), file({ measures: [] }), file({ measures: Array.from({ length: 51 }, () => entry) }), file({ eval_set_hash: "oops" }), file({ measures: [{ ...entry, name: "" }] }), file({ measures: [{ ...entry, name: "x".repeat(81) }] }), file({ measures: [{ ...entry, unit: "x".repeat(21) }] }), file({ measures: [{ ...entry, name: "hidden\u202E" }] })]) {
      expect(readMeasuresFile(input).status).toBe("unreadable");
    }
  });
  it("ignores unknown versions as newer without interpreting their payload", () => {
    expect(readMeasuresFile({ schemaVersion: 3, measures: "unknown" })).toEqual({ status: "newer" });
    for (const schemaVersion of [0, -1, "2", NaN, Infinity, 1.2]) expect(readMeasuresFile({ schemaVersion }).status).toBe("unreadable");
  });
  it("rejects prototype keys without assigning them and refuses malformed or too-large text", () => {
    expect(readMeasuresFileText('{"schemaVersion":1,"__proto__":{"polluted":true},"measures":[]}').status).toBe("unreadable");
    expect(readMeasuresFileText('{"schemaVersion":1,"measures":[{"name":"x","unit":"x","value":1e999,"direction":"up_good"}]}').status).toBe("unreadable");
    expect(readMeasuresFileText(`${JSON.stringify(file())}${" ".repeat(8 * 1024 * 1024)}`).status).toBe("unreadable");
    expect(readMeasuresFileText("not json").status).toBe("unreadable");
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});

it("rejects duplicate measure names with exact case-sensitive matching", () => {
  expect(MeasuresFileSchema.safeParse(file({ measures: [entry, { ...entry, unit: "ms", value: 5 }] })).success).toBe(false);
  expect(readMeasuresFile(file({ measures: [entry, { ...entry, name: "Accuracy" }] })).status).toBe("ok");
});
it("labels runner measures and refuses a forged measurement source", () => {
  expect(readMeasuresFile(file())).toMatchObject({ status: "ok", file: { source: "project_runner" } });
  expect(readMeasuresFile(file({ source: "project_runner" })).status).toBe("ok");
  expect(readMeasuresFile(file({ source: "rovara" })).status).toBe("unreadable");
});
