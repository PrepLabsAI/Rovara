// TE-F2 part B: the model helper's ledger and summary, read from bytes. A ledger that is malformed, has two headers, holds an overflow marker, an extra key, a row past a bound or is too large is UNTRUSTED (all zero, never "no calls");
// the writer stops at its bounds; a scripted row that names no provenance is task_made (never counted).
import { describe, expect, it } from "vitest";
import { MODEL_LEDGER_MAX_ROWS, UNTRUSTED_MODEL_SUMMARY, createModelLedgerWriter, summarizeModelLedgerBytes, type ModelLedgerRow } from "../../packages/worker/src/model-helper-ledger.js";

const HEADER = { header: 1 as const, mode: "scripted" as const, blockState: "by_name" as const, digest: "a".repeat(64), startedAt: 1 };
const bytes = (...lines: unknown[]): Uint8Array => new TextEncoder().encode(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
const row = (over: Partial<ModelLedgerRow> = {}): ModelLedgerRow => ({ t: 1, kind: "scripted", provenance: "before_task", status: 200, ...over });

describe("summarizing a ledger", () => {
  it("counts by kind and provenance", () => {
    const summary = summarizeModelLedgerBytes(bytes(HEADER, row(), row({ provenance: "task_made" }), row({ kind: "failure_pack", provenance: undefined, status: 429, failureMode: "rate_limit" }), row({ kind: "unmatched", provenance: undefined, status: 400 }), row({ kind: "escape", provenance: undefined, status: 0, host: "api.openai.com" }), row({ kind: "escape", provenance: undefined, status: 0 })));
    expect(summary).toMatchObject({ trusted: true, scripted: { before_task: 1, task_made: 1, independent: 0 }, countsTowardProof: 1, failurePack: 1, unmatched: 1, escapes: { count: 2, hosts: ["api.openai.com"], unreadable: 1 } });
  });
  it("a scripted row with no provenance is task_made and never counted", () => {
    const summary = summarizeModelLedgerBytes(bytes(HEADER, row({ provenance: undefined })));
    expect(summary).toMatchObject({ scripted: { task_made: 1, before_task: 0 }, countsTowardProof: 0 });
  });
  it("is untrusted for an extra key, a second header, an overflow marker, a bad host, an unknown kind, a non-JSON line, an empty ledger and a header that is not first", () => {
    const cases: Uint8Array[] = [
      bytes(HEADER, { ...row(), extra: 1 }), bytes(HEADER, HEADER), bytes(HEADER, { overflow: true }), bytes(HEADER, row({ kind: "escape", provenance: undefined, host: "evil.example.com/../x" })),
      bytes(HEADER, { ...row(), kind: "sneaky" }), new TextEncoder().encode(`${JSON.stringify(HEADER)}\nnot json\n`), new Uint8Array(), bytes(row(), HEADER), bytes({ ...HEADER, blockState: "sealed" }),
    ];
    for (const [index, ledger] of cases.entries()) expect(summarizeModelLedgerBytes(ledger), `case ${String(index)}`).toEqual(UNTRUSTED_MODEL_SUMMARY);
  });
  it("is untrusted past its byte and row bounds", () => {
    expect(summarizeModelLedgerBytes(new Uint8Array(9 * 1024 * 1024))).toEqual(UNTRUSTED_MODEL_SUMMARY);
    const many = [JSON.stringify(HEADER), ...Array.from({ length: MODEL_LEDGER_MAX_ROWS + 5 }, () => JSON.stringify(row()))].join("\n");
    expect(summarizeModelLedgerBytes(new TextEncoder().encode(many))).toEqual(UNTRUSTED_MODEL_SUMMARY);
  });
});

describe("the writer", () => {
  it("writes the header first, refuses past its row bound with an overflow marker (the summary then says nothing), and refuses a row that does not fit the schema", () => {
    const lines: string[] = [];
    const writer = createModelLedgerWriter("/x/l", HEADER, (_path, line) => { lines.push(line); });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ header: 1 });
    for (let i = 0; i < MODEL_LEDGER_MAX_ROWS; i += 1) expect(writer.append(row())).toBe(true);
    expect(writer.append(row())).toBe(false);
    expect(writer.open).toBe(false);
    expect(lines.at(-1)).toBe('{"overflow":true}\n');
    expect(summarizeModelLedgerBytes(new TextEncoder().encode(lines.join("")))).toEqual(UNTRUSTED_MODEL_SUMMARY);
    const other = createModelLedgerWriter("/x/l", HEADER, () => undefined);
    expect(other.append({ ...row(), model: "has space and <html>" })).toBe(false);
    expect(other.open).toBe(false);
  });
  it("a write that throws makes the ledger closed (the loop then refuses calls)", () => {
    let fail = false;
    const writer = createModelLedgerWriter("/x/l", HEADER, () => { if (fail) throw new Error("disk full"); });
    expect(writer.append(row())).toBe(true);
    fail = true;
    expect(writer.append(row())).toBe(false);
    expect(writer.open).toBe(false);
  });
});
