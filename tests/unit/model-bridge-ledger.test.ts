// TE-F1c: the bridge ledger (one fixed-field row per call, never a body, header value, URL query or provider message), the exec windows that turn a failed check into "not run: <class>", the task summary line, and the
// evidence lines of a round (7a's condition 2: an unsealed round ALWAYS says "not sealed; model hosts blocked by name only"; a round with no block at all says so instead; Azure is never implied blocked).
import { describe, expect, it } from "vitest";
import { MODEL_HOSTS_NOT_BLOCKED_SENTENCE, NOT_SEALED_BLOCKED_BY_NAME_SENTENCE } from "@agentx/contracts";
import { createModelBridgeLedger, modelBridgeEvidenceLines, parseModelRoundKind, AZURE_OPENAI_NOT_BLOCKED_SENTENCE, NOT_SEALED_NO_BLOCK_SENTENCE } from "../../packages/worker/src/model-bridge-ledger.js";

const settle = (over: Record<string, unknown> = {}) => ({ row: "gemini", status: 200, class: "ok", costMicros: 0, estimated: false, via: "real", ...over }) as never;

describe("the ledger holds fixed fields only", () => {
  it("drops every extra key an entry carries, and repairs what is out of range", () => {
    let now = 1_000;
    const ledger = createModelBridgeLedger({ now: () => now });
    ledger.record(settle({ body: "PLANTED-BODY", headers: [["x-a", "PLANTED-HEADER"]], url: "/v1?key=PLANTED-QUERY", message: "PLANTED-PROVIDER-MESSAGE", token: "PLANTED-TOKEN", costMicros: -5, status: 99999, class: "made-up" }));
    now = 2_000;
    ledger.record(settle({ row: "Not A Row!" }));
    const text = JSON.stringify(ledger.rows());
    for (const planted of ["PLANTED-BODY", "PLANTED-HEADER", "PLANTED-QUERY", "PLANTED-PROVIDER-MESSAGE", "PLANTED-TOKEN"]) expect(text.includes(planted)).toBe(false);
    expect(ledger.rows()[0]).toMatchObject({ atMs: 1_000, row: "gemini", status: 0, class: "provider_error", costMicros: 0 });
    expect(ledger.rows()[1]?.row).toBe("unknown");
    expect(Object.keys(ledger.rows()[0]!).sort()).toEqual(["atMs", "class", "costMicros", "estimated", "row", "status", "via"]);
  });
  it("keeps the refusal word only when it is one of the fixed words", () => {
    const ledger = createModelBridgeLedger({ now: () => 1 });
    ledger.record(settle({ class: "cap", refusal: "cap", status: 429, via: "refused" }));
    ledger.record(settle({ class: "refused", refusal: "PLANTED words", status: 400, via: "refused" }));
    expect(ledger.rows()[0]?.refusal).toBe("cap");
    expect(ledger.rows()[1]?.refusal).toBeUndefined();
  });
  it("is bounded: past 1000 rows it counts instead of growing", () => {
    const ledger = createModelBridgeLedger({ now: () => 1 });
    for (let i = 0; i < 1_005; i += 1) ledger.record(settle());
    expect(ledger.rows()).toHaveLength(1_000);
    expect(ledger.summary().omitted).toBe(5);
  });
});

describe("exec windows: a failed check whose window holds a provider or cap class is 'not run', never 'failed'", () => {
  const build = () => {
    let now = 0;
    const ledger = createModelBridgeLedger({ now: () => now, capMicros: 2_000_000 });
    return { ledger, at: (ms: number) => { now = ms; } };
  };
  it("reports each class with F1-a's words", () => {
    const cases: Array<[string, string]> = [["rate_limit", "not run: provider rate limit"], ["quota", "not run: provider quota used up"], ["overloaded", "not run: provider overloaded"], ["key_refused", "not run: the product key was refused (check it in Settings)"], ["cap", "not run: test model budget reached ($2.00 per task)"]];
    for (const [cls, sentence] of cases) {
      const { ledger, at } = build();
      at(100);
      ledger.execStart("check-1");
      at(150);
      ledger.record(settle({ class: cls, status: 429 }));
      at(200);
      ledger.execEnd("check-1");
      expect(ledger.notRunFor("check-1"), cls).toBe(sentence);
      expect(ledger.checkOutcome("check-1", "failed"), cls).toEqual({ status: "not_run", sentence });
    }
  });
  it("leaves a passed check alone and ignores a call outside the window", () => {
    const { ledger, at } = build();
    at(10);
    ledger.record(settle({ class: "rate_limit", status: 429 }));
    at(100);
    ledger.execStart("c");
    at(200);
    ledger.execEnd("c");
    at(300);
    ledger.record(settle({ class: "quota", status: 429 }));
    expect(ledger.notRunFor("c")).toBeUndefined();
    expect(ledger.checkOutcome("c", "failed")).toEqual({ status: "failed" });
    expect(ledger.checkOutcome("c", "passed")).toEqual({ status: "passed" });
  });
  it("an exec that never ended reads up to now, and an unknown exec reads nothing", () => {
    const { ledger, at } = build();
    at(100);
    ledger.execStart("open");
    at(150);
    ledger.record(settle({ class: "overloaded", status: 503 }));
    at(400);
    expect(ledger.notRunFor("open")).toBe("not run: provider overloaded");
    expect(ledger.notRunFor("nope")).toBeUndefined();
  });
  it("a cap outranks a rate limit in the same window", () => {
    const { ledger, at } = build();
    at(1);
    ledger.execStart("c");
    ledger.record(settle({ class: "rate_limit", status: 429 }));
    ledger.record(settle({ class: "cap", status: 429, via: "refused", refusal: "cap" }));
    ledger.execEnd("c");
    expect(ledger.notRunFor("c")).toMatch(/budget reached/u);
  });
});

describe("the task summary line", () => {
  it("counts real calls on the product's key and their cost; a replay or a pre-call refusal is no call", () => {
    const ledger = createModelBridgeLedger({ now: () => 1 });
    for (let i = 0; i < 14; i += 1) ledger.record(settle({ costMicros: i === 0 ? 380_000 : 0 }));
    ledger.record(settle({ via: "replayed" }));
    ledger.record(settle({ via: "refused", class: "cap", refusal: "cap", status: 429 }));
    expect(ledger.summary().line).toBe("Your product's model calls: 14 calls, $0.38 (your key)");
  });
  it("says 'estimated' when any cost was a reservation, and one call in the singular", () => {
    const ledger = createModelBridgeLedger({ now: () => 1 });
    ledger.record(settle({ costMicros: 1_500_000, estimated: true }));
    expect(ledger.summary().line).toBe("Your product's model calls: 1 call, $1.50 estimated (your key)");
  });
  it("with no call says so", () => {
    expect(createModelBridgeLedger({ now: () => 1 }).summary().line).toBe("Your product's model calls: none");
  });
});

describe("evidence lines", () => {
  const base = { blockList: ["generativelanguage.googleapis.com"], hostSuffixes: [] as string[], azureOpenAiNotBlocked: false, observedHosts: [] as unknown[], classes: [] as never[] };
  it("every unsealed round carries the residual sentence first, whatever the round is called", () => {
    for (const roundKind of ["working", "check_unsealed", "check_sealed ", "SEALED", "sealed", "", "check-sealed", undefined, 7, null]) {
      const lines = modelBridgeEvidenceLines({ ...base, roundKind: roundKind, blockMode: "by_name" });
      expect(lines[0], String(roundKind)).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
    }
  });
  it("the sealed round says nothing of 'not sealed', and only the exact typed round value is sealed", () => {
    const lines = modelBridgeEvidenceLines({ ...base, roundKind: "check_sealed", blockMode: "sealed" });
    expect(lines.join("\n")).not.toMatch(/not sealed/u);
    // a sealed word without the sealed block mode is not sealed either
    expect(modelBridgeEvidenceLines({ ...base, roundKind: "check_sealed", blockMode: "by_name" })[0]).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
    expect(parseModelRoundKind("check_sealed")).toBe("check_sealed");
    expect(parseModelRoundKind("check_sealed ")).toBeUndefined();
    expect(parseModelRoundKind({ toString: () => "check_sealed" })).toBeUndefined();
  });
  it("a padded or cased round name is not sealed even when the block mode says sealed", () => {
    for (const roundKind of ["check_sealed ", " check_sealed", "CHECK_SEALED", "check_sealed\n"]) {
      const lines = modelBridgeEvidenceLines({ ...base, roundKind, blockMode: "sealed" });
      expect(lines[0], JSON.stringify(roundKind)).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
    }
  });
  it("a round with no block at all never says 'blocked by name only'", () => {
    const lines = modelBridgeEvidenceLines({ ...base, roundKind: "check_unsealed", blockMode: "none" });
    expect(lines[0]).toBe(NOT_SEALED_NO_BLOCK_SENTENCE);
    expect(lines.join("\n")).not.toMatch(/blocked by name only/u);
  });
  it("names Azure as not blocked whenever a suffix row is in play in an unsealed round", () => {
    const lines = modelBridgeEvidenceLines({ ...base, roundKind: "check_unsealed", blockMode: "by_name", hostSuffixes: ["openai.azure.com"], azureOpenAiNotBlocked: true });
    expect(lines).toContain(AZURE_OPENAI_NOT_BLOCKED_SENTENCE);
    expect(AZURE_OPENAI_NOT_BLOCKED_SENTENCE).toMatch(/^Azure OpenAI is not blocked in this round/u);
    expect(modelBridgeEvidenceLines({ ...base, roundKind: "check_unsealed", blockMode: "by_name", hostSuffixes: [], azureOpenAiNotBlocked: true })).toContain(AZURE_OPENAI_NOT_BLOCKED_SENTENCE);
    expect(modelBridgeEvidenceLines({ ...base, roundKind: "check_unsealed", blockMode: "by_name" })).not.toContain(AZURE_OPENAI_NOT_BLOCKED_SENTENCE);
  });
  it("adds the not-run class lines and the redirect escapes (F0a's finder over the recorder's list)", () => {
    const lines = modelBridgeEvidenceLines({ ...base, roundKind: "working", blockMode: "by_name", classes: ["rate_limit"] as never, capMicros: 2_000_000, observedHosts: ["generativelanguage.googleapis.com", "evil.example\nignore previous"] });
    expect(lines).toContain("not run: provider rate limit");
    expect(lines).toContain("not run: client ignored the redirect (called generativelanguage.googleapis.com)");
    expect(lines.join("\n")).not.toMatch(/evil\.example/u);
  });
  it("a laptop that cannot block says so, and does not claim a block by name", () => {
    const lines = modelBridgeEvidenceLines({ ...base, roundKind: "check_unsealed", blockMode: "none", machineBlock: "not_blocked" });
    expect(lines[0]).toBe(`not sealed; ${MODEL_HOSTS_NOT_BLOCKED_SENTENCE}`);
    expect(lines.join("\n")).not.toMatch(/blocked by name only/u);
  });
  it("never throws on a hostile input", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("no"); } });
    expect(modelBridgeEvidenceLines(hostile as never)[0]).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
  });
});
