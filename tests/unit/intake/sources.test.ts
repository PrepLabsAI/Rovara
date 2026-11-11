// The project's intake rule on the document store: replaced as a whole, bounded, and the count kept beside it cannot drift.
import { describe, expect, it } from "vitest";
import { intakeSourceCountKey, type IntakeChannelRef, type OrgId } from "@agentx/contracts";
import { INTAKE_MAX_SOURCES_PER_PROJECT, addIntakeSource, intakeSourceIdOf, listAllIntakeSources, listIntakeSources, readIntakeSource, replaceIntakeSources } from "../../../packages/broker/src/core/intake/sources.js";
import { RecordingStore } from "../../support/intake-world.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const table = () => { const store = new RecordingStore(); return { store, table: { store, now: () => Date.parse("2026-11-10T10:00:00.000Z") } }; };
const ref = (label: string, system = "linear"): IntakeChannelRef => ({ channel: "tracker", system, when: { label } });

describe("replacing a project's sources", () => {
  it("writes the set and the count beside it, keeps a source's poll state across a change of its settings, and drops what is not named", async () => {
    const { store, table: t } = table();
    const first = await replaceIntakeSources(t, { orgId: ORG, project: "web", refs: [ref("a"), ref("b", "jira2")], setBy: "me" });
    expect(first).toHaveLength(2);
    expect((await store.get(intakeSourceCountKey(ORG, "web")))?.["count"]).toBe(2);
    await store.update({ key: { pk: "INTAKE_SOURCES", sk: `${ORG}#web#${intakeSourceIdOf(ref("a"))}` }, ops: [{ op: "set", path: ["failures"], value: 3 }] });
    const next = await replaceIntakeSources(t, { orgId: ORG, project: "web", refs: [{ ...ref("a"), when: { label: "a", assignedToRovara: true } }], setBy: "me" });
    expect(next).toHaveLength(1);
    expect((await readIntakeSource(t, ORG, "web", next[0]!.sourceId))?.failures).toBe(3);
    expect((await listIntakeSources(t, ORG, "web")).map((record) => record.ref)).toEqual([{ ...ref("a"), when: { label: "a", assignedToRovara: true } }]);
    expect((await store.get(intakeSourceCountKey(ORG, "web")))?.["count"]).toBe(1);
  });

  it("is per project and per company, and the poll sees every one", async () => {
    const { table: t } = table();
    await replaceIntakeSources(t, { orgId: ORG, project: "web", refs: [ref("a")], setBy: "me" });
    await replaceIntakeSources(t, { orgId: ORG, project: "api", refs: [ref("a")], setBy: "me" });
    await replaceIntakeSources(t, { orgId: OTHER, project: "web", refs: [ref("a")], setBy: "me" });
    expect(await listIntakeSources(t, ORG, "web")).toHaveLength(1);
    expect(await listAllIntakeSources(t)).toHaveLength(3);
  });

  it("refuses more than the most, and the same place twice", async () => {
    const { table: t } = table();
    await expect(replaceIntakeSources(t, { orgId: ORG, project: "web", refs: Array.from({ length: INTAKE_MAX_SOURCES_PER_PROJECT + 1 }, (_, index) => ref(`l${String(index)}`)), setBy: "me" })).rejects.toThrow("too many");
    await expect(replaceIntakeSources(t, { orgId: ORG, project: "web", refs: [ref("a"), ref("b")], setBy: "me" })).rejects.toThrow("named twice");
  });
});

describe("adding one source", () => {
  it("adds it once, leaves the same one alone, and never overwrites one with other settings", async () => {
    const { table: t } = table();
    expect(await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("a"), setBy: "me" })).toBe("added");
    expect(await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("a"), setBy: "me" })).toBe("already_set");
    expect(await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("other"), setBy: "me" })).toBe("differs");
  });

  it("takes the last place once when two adds meet, and refuses a ninth", async () => {
    const { store, table: t } = table();
    for (let index = 0; index < INTAKE_MAX_SOURCES_PER_PROJECT - 1; index += 1) await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("a", `t${String(index)}`), setBy: "me" });
    const results = await Promise.allSettled([
      addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("a", "tx"), setBy: "me" }),
      addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("a", "ty"), setBy: "me" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await listIntakeSources(t, ORG, "web")).toHaveLength(INTAKE_MAX_SOURCES_PER_PROJECT);
    expect((await store.get(intakeSourceCountKey(ORG, "web")))?.["count"]).toBe(INTAKE_MAX_SOURCES_PER_PROJECT);
    await expect(addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("a", "tz"), setBy: "me" })).rejects.toThrow("most intake sources");
  });
});
