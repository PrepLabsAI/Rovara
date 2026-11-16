// General fakes slice 2 (DEC 234, review M2): a check a Rovara-made fake answered is NOT a real result, so it never becomes the workspace's recorded "before" for the next task. Without this a task that ran against a fake
// would make the next task (setting off, or no fakes available) read a real failure as a regression.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckEntry, ProjectCommand } from "@agentx/contracts";
import { projectCheckKey, readCheckHistory, restoreCheckHistory } from "../../packages/worker/src/verification/check-history.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const commands: ProjectCommand[] = [0, 1, 2].map((index) => ({ cwd: "app", executable: "npm", args: ["run", `check${String(index)}`], timeoutSeconds: 30 }));
const entry = (index: number, extra: Partial<CheckEntry> = {}): CheckEntry => ({ id: `readiness:${String(index)}`, label: `c${String(index)}`, source: "project", before: "unknown", after: "passed", class: "passing", output: "", durationMs: 1, ...extra });

describe("the check history keeps only real results", () => {
  it("records unlabelled outcomes and leaves the old outcome of a labelled check alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "rovara-gf-history-"));
    roots.push(root);
    await mkdir(join(root, ".agentx"), { recursive: true });
    const base = { lastOutcomes: { [projectCheckKey(commands[0]!)]: "failed" as const } };
    const outcome = await restoreCheckHistory(root, base, { plan: { source: "project", readiness: commands }, entries: [entry(0, { madeByRovara: true }), entry(1), entry(2, { after: "failed", madeByRovara: true })] });
    expect(outcome.outcome).toBe("restored");
    const history = await readCheckHistory(root, {});
    expect(history.lastOutcomes[projectCheckKey(commands[0]!)]).toBe("failed");
    expect(history.lastOutcomes[projectCheckKey(commands[1]!)]).toBe("passed");
    expect(history.lastOutcomes[projectCheckKey(commands[2]!)]).toBeUndefined();
  });
});
