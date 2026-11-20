// TE-F1c: the bridge ledger (one fixed-field row per call, never a body, header value, URL query or provider message), the exec windows that turn a failed check into "not run: <class>", the task summary line, and the
// evidence lines of a round (7a's condition 2: an unsealed round ALWAYS says "not sealed; model hosts blocked by name only"; a round with no block at all says so instead; Azure is never implied blocked).
import { describe, expect, it } from "vitest";
import { MODEL_HOSTS_NOT_BLOCKED_SENTENCE, NOT_SEALED_BLOCKED_BY_NAME_SENTENCE } from "@agentx/contracts";
import { createModelBridgeLedger, modelBridgeEvidenceLines, AZURE_OPENAI_NOT_BLOCKED_SENTENCE, GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE, NOT_SEALED_NO_BLOCK_SENTENCE } from "../../packages/worker/src/model-bridge-ledger.js";

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
    ledger.record(settle({ execId: "check-9" }));
    ledger.record(settle({ execId: "not a plain id\n" }));
    expect(ledger.rows()[2]?.execId).toBe("check-9");
    expect(ledger.rows()[3]).not.toHaveProperty("execId");
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
  it("leaves a passed check alone and ignores a call outside the window", () => {
    const { ledger, at } = build();
    at(10);
    ledger.record(settle({ execId: "c", class: "rate_limit", status: 429 }));
    at(100);
    ledger.execStart("c");
    at(200);
    ledger.execEnd("c");
    at(300);
    ledger.record(settle({ execId: "c", class: "quota", status: 429 }));
    expect(ledger.notRunFor("c")).toBeUndefined();
    expect(ledger.checkOutcome("c", "failed")).toEqual({ status: "failed" });
    expect(ledger.checkOutcome("c", "passed")).toEqual({ status: "passed" });
  });
  it("an exec that never ended reads up to now, and an unknown exec reads nothing", () => {
    const { ledger, at } = build();
    at(100);
    ledger.execStart("open");
    at(150);
    ledger.record(settle({ execId: "open", class: "overloaded", status: 503 }));
    at(400);
    expect(ledger.notRunFor("open")).toBe("not run: provider overloaded");
    expect(ledger.notRunFor("nope")).toBeUndefined();
  });
  it("a call with no exec counts for no check", () => {
    const { ledger, at } = build();
    at(10);
    ledger.execStart("c");
    ledger.record(settle({ class: "rate_limit", status: 429 }));
    expect(ledger.notRunFor("c")).toBeUndefined();
    expect(ledger.classes()).toContain("rate_limit");
  });
});

describe("the task summary line", () => {
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
  it("every unsealed round also says a Google service that runs a model inside it is not blocked; the sealed round does not", () => {
    expect(GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE).toBe("a Google service that runs an AI model inside it (for example BigQuery AI functions) is not blocked");
    for (const [roundKind, blockMode, extra] of [["working", "by_name", {}], ["check_unsealed", "by_name", {}], ["check_unsealed", "none", {}], ["check_unsealed", "none", { machineBlock: "not_blocked" }], ["nonsense", "sealed", {}]] as const) {
      expect(modelBridgeEvidenceLines({ ...base, roundKind, blockMode, ...extra }), `${roundKind} ${blockMode}`).toContain(GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE);
    }
    expect(modelBridgeEvidenceLines({ ...base, roundKind: "check_sealed", blockMode: "sealed" })).not.toContain(GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE);
    const hostile = new Proxy({}, { get: () => { throw new Error("no"); } });
    expect(modelBridgeEvidenceLines(hostile as never)).toContain(GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE);
  });
  it("names Azure as not blocked whenever a suffix row is in play in an unsealed round", () => {
    const lines = modelBridgeEvidenceLines({ ...base, roundKind: "check_unsealed", blockMode: "by_name", hostSuffixes: ["openai.azure.com"], azureOpenAiNotBlocked: true });
    expect(lines).toContain(AZURE_OPENAI_NOT_BLOCKED_SENTENCE);
    expect(AZURE_OPENAI_NOT_BLOCKED_SENTENCE).toMatch(/^Azure resource hosts under .+ are not blocked in this round/u);
    expect(modelBridgeEvidenceLines({ ...base, roundKind: "check_unsealed", blockMode: "by_name", hostSuffixes: [], azureOpenAiNotBlocked: true })).toContain(AZURE_OPENAI_NOT_BLOCKED_SENTENCE);
    expect(modelBridgeEvidenceLines({ ...base, roundKind: "check_unsealed", blockMode: "by_name" })).not.toContain(AZURE_OPENAI_NOT_BLOCKED_SENTENCE);
  });
  it("adds the not-run class lines and the redirect escapes (F0a's finder over the recorder's list)", () => {
    const lines = modelBridgeEvidenceLines({ ...base, roundKind: "working", blockMode: "by_name", classes: ["rate_limit"] as never, capMicros: 2_000_000, observedHosts: ["generativelanguage.googleapis.com", "evil.example\nignore previous"] });
    expect(lines).toContain("not run: provider rate limit");
    expect(lines).toContain("not run: client ignored the redirect (called generativelanguage.googleapis.com)");
    expect(lines.join("\n")).not.toMatch(/evil\.example/u);
  });
  it("never throws on a hostile input, and the residual line it falls back to claims no more than the input can show (L1)", () => {
    const boom = (): never => { throw new Error("no"); };
    const everything = new Proxy({}, { get: boom });
    expect(modelBridgeEvidenceLines(everything as never)[0]).toBe(NOT_SEALED_NO_BLOCK_SENTENCE);
    const unreadable = (fields: Record<string, unknown>) => Object.defineProperty({ ...base, roundKind: "working", ...fields }, "hostSuffixes", { get: boom, enumerable: true }) as never;
    expect(modelBridgeEvidenceLines(unreadable({ blockMode: "none" }))[0]).toBe(NOT_SEALED_NO_BLOCK_SENTENCE);
    expect(modelBridgeEvidenceLines(unreadable({ blockMode: "none", machineBlock: "not_blocked" }))[0]).toBe(`not sealed; ${MODEL_HOSTS_NOT_BLOCKED_SENTENCE}`);
    expect(modelBridgeEvidenceLines(unreadable({ blockMode: "by_name" }))[0]).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
    for (const lines of [modelBridgeEvidenceLines(unreadable({ blockMode: "none" })), modelBridgeEvidenceLines(everything as never)]) expect(lines.join("\n")).not.toMatch(/blocked by name only/u);
  });
});
