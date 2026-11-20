// Lane L9-wire, review round 1: the lower-level cases (plan feedback, keys, the state folder lock, the message limit, the start transaction).
import { afterEach, describe, expect, it } from "vitest";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { fakeWorld, raw } from "../support/local-pages-fakes.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { PLAN_FEEDBACK_MAX, planFeedbackKey, planFeedbackOf } from "../../packages/broker/src/core/task-flow/stage-machine.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";

describe("M1: the planner is told the newest changes the owner asked for", () => {
  it("keeps the latest words after more than the cap of send-backs, oldest of the kept first", async () => {
    const store = new MemoryDocumentStore();
    for (let round = 1; round <= PLAN_FEEDBACK_MAX + 5; round += 1) await store.put({ item: { ...planFeedbackKey(TASK, round), entityType: "PLAN_FEEDBACK", text: `change ${round}`, createdAt: "2026-11-09T10:00:00.000Z" } });
    const feedback = await planFeedbackOf({ store }, TASK);
    expect(feedback).toHaveLength(PLAN_FEEDBACK_MAX);
    expect(feedback.at(-1)).toBe(`change ${PLAN_FEEDBACK_MAX + 5}`);
    expect(feedback[0]).toBe("change 6");
    expect(feedback).not.toContain("change 1");
  });
});

describe("N3: an address in the process list holds no session and is good once", () => {
  let server: LocalPagesServer | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("redirects the first GET to the owner's page, then answers like a path that does not exist; a code expires; HEAD and a wrong code spend nothing", async () => {
    let clock = 1_000_000;
    const world = fakeWorld();
    server = await createLocalPagesServer({ data: world.data, actions: world.actions, now: () => clock });
    const host = new URL(server.origin).host;
    const get = (path: string, method = "GET") => raw(server!.origin, { method, path, headers: { host } });
    const address = new URL(server.onceLink(`/plan/${TASK}`));
    expect(address.pathname).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}(\/|$)/);
    expect((await get(address.pathname, "HEAD")).status).toBe(404);
    expect((await get("/s/once/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    const hop = await get(address.pathname);
    expect(hop.status).toBe(303);
    expect(hop.headers["location"]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/s/[A-Za-z0-9_-]{43}/plan/${TASK}$|^/s/[A-Za-z0-9_-]{43}/plan/${TASK}$`));
    expect((await get(address.pathname)).status).toBe(404);
    // A code left unused for longer than its time is dead.
    const late = new URL(server.onceLink("/", { ttlMs: 30_000 }));
    clock += 30_001;
    expect((await get(late.pathname)).status).toBe(404);
  });
});
