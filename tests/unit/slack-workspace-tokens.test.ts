import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { createSlackWorkspaceTokens } from "../../packages/broker/src/aws/slack-workspace-tokens.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const TEAM = "T0AAAAAAA";
const OTHER = "T0BBBBBBB";
function world() {
  const bindings = new Map([[TEAM, A], [OTHER, B]]);
  const secrets = new Map<string, string>();
  const reads: string[] = [];
  let time = 0;
  let legacyReads = 0;
  const tokens = createSlackWorkspaceTokens({ environment: "test", legacyTeamId: TEAM,
    bindings: { requireCompany: async (team: string) => { const company = bindings.get(team); if (!company) throw new Error("private cause"); return company; } },
    readSecret: async (name) => { reads.push(name); return secrets.get(name); },
    legacyToken: async () => { legacyReads++; return slackTokens("legacy").bot; }, now: () => time });
  const put = (company: string, team: string, tag: string) => { secrets.set(`agentx/test/slack-workspaces/${company}/${team}`, JSON.stringify({ botToken: slackTokens(tag).bot })); };
  return { tokens, bindings, secrets, reads, put, advance: (ms: number) => { time += ms; }, legacyReads: () => legacyReads };
}
const sameToken = (value: unknown, tag: string) => expect(value === slackTokens(tag).bot).toBe(true);
describe("company-bound Slack tokens", () => {
  it("denies a cross-company read before secrets access", async () => {
    const h = world(); h.put(B, OTHER, "b");
    expect((await h.tokens.tokenForCompany(A, OTHER)) === undefined).toBe(true);
    expect(h.reads).toEqual([]); expect(h.legacyReads()).toBe(0);
    const event = await h.tokens.tokenForEvent(OTHER);
    expect(event?.companyId).toBe(B); sameToken(event?.token, "b");
    expect(h.reads).toEqual([`agentx/test/slack-workspaces/${B}/${OTHER}`]);
  });
  it("uses the binding company for the secret name and never falls back for another pair", async () => {
    const h = world(); h.put(A, TEAM, "a"); h.put(B, TEAM, "wrong");
    sameToken(await h.tokens.tokenForCompany(A, TEAM), "a");
    expect((await h.tokens.tokenForEvent(OTHER)) === undefined).toBe(true);
    expect(h.legacyReads()).toBe(0);
    h.bindings.set(TEAM, IMPLICIT_COMPANY_ID);
    sameToken((await h.tokens.tokenForEvent(TEAM))?.token, "legacy");
    expect(h.legacyReads()).toBe(1);
    h.bindings.set(OTHER, IMPLICIT_COMPANY_ID);
    expect((await h.tokens.tokenForEvent(OTHER)) === undefined).toBe(true);
    expect(h.legacyReads()).toBe(1);
  });
  it("never serves an old company's cached token after a test-only rebind", async () => {
    const h = world(); h.put(A, TEAM, "a"); h.put(B, TEAM, "b");
    sameToken((await h.tokens.tokenForEvent(TEAM))?.token, "a");
    h.bindings.set(TEAM, B);
    sameToken((await h.tokens.tokenForEvent(TEAM))?.token, "b");
    expect((await h.tokens.tokenForCompany(A, TEAM)) === undefined).toBe(true);
  });
  it("expires at five minutes, evicts the oldest at 1000 entries, and reads 1000 teams within the test timeout", async () => {
    const h = world();
    for (let i = 0; i < 1000; i++) { const team = `T${String(i).padStart(8, "0")}`; h.bindings.set(team, A); h.put(A, team, "a"); sameToken((await h.tokens.tokenForEvent(team))?.token, "a"); }
    expect(h.reads).toHaveLength(1000);
    sameToken((await h.tokens.tokenForEvent("T00000000"))?.token, "a"); expect(h.reads).toHaveLength(1000);
    h.put(B, OTHER, "b"); await h.tokens.tokenForEvent(OTHER);
    await h.tokens.tokenForEvent("T00000000"); expect(h.reads).toHaveLength(1002);
    h.advance(300_000); h.put(B, OTHER, "rotated"); sameToken((await h.tokens.tokenForEvent(OTHER))?.token, "rotated");
  });
  it.each(["", "{}", "not-json", "null", JSON.stringify({ botToken: "invalid" }), JSON.stringify({ botToken: ["xoxp", "private"].join("-") }), "a".repeat(1_000_000), JSON.stringify({ botToken: slackTokens("oversized").bot, padding: "a".repeat(1_000_000) }), JSON.stringify({ botToken: ["xoxb", "a".repeat(5000)].join("-") })])("refuses malformed secrets without falling back or disclosing them", async (secret) => {
    const h = world(); h.bindings.set(TEAM, IMPLICIT_COMPANY_ID); h.secrets.set(`agentx/test/slack-workspaces/${IMPLICIT_COMPANY_ID}/${TEAM}`, secret);
    expect((await h.tokens.tokenForEvent(TEAM)) === undefined).toBe(true); expect(h.legacyReads()).toBe(0);
  });
  it("does not return or expose read errors, malformed companies, enterprise ids, or late answers", async () => {
    let company = A; let time = 0; let read = 0;
    const tokens = createSlackWorkspaceTokens({ environment: "test", bindings: { requireCompany: async () => company }, now: () => time,
      readSecret: async () => { read++; time += 10_001; return JSON.stringify({ botToken: slackTokens("late").bot }); } });
    expect((await tokens.tokenForEvent(TEAM)) === undefined).toBe(true);
    company = "not-an-org"; expect((await tokens.tokenForEvent(TEAM)) === undefined).toBe(true);
    expect((await tokens.tokenForEvent("E0AAAAAAA")) === undefined).toBe(true); expect(read).toBe(1);
    const broken = createSlackWorkspaceTokens({ environment: "test", bindings: { requireCompany: async () => A }, readSecret: async () => { throw new Error("private cause"); } });
    expect((await broken.tokenForEvent(TEAM)) === undefined).toBe(true); expect((await broken.tokenForCompany(A, TEAM)) === undefined).toBe(true);
  });
});

it("never lets a malformed binding or an invalid asking company reach the secret reader", async () => {
  const h = world();
  expect((await h.tokens.tokenForCompany("not-an-org", TEAM)) === undefined).toBe(true);
  expect((await h.tokens.tokenForEvent("T0UNKNOWN")) === undefined).toBe(true);
  expect(h.reads).toEqual([]);
});

it("never uses the legacy token for a named company's legacy team with no secret", async () => {
  const h = world();
  expect((await h.tokens.tokenForEvent(TEAM)) === undefined).toBe(true);
  expect(h.legacyReads()).toBe(0);
});

it("refuses missing or wrong-type environment settings before any secret read", async () => {
  for (const environment of [undefined, null, 42, {}, "", "../prod"]) {
    let reads = 0;
    const tokens = createSlackWorkspaceTokens({ environment: environment as string, bindings: { requireCompany: async () => A }, readSecret: async () => { reads++; return JSON.stringify({ botToken: slackTokens("invalidenv").bot }); } });
    expect((await tokens.tokenForEvent(TEAM)) === undefined).toBe(true);
    expect(reads).toBe(0);
  }
});
