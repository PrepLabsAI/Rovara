// General fakes slice 2 (DEC 234; plan briefs/general-fakes-plan.md section 5): the "Made by Rovara" label travels on the CHECK RESULT ITSELF, not only through the test proof. After a round, every check a Rovara-made
// fake answered carries `madeByRovara: true` on its entry, in every round that runs through `runChecks` (the CHECKS round, the coding run's own verification, the test proof's reruns). Fakes never count as proof:
// a labelled check is never a proven one. Without a plan the entries are exactly what they were.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCheckRunners, runChecks, type CheckPlan } from "../../packages/worker/src/verification/checks.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const PETS = JSON.stringify({
  openapi: "3.0.3", info: { title: "pets", version: "1" },
  paths: { "/pets/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1, maximum: 9 } } } } } } } } } },
});
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rovara-gf-label-"));
  roots.push(root);
  await mkdir(join(root, "repo"));
  await writeFile(join(root, "repo", "openapi.json"), PETS);
  return root;
}
const command = (args: string[]) => ({ cwd: ".", executable: process.execPath, args, timeoutSeconds: 30 });
const planOf = (commands: ReturnType<typeof command>[]): CheckPlan => ({ source: "project", readiness: commands, projectBefore: commands.map(() => "passed" as const) });
const options = () => ({ budgetMs: 60_000, signal: new AbortController().signal });

describe("the Made by Rovara label on a check result", () => {

  it("a marker that throws labels every check that ran to a result (fail closed), and leaves a Not run check alone", async () => {
    const root = await workspace();
    const runners = { ...createCheckRunners({ rootPath: root, local: true }), markEntries: () => { throw new Error("boom"); } };
    const round = await runChecks(planOf([command(["-e", "process.exit(0)"]), command(["-e", "process.exit(1)"])]), runners, options());
    expect(round.entries.map((item) => [item.after, item.madeByRovara])).toEqual([["passed", true], ["failed", true]]);
  });

});
