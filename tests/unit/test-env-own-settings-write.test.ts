// The test environment's own write into the project's settings is recorded, so the look a person worked from is not called stale because of it; any other change to the settings still makes it stale.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { lookIsStale, ownWriteOf, readOwnSettingsWrite, recordOwnSettingsWrite } from "../../packages/core/src/core/test-env/own-settings-write.js";

const ORG = "org_00000000000000000000" as never;

describe("the own-write record", () => {
  it("is read back for its project only, and a run of writes in a row keeps the first start", async () => {
    const store = new MemoryDocumentStore();
    expect(await readOwnSettingsWrite({ store }, ORG, "web")).toBeUndefined();
    await recordOwnSettingsWrite({ store }, ORG, "web", { from: 3, to: 4 });
    expect(await readOwnSettingsWrite({ store }, ORG, "web")).toEqual({ from: 3, to: 4 });
    await recordOwnSettingsWrite({ store }, ORG, "web", { from: 4, to: 5 });
    expect(await readOwnSettingsWrite({ store }, ORG, "web")).toEqual({ from: 3, to: 5 });
    // A write that does not continue the run starts a new one.
    await recordOwnSettingsWrite({ store }, ORG, "web", { from: 7, to: 8 });
    expect(await readOwnSettingsWrite({ store }, ORG, "web")).toEqual({ from: 7, to: 8 });
    expect(await readOwnSettingsWrite({ store }, ORG, "other")).toBeUndefined();
  });

  it("refuses a record that does not move the settings forward, and an item that does not read as one is none", async () => {
    const store = new MemoryDocumentStore();
    await recordOwnSettingsWrite({ store }, ORG, "web", { from: 4, to: 4 });
    await recordOwnSettingsWrite({ store }, ORG, "web", { from: 0, to: 3 });
    expect(await readOwnSettingsWrite({ store }, ORG, "web")).toBeUndefined();
    await store.put({ item: { pk: `ORG#${String(ORG)}#PROJECT#web`, sk: "TESTENV#OWN_SETTINGS_WRITE", entityType: "TEST_ENV_OWN_SETTINGS_WRITE", orgId: ORG, project: "web", from: 5, to: 4 } });
    expect(await readOwnSettingsWrite({ store }, ORG, "web")).toBeUndefined();
  });
});

describe("whether a look is stale", () => {
  it("is not stale when it is at or after the settings, or older only by the environment's own write", () => {
    expect(lookIsStale(5, 5, undefined)).toBe(false);
    expect(lookIsStale(6, 5, undefined)).toBe(false);
    expect(lookIsStale(4, 5, undefined)).toBe(true);
    expect(lookIsStale(3, 5, { from: 3, to: 5 })).toBe(false);
    expect(lookIsStale(4, 5, { from: 3, to: 5 })).toBe(false);
  });

  it("is stale again when anyone else changed the settings: the write did not end at the revision now, or the look is from before it", () => {
    expect(lookIsStale(3, 6, { from: 3, to: 5 })).toBe(true);
    expect(lookIsStale(2, 5, { from: 3, to: 5 })).toBe(true);
  });

  it("makes an own write only for exactly the next revision (anything more means someone else saved in between)", () => {
    expect(ownWriteOf(3, 4)).toEqual({ from: 3, to: 4 });
    expect(ownWriteOf(3, 5)).toBeUndefined();
    expect(ownWriteOf(0, 1)).toBeUndefined();
    expect(ownWriteOf(3.5, 4.5)).toBeUndefined();
  });
});
