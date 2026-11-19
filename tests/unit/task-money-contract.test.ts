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
  expect(createHash("sha256").update(readFileSync(new URL("../../packages/contracts/src/task-money.ts", import.meta.url))).digest("hex")).toBe("7f69850e2004cb76ea15aad84e46770e61f3762a51badc82908e9f3fd89fef6a");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("5f35eba06e7884206679701604e7166cd024510059710714c06cbc607f94733e");
});

it("uses cents and honest running or closed estimates, distinguishing measured zero from unknown", () => {
 const { examples } = JSON.parse(readFileSync("contracts/shared/task-money.v1.json", "utf8")) as { examples: contract.TaskMoneyV1[] };
 const sample = examples[0]!;
 for (const [micros, terminal, want] of [[1_234_567, false, "About $1.23 so far"], [1_234_567, true, "About $1.23 (not yet confirmed)"], [1, false, "under $0.01 so far"], [0, false, "No spend yet"], [1_234_560_000, true, "About $1,234.56 (not yet confirmed)"]] as const) {
  expect(contract.taskMoneyWords({ ...sample, terminal, coverage: { ...sample.coverage, awaitingUsageCalls: 0 }, spentMicros: { state: "available", value: micros } })).toBe(want);
 }
 expect(contract.taskMoneyWords(undefined)).toBe("Cost unavailable");
 expect(contract.taskMoneyWords({ ...sample, state: "unavailable", spentMicros: { state: "unavailable", reason: "unreadable" } })).toBe("Cost unavailable");
 expect(contract.taskMoneyWords({ ...sample, state: "current", terminal: true, finality: "final", spentMicros: { state: "available", value: 1_230_000 } })).toBe("$1.23");
});

it("labels a new unreported task without inventing an amount, while read failures and closed unknowns stay unavailable", () => {
 const { examples } = JSON.parse(readFileSync("contracts/shared/task-money.v1.json", "utf8")) as { examples: contract.TaskMoneyV1[] };
 const initial: contract.TaskMoneyV1 = { ...examples[0]!, state: "unavailable", revision: 0, terminal: false, spentMicros: { state: "unavailable", reason: "not_measured" }, coverage: { ...examples[0]!.coverage, finalCalls: 0, estimatedCalls: 0, awaitingUsageCalls: 0, incompatibleCurrencyCalls: 0 } };
 expect(contract.taskMoneyWords(initial)).toBe("No spend yet");
 expect(contract.taskMoneyWords({ ...initial, spentMicros: { state: "unavailable", reason: "unreadable" } })).toBe("Cost unavailable");
 expect(contract.taskMoneyWords({ ...initial, terminal: true })).toBe("Cost unavailable");
});
