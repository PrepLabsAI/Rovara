// Agent knowledge, step (b): the per-person daily limits of team knowledge read OUTSIDE Rovara (300 calls a day, an alert above 150 distinct units). Counters hold numbers and unit ids only, keyed by company, person and day.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, LOCAL_KNOWLEDGE_DAY_CALLS_MAX, LOCAL_KNOWLEDGE_DISTINCT_ALERT, indexExpiresAt } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { knowledgeLimits } from "../../../packages/broker/src/lessons/knowledge-limits.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);

function make(start = T0) {
  const clock = { t: start };
  const store = new MemoryDocumentStore({ indexes: [], nowSeconds: () => Math.floor(clock.t / 1000) });
  const limits = knowledgeLimits({ store, now: () => clock.t, expiry: { attribute: INDEX_EXPIRY_ATTRIBUTE, expiresAt: (ms) => indexExpiresAt(new Date(ms).toISOString()) } });
  return { clock, store, limits };
}
const ids = (from: number, count: number): string[] => Array.from({ length: count }, (_, i) => `les_${String(from + i).padStart(6, "0")}`);

describe("the daily call limit (300 per person)", () => {
  it("allows 300 calls in a day and refuses the 301st; a new UTC day opens again", async () => {
    const { limits, clock } = make();
    for (let n = 0; n < LOCAL_KNOWLEDGE_DAY_CALLS_MAX; n += 1) expect(await limits.takeCall(A, "ann"), String(n)).toBe(true);
    expect(await limits.takeCall(A, "ann")).toBe(false);
    expect(await limits.takeCall(A, "ann")).toBe(false);
    clock.t = Math.floor(clock.t / DAY) * DAY + DAY + 1;
    expect(await limits.takeCall(A, "ann")).toBe(true);
  });
  it("is per person and per company: another person, and the same person id in another company, have their own 300", async () => {
    const { limits } = make();
    for (let n = 0; n < LOCAL_KNOWLEDGE_DAY_CALLS_MAX; n += 1) await limits.takeCall(A, "ann");
    expect(await limits.takeCall(A, "ann")).toBe(false);
    expect(await limits.takeCall(A, "bob")).toBe(true);
    expect(await limits.takeCall(B, "ann")).toBe(true);
  });
  it("keeps its row only company-scoped and expiring: no row holds text, and every row has the store's expiry", async () => {
    const { limits, store } = make();
    await limits.takeCall(A, "ann");
    await limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ["les_000001"] });
    const rows = [...(await store.query({ pk: `ORG#${A}#KNOWLEDGE_READ_DAY` })).items, ...(await store.query({ pk: `ORG#${A}#KNOWLEDGE_UNIT_DAY` })).items, ...(await store.query({ pk: `ORG#${A}#KNOWLEDGE_DISTINCT_DAY` })).items];
    expect(rows.length).toBe(3);
    for (const row of rows) expect(typeof row[INDEX_EXPIRY_ATTRIBUTE]).toBe("number");
    // Only numbers, a day, fixed words and the unit id: none of the attributes can hold text.
    for (const row of rows) expect(Object.keys(row).sort().every((key) => ["pk", "sk", "entityType", "day", "count", "windowStart", "distinct", INDEX_EXPIRY_ATTRIBUTE].includes(key))).toBe(true);
  });
});

describe("the distinct-units alert (above 150 in a day)", () => {
  it("counts each unit once however often it is served, and fires exactly once, on the call that crosses 150", async () => {
    const { limits } = make();
    const first = await limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(0, 10) });
    expect(first).toEqual({ distinct: 10, crossed: false });
    // The same ten again: nothing new.
    expect(await limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(0, 10) })).toEqual({ distinct: 10, crossed: false });
    let crossedAt: number | undefined;
    let fired = 0;
    for (let from = 10; from < 200; from += 10) {
      const answer = await limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(from, 10) });
      if (answer.crossed) { fired += 1; crossedAt = answer.distinct; }
    }
    expect(fired).toBe(1);
    expect(crossedAt).toBe(160);
    // Exactly 150 is not above 150.
    const exact = make();
    for (let from = 0; from < LOCAL_KNOWLEDGE_DISTINCT_ALERT; from += 10) expect((await exact.limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(from, 10) })).crossed).toBe(false);
    expect((await exact.limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(150, 1) })).crossed).toBe(true);
  });
  it("fires once even when two calls cross at the same moment", async () => {
    const { limits } = make();
    await limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(0, 145) });
    const answers = await Promise.all([ids(1000, 10), ids(2000, 10), ids(3000, 10)].map((unitIds) => limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds })));
    expect(answers.filter((answer) => answer.crossed)).toHaveLength(1);
  });
  it("starts again the next day, and is per person and per company", async () => {
    const { limits, clock } = make();
    await limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(0, 151) });
    expect((await limits.noteServed({ companyId: A, project: "payments", developerId: "bob", unitIds: ids(0, 100) })).crossed).toBe(false);
    expect((await limits.noteServed({ companyId: B, project: "payments", developerId: "ann", unitIds: ids(0, 100) })).crossed).toBe(false);
    clock.t += DAY;
    expect(await limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(0, 151) })).toEqual({ distinct: 151, crossed: true });
  });
  it("counts the same unit id served for two projects as two (a person's reach across projects adds up)", async () => {
    const { limits } = make();
    await limits.noteServed({ companyId: A, project: "payments", developerId: "ann", unitIds: ids(0, 100) });
    expect(await limits.noteServed({ companyId: A, project: "billing", developerId: "ann", unitIds: ids(0, 100) })).toEqual({ distinct: 200, crossed: true });
  });
});
