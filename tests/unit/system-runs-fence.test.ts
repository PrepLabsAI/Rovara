// L4-FENCE (review Low of the combined batch): the company's consent row and the project's upkeep row change only if the row is still the one this act READ. A row with no `changedAt` (an older row) used to be written
// with NO condition, so two admins racing meant last write wins. The fence (`seenRowFence`): new row -> still absent; row with `changedAt` -> same `changedAt`; row without `changedAt` -> still there and still without one.
// A lost race is the existing "try again" refusal (RUNTIME_UNAVAILABLE, fixed words), never a silent overwrite.
//
// Mutants (each killed by the test named after it):
//   F1 consent-control.ts: a row seen without `changedAt` is written with no condition (the old bug)              -> "two concurrent writers ... without changedAt" + "a writer that read ... changedAt appears"
//   F2 seenRowFence: the `changedAt` branch drops its `eq` (unconditional)                                         -> "a row whose changedAt moved ..."
//   F3 seenRowFence: the new-row branch is unconditional (no `absent`)                                             -> "two concurrent creators ..."
//   F4 seenRowFence: the no-changedAt branch loses `present()` (only notExists changedAt)                          -> "a row deleted ..."
//   F5 seenRowFence: the no-changedAt branch loses `notExists(changedAt)` (only present)                           -> "two concurrent writers ..."
//   F7 seenRowFence: the no-changedAt branch is unconditional (the old bug moved into the helper)                 -> same tests as F1
//   F8 settings.ts setUpkeepEnabled (the maintainer's plain switch): the put is unconditional / ignores a lost condition  -> the three "plain switch" tests
//   F6 settings.ts: the consent row's put is unconditional / the settings row's put is unconditional               -> the two "setup step" race tests (each row on its own)
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { upkeepSettingsKey } from "../../packages/broker/src/core/upkeep/keys.js";
import { UPKEEP_WORDS, setSystemRunsAndUpkeep, setUpkeepEnabled, type UpkeepSettingsDeps } from "../../packages/broker/src/core/upkeep/settings.js";
import { COMPANY_A } from "../support/wiki-build-fixtures.js";

const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const PERSON = "p1".repeat(32);

/** Releases every caller only once `n` have arrived: both writers have read the row and recorded before either writes. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => { release = resolve; });
  return async () => { arrived += 1; if (arrived >= n) release(); await open; };
};

const consentRow = (extra: Record<string, unknown> = {}) => ({ ...systemRunsConsentKey(COMPANY_A), entityType: "SYSTEM_RUNS_CONSENT", orgId: COMPANY_A, enabled: false, ...extra });
const projectRow = (extra: Record<string, unknown> = {}) => ({ ...upkeepSettingsKey({ orgId: COMPANY_A, project: "beacon" }), entityType: "UPKEEP_SETTINGS", orgId: COMPANY_A, project: "beacon", enabled: false, ...extra });
const consentOf = (store: MemoryDocumentStore) => store.get(systemRunsConsentKey(COMPANY_A));


function setupDeps(store: MemoryDocumentStore, hook: () => Promise<void> = async () => undefined): UpkeepSettingsDeps {
  return {
    store, companyId: COMPANY_A, now: () => T0, standing: async () => ({ access: "manage", companyAdmin: true }), webApp: true, // owner DEC 254zzz91: the website's own client
    record: async () => undefined, recordConsent: async () => { await hook(); }, // the hook runs once per request, after both rows were read and before any write
  };
}
const setup = (deps: UpkeepSettingsDeps) => setSystemRunsAndUpkeep(deps, { personId: PERSON, project: "beacon", requestId: randomUUID(), on: true, allow: true });
const lostSetup = { code: "RUNTIME_UNAVAILABLE", message: `RUNTIME_UNAVAILABLE: ${UPKEEP_WORDS.unreadable}` };

describe("the setup step (setSystemRunsAndUpkeep): both rows are fenced", () => {
  // MUTANT F5/F6: both rows lack changedAt; the concurrent setup requests: one wins, neither row is torn.
  it("two concurrent setup requests on rows without changedAt: exactly one wins and both rows come from the same request", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: consentRow() });
    await store.put({ item: projectRow() });
    const wait = barrier(2);
    const results = await Promise.allSettled([setup(setupDeps(store, wait)), setup(setupDeps(store, wait))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject(lostSetup);
    const c = await consentOf(store);
    const p = await store.get(upkeepSettingsKey({ orgId: COMPANY_A, project: "beacon" }));
    expect(c).toMatchObject({ enabled: true });
    expect(p).toMatchObject({ enabled: true });
    expect(c?.["requestId"]).toBe(p?.["requestId"]);
  });

});

describe("the maintainer's plain switch (setUpkeepEnabled) is fenced too", () => {
  const settingsOf = (store: MemoryDocumentStore) => store.get(upkeepSettingsKey({ orgId: COMPANY_A, project: "beacon" }));
  function plain(store: MemoryDocumentStore, hook: () => Promise<void>, schedule?: string[]): UpkeepSettingsDeps {
    return {
      store, companyId: COMPANY_A, now: () => T0, standing: async () => ({ access: "manage" }), record: async () => { await hook(); },
      ...(schedule === undefined ? {} : { schedule: { put: async () => { schedule.push("put"); }, remove: async () => { schedule.push("remove"); } } }),
    };
  }
  const flip = (deps: UpkeepSettingsDeps, on = true) => setUpkeepEnabled(deps, { personId: PERSON, project: "beacon", requestId: randomUUID(), on, fromPage: true });

  // MUTANT F8: two concurrent switches on a row without changedAt: one wins.
  it("two concurrent switches on a row without changedAt: exactly one wins, the other is told to try again and touches no schedule", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: projectRow() });
    const wait = barrier(2);
    const calls: string[] = [];
    const results = await Promise.allSettled([flip(plain(store, wait, calls)), flip(plain(store, wait, calls))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject(lostSetup);
    expect(await settingsOf(store)).toMatchObject({ enabled: true, changedAt: new Date(T0).toISOString() });
    expect(calls).toEqual(["put"]);
  });

});

