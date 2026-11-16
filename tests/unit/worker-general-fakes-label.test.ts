// General fakes slice 2 (DEC 234; plan briefs/general-fakes-plan.md section 5): the "Made by Rovara" label travels on the CHECK RESULT ITSELF, not only through the test proof. After a round, every check a Rovara-made
// fake answered carries `madeByRovara: true` on its entry, in every round that runs through `runChecks` (the CHECKS round, the coding run's own verification, the test proof's reruns). Fakes never count as proof:
// a labelled check is never a proven one. Without a plan the entries are exactly what they were.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckEntrySchema, GENERAL_FAKE_NOT_RUN_SENTENCES, type CheckEntry, type GeneralFakesPayload } from "@agentx/contracts";
import { createCheckRunners, runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { generalFakesPlanFor, withGeneralFakesRound } from "../../packages/worker/src/general-fakes-round.js";

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
const callPets = (path: string, expectStatus = 200) => ["-e", `fetch(process.env.PETS_API_URL + ${JSON.stringify(path)}).then((r) => process.exit(r.status === ${String(expectStatus)} ? 0 : 1), () => process.exit(3));`];
const command = (args: string[]) => ({ cwd: ".", executable: process.execPath, args, timeoutSeconds: 30 });
const planOf = (commands: ReturnType<typeof command>[]): CheckPlan => ({ source: "project", readiness: commands, projectBefore: commands.map(() => "passed" as const) });
const entry = (id: string): CheckEntry => ({ id, label: "x", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 1 });
const options = () => ({ budgetMs: 60_000, signal: new AbortController().signal });

function fakesRunners(root: string, services: GeneralFakesPayload["services"] = [{ variable: "PETS_API_URL" }]): CheckRunners {
  const plan = generalFakesPlanFor({ services }, { localShell: true, rootPath: root, repositoryPaths: [join(root, "repo")], onResult: () => undefined });
  if (plan === undefined) throw new Error("expected a plan");
  return withGeneralFakesRound(plan, createCheckRunners({ rootPath: root, local: true }));
}

describe("the Made by Rovara label on a check result", () => {
  it("marks exactly the checks a fake answered, and the entry still parses", async () => {
    const root = await workspace();
    const round = await runChecks(planOf([command(callPets("/pets/4")), command(["-e", "process.exit(0)"]), command(callPets("/pets/5"))]), fakesRunners(root), options());
    expect(round.entries.map((entry) => entry.madeByRovara)).toEqual([true, undefined, true]);
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed", "passed", "passed"]);
    for (const entry of round.entries) expect(CheckEntrySchema.safeParse(entry).success).toBe(true);
    // The key is absent, not false, on a check no fake touched (an entry without the label is byte-identical to before).
    expect(Object.hasOwn(round.entries[1]!, "madeByRovara")).toBe(false);
  });

  it("a failing check that a fake answered is labelled too (the fake may be what failed it)", async () => {
    const root = await workspace();
    const round = await runChecks(planOf([command(callPets("/pets/4", 404))]), fakesRunners(root), options());
    expect(round.entries[0]).toMatchObject({ after: "failed", madeByRovara: true });
  });

  it("a check that was Not run for an unanswerable call is Not run with the reason, and carries no label (nothing passed)", async () => {
    const root = await workspace();
    const round = await runChecks(planOf([command(callPets("/owners"))]), fakesRunners(root), options());
    expect(round.entries[0]).toMatchObject({ after: "not_run", output: GENERAL_FAKE_NOT_RUN_SENTENCES.operation_unknown });
    expect(Object.hasOwn(round.entries[0]!, "madeByRovara")).toBe(false);
  });

  it("a call nobody can be blamed for (during setup) labels every check that ran in the round", async () => {
    const root = await workspace();
    const runners = fakesRunners(root);
    const withSetup: CheckRunners = {
      ...runners,
      prepareRound: async (signal) => { await runners.runProjectCommand(command(callPets("/pets/1")), signal); },
    };
    const round = await runChecks(planOf([command(["-e", "process.exit(0)"]), command(["-e", "process.exit(0)"])]), withSetup, options());
    expect(round.entries.map((entry) => entry.madeByRovara)).toEqual([true, true]);
  });

  it("labels carry over from one round to the next only as that round's own facts (a second round without a call is clean)", async () => {
    const root = await workspace();
    const runners = fakesRunners(root);
    const first = await runChecks(planOf([command(callPets("/pets/4"))]), runners, options());
    const second = await runChecks(planOf([command(["-e", "process.exit(0)"])]), runners, options());
    expect(first.entries[0]!.madeByRovara).toBe(true);
    expect(Object.hasOwn(second.entries[0]!, "madeByRovara")).toBe(false);
  });

  it("a round that ended without its entries being marked leaves nothing behind for the next round", async () => {
    const root = await workspace();
    const runners = fakesRunners(root);
    runners.beginCheck?.("readiness:0");
    await runners.runProjectCommand(command(callPets("/pets/4")), new AbortController().signal);
    await runners.endRound?.();
    // The round above was never marked (runChecks threw before it could). A later round with no call must not inherit its label.
    await runners.endRound?.();
    expect(runners.markEntries?.([entry("readiness:0")])).toEqual([entry("readiness:0")]);
  });

  it("a marker that throws labels every check that ran to a result (fail closed), and leaves a Not run check alone", async () => {
    const root = await workspace();
    const runners = { ...createCheckRunners({ rootPath: root, local: true }), markEntries: () => { throw new Error("boom"); } };
    const round = await runChecks(planOf([command(["-e", "process.exit(0)"]), command(["-e", "process.exit(1)"])]), runners, options());
    expect(round.entries.map((item) => [item.after, item.madeByRovara])).toEqual([["passed", true], ["failed", true]]);
  });

  it("without a plan the entries have no label and the runners object is the same", async () => {
    const root = await workspace();
    const runners = createCheckRunners({ rootPath: root, local: true });
    expect(withGeneralFakesRound(undefined, runners)).toBe(runners);
    const round = await runChecks(planOf([command(["-e", "process.exit(0)"])]), runners, options());
    expect(Object.keys(round.entries[0]!).sort()).toEqual(["after", "before", "class", "durationMs", "exitCode", "id", "label", "output", "source"]);
  });
});
