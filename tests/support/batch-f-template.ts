import { expect } from "vitest";

/**
 * Batch F (8a81d877a, made unconditional by e0efb9461) adds exactly
 * Outputs.ModelRunPriceVersion to the default legacy and named synths.
 * No gateway resource or IAM statement is added in these configurations.
 */
export function withoutBatchFAdditions<T>(input: T): T {
  const copy = structuredClone(input);
  const outputs = (copy as { Outputs: Record<string, unknown> }).Outputs;
  expect(outputs.ModelRunPriceVersion).toStrictEqual({
    Value: "1",
    Description: "Broker signs task run-price ceilings; deploy gateway before broker before workers",
  });
  delete outputs.ModelRunPriceVersion;
  return copy;
}
