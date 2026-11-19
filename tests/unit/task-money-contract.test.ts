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
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("5f35eba06e7884206679701604e7166cd024510059710714c06cbc607f94733e");
});
