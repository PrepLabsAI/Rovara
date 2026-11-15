import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashEvalDirectory, planEvalRound, readEvalMeasures } from "../../packages/worker/src/verification/eval-round.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function workspace() { const root = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "te-f3c-files-")); roots.push(root); return root; }
describe("the existing measures reader and hidden mount", () => {
  it("reads a real v1 aggregate file unchanged, and fails closed for stale, missing, newer or malformed files", async () => {
    const root = await workspace();
    const location = { root, cwd: ".", argument: "measures.json", notBeforeMs: Date.now() - 1000 };
    const file = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: .8, direction: "up_good", spread: .05, count: 50 }] };
    await writeFile(join(root, location.argument), JSON.stringify(file));
    expect(await readEvalMeasures(location)).toMatchObject({ ok: true, measures: { ...file, source: "project_runner" } });
    expect(await readEvalMeasures({ ...location, notBeforeMs: undefined })).toEqual({ ok: false });
    expect(await readEvalMeasures({ ...location, argument: "missing" })).toEqual({ ok: false });
    for (const text of ["{", JSON.stringify({ ...file, schemaVersion: 999 }), "<testsuite/>"]) {
      await writeFile(join(root, location.argument), text);
      expect(await readEvalMeasures(location)).toEqual({ ok: false });
    }
  });
  it("opens no private set on a working or unsealed round, and the trigger reads nothing when skipped", async () => {
    let opened = 0;
    const source = { exists: async () => true, open: async () => { opened += 1; throw new Error("must not open"); } };
    for (const roundKind of ["working", "check_unsealed"] as const) {
      expect(await planEvalRound({ trigger: { needed: true, reason: "changes" }, roundKind, hiddenSet: source })).toMatchObject({ status: "stopped", output: { result: { notRun: { reason: "hidden_set_needs_sealed_round" } } } });
    }
    expect(await planEvalRound({ trigger: { needed: false, reason: "none_found" }, roundKind: "check_sealed", hiddenSet: source })).toEqual({ status: "stopped", output: { status: "skipped", reason: "none_found" } });
    expect(opened).toBe(0);
  });
  it("resolves the real private path and verifies its hash before returning a read-only mount", async () => {
    const root = await workspace();
    await writeFile(join(root, "data"), "private-canary");
    const hash = await hashEvalDirectory(root);
    const parent = await workspace(); const link = join(parent, "link"); await symlink(root, link);
    const source = { exists: async () => true, open: async () => ({ hostPath: link, hash }) };
    const plan = await planEvalRound({ trigger: { needed: true, reason: "changes" }, roundKind: "check_sealed", hiddenSet: source });
    expect(plan).toMatchObject({ status: "ready", hiddenHash: hash, hiddenMount: { readOnly: true, containerPath: "/rovara/hidden-eval" } });
    if (plan.status === "ready") expect(plan.hiddenMount!.hostPath).not.toBe(link);
    expect(JSON.stringify(plan)).not.toContain("private-canary");
    await writeFile(join(root, "data"), "changed");
    expect(await planEvalRound({ trigger: { needed: true, reason: "changes" }, roundKind: "check_sealed", hiddenSet: source })).toMatchObject({ status: "stopped", output: { result: { notRun: { reason: "hidden_set_unavailable" } } } });
  });
  it("fails closed on empty or linked directories and unavailable hidden storage", async () => {
    const root = await workspace();
    await expect(hashEvalDirectory(root)).rejects.toThrow();
    await writeFile(join(root, "target"), "data"); await symlink(join(root, "target"), join(root, "link"));
    await expect(hashEvalDirectory(root)).rejects.toThrow();
    const source = { exists: async () => true, open: async () => { throw new Error("private-path-canary"); } };
    const plan = await planEvalRound({ trigger: { needed: true, reason: "changes" }, roundKind: "check_sealed", hiddenSet: source });
    expect(plan).toMatchObject({ status: "stopped", output: { result: { notRun: { reason: "hidden_set_unavailable" } } } });
    expect(JSON.stringify(plan)).not.toContain("private-path-canary");
  });
});
