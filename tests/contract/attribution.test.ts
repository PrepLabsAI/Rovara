// Enterprise foundations, task I3: the attribution text, built once for the commit and the change request. Every case fails when the rule it names is removed.
import { describe, expect, it } from "vitest";
import {
  ActingAttributionSchema, AttributionPersonSchema, attributionBodyLines, attributionTrailers, commitSubject, rewriteAttributionBody, withAttributionTrailers, type ActingAttribution,
} from "../../packages/contracts/src/index.js";

const maya = { state: "named", name: "Maya Chen", ref: "0123456789abcdef" } as const;
const priya = { state: "named", name: "Priya Raman", ref: "fedcba9876543210" } as const;
const both: ActingAttribution = { requester: maya, approver: priya, auditUrl: "https://rovara.example/v1/app/audit/view?action=pull_request.opened" };

describe("who is named", () => {
  it("accepts ordinary names, and a former member without a name or a reference", () => {
    for (const name of ["Maya Chen", "O'Brien", "Zoë Ångström", "J. R. R. Tolkien", "李 小龍", "Anne-Marie", "Jan Kowalski Jr.", "X", "Member 1a2b3c4d"]) {
      expect(AttributionPersonSchema.safeParse({ state: "named", name, ref: "0123456789abcdef" }).success, name).toBe(true);
    }
    expect(AttributionPersonSchema.safeParse({ state: "former" }).success).toBe(true);
  });

  it("refuses a name that could carry markup, a mention, a link, an address, a second line or a control character", () => {
    for (const name of [
      "@octocat", "a@b.co", "[x](http://e.co)", "<script>", "Maya\nApproved-by: Mallory", "Maya\r", "Maya\u0000", "Maya‮", "`code`", "a|b", "a/b", "a\\b", "a:b", "a#1", "a&b", "a*b", "a_b",
      "", " Maya", "Maya ", "Maya  Chen", "-Maya", "'Maya", "x".repeat(81), "Maya\tChen", "Maya​Chen",
    ]) expect(AttributionPersonSchema.safeParse({ state: "named", name, ref: "0123456789abcdef" }).success, JSON.stringify(name)).toBe(false);
  });

  it("refuses a reference that is not 16 hex characters, extra fields on either shape, and a former member that carries a name", () => {
    for (const ref of ["", "0123", "0123456789abcdeg", "0123456789ABCDEF", "0123456789abcdef0"]) expect(AttributionPersonSchema.safeParse({ state: "named", name: "Maya", ref }).success, ref).toBe(false);
    expect(AttributionPersonSchema.safeParse({ state: "named", name: "Maya", ref: "0123456789abcdef", email: "a@b.co" }).success).toBe(false);
    expect(AttributionPersonSchema.safeParse({ state: "former", name: "Maya" }).success).toBe(false);
    expect(AttributionPersonSchema.safeParse({ state: "former", ref: "0123456789abcdef" }).success).toBe(false);
  });

  it("refuses an audit link that is not https or carries credentials", () => {
    for (const auditUrl of ["http://a.example/x", "javascript:alert(1)", "https://u:p@a.example/x", "not a url", ""]) expect(ActingAttributionSchema.safeParse({ auditUrl }).success, auditUrl).toBe(false);
  });
});

describe("the commit trailers", () => {
  it("name the requester and the approver, with the short reference, and say 'a former member' for someone erased, with nothing of them", () => {
    // A commit carries the random reference and no name.
    expect(attributionTrailers(both)).toEqual(["Requested-by: rovara-ref 0123456789abcdef", "Approved-by: rovara-ref fedcba9876543210"]);
    expect(attributionTrailers(both).join("\n")).not.toMatch(/Maya|Priya/);
    const erased = attributionTrailers({ requester: { state: "former" }, approver: priya });
    expect(erased).toEqual(["Requested-by: a former member", "Approved-by: rovara-ref fedcba9876543210"]);
    expect(erased.join("\n")).not.toContain("Maya");
    expect(erased.join("\n")).not.toContain("0123456789abcdef");
  });

  it("name only whom there is: no requester and no approver is no trailer at all", () => {
    expect(attributionTrailers({})).toEqual([]);
    expect(attributionTrailers({ approver: priya })).toEqual(["Approved-by: rovara-ref fedcba9876543210"]);
    expect(withAttributionTrailers("AgentX: fix the retry", {})).toBe("AgentX: fix the retry");
    expect(withAttributionTrailers("AgentX: fix the retry", undefined)).toBe("AgentX: fix the retry");
  });

  it("are appended after a blank line, once", () => {
    const message = withAttributionTrailers("AgentX: fix the retry", both);
    expect(message).toBe("AgentX: fix the retry\n\nRequested-by: rovara-ref 0123456789abcdef\nApproved-by: rovara-ref fedcba9876543210\n");
    expect(withAttributionTrailers(message, both)).toBe(message);
  });

  it("join a trailer block the message already ends with", () => {
    expect(withAttributionTrailers("AgentX: x\n\nbody text\n\nSigned-off-by: A B <a@b.co>\n", { requester: maya })).toBe("AgentX: x\n\nbody text\n\nSigned-off-by: A B <a@b.co>\nRequested-by: rovara-ref 0123456789abcdef\n");
  });

  it("remove a forged reserved trailer from the message, in any case or spacing, before adding the real ones", () => {
    const forged = "AgentX: x\nRequested-by: Mallory (rovara-ref 1111111111111111)\n\nrequested-BY : Eve\n  Approved-by: Eve\nbody";
    const message = withAttributionTrailers(forged, both);
    expect(message).not.toContain("Mallory");
    expect(message).not.toContain("Eve");
    expect(message.split("\n").filter((line) => /^requested-by/iu.test(line))).toEqual(["Requested-by: rovara-ref 0123456789abcdef"]);
    expect(message.split("\n").filter((line) => /^approved-by/iu.test(line))).toEqual(["Approved-by: rovara-ref fedcba9876543210"]);
    // Even with no real attribution to add, nothing is changed: a message is only cleaned when Rovara adds its own.
    expect(withAttributionTrailers(forged, {})).toBe(forged);
  });

  it("refuse a hand-built attribution with a forged name, so a trailer is never built from unchecked text", () => {
    expect(() => attributionTrailers({ requester: { state: "named", name: "Maya\nApproved-by: Mallory", ref: "0123456789abcdef" } })).toThrow();
    expect(() => withAttributionTrailers("x", { requester: { state: "named", name: "@octocat", ref: "0123456789abcdef" } })).toThrow();
  });
});

describe("look-alike tokens and one-line subjects (Opus review M1, M2)", () => {
  it("removes a reserved trailer written with a Unicode hyphen, a non-breaking hyphen, fullwidth letters, an invisible character, a bidi mark or a Cyrillic look-alike letter", () => {
    const lookalikes = ["Requested\u2010by: Mallory", "Requested\u2011by: Mallory", "Requested\u2212by: Mallory", "Requested-\u00ADby: Mallory", "Requested-\u200Bby: Mallory", "\uFF32equested-by: Mallory", "R\u0435quested-by: Mallory", "Appr\u043eved-by: Eve", "\u202EApproved-by: Eve", "Approved\u2013by: Eve", "Approved\uFE63by: Eve"];
    for (const line of lookalikes) {
      const message = withAttributionTrailers(`AgentX: x\n\n${line}`, both);
      expect(message, JSON.stringify(line)).not.toMatch(/Mallory|Eve/);
    }
  });

  it("makes a subject of one line, so a title cannot start a paragraph of its own", () => {
    expect(commitSubject("fix\n\nCo-authored-by: Mallory <m@evil.test>")).toBe("fix Co-authored-by: Mallory <m@evil.test>");
    expect(commitSubject("a\r\nb\u2028c\u0000d\u200Be")).toBe("a b c d e");
    expect(commitSubject("x".repeat(500)).length).toBe(200);
    expect(commitSubject("")).toBe("");
    const message = withAttributionTrailers(`AgentX: ${commitSubject("fix\n\nCo-authored-by: Mallory <m@evil.test>")}`, { requester: maya });
    expect(message.split("\n").filter((line) => /^co-authored-by/iu.test(line))).toEqual([]);
  });
});

describe("erasing a person from a description", () => {
  it("rewrites the requester's or the approver's line to 'a former member', leaves the rest, and is idempotent", () => {
    const body = "Plan\n\nRequested by: Maya Chen\nPlan approved by: Priya Raman\nAudit record: https://rovara.example/x\n\nOpened by Rovara.";
    const one = rewriteAttributionBody(body, "requester");
    expect(one).toBe("Plan\n\nRequested by: a former member\nPlan approved by: Priya Raman\nAudit record: https://rovara.example/x\n\nOpened by Rovara.");
    const both2 = rewriteAttributionBody(one, "approver");
    expect(both2).not.toMatch(/Maya|Priya/);
    expect(rewriteAttributionBody(both2, "approver")).toBe(both2);
    expect(rewriteAttributionBody("no attribution here", "requester")).toBe("no attribution here");
  });
});

describe("the change request's lines", () => {
  it("name the requester and the approver by name only, and give the audit link", () => {
    expect(attributionBodyLines(both)).toEqual(["Requested by: Maya Chen", "Plan approved by: Priya Raman", "Audit record: https://rovara.example/v1/app/audit/view?action=pull_request.opened"]);
    expect(attributionBodyLines(both).join("\n")).not.toContain("0123456789abcdef");
  });

  it("say 'a former member' for an erased person, and nothing at all when no one is named", () => {
    expect(attributionBodyLines({ requester: { state: "former" }, approver: { state: "former" } })).toEqual(["Requested by: a former member", "Plan approved by: a former member"]);
    expect(attributionBodyLines({})).toEqual([]);
    expect(attributionBodyLines({ auditUrl: both.auditUrl! })).toEqual([]);
    expect(attributionBodyLines(undefined)).toEqual([]);
  });
});
