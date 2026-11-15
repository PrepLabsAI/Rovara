import { describe, expect, it } from "vitest";
import { resolvePayer, WORK_ORIGINS, type ResolvePayerInput, type Payer, type WorkOrigin } from "@agentx/contracts";
// Ported rule cases: precedence, missing facts and every public origin.
const MAYA = "1".repeat(64);
const OMAR = "2".repeat(64);
const KIT = "3".repeat(64);
const AGENT = "agt_aaaaaaaaaaaaaaaaaaaa" as never;

const base = (extra: Partial<ResolvePayerInput> = {}): ResolvePayerInput => ({ origin: "app", project: "payments", projectPays: false, agentId: AGENT, startedBy: { developerId: MAYA }, ...extra });
const code = (action: () => unknown) => { try { action(); } catch (error) { return (error as { code?: string; message: string }); } throw new Error("expected a throw"); };

describe("resolvePayer", () => {
  it("makes the person who started a person-started run the payer, for every origin a person starts from", () => {
    for (const origin of ["app", "cli", "mcp", "slack"] as const) {
      expect(resolvePayer(base({ origin })), origin).toEqual({ kind: "member", developerId: MAYA });
    }
  });

  it("makes the project the payer of a person-started run when the project pays", () => {
    for (const origin of ["app", "cli", "mcp", "slack"] as const) {
      expect(resolvePayer(base({ origin, projectPays: true })), origin).toEqual({ kind: "project", project: "payments" });
    }
  });

  it("refuses a person-started run that names no one who started it", () => {
    for (const origin of ["app", "cli", "mcp", "slack"] as const) {
      const { startedBy: _startedBy, ...rest } = base({ origin }); // eslint-disable-line @typescript-eslint/no-unused-vars -- the point is that it is absent
      expect(code(() => resolvePayer(rest)), origin).toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("makes the project pay for a test run, whoever started it and whether or not the project pays", () => {
    expect(resolvePayer(base({ origin: "test_run" }))).toEqual({ kind: "project", project: "payments" });
    expect(resolvePayer(base({ origin: "test_run", projectPays: true }))).toEqual({ kind: "project", project: "payments" });
  });

  it("makes the agent pay for work an event or a schedule starts, even when the project pays", () => {
    for (const origin of ["event", "schedule"] as const) {
      const { startedBy: _startedBy, ...rest } = base({ origin }); // eslint-disable-line @typescript-eslint/no-unused-vars -- no person started it
      expect(resolvePayer(rest), origin).toEqual({ kind: "agent", agentId: AGENT });
      expect(resolvePayer({ ...rest, projectPays: true }), origin).toEqual({ kind: "agent", agentId: AGENT });
    }
  });

  it("returns the chain payer the chain supplied, and refuses a chain run without one", () => {
    const chainPayer: Payer = { kind: "member", developerId: OMAR };
    expect(resolvePayer(base({ origin: "chain", chainPayer }))).toEqual(chainPayer);
    // The chain's payer wins over the project paying: Plan 4 decided it with the chain's own rules.
    expect(resolvePayer(base({ origin: "chain", chainPayer, projectPays: true }))).toEqual(chainPayer);
    expect(code(() => resolvePayer(base({ origin: "chain" })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(code(() => resolvePayer(base({ origin: "chain", projectPays: true })))).toMatchObject({ code: "CONFIG_INVALID" });
    // A chain payer is not looked at for any other origin.
    expect(resolvePayer(base({ origin: "app", chainPayer }))).toEqual({ kind: "member", developerId: MAYA });
  });

  it("makes the person who assigned a Linear issue pay, a bot's approver pay, and the project pay when no one approved", () => {
    const linear = (extra: Partial<ResolvePayerInput>) => { const { startedBy: _startedBy, ...rest } = base({ origin: "linear", ...extra }); return resolvePayer(rest); }; // eslint-disable-line @typescript-eslint/no-unused-vars -- Linear work has no starter
    expect(linear({ assignedBy: { developerId: OMAR, bot: false } })).toEqual({ kind: "member", developerId: OMAR });
    expect(linear({ assignedBy: { bot: true } })).toEqual({ kind: "project", project: "payments" });
    expect(linear({ assignedBy: { bot: true }, approvedBy: { developerId: KIT } })).toEqual({ kind: "member", developerId: KIT });
    // A person Rovara has no member for is treated like a bot: their approver, else the project.
    expect(linear({ assignedBy: { bot: false } })).toEqual({ kind: "project", project: "payments" });
    expect(linear({ assignedBy: { bot: false }, approvedBy: { developerId: KIT } })).toEqual({ kind: "member", developerId: KIT });
    // No assigner at all is the same as no one the work can be charged to but the project.
    expect(linear({})).toEqual({ kind: "project", project: "payments" });
  });

  it("lets a project that pays take a Linear run, and only a person assigner or approver is skipped by it", () => {
    const { startedBy: _startedBy, ...rest } = base({ origin: "linear", projectPays: true, assignedBy: { developerId: OMAR, bot: false } }); // eslint-disable-line @typescript-eslint/no-unused-vars -- Linear work has no starter
    expect(resolvePayer(rest)).toEqual({ kind: "project", project: "payments" });
  });

  it("makes the person who accepted an offer pay, or the project when it pays, and refuses an offer no one accepted", () => {
    const offer = (extra: Partial<ResolvePayerInput>) => { const { startedBy: _startedBy, ...rest } = base({ origin: "offer", ...extra }); return resolvePayer(rest); }; // eslint-disable-line @typescript-eslint/no-unused-vars -- an offer has no starter
    expect(offer({ acceptedBy: { developerId: KIT } })).toEqual({ kind: "member", developerId: KIT });
    expect(offer({ acceptedBy: { developerId: KIT }, projectPays: true })).toEqual({ kind: "project", project: "payments" });
    expect(code(() => offer({}))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("covers every origin: each one is either resolved or refused for lack of its facts, never left to a default", () => {
    const resolved: Partial<Record<WorkOrigin, Payer["kind"]>> = {};
    for (const origin of WORK_ORIGINS) {
      const chainPayer: Payer = { kind: "project", project: "payments" };
      const input = base({ origin, chainPayer, assignedBy: { developerId: OMAR, bot: false }, acceptedBy: { developerId: KIT } });
      resolved[origin] = resolvePayer(input).kind;
    }
    expect(resolved).toEqual({
      app: "member", cli: "member", mcp: "member", slack: "member", linear: "member", jira: "member", github_issue: "member", tracker: "member", offer: "member",
      test_run: "project", event: "agent", schedule: "agent", chain: "project", nightly: "project", automatic: "project",
    });
    // And with the project paying, only the origins above projectPays in the order keep their payer.
    const paying: Partial<Record<WorkOrigin, Payer["kind"]>> = {};
    for (const origin of WORK_ORIGINS) {
      paying[origin] = resolvePayer(base({ origin, projectPays: true, chainPayer: { kind: "member", developerId: OMAR }, assignedBy: { developerId: OMAR, bot: false }, acceptedBy: { developerId: KIT } })).kind;
    }
    expect(paying).toEqual({
      app: "project", cli: "project", mcp: "project", slack: "project", linear: "project", jira: "project", github_issue: "project", tracker: "project", offer: "project",
      test_run: "project", event: "agent", schedule: "agent", chain: "member", nightly: "project", automatic: "project",
    });
  });
});


it("prefers a trigger's chain over its agent and project", () => {
  for (const origin of ["event", "schedule"] as const) {
    expect(resolvePayer(base({ origin, chainId: "chn_aaaaaaaaaaaaaaaaaaaa", projectPays: true }))).toEqual({ kind: "chain", chainId: "chn_aaaaaaaaaaaaaaaaaaaa" });
    expect(() => resolvePayer({ origin, project: "payments", projectPays: false })).toThrow();
  }
});
it.each([null, {}, { origin: "unknown", project: "payments", projectPays: true }, { origin: "app", project: "payments", projectPays: "yes" }, { origin: "app", project: "payments" }])("refuses malformed or unavailable facts with fixed words", (value) => {
  expect(() => resolvePayer(value as ResolvePayerInput)).toThrow("could not work out who pays for this task");
});

it.each(["app", "cli", "mcp", "slack", "tracker", "jira", "github_issue"] as const)("a missing project payer setting means false for %s", origin => {
  expect(resolvePayer({ origin, project: "payments", startedBy: { developerId: MAYA } })).toEqual({ kind: "member", developerId: MAYA });
});
