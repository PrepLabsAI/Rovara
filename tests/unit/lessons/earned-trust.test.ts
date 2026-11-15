// Earned trust (DEC 231): the tally behind "Let low-risk lessons go live on trial?". Counts only, the project's own lessons only, bounded, and in doubt no offer.
import { companyScoped, DocumentStoreError, type OrgId } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import {
  TRIAL_OFFER_LESSONS_MAX, snoozeTrialOffer, tallyTrialOffer, trialOfferEarned, trialOfferSnoozed,
} from "../../../packages/broker/src/lessons/earned-trust.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { lessonRecord } from "./lesson-helpers.js";

const A = "org_trustoffer00000000000a" as OrgId;
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const KEY = { workspaceId: A, project: "payments" };
const kept = (id: string, over: Partial<Lesson> = {}) => lessonRecord({ id, workspaceId: A, project: "payments", status: "active", approvals: [{ approvalId: id, by: "ann", at: NOW - DAY, mode: "one" }], updatedAt: NOW - DAY, ...over });
const listOf = (lessons: Lesson[]) => ({ list: async () => lessons });

describe("the earned-trust tally", () => {
  it("control: person approvals and person drops in the window", async () => {
    const lessons = [...Array.from({ length: 10 }, (_, i) => kept(`les_k${String(i)}`)), kept("les_d1", { status: "rejected", approvals: [] }), kept("les_old", { status: "rejected", approvals: [], updatedAt: NOW - 91 * DAY })];
    expect(await tallyTrialOffer(listOf(lessons), KEY, NOW)).toEqual({ approvals: 10, drops: 1, since: NOW - 90 * DAY });
  });

  it("the threshold: 10 approvals, and drops at most a fifth of the decisions", () => {
    expect(trialOfferEarned({ approvals: 10, drops: 2, since: 0 })).toBe(true);
    expect(trialOfferEarned({ approvals: 10, drops: 3, since: 0 })).toBe(false);
    expect(trialOfferEarned({ approvals: 9, drops: 0, since: 0 })).toBe(false);
    expect(trialOfferEarned({ approvals: 40, drops: 10, since: 0 })).toBe(true);
    expect(trialOfferEarned({ approvals: 40, drops: 11, since: 0 })).toBe(false);
  });

  it("the store is not trusted to filter: another company's or project's lesson is never counted", async () => {
    const lessons = [kept("les_mine"), kept("les_other", { workspaceId: "org_trustoffer00000000000b" }), kept("les_proj", { project: "billing" })];
    expect(await tallyTrialOffer(listOf(lessons), KEY, NOW)).toMatchObject({ approvals: 1 });
  });

  it("bounded and never a guess: too many lessons, or a store that fails, is no tally", async () => {
    const many = Array.from({ length: TRIAL_OFFER_LESSONS_MAX + 1 }, (_, i) => kept(`les_m${String(i)}`));
    const started = Date.now();
    expect(await tallyTrialOffer(listOf(many), KEY, NOW)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await tallyTrialOffer(listOf(many.slice(0, TRIAL_OFFER_LESSONS_MAX)), KEY, NOW)).toMatchObject({ approvals: TRIAL_OFFER_LESSONS_MAX });
    expect(await tallyTrialOffer({ list: async () => { throw new Error("down"); } }, KEY, NOW)).toBeUndefined();
  });
});

describe("not now", () => {
  it("is the company's own row, holds no person, is kept 30 days and read with its time; a row that cannot be read counts as snoozed", async () => {
    const db = new MemoryDocumentStore({ ttlAttribute: "expiresAt", nowSeconds: () => Math.floor(NOW / 1000) });
    expect(await trialOfferSnoozed(db, A, "payments", NOW)).toBe(false);
    await snoozeTrialOffer(db, A, "payments", NOW);
    const row = await db.get({ pk: companyScoped(A, "LESSON_TRIAL_OFFER#payments"), sk: "NOT_NOW" });
    expect(row).toMatchObject({ entityType: "LESSON_TRIAL_OFFER", at: NOW, expiresAt: Math.floor(NOW / 1000) + 30 * 86_400 });
    expect(Object.keys(row!).sort()).toEqual(["at", "entityType", "expiresAt", "pk", "sk"]);
    expect(await trialOfferSnoozed(db, A, "payments", NOW + 29 * DAY)).toBe(true);
    expect(await trialOfferSnoozed(db, A, "payments", NOW + 31 * DAY)).toBe(false);
    expect(await trialOfferSnoozed(db, A, "billing", NOW)).toBe(false);
    expect(await trialOfferSnoozed(db, "org_trustoffer00000000000b", "payments", NOW)).toBe(false);
    db.injectFault(new DocumentStoreError("unavailable", "down"));
    expect(await trialOfferSnoozed(db, A, "billing", NOW)).toBe(true);
  });
});
