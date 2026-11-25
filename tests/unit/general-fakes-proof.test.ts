// General fakes slice 1 (DEC 234): the setting, the payload, the fixed words, and the NEVER-PROOF rule along the whole proof path: the worker writes `madeByRovara` facts into the test proof, the broker turns
// them into a `made_by_rovara` dependency (so #588's proof table says "with a Rovara-made mock; not Proven"), the v1 lines say so first, and the hold rule never counts such a check.
import { describe, expect, it } from "vitest";
import {
  GENERAL_FAKE_LABEL, GENERAL_FAKE_NOT_RUN_SENTENCES, GeneralFakesSettingSchema, ProjectDefinitionSchema, TestProofSchema,
  generalFakesPayloadOf, generalFakesRoundLine, proofHolds, workerProjectDefinition, type TestProof,
} from "@agentx/contracts";
import { withGeneralFakeFacts } from "../../packages/worker/src/verification/test-proof.js";
import { definition } from "../support/task-flow-harness.js";

const DIGEST = "1".repeat(64);
const proof = (extra: Partial<TestProof> = {}): TestProof => ({
  schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 },
  items: [{ checkId: "readiness:0", label: "Unit tests", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" }], durationMs: 1, ...extra,
});

describe("the setting and the payload", () => {
  it("is off unless it parses, is enabled and names a service; a damaged value is off", () => {
    const on = { enabled: true, services: [{ variable: "PAYMENTS_API_URL", spec: "repo/api/openapi.yaml" }] };
    expect(generalFakesPayloadOf(on)).toEqual({ services: on.services });
    for (const value of [undefined, null, "on", { enabled: false, services: on.services }, { enabled: true, services: [] }, { enabled: true }, { ...on, extra: 1 }]) expect(generalFakesPayloadOf(value)).toBeUndefined();
  });

  it("refuses reserved, lowercase, duplicate and escaping values", () => {
    for (const service of [{ variable: "PATH" }, { variable: "NODE_OPTIONS" }, { variable: "LD_PRELOAD" }, { variable: "HTTPS_PROXY" }, { variable: "lower" }, { variable: "OK_URL", spec: "../x.yaml" }, { variable: "OK_URL", spec: "/abs.yaml" }, { variable: "OK_URL", spec: "a/./b.yaml" }, { variable: "OPENAI_BASE_URL" }, { variable: "GIT_DIR" }, { variable: "AGENTX_WORKER" }, { variable: "BASH_ENV" }, { variable: "NODE_EXTRA_CA_CERTS" }, { variable: "OK_URL", spec: ".agentx/state.json" }, { variable: "OK_URL", spec: "repo/.hidden/openapi.yaml" }]) {
      expect(GeneralFakesSettingSchema.safeParse({ enabled: true, services: [service] }).success, JSON.stringify(service)).toBe(false);
    }
    expect(GeneralFakesSettingSchema.safeParse({ enabled: true, services: [{ variable: "A_URL" }, { variable: "A_URL" }] }).success).toBe(false);
  });

  it("a project without the setting parses and reaches the worker exactly as before; the setting never reaches the worker (golden)", () => {
    const parsed = ProjectDefinitionSchema.parse(definition);
    expect(parsed).not.toHaveProperty("generalFakes");
    expect(JSON.stringify(workerProjectDefinition(parsed))).toBe(JSON.stringify(workerProjectDefinition(definition)));
    const withSetting = ProjectDefinitionSchema.parse({ ...definition, generalFakes: { enabled: true, services: [{ variable: "PAYMENTS_API_URL" }] } });
    expect(withSetting.generalFakes).toEqual({ enabled: true, services: [{ variable: "PAYMENTS_API_URL" }] });
    expect(JSON.stringify(workerProjectDefinition(withSetting))).toBe(JSON.stringify(workerProjectDefinition(parsed)));
  });

  it("the words are fixed: the shared trust label, a number, and Not run sentences with no placeholder", () => {
    expect(GENERAL_FAKE_LABEL).toBe("Made by Rovara");
    expect(generalFakesRoundLine(3)).toBe("Made by Rovara: 3 outside calls in this check round were answered by fakes Rovara made from your OpenAPI description. They never count as change proof.");
    expect(generalFakesRoundLine(1)).toContain(": 1 outside call in this check round was answered");
    expect(generalFakesRoundLine(Number.NaN)).toContain(": 0 outside calls");
    for (const sentence of Object.values(GENERAL_FAKE_NOT_RUN_SENTENCES)) {
      expect(sentence).toMatch(/^Not run: /u);
      expect(sentence).not.toMatch(/[{}$<>]/u);
    }
  });
});

describe("never proof", () => {
  it("the worker writes the facts only when there are some; absent facts keep the proof the same object", () => {
    const base = proof();
    expect(withGeneralFakeFacts(base, undefined)).toBe(base);
    expect(withGeneralFakeFacts(base, { unknown: false, checks: [] })).toBe(base);
    expect(withGeneralFakeFacts(base, { unknown: false, checks: [{ checkId: "readiness:0", served: 3 }] }).madeByRovara).toEqual([{ checkId: "readiness:0", served: 3 }]);
    // Unknown: every check the proof lists is fake-answered too.
    expect(withGeneralFakeFacts(base, { unknown: true, checks: [] }).madeByRovara).toEqual([{ checkId: "readiness:0", served: 1 }]);
    expect(() => withGeneralFakeFacts(base, { unknown: false, checks: Array.from({ length: 201 }, (_, index) => ({ checkId: `readiness:${String(index)}`, served: 1 })) })).toThrow("unsupported general fake facts");
  });

  it("a present unreadable madeByRovara part invalidates the whole proof for readers", () => {
    for (const madeByRovara of ["broken", [{ checkId: "readiness:0", served: 0 }], [{ checkId: "readiness:0", served: 1 }, { checkId: "readiness:0", served: 2 }]]) {
      expect(TestProofSchema.safeParse({ ...proof(), madeByRovara }).success, JSON.stringify(madeByRovara)).toBe(false);
    }
  });

  it("the hold rule never counts a fake-answered proving check", () => {
    const facts = { proof: proof() };
    expect(proofHolds({ facts, mode: "hold" }).provenCount).toBe(1);
    expect(proofHolds({ facts: { proof: proof({ madeByRovara: [{ checkId: "readiness:0", served: 1 }] }) }, mode: "hold" }).provenCount).toBe(0);
  });

});
