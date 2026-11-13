// TE-F1a: the model-egress conformance suite on the fake adapter, and the proof that it can fail: each mutant is the fake adapter with ONE defect switched on, and the check that guards that defect must catch it.
import { describe, expect, it } from "vitest";
import { runContract } from "../../packages/testing/src/ports/plugin-contract-kit.js";
import { modelEgressChecks } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { fakeModelEgressWorld } from "../../packages/testing/src/ports/model-egress-world.js";
import type { ModelEgressMutation } from "../../packages/testing/src/ports/model-egress-fake.js";

runContract("model-egress conformance: the fake adapter", modelEgressChecks, () => fakeModelEgressWorld());

/** Runs every check on a world with `mutation` and returns the names of the checks that FAILED. */
async function failingChecks(mutation: ModelEgressMutation): Promise<string[]> {
  const failed: string[] = [];
  for (const check of modelEgressChecks) {
    const world = fakeModelEgressWorld(mutation);
    if (check.needs !== undefined && !check.needs(world)) continue;
    try {
      await check.run(world);
    } catch {
      failed.push(check.name);
    }
  }
  return failed;
}

const KILLERS: Array<[ModelEgressMutation, RegExp]> = [
  ["source_by_id_only", /another company's exactly as it answers one that does not exist/u],
  ["not_found_differs", /another company's exactly as it answers one that does not exist/u],
  ["retry_on_fault", /makes one attempt/u],
  ["retry_on_429", /makes one attempt/u],
  ["forward_inbound_credentials", /drops every inbound credential and places exactly one/u],
  ["two_credentials", /drops every inbound credential and places exactly one/u],
  ["shared_token_cache", /warm adapter serving company A then B/u],
  ["shared_meter", /never move another company's meter/u],
  ["ignore_cap", /refuses past the cap/u],
  ["host_from_frame", /no host but the row's/u],
  ["skip_scrub", /never gives a planted key back/u],
  ["log_request", /never gives a planted key back/u],
  ["no_settle_on_refusal", /streams one head, then chunks, then exactly one settle/u],
  ["reservation_released_on_cut", /cut-off stream keeps its reservation/u],
  ["unfiltered_headers", /only allow-listed response headers/u],
  ["pass_redirect", /never follows or passes on a provider redirect/u],
  ["default_company_on_broken_scope", /fails closed when the company cannot be resolved/u],
  ["no_overrun_block", /takes no further call/u],
  ["wrong_row_host", /no host but the row's/u],
];

describe("the suite fails on an adapter with one defect", () => {
  for (const [mutation, killer] of KILLERS) {
    it(`${mutation}: caught by "${killer.source.slice(0, 50)}"`, async () => {
      const failed = await failingChecks(mutation);
      expect(failed.some((name) => killer.test(name)), `failed checks: ${JSON.stringify(failed)}`).toBe(true);
    }, 30_000);
  }
  it("a world that serves two companies and supplies no brokenScope FAILS the fail-closed check; a one-company world without it passes", async () => {
    const check = modelEgressChecks.find((entry) => /fails closed when the company cannot be resolved/u.test(entry.name))!;
    const two = { ...fakeModelEgressWorld(), brokenScope: undefined };
    await expect(check.run(two)).rejects.toThrow(/must supply brokenScope/u);
    const oneCompany = { ...fakeModelEgressWorld(), brokenScope: undefined, isolation: undefined };
    await expect(check.run(oneCompany)).resolves.toBeUndefined();
  });
  it("passes every check on the honest adapter, so each failure above is the defect's", async () => {
    const failed: string[] = [];
    for (const check of modelEgressChecks) {
      const world = fakeModelEgressWorld();
      if (check.needs !== undefined && !check.needs(world)) continue;
      try {
        await check.run(world);
      } catch (error) {
        failed.push(`${check.name}: ${(error as Error).message.slice(0, 200)}`);
      }
    }
    expect(failed).toEqual([]);
  });
});
