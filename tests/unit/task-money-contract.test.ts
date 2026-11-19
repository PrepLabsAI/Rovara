import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as contract from "../../packages/contracts/src/index.js";

it("strictly reads the shared task-money snapshot and pins its wire schema", () => {
  const parse = Reflect.get(contract, "parseTaskMoneyV1") as (value: unknown) => unknown;
  expect(parse).toBeTypeOf("function");
  const bytes = readFileSync(new URL("../../contracts/shared/task-money.v1.json", import.meta.url));
  const sample = (JSON.parse(bytes.toString()) as { examples: Record<string, unknown>[] }).examples[0]!;
  expect(parse(sample)).toEqual(sample);
  for (const patch of [{ spentMicros: { state: "available", value: 160 } }, { revision: -1 }, { currency: "EUR" }, { source: {} }, { finality: "final" }, { estimatedMicros: { state: "available", value: Number.MAX_SAFE_INTEGER + 1 } }]) expect(parse({ ...sample, ...patch })).toBeUndefined();
  expect(createHash("sha256").update(readFileSync(new URL("../../packages/contracts/src/task-money.ts", import.meta.url))).digest("hex")).toBe("c7de44191c16bc711e2ef918d2e10336c8ddca58c3921575639b5b2f7aab8d06");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("5f35eba06e7884206679701604e7166cd024510059710714c06cbc607f94733e");
});

it("uses cents and honest running or closed estimates, distinguishing measured zero from unknown", () => {
 const { examples } = JSON.parse(readFileSync("contracts/shared/task-money.v1.json", "utf8")) as { examples: contract.TaskMoneyV1[] };
 const sample = examples[0]!;
 for (const [micros, terminal, want] of [[1_234_567, false, "About $1.23 so far"], [1_234_567, true, "About $1.23 (not yet confirmed)"], [1, false, "under $0.01 so far"], [0, false, "Cost unavailable"], [1_234_560_000, true, "About $1,234.56 (not yet confirmed)"]] as const) {
  expect(contract.taskMoneyWords({ ...sample, terminal, coverage: { ...sample.coverage, awaitingUsageCalls: 0 }, spentMicros: { state: "available", value: micros } })).toBe(want);
 }
 expect(contract.taskMoneyWords(undefined)).toBe("Cost unavailable");
 expect(contract.taskMoneyWords({ ...sample, state: "unavailable", spentMicros: { state: "unavailable", reason: "unreadable" } })).toBe("Cost unavailable");
 expect(contract.taskMoneyWords({ ...sample, state: "current", terminal: true, finality: "final", spentMicros: { state: "available", value: 1_230_000 } })).toBe("$1.23");
});

const sample = (JSON.parse(readFileSync("contracts/shared/task-money.v1.json", "utf8")) as { examples: contract.TaskMoneyV1[] }).examples[0]!;
const zero = { state: "available", value: 0 } as const;
const unmeasured: contract.TaskMoneyV1 = {
 ...sample, revision: 0, state: "unavailable", terminal: false, finality: "unavailable",
 spentMicros: { state: "unavailable", reason: "not_measured" }, finalMicros: { state: "unavailable", reason: "not_measured" }, estimatedMicros: { state: "unavailable", reason: "not_measured" },
 awaitingUsageMicros: { state: "unavailable", reason: "not_measured" }, awaitingUsageCalls: zero,
 coverage: { ...sample.coverage, finalCalls: 0, estimatedCalls: 0, awaitingUsageCalls: 0, incompatibleCurrencyCalls: 0 },
};
const empty: contract.TaskMoneyV1 = {
 ...unmeasured, state: "current", finality: "provisional", spentMicros: zero, finalMicros: zero, estimatedMicros: zero, heldMicros: zero, awaitingUsageMicros: zero,
 coverage: { ...unmeasured.coverage, expectedCalls: zero },
};
const lowerBound: contract.TaskMoneyV1 = {
 ...sample, terminal: false, spentMicros: { state: "available", value: 1_230_000 }, estimatedMicros: { state: "available", value: 1_230_000 },
};
const cases: Array<[string, contract.TaskMoneyV1 | undefined, string]> = [
 ["proven-empty running", empty, "No spend yet"],
 ["proven-empty closed", { ...empty, terminal: true }, "No spend yet"],
 ["unmeasured running (including legacy TOTAL without entries)", unmeasured, "Cost unavailable"],
 ["unmeasured closed", { ...unmeasured, terminal: true }, "Cost unavailable"],
 ["partial zero without complete coverage", { ...empty, state: "partial", coverage: { ...empty.coverage, expectedCalls: sample.coverage.expectedCalls } }, "Cost unavailable"],
 ["partial zero with unpriced calls", { ...empty, state: "partial", unpricedCalls: { state: "available", value: 1 }, coverage: { ...empty.coverage, expectedCalls: { state: "available", value: 1 }, estimatedCalls: 1 } }, "Cost unavailable"],
 ["partial zero awaiting usage", { ...lowerBound, spentMicros: zero, estimatedMicros: zero, awaitingUsageMicros: zero }, "Cost unavailable"],
 ["partial without a measured amount", { ...unmeasured, state: "partial" }, "Cost unavailable"],
 ["read failure", { ...unmeasured, spentMicros: { state: "unavailable", reason: "unreadable" } }, "Cost unavailable"],
 ["absent snapshot", undefined, "Cost unavailable"],
 ["measured running lower bound", lowerBound, "About $1.23 so far"],
 ["measured closed lower bound", { ...lowerBound, terminal: true }, "About $1.23 (not yet confirmed)"],
];
it.each(cases)("keeps %s money honest", (_label, money, words) => {
 if (money !== undefined) expect(contract.parseTaskMoneyV1(money)).toEqual(money);
 expect(contract.taskMoneyWords(money)).toBe(words);
});
