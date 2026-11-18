// Ticket comments as a (weak) lessons source (L4-SRC-TK): the pure filter. Each check is its own test, so a mutant that removes one is caught by that test alone:
// the task's time window, who wrote it (a person's account, not a bot, not Rovara), who that person is (a member of this project now, not erased), and what it says (the no-AI correction filter).
import { describe, expect, it } from "vitest";
import {
  MAX_AUTHORS, MAX_ROWS, MAX_SPANS, TICKET_COMMENT_CHARS, TICKET_PAUSE_KEY, inWindow, isRovareComment, ticketCommentSpans, ticketEventId, ticketSourceKey, ticketSourcePaused, type TicketCommentRow, type TicketCommentsInput,
} from "../../../packages/broker/src/lessons/ticket-comments.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";

const START = Date.parse("2026-11-17T10:00:00.000Z");
const END = Date.parse("2026-11-17T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const RULE = "Error messages shown to customers must come from copy/errors.ts, not inline strings.";
const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

let counter = 0;
const row = (over: Partial<TicketCommentRow> = {}): TicketCommentRow => {
  counter += 1;
  return { id: `c${String(counter)}`, accountId: ANN, isBot: false, body: RULE, createdAt: iso(START + 1_000 * (1 + (counter % 3_000))), updatedAt: iso(START + 1_000 * (1 + (counter % 3_000))), ...over };
};
const people: Record<string, string> = { [ANN]: "dev-ann", [BOB]: "dev-bob" };
function input(rows: TicketCommentRow[], over: Partial<TicketCommentsInput> = {}): TicketCommentsInput {
  return {
    tracker: "linear", ticket: "ENG-12", project: "payments", startedAt: START, endedAt: END, rows,
    personOf: async (account) => people[account], standingOf: async () => "member", ...over,
  };
}
const texts = async (rows: TicketCommentRow[], over: Partial<TicketCommentsInput> = {}) => (await ticketCommentSpans(input(rows, over))).map((s) => s.text);

describe("a kept comment", () => {
  it("is a ticket_comment span of its person, a member's, with a record id that names the ticket and the comment and holds no text, the project's source key, and a project audience", async () => {
    const spans = await ticketCommentSpans(input([row({ id: "cmt-1" })]));
    expect(spans).toEqual([{
      kind: "ticket_comment", text: RULE, trust: "member", authorId: "dev-ann", eventId: "ticket:linear:ENG-12:cmt-1", sourceKey: "linear:payments", audience: { kind: "project" },
    }]);
    expect(spans[0]!.scopes).toBeUndefined();
    expect(spans[0]!.eventId).not.toContain("copy");
  });
  it("the record id and the source key are bounded to one short line", () => {
    expect(ticketEventId("jira", "ENG-12", "x".repeat(200))).toHaveLength(100);
    expect(ticketSourceKey("linear", "p".repeat(200))).toHaveLength(100);
  });
  it("the text is cleaned: a secret is redacted and it is cut to the span limit", async () => {
    const fake = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");
    const [span] = await ticketCommentSpans(input([row({ body: `${RULE} Never log ${fake} in a message. ${"More words. ".repeat(100)}` })]));
    expect(span!.text).not.toContain(fake);
    expect(span!.text.length).toBeLessThanOrEqual(TICKET_COMMENT_CHARS);
  });
});

describe("the task's window", () => {
  it("a comment written before the task started, or at the very moment it started, is the ticket's own brief and is left out", async () => {
    expect(await texts([row({ createdAt: iso(START - 1), updatedAt: iso(START - 1) }), row({ createdAt: iso(START), updatedAt: iso(START) })])).toEqual([]);
    expect(await texts([row({ createdAt: iso(START + 1), updatedAt: iso(START + 1) })])).toEqual([RULE]);
  });
  it("a comment written after the task ended is left out; one written at the very end is kept", async () => {
    expect(await texts([row({ createdAt: iso(END + 1), updatedAt: iso(END + 1) })])).toEqual([]);
    expect(await texts([row({ createdAt: iso(END), updatedAt: iso(END) })])).toEqual([RULE]);
  });
  it("a comment that was edited after the task ended is left out (its words are not the ones written inside the window)", async () => {
    expect(await texts([row({ createdAt: iso(START + 5_000), updatedAt: iso(END + 1) })])).toEqual([]);
    expect(await texts([row({ createdAt: iso(START + 5_000), updatedAt: iso(END - 1) })])).toEqual([RULE]);
  });
  it("a time that cannot be read is outside the window", async () => {
    expect(await texts([row({ createdAt: "soon" }), row({ updatedAt: "later" })])).toEqual([]);
    expect(inWindow({ createdAt: iso(START + 1), updatedAt: iso(START + 1) }, Number.NaN, END)).toBe(false);
    expect(inWindow({ createdAt: iso(START + 1), updatedAt: iso(START + 1) }, START, Number.NaN)).toBe(false);
  });
});

describe("who wrote it: a person's account, not a bot, not Rovara", () => {
  it("a bot, an app or a service-desk customer (the adapter says isBot) is left out", async () => {
    expect(await texts([row({ isBot: true })])).toEqual([]);
  });
  it("a comment with no account id, or an id that is not a plain account id, names nobody and is left out", async () => {
    expect(await texts([row({ accountId: undefined }), row({ accountId: "a b" }), row({ accountId: "x".repeat(129) }), row({ accountId: "" })])).toEqual([]);
  });
  it("an id that is not a plain account id is nobody even when the identity point would place it", async () => {
    const places = { personOf: async () => "dev-any" };
    expect(await texts([row({ accountId: "a b" }), row({ accountId: "x".repeat(129) }), row({ accountId: "a/b" })], places)).toEqual([]);
    expect(await texts([row({ accountId: "712020:a1b2-c3_d4" })], places)).toEqual([RULE]);
  });
  it("Rovara's own comments are left out by their words (a laptop writes with the owner's own account): the status line, the thread root, a decision, the plan notice, the pull request notice", async () => {
    const own = [
      "Rovara started work on this ticket: \"Refunds fail\".", "Rovara: \"Refunds fail\"\nState: Working on it (since Nov 17 14:10 UTC)", "Rovara's plan for this ticket is ready for review: \"Refunds fail\".",
      "Decision recorded: Which retry helper? Use the shared one, please. Ana Ruiz, on Slack.", "Decisions recorded:\n1. Use the shared retry helper everywhere please.", "Plan ready for review: \"Refunds fail\". Risk: low.", "Pull request opened:\nPull request: https://github.com/acme/api/pull/7",
    ];
    expect(await texts(own.map((body) => row({ body })))).toEqual([]);
    expect(own.every(isRovareComment)).toBe(true);
    expect(isRovareComment(RULE)).toBe(false);
  });
});

describe("who that person is: a member of this project now, not erased", () => {
  it("an account the identity point cannot place (a customer, an outside collaborator, another company's person) is left out", async () => {
    expect(await texts([row({ accountId: "99999999-9999-4999-8999-999999999999" })])).toEqual([]);
  });
  it("a person who is not a member of the project now (outsider), or who is erased (undefined), is left out; a member's comment on the same ticket is kept", async () => {
    const standing = { "dev-ann": "member", "dev-bob": "outsider" } as const;
    expect(await texts([row({ accountId: BOB }), row({ accountId: ANN })], { standingOf: async (p) => standing[p as keyof typeof standing] })).toEqual([RULE]);
    expect(await texts([row()], { standingOf: async () => undefined })).toEqual([]);
  });
  it("each account is looked up once, however many comments it wrote, and at most MAX_AUTHORS accounts are looked up", async () => {
    let lookups = 0;
    const many = Array.from({ length: 5 }, () => row());
    await ticketCommentSpans(input(many, { personOf: async (a) => { lookups += 1; return people[a]; } }));
    expect(lookups).toBe(1);
    lookups = 0;
    const authors = Array.from({ length: MAX_AUTHORS + 5 }, (_, i) => row({ accountId: `acct-${String(i)}` }));
    const spans = await ticketCommentSpans(input(authors, { personOf: async (a) => { lookups += 1; return `dev-${a}`; } }));
    expect(lookups).toBe(MAX_AUTHORS);
    expect(spans).toHaveLength(MAX_SPANS);
  });
});

describe("what it says: the no-AI correction filter", () => {
  it("praise, a nit, a bare question, short words and an empty comment are left out; a question that asks for a change is kept", async () => {
    const dropped = ["Looks good to me, nice work on this one", "nit: rename the second heading to something shorter please", "Why is this step needed here at all, though?", "ok thanks", "", "   "];
    expect(await texts(dropped.map((body) => row({ body })))).toEqual([]);
    expect(await texts([row({ body: "Should we use the shared helper here instead of a new loop?" })])).toEqual(["Should we use the shared helper here instead of a new loop?"]);
  });
});

describe("one total limit", () => {
  it("at most MAX_SPANS spans are returned, the newest, oldest first", async () => {
    const rows = Array.from({ length: MAX_SPANS + 4 }, (_, i) => row({ id: `n${String(i)}`, body: `${RULE} Round ${String(i)}.`, createdAt: iso(START + 1_000 * (i + 1)), updatedAt: iso(START + 1_000 * (i + 1)) }));
    const spans = await ticketCommentSpans(input(rows));
    expect(spans).toHaveLength(MAX_SPANS);
    expect(spans[0]!.text.endsWith("Round 4.")).toBe(true);
    expect(spans.at(-1)!.text.endsWith(`Round ${String(MAX_SPANS + 3)}.`)).toBe(true);
  });
  it("a list longer than one read can reach is used not at all (never its oldest part), and is refused in bounded time", async () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, () => row());
    const started = Date.now();
    expect(await texts(rows)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await texts(rows.slice(0, 3))).toEqual([RULE, RULE, RULE]);
  });
});

describe("the project's Pause of this source", () => {
  const key = { workspaceId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments" };
  it("is on when a pause is stored under the source's key (any spelling), off when none is or only another source is paused", async () => {
    const store = new InMemoryLessonStore();
    expect(await ticketSourcePaused(store, key)).toBe(false);
    await store.setFlags(key, { pausedSources: { "linear:billing": { at: 1, reason: "spike" }, "kind:pr_comment": { at: 1, reason: "person" } } });
    expect(await ticketSourcePaused(store, key)).toBe(false);
    await store.setFlags(key, { pausedSources: { [` ${TICKET_PAUSE_KEY} `]: { at: 1, reason: "person" } } });
    expect(await ticketSourcePaused(store, key)).toBe(true);
  });
  it("is on when the flood guard paused the source under its own key (`<tracker>:<project>`), for either tracker and only for this project", async () => {
    for (const name of ["linear:payments", "jira:payments"]) {
      const store = new InMemoryLessonStore();
      await store.setFlags(key, { pausedSources: { [name]: { at: 1, reason: "spike" } } });
      expect(await ticketSourcePaused(store, key), name).toBe(true);
      expect(await ticketSourcePaused(store, { ...key, project: "billing" }), name).toBe(false);
    }
  });
  it("fails closed: a store that cannot be read counts as paused (nothing is read)", async () => {
    expect(await ticketSourcePaused({ flags: async () => { throw new Error("down"); } }, key)).toBe(true);
  });
  it("one project's pause is not another's", async () => {
    const store = new InMemoryLessonStore();
    await store.setFlags(key, { pausedSources: { [TICKET_PAUSE_KEY]: { at: 1, reason: "person" } } });
    expect(await ticketSourcePaused(store, { ...key, project: "billing" })).toBe(false);
    expect(await ticketSourcePaused(store, { workspaceId: "org_bbbbbbbbbbbbbbbbbbbb", project: "payments" })).toBe(false);
  });
});
