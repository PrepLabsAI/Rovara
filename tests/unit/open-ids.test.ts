// Port lane P6 (item E1, owner decision 62): tracker, event and intake ids are open and registered by adapters; the fixed lists take no new entry; the comment-command seam is keyed on a subject.
import { describe, expect, it } from "vitest";
import {
  CommentSubjectSchema,
  ConnectionTypeSchema,
  EVENT_SOURCES,
  EVENT_TYPES,
  EventSourceRegistrationSchema,
  INTAKE_CHANNELS,
  IntakeSystemSchema,
  OpenEventTypeSchema,
  OpenSourceIdSchema,
  SubjectCommentsPageSchema,
  checkEventTrigger,
  commentSubjectKey,
  eventSourceCatalog,
  isBuiltInEventSource,
  subjectCommentFromHost,
  type CommentSource,
  type HostComment,
  type RegisteredEventSource,
  type Tracker,
} from "@agentx/contracts";

const EXAMPLE: RegisteredEventSource = { source: "examplehost", types: { "item.created": ["label"], "item.assigned": ["assignee"], "alert.firing": [] } };

describe("the fixed lists take no new entry (decision 62)", () => {
  // If you are here because you added an entry: do not. Register the source with the adapter (`Tracker.eventSource`, open-ids.ts). Changing this list needs the owner's say-so.
  it("event sources are exactly the nine that exist", () => {
    expect([...EVENT_SOURCES]).toEqual(["github", "linear", "jira", "pagerduty", "sentry", "datadog", "grafana", "vercel", "cloudwatch"]);
  });
  it("each source has exactly the event types it had", () => {
    expect(Object.fromEntries(Object.entries(EVENT_TYPES).map(([source, types]) => [source, [...types].length]))).toEqual({ github: 8, linear: 1, jira: 3, pagerduty: 1, sentry: 2, datadog: 1, grafana: 1, vercel: 2, cloudwatch: 1 });
  });
  it("intake channels are exactly the nine that exist", () => {
    expect([...INTAKE_CHANNELS]).toEqual(["web", "cli", "slack", "linear", "jira", "github_issue", "tracker", "session", "offer"]);
  });
  it("connection types are exactly the nine that exist", () => {
    expect([...ConnectionTypeSchema.options]).toEqual(["linear", "jira", "mcp", "sentry", "datadog", "cloudwatch", "grafana", "vercel", "pagerduty"]);
  });
  it("a tracker that is on none of them already has an open way in: the tracker channel names its own system", () => {
    expect(IntakeSystemSchema.safeParse("examplehost").success).toBe(true);
  });
});

describe("open ids", () => {
  it("are short lower-case names, and event types are dotted lower-case words", () => {
    for (const id of ["examplehost", "ex-host", "ex_host2"]) expect(OpenSourceIdSchema.safeParse(id).success, id).toBe(true);
    for (const id of ["", "Example", "1host", "a b", "x".repeat(33), "host.x"]) expect(OpenSourceIdSchema.safeParse(id).success, id).toBe(false);
    for (const type of ["issue.created", "item.assigned_to_rovara", "a.b.c"]) expect(OpenEventTypeSchema.safeParse(type).success, type).toBe(true);
    for (const type of ["created", "Issue.Created", "issue.", ".created", "issue created"]) expect(OpenEventTypeSchema.safeParse(type).success, type).toBe(false);
  });

  it("a registration is one to thirty-two event types with at most ten filter keys each", () => {
    expect(EventSourceRegistrationSchema.safeParse({ types: EXAMPLE.types }).success).toBe(true);
    expect(EventSourceRegistrationSchema.safeParse({ types: {} }).success).toBe(false);
    expect(EventSourceRegistrationSchema.safeParse({ types: { "a.b": Array.from({ length: 11 }, (_, i) => `k${String(i)}`) } }).success).toBe(false);
    expect(EventSourceRegistrationSchema.safeParse({ types: { "a.b": [] }, extra: 1 }).success).toBe(false);
  });
});

describe("the catalog of event sources", () => {
  it("holds the built-in sources and the registered ones, with their filter keys", () => {
    const { sources, skipped } = eventSourceCatalog([EXAMPLE]);
    expect([...sources.keys()]).toEqual([...EVENT_SOURCES, "examplehost"]);
    expect(sources.get("github")?.["pull_request.opened"]).toEqual(["baseBranch", "label", "authorAssociation"]);
    expect(sources.get("examplehost")?.["item.created"]).toEqual(["label"]);
    expect(skipped).toEqual([]);
  });

  it("skips (and reports) a registration that takes a built-in id, another registration's, or is not well formed, and keeps every other source working", () => {
    const { sources, skipped } = eventSourceCatalog([
      { source: "jira", types: { "item.created": [] } }, EXAMPLE, EXAMPLE, { source: "Bad Id", types: { "a.b": [] } }, { source: "okay", types: { "NOT A TYPE": [] } },
      { source: "goodone", types: { "a.b": ["k"] } },
    ]);
    expect(skipped).toEqual([{ source: "jira", reason: "built_in_id" }, { source: "examplehost", reason: "duplicate" }, { source: "invalid", reason: "invalid" }, { source: "okay", reason: "invalid" }]);
    expect([...sources.keys()]).toEqual([...EVENT_SOURCES, "examplehost", "goodone"]);
    // The built-in entry of that name stays the one in force: a Jira tracker's own types did not replace it.
    expect(Object.keys(sources.get("jira") ?? {})).toEqual(["issue.created", "issue.labeled", "issue.assigned"]);
    expect(isBuiltInEventSource("github")).toBe(true);
    expect(isBuiltInEventSource("examplehost")).toBe(false);
  });

  it("a tracker whose kind is a built-in id does not make a trigger check fail for the other sources", () => {
    expect(checkEventTrigger({ source: "examplehost", type: "item.created" }, [{ source: "linear", types: { "x.y": [] } }, EXAMPLE])).toEqual([]);
  });
});

describe("checking a trigger against the built-in and the registered sources", () => {
  it("allows a registered source, type and filter", () => {
    expect(checkEventTrigger({ source: "examplehost", type: "item.created", filter: { label: ["bug"] } }, [EXAMPLE])).toEqual([]);
    expect(checkEventTrigger({ source: "github", type: "pull_request.opened", filter: { baseBranch: ["main"] } }, [])).toEqual([]);
  });

  it("refuses an unknown source, an unknown type, a filter key the type does not take, and a filter with no or too many values", () => {
    expect(checkEventTrigger({ source: "examplehost", type: "item.created" }, [])[0]).toMatch(/no event source/);
    expect(checkEventTrigger({ source: "examplehost", type: "item.deleted" }, [EXAMPLE])[0]).toMatch(/has no item.deleted event/);
    expect(checkEventTrigger({ source: "examplehost", type: "item.created", filter: { assignee: ["x"] } }, [EXAMPLE])[0]).toMatch(/can't be filtered by assignee/);
    expect(checkEventTrigger({ source: "examplehost", type: "alert.firing", filter: { label: ["x"] } }, [EXAMPLE])[0]).toMatch(/no filters/);
    expect(checkEventTrigger({ source: "examplehost", type: "item.created", filter: { label: [] } }, [EXAMPLE])[0]).toMatch(/one to 10 values/);
    expect(checkEventTrigger({ source: "examplehost", type: "item.created", filter: { label: Array.from({ length: 11 }, (_, i) => `v${String(i)}`) } }, [EXAMPLE])[0]).toMatch(/one to 10 values/);
  });

  it("does not read a type named like an Object property as present", () => {
    expect(checkEventTrigger({ source: "examplehost", type: "constructor" }, [EXAMPLE])[0]).toMatch(/has no constructor event/);
    expect(checkEventTrigger({ source: "toString", type: "a.b" }, [])[0]).toMatch(/no event source/);
  });
});

describe("a tracker registers its events and its comments (types only)", () => {
  it("is satisfied by a minimal tracker that declares an event source and fetches item comments", async () => {
    const tracker: Tracker = {
      kind: "examplehost",
      capabilities: { startTasks: true, comment: true, status: false, link: false, events: "webhook" },
      readItem: () => Promise.reject(new Error("not used")),
      eventSource: { types: EXAMPLE.types },
      comments: async (ref) => ({ comments: [{ id: "c1", subject: { kind: "item", ref }, author: { login: "pat", isBot: false }, body: "/rovara stop", createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" }] }),
    };
    const page = await tracker.comments!({ tracker: "examplehost", id: "T-1" }, {}, { system: "webhook" });
    expect(SubjectCommentsPageSchema.safeParse(page).success).toBe(true);
    expect(EventSourceRegistrationSchema.safeParse(tracker.eventSource).success).toBe(true);
  });
});

describe("the comment-command seam is keyed on an item or a change request", () => {
  const changeRequest = { kind: "change-request", ref: { repository: { url: "https://examplehost.test/acme/app" }, id: "12", url: "https://examplehost.test/acme/app/pull/12" } } as const;
  const item = { kind: "item", ref: { tracker: "examplehost", id: "T-1" } } as const;

  it("accepts both kinds and nothing else", () => {
    expect(CommentSubjectSchema.safeParse(changeRequest).success).toBe(true);
    expect(CommentSubjectSchema.safeParse(item).success).toBe(true);
    expect(CommentSubjectSchema.safeParse({ kind: "claim", id: "x" }).success).toBe(false);
    expect(CommentSubjectSchema.safeParse({ kind: "item", ref: item.ref, extra: 1 }).success).toBe(false);
  });

  it("gives a stable key for each, so a claim on a comment is per subject", () => {
    expect(commentSubjectKey(changeRequest)).toBe("change-request:https://examplehost.test/acme/app#12");
    expect(commentSubjectKey(item)).toBe("item:examplehost:T-1");
    expect(commentSubjectKey(changeRequest)).not.toBe(commentSubjectKey(item));
  });

  it("carries a code host's change-request comment into the same shape", () => {
    const comment: HostComment = { id: "9", ref: changeRequest.ref, author: { login: "pat", isBot: false }, body: "/rovara stop", createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" };
    const converted = subjectCommentFromHost(comment);
    expect(converted.subject).toEqual(changeRequest);
    expect(SubjectCommentsPageSchema.safeParse({ comments: [converted] }).success).toBe(true);
  });

  it("is one interface for both: a source fetches by subject", async () => {
    const source: CommentSource = { comments: async (subject) => ({ comments: [{ id: "1", subject, author: { login: "pat", isBot: false }, body: "hi", createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" }] }) };
    for (const subject of [changeRequest, item]) expect((await source.comments(subject, {}, { system: "webhook" })).comments[0]?.subject).toEqual(subject);
  });
});
