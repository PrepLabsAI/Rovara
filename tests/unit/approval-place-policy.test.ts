// Approval-place policy (owner decisions 62, 66, 83; requirements A-01, A-02, A-08, A-09, A-49, E-37, E-38). The function is authority, so every rule has a test that it does not widen anything: a chat never approves high risk,
// a tool never approves medium, "Not now" is never a decision, a collaborator never decides code, and the recent-sign-in window's edge is exact. The exhaustive tests walk EVERY combination of the input and check the
// invariants, so a new place, risk or role added later and forgotten here fails loudly.
import { describe, expect, it } from "vitest";
import {
  APPROVAL_DECIDER_ROLES, APPROVAL_DECISION_KINDS, APPROVAL_PLACES, APPROVAL_PLACE_ANSWERS, APPROVAL_PLACE_RISKS, APPROVAL_SIGN_IN_SKEW_SECONDS, DEFAULT_RECENT_SIGN_IN_SETTING,
  RECENT_SIGN_IN_DEFAULT_SECONDS, RECENT_SIGN_IN_MAX_SECONDS, RECENT_SIGN_IN_MIN_SECONDS, RECENT_SIGN_IN_SKEW_SECONDS, RecentSignInSettingSchema, approvalPlaceDecision, checkRecentSignInChange, isOutsideApprovalPlace,
  type ApprovalDeciderRole, type ApprovalPlace, type ApprovalPlaceInput, type ApprovalPlaceVerdict,
} from "@agentx/contracts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function input(overrides: Partial<Omit<ApprovalPlaceInput, "decider" | "settings">> & { decider?: Partial<ApprovalPlaceInput["decider"]>; settings?: Partial<ApprovalPlaceInput["settings"]> } = {}): ApprovalPlaceInput {
  const { decider, settings, ...rest } = overrides;
  return {
    kind: "plan", risk: "medium", answer: "approve", place: "chat", freshSignIn: false, nowMs: NOW,
    decider: { role: "owner", linked: true, authTime: iso(HOUR), ...decider },
    settings: { recentSignIn: DEFAULT_RECENT_SIGN_IN_SETTING, collaboratorApprovals: true, ...settings },
    ...rest,
  };
}
const decide = (overrides: Parameters<typeof input>[0] = {}): ApprovalPlaceVerdict => approvalPlaceDecision(input(overrides));

describe("the recent sign-in window setting", () => {
  it("defaults to 24 hours and accepts 1 hour to 7 days, whole seconds only", () => {
    expect(DEFAULT_RECENT_SIGN_IN_SETTING).toEqual({ seconds: 86_400 });
    expect(RECENT_SIGN_IN_DEFAULT_SECONDS).toBe(86_400);
    expect(RecentSignInSettingSchema.safeParse({ seconds: RECENT_SIGN_IN_MIN_SECONDS }).success).toBe(true);
    expect(RecentSignInSettingSchema.safeParse({ seconds: RECENT_SIGN_IN_MAX_SECONDS }).success).toBe(true);
    expect(RecentSignInSettingSchema.safeParse({ seconds: RECENT_SIGN_IN_MIN_SECONDS - 1 }).success).toBe(false);
    expect(RecentSignInSettingSchema.safeParse({ seconds: RECENT_SIGN_IN_MAX_SECONDS + 1 }).success).toBe(false);
    expect(RecentSignInSettingSchema.safeParse({ seconds: 5_400.5 }).success).toBe(false);
    expect(RecentSignInSettingSchema.safeParse({ seconds: "86400" }).success).toBe(false);
    expect(RecentSignInSettingSchema.safeParse({ seconds: 86_400, extra: true }).success).toBe(false);
    expect(RecentSignInSettingSchema.safeParse({}).success).toBe(false);
  });

  it("shortening and keeping apply at once; lengthening needs a second admin", () => {
    expect(checkRecentSignInChange({ seconds: 86_400 }, { seconds: 4 * 3_600 })).toEqual({ ok: true, setting: { seconds: 14_400 }, change: "shorten", needsSecondAdmin: false });
    expect(checkRecentSignInChange({ seconds: 86_400 }, { seconds: 86_400 })).toEqual({ ok: true, setting: { seconds: 86_400 }, change: "same", needsSecondAdmin: false });
    expect(checkRecentSignInChange({ seconds: 14_400 }, { seconds: 86_400 })).toEqual({ ok: true, setting: { seconds: 86_400 }, change: "lengthen", needsSecondAdmin: true });
    expect(checkRecentSignInChange({ seconds: 86_400 }, { seconds: 86_401 }).ok && checkRecentSignInChange({ seconds: 86_400 }, { seconds: 86_401 })).toMatchObject({ change: "lengthen", needsSecondAdmin: true });
    expect(checkRecentSignInChange({ seconds: 86_400 }, { seconds: RECENT_SIGN_IN_MAX_SECONDS })).toMatchObject({ change: "lengthen", needsSecondAdmin: true });
  });

  it("reads a missing or damaged current value as the default, so it cannot be used to lengthen without a second admin", () => {
    for (const damaged of [undefined, null, "x", {}, { seconds: 1 }, { seconds: 10 ** 9 }]) {
      expect(checkRecentSignInChange(damaged, { seconds: 90_000 })).toMatchObject({ change: "lengthen", needsSecondAdmin: true });
      expect(checkRecentSignInChange(damaged, { seconds: 3_600 })).toMatchObject({ change: "shorten", needsSecondAdmin: false });
    }
  });

  it("refuses a proposed value that is not a valid window", () => {
    for (const bad of [undefined, null, 86_400, { seconds: 0 }, { seconds: -5 }, { seconds: 59 }, { seconds: RECENT_SIGN_IN_MAX_SECONDS + 1 }, { seconds: Number.NaN }, { seconds: 5_400.5 }, { seconds: 86_400, mode: "window" }]) {
      expect(checkRecentSignInChange({ seconds: 86_400 }, bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("where a medium approval may be answered", () => {
  it.each(["chat", "tracker-comment", "code-host-comment"] as const)("%s: a linked person who signed in 23 hours ago may approve; at 25 hours they are sent to Rovara", (place) => {
    expect(decide({ place, decider: { authTime: iso(23 * HOUR) } })).toEqual({ allowed: true, reason: "ok", needs: [], effect: "decision", notifyOwner: false });
    expect(decide({ place, decider: { authTime: iso(25 * HOUR) } })).toEqual({ allowed: false, reason: "sign_in_too_old", needs: ["sign_in_recently"], effect: "refused", notifyOwner: false });
  });

  it("the window's edge is exact: inside to the millisecond is allowed, one millisecond past is refused", () => {
    const window = 4 * HOUR;
    const settings = { recentSignIn: { seconds: window / 1000 } };
    expect(decide({ settings, decider: { authTime: iso(window) } }).allowed).toBe(true);
    expect(decide({ settings, decider: { authTime: iso(window - 1) } }).allowed).toBe(true);
    expect(decide({ settings, decider: { authTime: iso(window + 1) } })).toMatchObject({ allowed: false, reason: "sign_in_too_old" });
    // The company's own window decides, not the default: 5 hours is refused at 4 hours and fine at 24.
    expect(decide({ settings, decider: { authTime: iso(5 * HOUR) } }).allowed).toBe(false);
    expect(decide({ decider: { authTime: iso(5 * HOUR) } }).allowed).toBe(true);
  });

  it("a lengthened window is honoured up to the 7-day maximum and not beyond what the setting allows", () => {
    const week = { recentSignIn: { seconds: RECENT_SIGN_IN_MAX_SECONDS } };
    expect(decide({ settings: week, decider: { authTime: iso(6 * 24 * HOUR) } }).allowed).toBe(true);
    expect(decide({ settings: week, decider: { authTime: iso(7 * 24 * HOUR + 1) } })).toMatchObject({ allowed: false, reason: "sign_in_too_old" });
    // A window the contract does not allow (a damaged setting, a plug-in's data) refuses rather than trusting it.
    for (const seconds of [0, -1, 59, 3_599, RECENT_SIGN_IN_MAX_SECONDS + 1, 10 ** 12, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(decide({ settings: { recentSignIn: { seconds } } })).toEqual({ allowed: false, reason: "invalid_setting", needs: ["open_in_rovara"], effect: "refused", notifyOwner: false });
    }
  });

  it("the skew allowance is the same number the fresh sign-in check uses", () => {
    expect(RECENT_SIGN_IN_SKEW_SECONDS).toBe(APPROVAL_SIGN_IN_SKEW_SECONDS);
  });

  it("no sign-in time, an unreadable one, or one in the future is refused (fail closed)", () => {
    expect(decide({ decider: { authTime: undefined } })).toMatchObject({ allowed: false, reason: "no_sign_in_time", needs: ["sign_in_recently"] });
    for (const authTime of ["", "yesterday", "2026-13-45T00:00:00Z", "NaN"]) expect(decide({ decider: { authTime } })).toMatchObject({ allowed: false, reason: "no_sign_in_time" });
    // A clock a little ahead is believed (skew), a clock far ahead is not.
    expect(decide({ decider: { authTime: new Date(NOW + (APPROVAL_SIGN_IN_SKEW_SECONDS - 1) * 1000).toISOString() } }).allowed).toBe(true);
    expect(decide({ decider: { authTime: new Date(NOW + (APPROVAL_SIGN_IN_SKEW_SECONDS + 1) * 1000).toISOString() } })).toMatchObject({ allowed: false, reason: "sign_in_in_future" });
  });

  it("an unlinked person is told to link, before anything else is asked", () => {
    for (const place of ["chat", "tracker-comment", "code-host-comment"] as const) {
      expect(decide({ place, decider: { linked: false, authTime: iso(HOUR) } })).toEqual({ allowed: false, reason: "not_linked", needs: ["link_account"], effect: "refused", notifyOwner: false });
      // Not even the role is read for someone nobody can name: the answer is the same for every role.
      for (const role of APPROVAL_DECIDER_ROLES) expect(decide({ place, decider: { role, linked: false } }).reason).toBe("not_linked");
    }
  });

  it("the browser needs no sign-in age for a medium approval: the live session is the sign-in", () => {
    expect(decide({ place: "browser", decider: { authTime: undefined } })).toMatchObject({ allowed: true });
    expect(decide({ place: "browser", decider: { authTime: iso(1000 * HOUR) } })).toMatchObject({ allowed: true });
  });

  it("an AI tool, the CLI or an API token never approves medium: it gets a link (decision Q4)", () => {
    expect(decide({ place: "tool" })).toEqual({ allowed: false, reason: "tool_low_risk_only", needs: ["open_in_rovara"], effect: "refused", notifyOwner: false });
    expect(decide({ place: "tool", decider: { authTime: iso(1) }, freshSignIn: true }).allowed).toBe(false);
  });
});

describe("low risk", () => {
  it("is answered anywhere by a linked person: no sign-in age needed", () => {
    for (const place of APPROVAL_PLACES) expect(decide({ risk: "low", place, decider: { authTime: undefined } })).toMatchObject({ allowed: true, reason: "ok" });
    expect(decide({ risk: "low", place: "chat", decider: { authTime: iso(1000 * HOUR) } }).allowed).toBe(true);
  });
  it("still needs a linked person from an outside place", () => {
    for (const place of ["chat", "tracker-comment", "code-host-comment"] as const) expect(decide({ risk: "low", place, decider: { linked: false } })).toMatchObject({ allowed: false, reason: "not_linked" });
  });
});

describe("high risk stays in the browser, under the fresh sign-in", () => {
  it("is refused everywhere outside the browser, with the way forward, even for a fresh and recent person", () => {
    for (const place of ["chat", "tracker-comment", "code-host-comment", "tool"] as const) {
      expect(decide({ risk: "high", place, freshSignIn: true, decider: { authTime: iso(1) } })).toEqual({ allowed: false, reason: "high_risk_browser_only", needs: ["open_in_rovara"], effect: "refused", notifyOwner: false });
      expect(decide({ risk: "high", place, freshSignIn: false })).toMatchObject({ allowed: false, reason: "high_risk_browser_only", needs: ["open_in_rovara", "fresh_sign_in"] });
    }
  });
  it("the browser needs the fresh sign-in; a recent one is not enough", () => {
    expect(decide({ risk: "high", place: "browser", freshSignIn: false, decider: { authTime: iso(1) } })).toEqual({ allowed: false, reason: "fresh_sign_in_required", needs: ["fresh_sign_in"], effect: "refused", notifyOwner: false });
    expect(decide({ risk: "high", place: "browser", freshSignIn: true })).toEqual({ allowed: true, reason: "ok", needs: [], effect: "decision", notifyOwner: false });
  });
});

describe("rejecting needs a signed-in session under the fresh sign-in, at every risk", () => {
  it("is never taken from a chat, a comment or a tool", () => {
    for (const risk of APPROVAL_PLACE_RISKS) {
      for (const place of ["chat", "tracker-comment", "code-host-comment", "tool"] as const) {
        expect(decide({ answer: "reject", risk, place, freshSignIn: true, decider: { authTime: iso(1) } })).toMatchObject({ allowed: false, reason: "reject_browser_only", needs: ["open_in_rovara"] });
      }
    }
  });
  it("the browser needs the fresh sign-in", () => {
    for (const risk of APPROVAL_PLACE_RISKS) {
      expect(decide({ answer: "reject", risk, place: "browser", freshSignIn: false })).toMatchObject({ allowed: false, reason: "fresh_sign_in_required" });
      expect(decide({ answer: "reject", risk, place: "browser", freshSignIn: true })).toMatchObject({ allowed: true });
    }
  });
});

describe("request changes", () => {
  it("may come from any place a linked person can reach, with no sign-in age and no fresh step, at every risk", () => {
    for (const risk of APPROVAL_PLACE_RISKS) {
      for (const place of APPROVAL_PLACES) expect(decide({ answer: "request_changes", risk, place, decider: { authTime: undefined } })).toMatchObject({ allowed: true, reason: "ok" });
    }
  });
  it("still needs the person to be linked and allowed to decide", () => {
    expect(decide({ answer: "request_changes", place: "chat", decider: { linked: false } })).toMatchObject({ reason: "not_linked" });
    expect(decide({ answer: "request_changes", decider: { role: "viewer" } })).toMatchObject({ reason: "role_not_allowed" });
  });
});

describe("\"Not now\" is a dismissal, never a decision (A-49)", () => {
  it("hides the card and decides nothing, from every place, for everyone", () => {
    for (const place of APPROVAL_PLACES) {
      for (const role of APPROVAL_DECIDER_ROLES) {
        for (const risk of APPROVAL_PLACE_RISKS) {
          const verdict = decide({ answer: "not_now", place, risk, decider: { role, linked: false, authTime: undefined } });
          expect(verdict).toEqual({ allowed: false, reason: "dismissal", needs: [], effect: "dismissal", notifyOwner: false });
        }
      }
    }
  });
  it("is not a rejection: it needs no fresh sign-in and is not refused for lacking one", () => {
    expect(decide({ answer: "not_now", place: "chat", risk: "high", freshSignIn: false })).toMatchObject({ effect: "dismissal" });
    expect(decide({ answer: "reject", place: "chat", risk: "low" }).effect).toBe("refused");
  });
});

describe("who may decide (E-37)", () => {
  it("the owner and co-owners decide their own task, with no one to notify", () => {
    for (const role of ["owner", "co-owner"] as const) {
      for (const kind of APPROVAL_DECISION_KINDS) expect(decide({ kind, risk: "low", place: "browser", decider: { role } })).toEqual({ allowed: true, reason: "ok", needs: [], effect: "decision", notifyOwner: false });
    }
  });

  it("a maintainer may approve someone else's plan, design or product decision at every risk, and the owner is told (Q7)", () => {
    for (const kind of ["plan", "design", "product"] as const) {
      expect(decide({ kind, risk: "medium", place: "chat", decider: { role: "maintainer" } })).toEqual({ allowed: true, reason: "ok", needs: [], effect: "decision", notifyOwner: true });
      expect(decide({ kind, risk: "high", place: "browser", freshSignIn: true, decider: { role: "maintainer" } })).toMatchObject({ allowed: true, notifyOwner: true });
    }
  });

  it("a maintainer from chat still meets the place rules: stale sign-in and high risk are refused", () => {
    expect(decide({ place: "chat", decider: { role: "maintainer", authTime: iso(30 * HOUR) } })).toMatchObject({ allowed: false, reason: "sign_in_too_old", notifyOwner: false });
    expect(decide({ risk: "high", place: "chat", decider: { role: "maintainer" } })).toMatchObject({ allowed: false, reason: "high_risk_browser_only" });
  });

  it("a collaborator decides a LOW-risk PRODUCT decision when the project allows, and the owner is told", () => {
    expect(decide({ kind: "product", risk: "low", place: "chat", decider: { role: "collaborator" } })).toEqual({ allowed: true, reason: "ok", needs: [], effect: "decision", notifyOwner: true });
    expect(decide({ kind: "product", risk: "low", place: "browser", answer: "request_changes", decider: { role: "collaborator" } })).toMatchObject({ allowed: true, notifyOwner: true });
  });

  it("a collaborator never decides a plan, a design or a merge, at any risk, from any place", () => {
    for (const kind of ["plan", "design", "merge"] as const) {
      for (const risk of APPROVAL_PLACE_RISKS) {
        for (const place of APPROVAL_PLACES) {
          for (const answer of ["approve", "request_changes", "reject"] as const) {
            expect(decide({ kind, risk, place, answer, freshSignIn: true, decider: { role: "collaborator" } })).toEqual({ allowed: false, reason: "role_not_allowed", needs: ["ask_maintainer"], effect: "refused", notifyOwner: false });
          }
        }
      }
    }
  });

  it("a collaborator never decides a medium or high product decision (the risk floor)", () => {
    for (const risk of ["medium", "high"] as const) expect(decide({ kind: "product", risk, place: "browser", freshSignIn: true, decider: { role: "collaborator" } })).toMatchObject({ allowed: false, reason: "role_not_allowed" });
  });

  it("with the project's switch off a collaborator is sent to a maintainer", () => {
    expect(decide({ kind: "product", risk: "low", place: "chat", decider: { role: "collaborator" }, settings: { collaboratorApprovals: false } })).toEqual({ allowed: false, reason: "collaborator_approvals_off", needs: ["ask_maintainer"], effect: "refused", notifyOwner: false });
    // The switch changes nothing for anyone else.
    expect(decide({ kind: "product", risk: "low", place: "chat", decider: { role: "maintainer" }, settings: { collaboratorApprovals: false } }).allowed).toBe(true);
    // Only the value true turns it on: a damaged setting is off.
    expect(decide({ kind: "product", risk: "low", place: "chat", decider: { role: "collaborator" }, settings: { collaboratorApprovals: "yes" as unknown as boolean } }).allowed).toBe(false);
  });

  it("a contributor who does not own the task, a viewer and a stranger decide nothing", () => {
    for (const role of ["contributor", "viewer", "none"] as const) {
      for (const kind of APPROVAL_DECISION_KINDS) {
        for (const place of APPROVAL_PLACES) expect(decide({ kind, risk: "low", place, decider: { role } })).toEqual({ allowed: false, reason: "role_not_allowed", needs: ["ask_maintainer"], effect: "refused", notifyOwner: false });
      }
    }
  });

  it("the owner's notice is for a decision that happened: a refusal never asks to notify", () => {
    expect(decide({ place: "chat", decider: { role: "maintainer", authTime: undefined } })).toMatchObject({ allowed: false, notifyOwner: false });
  });
});

describe("input that cannot be read is refused", () => {
  const good = input();
  it("an unknown kind, risk, answer, place or role", () => {
    for (const bad of [{ kind: "setting" }, { risk: "critical" }, { answer: "maybe" }, { place: "email" }, { risk: undefined }, { place: undefined }, { answer: "" }]) {
      expect(approvalPlaceDecision({ ...good, ...bad } as unknown as ApprovalPlaceInput)).toEqual({ allowed: false, reason: "invalid_input", needs: [], effect: "refused", notifyOwner: false });
    }
    expect(approvalPlaceDecision({ ...good, decider: { ...good.decider, role: "admin" as ApprovalDeciderRole } })).toMatchObject({ allowed: false, reason: "invalid_input" });
  });
  it("a missing decider, settings or clock, and a non-boolean fresh flag", () => {
    for (const bad of [{ decider: undefined }, { settings: undefined }, { decider: null }, { nowMs: Number.NaN }, { nowMs: "now" }, { nowMs: undefined }, { freshSignIn: "true" }, { freshSignIn: undefined }]) {
      expect(approvalPlaceDecision({ ...good, ...bad } as unknown as ApprovalPlaceInput)).toMatchObject({ allowed: false, reason: "invalid_input" });
    }
    for (const bad of [undefined, null, "approve", 42, []]) expect(approvalPlaceDecision(bad as unknown as ApprovalPlaceInput)).toMatchObject({ allowed: false, reason: "invalid_input" });
  });
  it("inherited names are not kinds, places or roles", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(approvalPlaceDecision({ ...good, place: name as ApprovalPlace })).toMatchObject({ reason: "invalid_input" });
      expect(approvalPlaceDecision({ ...good, decider: { ...good.decider, role: name as ApprovalDeciderRole } })).toMatchObject({ reason: "invalid_input" });
    }
  });
  it("a truthy but non-true linked flag does not link an outside person", () => {
    expect(approvalPlaceDecision({ ...good, decider: { ...good.decider, linked: "yes" as unknown as boolean } })).toMatchObject({ allowed: false, reason: "not_linked" });
  });
});

describe("every combination keeps the invariants (a new place, risk or role fails here until it is thought through)", () => {
  const authTimes = [undefined, iso(HOUR), iso(30 * HOUR)];
  function* everything(): Generator<ApprovalPlaceInput> {
    for (const kind of APPROVAL_DECISION_KINDS) for (const risk of APPROVAL_PLACE_RISKS) for (const answer of APPROVAL_PLACE_ANSWERS) for (const place of APPROVAL_PLACES)
      for (const role of APPROVAL_DECIDER_ROLES) for (const linked of [true, false]) for (const authTime of authTimes) for (const freshSignIn of [true, false]) for (const collaboratorApprovals of [true, false]) {
        yield input({ kind, risk, answer, place, freshSignIn, decider: { role, linked, authTime }, settings: { collaboratorApprovals } });
      }
  }
  const owners: readonly ApprovalDeciderRole[] = ["owner", "co-owner"];

  it("keeps every invariant over the whole input space", () => {
    let count = 0;
    let allowedCount = 0;
    for (const i of everything()) {
      count += 1;
      const v = approvalPlaceDecision(i);
      const where = JSON.stringify(i);
      // The three fields agree.
      expect(v.allowed, where).toBe(v.effect === "decision");
      expect(v.allowed, where).toBe(v.reason === "ok");
      if (v.allowed) { allowedCount += 1; expect(v.needs, where).toEqual([]); }
      if (v.effect === "refused") expect(v.notifyOwner, where).toBe(false);
      // A dismissal is never a decision; nothing else is a dismissal.
      expect(v.effect === "dismissal", where).toBe(i.answer === "not_now");
      if (!v.allowed) continue;
      // Allowed means the decider may decide this at all.
      expect(["owner", "co-owner", "maintainer", "collaborator"], where).toContain(i.decider.role);
      expect(v.notifyOwner, where).toBe(!owners.includes(i.decider.role));
      if (i.decider.role === "collaborator") { expect(i.kind, where).toBe("product"); expect(i.risk, where).toBe("low"); expect(i.settings.collaboratorApprovals, where).toBe(true); }
      // Outside places always need a linked person.
      if (isOutsideApprovalPlace(i.place)) expect(i.decider.linked, where).toBe(true);
      // High risk and rejection: the browser and the fresh sign-in, nothing less.
      if ((i.answer === "approve" && i.risk === "high") || i.answer === "reject") { expect(i.place, where).toBe("browser"); expect(i.freshSignIn, where).toBe(true); }
      // Medium from an outside place: a recent sign-in.
      if (i.answer === "approve" && i.risk === "medium" && isOutsideApprovalPlace(i.place)) expect(i.decider.authTime, where).toBe(iso(HOUR));
      // A tool approves low only.
      if (i.place === "tool" && i.answer === "approve") expect(i.risk, where).toBe("low");
    }
    expect(count).toBe(APPROVAL_DECISION_KINDS.length * APPROVAL_PLACE_RISKS.length * APPROVAL_PLACE_ANSWERS.length * APPROVAL_PLACES.length * APPROVAL_DECIDER_ROLES.length * 2 * 3 * 2 * 2);
    expect(allowedCount).toBeGreaterThan(0);
  });

  it("is pure: the same input gives the same answer and the input is not changed", () => {
    const i = input();
    const frozen = JSON.stringify(i);
    const first = approvalPlaceDecision(i);
    expect(approvalPlaceDecision(i)).toEqual(first);
    expect(JSON.stringify(i)).toBe(frozen);
  });
});
