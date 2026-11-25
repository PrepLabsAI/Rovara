import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as contract from "../../packages/model-gateway/src/meter.js";
const bytes = readFileSync(new URL("../../contracts/shared/charge-receipt.v1.json", import.meta.url));
it("pins the canonical charge receipt schema", () => {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("110f0a01b76568a53c58e6e2f9f364db92b1eed8057e731a4cccd44f198ebfc2");
});
it("reads the canonical receipt and refuses unsafe money and false finality", () => {
  const read = Reflect.get(contract, "parseChargeReceiptV1") as (v: unknown) => unknown;
  expect(read).toBeTypeOf("function");
  const receipt = (JSON.parse(bytes.toString()) as { examples: Array<Record<string, unknown>> }).examples[0]!;
  expect(read(receipt)).toEqual(receipt);
  for (const patch of [{ amountMicros: { state: "available", value: -1 } }, { revision: 1.5 }, { status: "final" }, { currency: "EUR" }, { injected: true }]) expect(read({ ...receipt, ...patch })).toBeUndefined();
});

it("accepts only bounded, explicitly never-confirmed 24h estimates and never makes them final", () => {
  const read = Reflect.get(contract, "parseChargeReceiptV1") as (v: unknown) => unknown;
  const receipt = (JSON.parse(bytes.toString()) as { examples: Array<Record<string, unknown>> }).examples[0]!;
  const estimate = { ...receipt, revision: 2, replacesRevision: 1, status: "estimated", reason: "missing_usage", neverConfirmed: true, amountMicros: { state: "available", value: 40 } };
  expect(read(estimate)).toEqual(estimate);
  for (const patch of [{ neverConfirmed: false }, { neverConfirmed: undefined }, { status: "final" }, { amountMicros: { state: "available", value: 81 } }, { usageComplete: true }]) expect(read({ ...estimate, ...patch })).toBeUndefined();
});
