// TE-F1a: the evidence lines. The residual line is shown plainly for every unsealed round; no line ever says "sealed" without "not" before it.
import { describe, expect, it } from "vitest";
import {
  MODEL_EGRESS_CLASSES, MODEL_EGRESS_ROUND_KINDS, NOT_SEALED_BLOCKED_BY_NAME_SENTENCE, SIGV4_NOT_RUN_SENTENCE, evidenceLinesFor, redirectEscapeSentence, type ModelEgressLedger,
} from "@agentx/contracts";

const BLOCK = ["generativelanguage.googleapis.com", "api.openai.com", "sealed.gateway.example.com"];
const UNSAID = /(?<!not )sealed/iu;

describe("evidence lines", () => {
  it("reuses F0a's residual sentence exactly", () => {
    expect(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE).toBe("not sealed; model hosts blocked by name only");
  });
  it("always starts an unsealed round with the residual line, whatever else is in the ledger", () => {
    for (const round of ["working", "check_unsealed"] as const) {
      expect(evidenceLinesFor(round, { classes: [] })[0]).toBe("not sealed; model hosts blocked by name only");
      expect(evidenceLinesFor(round, { classes: ["rate_limit", "cap"], capMicros: 2_000_000, blockList: BLOCK, observedHosts: ["api.openai.com"] })[0]).toBe("not sealed; model hosts blocked by name only");
    }
  });
  it("treats an unknown round kind as unsealed", () => {
    for (const round of ["", "sealed", "SEALED", "check_sealed ", undefined, null, 7, {}]) expect(evidenceLinesFor(round as never, { classes: [] })[0]).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
  });
  it("the sealed round has no residual line and no word 'sealed' at all", () => {
    const lines = evidenceLinesFor("check_sealed", { classes: [...MODEL_EGRESS_CLASSES], capMicros: 2_000_000, blockList: BLOCK, observedHosts: BLOCK, bedrockCalls: 2 });
    expect(lines).not.toContain(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
    expect(lines.join("\n").toLowerCase()).not.toContain("sealed");
  });
  it("gives one fixed line per not-run class, in a fixed order, and none for ok, provider_error or refused", () => {
    const lines = evidenceLinesFor("check_unsealed", { classes: ["ok", "provider_error", "refused", "overloaded", "quota", "rate_limit", "key_refused", "cap", "cap"], capMicros: 2_000_000 });
    expect(lines).toEqual([
      NOT_SEALED_BLOCKED_BY_NAME_SENTENCE,
      "not run: test model budget reached ($2.00 per task)",
      "not run: the product key was refused (check it in Settings)",
      "not run: provider rate limit",
      "not run: provider quota used up",
      "not run: provider overloaded",
    ]);
  });
  it("says a client ignored the redirect, naming the BLOCK LIST's host, once, never an observed spelling", () => {
    const lines = evidenceLinesFor("check_unsealed", { classes: [], blockList: BLOCK, observedHosts: ["API.OpenAI.com:443", "api.openai.com", "[x](http://evil.test) @all", "unrelated.example.org", 5, null] });
    expect(lines).toEqual([NOT_SEALED_BLOCKED_BY_NAME_SENTENCE, redirectEscapeSentence("api.openai.com")]);
    expect(lines.join("\n")).not.toContain("evil");
  });
  it("names a host under a blocked suffix (Azure) as an ignored redirect, and an unlisted Google AI host as such", () => {
    const lines = evidenceLinesFor("check_unsealed", { classes: [], blockList: BLOCK, hostSuffixes: ["openai.azure.com"], observedHosts: ["acme.openai.azure.com", "us-east99-aiplatform.googleapis.com", "evil-openai.azure.com.example.org"] });
    expect(lines).toEqual([
      NOT_SEALED_BLOCKED_BY_NAME_SENTENCE,
      redirectEscapeSentence("acme.openai.azure.com"),
      "not run: unlisted model host (called us-east99-aiplatform.googleapis.com)",
    ]);
  });
  it("shows at most five escaped hosts and counts the rest", () => {
    const hosts = Array.from({ length: 9 }, (_, index) => `h${String(index)}.example.com`);
    const lines = evidenceLinesFor("check_unsealed", { classes: [], blockList: hosts, observedHosts: hosts });
    expect(lines).toHaveLength(1 + 5 + 1);
    expect(lines.at(-1)).toBe("not run: client ignored the redirect (4 more hosts called)");
  });
  it("a host that holds the word sealed is not shown, so no line says it bare", () => {
    const lines = evidenceLinesFor("check_unsealed", { classes: [], blockList: BLOCK, observedHosts: ["sealed.gateway.example.com"] });
    expect(lines.join("\n")).not.toContain("sealed.gateway");
    expect(lines.some((line) => UNSAID.test(line))).toBe(false);
    expect(lines).toContain("not run: client ignored the redirect (called a host whose name is withheld)");
  });
  it("adds the Bedrock line when a Bedrock call was refused", () => {
    expect(evidenceLinesFor("check_unsealed", { classes: [], bedrockCalls: 1 })).toContain(SIGV4_NOT_RUN_SENTENCE);
    expect(evidenceLinesFor("check_unsealed", { classes: [], bedrockCalls: 0 })).not.toContain(SIGV4_NOT_RUN_SENTENCE);
  });
  it("never says sealed without not in front of it, for every round, every class set and hostile hosts", () => {
    let seed = 7;
    const next = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed);
    const hostile = ["sealed.example.com", "SEALED.x.com", "not-sealed.example.com", "unsealed.example.com", "api.openai.com", "x".repeat(400), "a\u0000b", "‮sealed"];
    for (let round = 0; round < 300; round += 1) {
      const kinds = [...MODEL_EGRESS_ROUND_KINDS, "bogus" as never];
      const kind = kinds[next() % kinds.length]!;
      const ledger: ModelEgressLedger = {
        classes: MODEL_EGRESS_CLASSES.filter(() => next() % 2 === 0),
        capMicros: [0, 1, 2_000_000, Number.NaN, -1, 1.5][next() % 6]!,
        blockList: [...BLOCK, ...hostile.filter(() => next() % 2 === 0)],
        observedHosts: hostile.filter(() => next() % 2 === 0),
        bedrockCalls: next() % 3,
      };
      const lines = evidenceLinesFor(kind, ledger);
      for (const line of lines) expect(UNSAID.test(line), `${kind}: ${line}`).toBe(false);
      if (kind !== "check_sealed") expect(lines[0]).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
    }
  });
  it("never throws: not for a null, undefined or non-object ledger, nor for a null or odd round kind", () => {
    for (const ledger of [null, undefined, "x", 5, true, [], () => 1, { classes: null, blockList: null, observedHosts: null, hostSuffixes: null }]) {
      for (const round of [null, undefined, "working", "check_sealed", 7, {}, "check_unsealed"]) {
        let lines: string[] = [];
        expect(() => { lines = evidenceLinesFor(round as never, ledger as never); }, `${String(round)} / ${JSON.stringify(ledger)}`).not.toThrow();
        // A round that is not the sealed one always carries the residual line.
        if (round !== "check_sealed") expect(lines[0]).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
        for (const line of lines) expect(UNSAID.test(line)).toBe(false);
      }
    }
    // A hostile getter on the ledger cannot make it throw either.
    const hostile = { get classes(): never { throw new Error("boom"); } };
    expect(() => evidenceLinesFor("working", hostile as never)).not.toThrow();
  });
  it("does not throw on a malformed ledger", () => {
    for (const ledger of [{}, { classes: "x" }, { classes: [1, null, "nope"] }, { classes: [], blockList: "a" }, { classes: [], observedHosts: 5 }, { classes: [], capMicros: "2" }]) {
      expect(() => evidenceLinesFor("working", ledger as never)).not.toThrow();
    }
  });
});
