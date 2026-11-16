import { expect, it } from "vitest";
import { MeasuresFileSchema } from "../../packages/contracts/src/measures-file.js";
import { EvalBaseRecordSchema } from "../../packages/contracts/src/eval-base-cache.js";
const measures = [{ name: "accuracy", value: 1, unit: "fraction", direction: "up_good" }];
const question = { id: "__proto__", samples: [{ pass: true, answer: "answer" }] };
it("reads question samples through the existing measures reader and old v1 writers unchanged", () => {
  expect(MeasuresFileSchema.safeParse({ schemaVersion: 1, measures, questions: [question] }).success).toBe(true);
  expect(MeasuresFileSchema.safeParse({ schemaVersion: 1, measures }).success).toBe(true);
  const old = { schemaVersion: 1, measures, caseCount: 1, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1 };
  expect(EvalBaseRecordSchema.safeParse(old).success).toBe(true);
  expect(EvalBaseRecordSchema.safeParse({ ...old, questions: [{ ...question, samples: Array(3).fill(question.samples[0]) }] }).success).toBe(true);
});
it("rejects duplicate identities, unscored numbers, excessive answers and unknown keys", () => {
  for (const questions of [[question, question], [{ ...question, samples: [{ pass: .7, answer: "graded" }] }], [{ ...question, samples: [{ pass: true, answer: "a".repeat(1_048_577) }] }], [{ ...question, surprise: true }]]) {
    expect(MeasuresFileSchema.safeParse({ schemaVersion: 1, measures, questions }).success).toBe(false);
  }
});
