import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { materializeT1Golden, normalizeT1Golden } from "../support/t1-golden-normalizer.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

it("preserves every field name, including hash-shaped and prototype-spelled names", () => {
  const key = hash("field");
  const input: unknown = Object.fromEntries([[key, hash("value")], ["__proto__", { ownerKey: hash("value") }]]);
  expect(normalizeT1Golden(input)).toEqual(Object.fromEntries([[key, "<hex64#1>"], ["__proto__", { ownerKey: "<hex64#1>" }]]));
});

it("normalizes hash shapes by first appearance across rows, keys and exact JSON strings", () => {
  const first = hash("first"), second = hash("second");
  const input = { ownerKey: first, rows: [{ payloadHash: second }, { ownerKey: first }], json: ` { "hash" : "${second}" } `, pk: `IDEMPOTENCY#${first}#workspace` };
  expect(normalizeT1Golden(input)).toEqual({ ownerKey: "<hex64#1>", rows: [{ payloadHash: "<hex64#2>" }, { ownerKey: "<hex64#1>" }], json: ' { "hash" : "<hex64#2>" } ', pk: "IDEMPOTENCY#<hex64#1>#workspace" });
  expect(input.ownerKey).toBe(first);
  expect(normalizeT1Golden({ ownerKey: second })).toEqual({ ownerKey: "<hex64#1>" });
});

it("keeps hash equality, length, case, field presence and ordinary bytes asserted", () => {
  const first = hash("first"), second = hash("second");
  const baseline = { ownerKey: first, rows: [first, second], ordinary: ' { "ok" : true } ' };
  for (const changed of [
    { ...baseline, rows: [second, second] },
    { ...baseline, ownerKey: first.slice(1) },
    { ...baseline, ownerKey: first.slice(1), rows: [first.slice(1), second] },
    { ...baseline, ownerKey: first.toUpperCase() },
    { ...baseline, ownerKey: first.toUpperCase(), rows: [first.toUpperCase(), second] },
    { ...baseline, ownerKey: null },
    { rows: baseline.rows, ordinary: baseline.ordinary },
    { ...baseline, ordinary: '{"ok":true}' },
  ]) expect(normalizeT1Golden(changed)).not.toEqual(normalizeT1Golden(baseline));
  expect(normalizeT1Golden({ base: createHash("sha1").update("base").digest("hex"), ordinary: baseline.ordinary }))
    .toEqual({ base: "<hex40#1>", ordinary: baseline.ordinary });
});

it("committed T1 goldens contain no long raw hexadecimal strings", () => {
  for (const backend of ["memory", "dynamo"]) {
    const text = readFileSync(new URL(`../fixtures/t1-key-goldens/${backend}.json`, import.meta.url), "utf8");
    expect(text).not.toMatch(/[0-9a-f]{40,}/);
  }
});

it("materializes shape-correct replay hashes with consistent embedded references", () => {
  const golden = { base: "<hex40#1>", ownerKey: "<hex64#2>", duplicate: "IDEMPOTENCY#<hex64#2>#workspace", other: "<hex64#3>", json: ' { "hash" : "<hex64#3>" } ' };
  const replay = materializeT1Golden(golden);
  expect(replay.base).toMatch(/^[0-9a-f]{40}$/);
  expect(replay.ownerKey).toMatch(/^[0-9a-f]{64}$/);
  expect(replay.other).toMatch(/^[0-9a-f]{64}$/);
  expect(replay.other).not.toBe(replay.ownerKey);
  expect(replay.duplicate).toBe(`IDEMPOTENCY#${replay.ownerKey}#workspace`);
  expect(replay.json).toBe(` { "hash" : "${replay.other}" } `);
  expect(materializeT1Golden(golden)).toEqual(replay);
  expect(normalizeT1Golden(replay)).toEqual(golden);
  expect(golden.ownerKey).toBe("<hex64#2>");
});

it("refuses raw placeholder collisions rather than accepting a broken runtime hash", () => {
  expect(() => normalizeT1Golden({ ownerKey: "<hex64#1>" })).toThrow("unsupported golden capture");
});
