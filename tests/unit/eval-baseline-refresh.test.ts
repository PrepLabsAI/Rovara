import { expect, it } from "vitest";
import { createEvalBaselines } from "../../packages/worker/src/verification/eval-baseline-refresh.js";
import { evaluateReadiness } from "../../packages/worker/src/readiness.js";
import type { EvalHealthInput } from "../../packages/worker/src/verification/eval-health.js";
const key = { company: "org_aaaaaaaaaaaaaaaaaaaa", project: "p", baseCommit: "a".repeat(40), codeHash: "b".repeat(64), judgePin: "c".repeat(64), evalSetHash: "d".repeat(64), hiddenSetHash: "none", commandFingerprint: "e".repeat(64), catalogRowId: "model", model: "model", modelVersion: "version", settingsFingerprint: "f".repeat(64) };
it("lets the first task proceed while main is measured and joins the refresh", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }); let reads = 0;
  const input = { key, settings: { imageDigest: "image", route: "customer" }, cache: { read: async () => { reads++; await gate; return undefined; } } } as unknown as EvalHealthInput;
  const service = createEvalBaselines();
  const refreshing = service.afterMerge(input);
  let state: string | undefined;
  const task = service.forTask(input).then(result => { state = result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(state).toBe("measuring"); expect(reads).toBe(1);
  } finally { finish(); await Promise.all([refreshing, task]); }
  expect((await refreshing).status).toBe("not_run");
  expect(await service.forTask(input)).toBe("unavailable");
});
it("uses the existing readiness path and refuses unwired eval capabilities without affecting readiness", async () => {
  const result = await evaluateReadiness({ rootPath: process.cwd(), commands: [], evalSetup: {} }, async () => { throw new Error("no commands"); });
  expect(result.ready).toBe(true);
  const measurement = await result.eval!.measurement; expect(measurement.status).toBe("not_run");
  if (measurement.status === "not_run") expect(measurement.message).toContain("not connected");
});
it("reuses complete cached questions and isolates in-flight work by company", async () => {
  const record = { schemaVersion: 1, measures: [{ name: "pass", unit: "fraction", value: 1, direction: "up_good" }], questions: [{ id: "q", samples: Array.from({ length: 3 }, () => ({ pass: true, answer: "a" })) }], caseCount: 1, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1 };
  const input = { key, settings: { imageDigest: "image", route: "customer" }, cache: { read: async () => record } } as unknown as EvalHealthInput;
  const service = createEvalBaselines();
  expect(await service.afterMerge(input)).toEqual({ status: "cached" });
  expect(await service.forTask(input)).toBe("ready");
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const first = service.afterMerge({ ...input, key: { ...key, codeHash: "1".repeat(64) }, cache: { ...input.cache, read: async () => { await pending; return undefined; } } });
  expect(await service.forTask({ ...input, key: { ...key, company: "org_bbbbbbbbbbbbbbbbbbbb", codeHash: "1".repeat(64) } })).toBe("ready");
  finish(); await first;
});

it("does not share an in-flight baseline across different runner settings", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const input = { key, settings: { imageDigest: "image", route: "customer" }, cache: { read: async () => { await gate; return undefined; } } } as unknown as EvalHealthInput;
  const service = createEvalBaselines(); const first = service.afterMerge(input);
  let otherRead = false;
  const other = service.afterMerge({ ...input, settings: { ...input.settings, route: "different" }, cache: { ...input.cache, read: async () => { otherRead = true; return undefined; } } });
  try {
    expect(other).not.toBe(first); expect(otherRead).toBe(true);
    expect((await other).status).toBe("not_run");
  } finally { finish(); await Promise.all([first, other]); }
});
