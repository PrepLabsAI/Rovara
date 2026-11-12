// The conformance suite every `realtime` adapter must pass: Code's in-process adapter (also the fake), and Cloud's events-service adapter later (over a fake transport).
import { describe, expect, it } from "vitest";
import { REALTIME_BATCH_MAX, type RealtimeAudience, type RealtimeEntry, type RealtimePublisher } from "@agentx/contracts";

/** What the transport carried, as the harness can see it (a listener, a fake transport's requests). */
export interface HeardEntry extends RealtimeEntry {
  companyId: string;
}

export interface RealtimeUnderTest {
  publisher: RealtimePublisher;
  /** Everything the transport carried so far, in order. */
  heard: () => HeardEntry[] | Promise<HeardEntry[]>;
  /** Makes the transport fail (every request) until called with false. */
  setDown: (down: boolean) => void;
  dispose?: () => Promise<void>;
}

export interface RealtimeHarness {
  create(): Promise<RealtimeUnderTest>;
}

const COMPANY = "org_00000000000000000000";
const OTHER = "org_11111111111111111111";
const SESSION: RealtimeAudience = { kind: "session", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" };
const PROJECT: RealtimeAudience = { kind: "project", project: "web" };
const PERSON: RealtimeAudience = { kind: "person", personId: "a".repeat(64) };

export function runRealtimeConformance(name: string, harness: RealtimeHarness): void {
  async function withAdapter<T>(body: (under: RealtimeUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try { return await body(under); } finally { await under.dispose?.(); }
  }

  describe(`realtime conformance: ${name}`, () => {
    it("carries each notice to its audience, for its company, as given", () => withAdapter(async ({ publisher, heard }) => {
      const result = await publisher.publish({ companyId: COMPANY, entries: [
        { audience: SESSION, notice: { type: "session.updated", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", revision: 3 } },
        { audience: PROJECT, notice: { type: "session.updated", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", revision: 3 } },
        { audience: PERSON, notice: { type: "home.changed", revision: 3 } },
      ] });
      expect(result).toEqual({ sent: 3, failed: 0 });
      const carried = await heard();
      expect(carried.map((entry) => [entry.companyId, entry.audience.kind, entry.notice.type])).toEqual([
        [COMPANY, "session", "session.updated"], [COMPANY, "project", "session.updated"], [COMPANY, "person", "home.changed"],
      ]);
      expect(carried[2]?.notice).toEqual({ type: "home.changed", revision: 3 });
    }));

    it("answers an empty batch with nothing sent and nothing failed", () => withAdapter(async ({ publisher }) => {
      expect(await publisher.publish({ companyId: COMPANY, entries: [] })).toEqual({ sent: 0, failed: 0 });
    }));

    it("refuses a notice that carries words or a nested value, and an audience it does not know, counting each as failed and sending the rest", () => withAdapter(async ({ publisher, heard }) => {
      const result = await publisher.publish({ companyId: COMPANY, entries: [
        { audience: SESSION, notice: { type: "session.updated", title: "Fix the login page for Alice" } },
        { audience: SESSION, notice: { type: "session.updated", nested: { a: 1 } } as never },
        { audience: SESSION, notice: { type: "Not A Type" } },
        { audience: { kind: "everyone" } as never, notice: { type: "home.changed", revision: 1 } },
        { audience: { kind: "person", personId: "*" }, notice: { type: "home.changed", revision: 1 } },
        { audience: PERSON, notice: { type: "home.changed", revision: 2 } },
      ] });
      expect(result).toEqual({ sent: 1, failed: 5 });
      expect((await heard()).map((entry) => entry.notice)).toEqual([{ type: "home.changed", revision: 2 }]);
    }));

    it("never throws: a transport that fails counts every entry as failed", () => withAdapter(async ({ publisher, setDown, heard }) => {
      setDown(true);
      const result = await publisher.publish({ companyId: COMPANY, entries: [{ audience: PERSON, notice: { type: "home.changed", revision: 1 } }] });
      expect(result).toEqual({ sent: 0, failed: 1 });
      setDown(false);
      expect(await publisher.publish({ companyId: COMPANY, entries: [{ audience: PERSON, notice: { type: "home.changed", revision: 2 } }] })).toEqual({ sent: 1, failed: 0 });
      expect((await heard()).map((entry) => entry.notice["revision"])).toEqual([2]);
    }));

    it("returns by the deadline: a batch whose deadline has passed sends nothing and fails every entry", () => withAdapter(async ({ publisher }) => {
      const result = await publisher.publish({ companyId: COMPANY, deadline: Date.now() - 1, entries: [{ audience: PERSON, notice: { type: "home.changed", revision: 1 } }] });
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
    }));

    it("keeps companies apart: a notice is carried for the company of its batch only", () => withAdapter(async ({ publisher, heard }) => {
      await publisher.publish({ companyId: OTHER, entries: [{ audience: PROJECT, notice: { type: "session.updated", sessionId: "ses_bbbbbbbbbbbbbbbbbbbb", revision: 1 } }] });
      await publisher.publish({ companyId: COMPANY, entries: [{ audience: PROJECT, notice: { type: "session.updated", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", revision: 1 } }] });
      const carried = await heard();
      expect(carried.map((entry) => [entry.companyId, entry.notice["sessionId"]])).toEqual([[OTHER, "ses_bbbbbbbbbbbbbbbbbbbb"], [COMPANY, "ses_aaaaaaaaaaaaaaaaaaaa"]]);
    }));

    it("takes a full batch and refuses what is past the batch limit", () => withAdapter(async ({ publisher }) => {
      const entries = Array.from({ length: REALTIME_BATCH_MAX + 1 }, (_, revision) => ({ audience: PERSON, notice: { type: "home.changed", revision } }));
      const result = await publisher.publish({ companyId: COMPANY, entries });
      expect(result).toEqual({ sent: REALTIME_BATCH_MAX, failed: 1 });
    }));
  });
}
