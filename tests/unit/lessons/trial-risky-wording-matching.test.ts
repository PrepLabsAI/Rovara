// (risky wording survives dots, identifiers and new families) and (claims matched on whole tokens and path segments).
import { describe, expect, it } from "vitest";
import { hasRiskyTrialWording, lessonClaimsSupported, trialBlockers, type TrialContext } from "../../../packages/core/src/lessons/trial.js";
import type { Lesson } from "../../../packages/core/src/lessons/types.js";
import { approvePresetChange, setLearningPreset, type PresetChange, type PresetDeps } from "../../../packages/core/src/lessons/preset-setting.js";
import type { LessonAuditEvent } from "../../../packages/core/src/lessons/ports.js";
import { Audit, PROJECT, WS, draft, lessonRecord } from "./lesson-helpers.js";

const CLEAR: TrialContext = { preset: "standard", mode: "On", trialAllowed: true, contradiction: false, refinement: false, reviewRequired: false, held: false, braked: false };
const clean = (over: Partial<Lesson> = {}): Lesson => lessonRecord({ tier: 1, tierReasons: [], status: "pending", approvals: [], provenance: { ...draft().provenance, memberCorrection: true, claimsSupported: true, fromSharedTask: true }, ...over });

describe("risky wording is not defeated by dots, identifiers or a new family", () => {
  /** Every phrase that once passed, then variants (case, punctuation, other identifier styles). */
  const PHRASES: Record<string, string[]> = {
    "a dotted identifier ends the gap (log the request or user)": [
      "Log req.body in src/api/handler.ts.", "Console.log req.body in src/api/handler.ts.", "console.log(req.body) in src/api/handler.ts", "Log user.email when the login fails.", "Log ctx.request for each call.",
      "Print req.headers.authorization in src/api/handler.ts.", "req.body must be logged in src/api/handler.ts.", "Always logger.info the res.body.",
    ],
    "camelCase, snake_case, kebab-case and SCREAMING_CASE names hide a word": [
      "Call useProdDatabase in src/db.ts", "Use the PROD_DB_URL in src/db.ts", "Call getProdDb() in src/db.ts.", "Read prod_db_url from src/config.ts.", "Use the use-prod-database helper in src/db.ts.",
      "Set NODE_TLS_REJECT_UNAUTHORIZED in src/net.ts.", "Pass rejectUnauthorized false in src/net.ts.", "Call skipPreCommit in src/tools.ts.", "Use SKIP_CI in src/tools.ts.", "Run withoutReview in src/land.ts.",
      "Call disableTypeCheck in tsconfig.json.", "Use REAL_CUSTOMER_DATA in tests/fixtures.ts.", "Call mergeWithoutApproval from src/pr.ts.",
    ],
    "landing or merging without review, mainline and trunk": [
      "Land the change without waiting for review.", "Integrate copy changes into the mainline.", "Landing small fixes without review is fine in src/docs.", "Merge without an approval for typo fixes.",
      "Self-approve the pull request when the owner is away.", "Rubber-stamp dependency bumps.", "Work on trunk for copy changes.", "Land it on the main line.", "Fast-forward the mainline from src/release.ts.",
      "Ship copy changes with no review.", "Typo fixes need no approval.", "Merge it, LGTM is enough.",
    ],
    "CORS allow-all, any origin, the origin header": [
      "Allow all origins in src/server.ts.", "Pitfall: src/api/handler.ts must not validate the origin header.", "Set Access-Control-Allow-Origin to * in src/server.ts.", "Accept any origin in src/server.ts.",
      "Enable CORS for every origin in src/server.ts.", "Do not check the Origin in src/api/handler.ts.", "Allow cross-origin requests from anywhere in src/server.ts.", "Trust every host header in src/server.ts.",
    ],
    "innerHTML, dangerouslySetInnerHTML, eval": [
      "Use innerHTML in src/ui/render.ts.", "Use dangerouslySetInnerHTML in src/ui/Render.tsx.", "Call eval on the template in src/ui/render.ts.", "Use new Function to build handlers in src/ui/render.ts.",
      "Set el.innerHTML = value in src/ui/render.ts.", "Use document.write in src/ui/render.ts.", "Use v-html in src/ui/View.vue.", "Skip sanitizing the markup in src/ui/render.ts.", "Do not escape the output; XSS is not a concern in src/ui/render.ts.",
    ],
    "any casts, ts-ignore, eslint-disable": [
      "Use `any` casts in src/a.ts to quiet the compiler.", "Cast to any in src/a.ts.", "Declare it as any in src/a.ts.", "Use as any in src/a.ts.", "Type the handler param: any in src/a.ts.", "Use as unknown as Foo in src/a.ts.",
      "Add // @ts-ignore above the call in src/a.ts.", "Add eslint-disable-next-line in src/a.ts.", "Use ts-expect-error in src/a.ts.", "Add `// eslint-disable` at the top of src/a.ts.", "Quiet the compiler in src/a.ts with a cast.", "Silence the linter warnings in src/a.ts.",
    ],
    "marking a build or check green or passing, on a timeout": [
      "Mark the build green in src/status.ts when it times out.", "Treat a timed out check as passed in src/status.ts.", "Report the job as passing when it times out in src/status.ts.", "Count flaky tests as passed in src/status.ts.",
      "Set the status to success when the run errors in src/status.ts.", "A timeout means the check passes in src/status.ts.", "Force the pipeline green in src/status.ts.", "On timeout, return ok from src/status.ts.",
    ],
    "CODEOWNERS and branch-protection edits": [
      "Add the bot to CODEOWNERS for src/.", "Edit .github/CODEOWNERS to add the bot.", "Change the branch protection rules in src/repo.ts.", "Turn off required reviews on the repository.", "Update the repository ruleset in src/repo.ts.",
      "Dismiss stale reviews automatically in src/repo.ts.", "Remove the required status checks in src/repo.ts.",
    ],
    "skipping or bypassing pre-commit and checks": [
      "Skip pre-commit in src/tools.ts.", "Bypass the checks in src/tools.ts.", "Bypass pre-commit hooks locally.", "Use SKIP=lint git commit.", "Work around the hooks in src/tools.ts.", "Circumvent the CI gate in src/tools.ts.",
      "Override the pre-push hook in src/tools.ts.", "git commit -n skips the hooks.", "Run with --no-verify in src/tools.ts.", "Waive the review gate for docs in src/tools.ts.",
    ],
    "real customer data and TLS": [
      "Use real customer data in tests/fixtures.ts.", "Copy actual user records into tests/fixtures.ts.", "Seed the fixtures from live data in tests/fixtures.ts.", "Use production data in tests/fixtures.ts.", "Use real user emails in tests/fixtures.ts.",
      "Disable TLS verification in src/net.ts.", "Turn off SSL checks in src/net.ts.", "Use an insecure connection in src/net.ts.",
    ],
  };
  const ALL = Object.entries(PHRASES).flatMap(([family, phrases]) => phrases.map((phrase) => [family, phrase] as const));
  it.each(ALL)("blocked (%s): %s", (_family, phrase) => {
    expect(hasRiskyTrialWording(phrase), phrase).toBe(true);
    expect(trialBlockers(clean({ body: phrase }), 1, CLEAR), phrase).toContain("risky_wording");
    expect(trialBlockers(clean({ title: phrase }), 1, CLEAR), phrase).toContain("risky_wording");
  });

  it("a Cyrillic look-alike or a zero-width character inside an identifier does not hide it either", () => {
    expect(hasRiskyTrialWording("Call useРrodDatabase in src/db.ts")).toBe(true);
    expect(hasRiskyTrialWording("Log req.b​ody in src/api/handler.ts.")).toBe(true);
  });

  it("ordinary lessons about the code still pass every rule", () => {
    for (const body of [
      "HTTP retries in the api service use withRetry from src/retry/index.ts.", "Config loaders in src/config read defaults from defaults.ts first.", "Prefer the Result type from src/result.ts for handler errors.",
      "The formatter in src/format/money.ts rounds half to even.", "useRetryBackoff in src/retry/backoff.ts reads MAX_ATTEMPTS from the config.", "Handlers in src/api return a Result; map errors with toHttpError from src/api/errors.ts.",
      "The request id is set in src/api/context.ts and read by getRequestId.", "Date helpers live in src/dates; parseIsoDate rejects strings without a zone.",
      "The test helper makeUser in tests/helpers.ts builds a user with an id and a name.", "Use the req.id value from src/api/context.ts as the cache key.",
    ]) {
      expect(hasRiskyTrialWording(body), body).toBe(false);
      expect(trialBlockers(clean({ body }), 1, CLEAR), body).toEqual([]);
    }
  });
});

describe("identifiers and paths are matched as whole tokens and path segments, never as substrings", () => {
  const text = (body: string, scopePaths?: string[]) => ({ title: "Lesson", description: "A lesson.", body, ...(scopePaths === undefined ? {} : { scopePaths }) });
  const code = (path: string, anchor = "export function x()") => [{ path, anchor }];
  it("src/a is not supported by src/abc/deep.ts, but is by src/a/deep.ts and by src/a itself", () => {
    expect(lessonClaimsSupported(text("Use the helper in src/a."), { correctionTexts: [], code: code("src/abc/deep.ts") })).toBe(false);
    expect(lessonClaimsSupported(text("Use the helper in src/a."), { correctionTexts: [], code: code("src/a/deep.ts") })).toBe(true);
    expect(lessonClaimsSupported(text("Use the helper in src/a."), { correctionTexts: ["see src/a"], code: code("src/zzz.ts") })).toBe(true);
    expect(lessonClaimsSupported(text("Use the helper in src/a."), { correctionTexts: ["see (src/a)."], code: code("src/zzz.ts") })).toBe(true);
  });
  it("an identifier inside a longer identifier does not count (withRetry vs withRetryPolicy, retry_max vs retry_max_attempts)", () => {
    expect(lessonClaimsSupported(text("Use withRetry."), { correctionTexts: ["use withRetryPolicy"], code: code("src/x.ts") })).toBe(false);
    expect(lessonClaimsSupported(text("Use withRetry."), { correctionTexts: ["use withRetry here"], code: code("src/x.ts") })).toBe(true);
    expect(lessonClaimsSupported(text("Set retry_max."), { correctionTexts: ["set retry_max_attempts"], code: code("src/x.ts") })).toBe(false);
    expect(lessonClaimsSupported(text("Set retry_max."), { correctionTexts: ["set retry_max, please"], code: code("src/x.ts") })).toBe(true);
  });
  it("a scope path glob's literal front is a whole segment prefix: src/ret/** is not supported by src/retry/index.ts", () => {
    expect(lessonClaimsSupported(text("Use withRetry.", ["src/ret/**"]), { correctionTexts: ["use withRetry"], code: code("src/retry/index.ts") })).toBe(false);
    expect(lessonClaimsSupported(text("Use withRetry.", ["src/retry/**"]), { correctionTexts: ["use withRetry"], code: code("src/retry/index.ts") })).toBe(true);
    expect(lessonClaimsSupported(text("Use withRetry.", ["src/retry/index.*"]), { correctionTexts: ["use withRetry"], code: code("src/retry/index.ts") })).toBe(true);
  });
  it("existing behaviour holds: a path the lesson names may be a prefix of a deeper cited file; a file name matches as a whole segment", () => {
    expect(lessonClaimsSupported(text("Use withRetry from src/retry/index.ts."), { correctionTexts: [], code: code("src/retry/index.ts", "export function withRetry()") })).toBe(true);
    expect(lessonClaimsSupported(text("Use withRetry from src/retry."), { correctionTexts: [], code: code("src/retry/index.ts", "export function withRetry()") })).toBe(true);
    expect(lessonClaimsSupported(text("Config is in defaults.ts."), { correctionTexts: [], code: code("src/config/defaults.ts") })).toBe(true);
    expect(lessonClaimsSupported(text("Config is in defaults.ts."), { correctionTexts: [], code: code("src/config/mydefaults.ts") })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the preset setting's ledger", () => {
  const DAY = 86_400_000;
  const NOW = 1_800_000_000_000;
  const project = { kind: "project" as const, workspaceId: WS, project: PROJECT };
  /** An audit sink that can refuse a required write of one action. */
  class FlakyAudit extends Audit {
    failing = new Set<string>();
    override async emit(event: LessonAuditEvent, options?: { required?: boolean }): Promise<void> {
      if (options?.required === true && this.failing.has(event.action)) throw new Error("down");
      await super.emit(event, options);
    }
  }
  function world(over: { eligible?: string[]; loss?: number | null; soleOwnerAllowed?: boolean; losesRace?: boolean } = {}) {
    const rows = new Map<string, "standard" | "regulated">([["project:" + PROJECT, "regulated"]]);
    const changes = new Map<string, PresetChange>();
    const audit = new FlakyAudit();
    const eligible = over.eligible ?? ["ann"];
    const group = { complete: true, membershipVersion: 7, ownerIds: eligible.slice(0, 1), eligibleIds: eligible, lastEligibleLossAtMs: over.loss ?? null as number | null };
    const key = (s: { kind: string; project?: string }) => `${s.kind}:${s.project ?? ""}`;
    const deps: PresetDeps = {
      settings: { read: async (s) => rows.get(key(s)), write: async (s, v, _meta, from) => { if ((rows.get(key(s)) ?? "standard") !== from) return false; rows.set(key(s), v); return true; } },
      changes: {
        create: async (c) => { if (over.losesRace === true || changes.has(c.id)) return false; changes.set(c.id, { ...c }); return true; },
        get: async (_s, id) => changes.get(id), open: async () => [...changes.values()].find((c) => c.state === "pending"),
        transition: async (_s, id, from, to) => { const c = changes.get(id); if (c === undefined || c.state !== from) return false; c.state = to; return true; },
      },
      audit, now: () => NOW, newId: () => "chg-1", soleOwnerLoosening: async () => over.soleOwnerAllowed ?? true,
      authority: { eligibility: async () => group },
    };
    return { deps, rows, changes, audit, group };
  }

  it("a sole owner who approves their own loosening writes lesson.sole_owner_exception (with the owner count and the reason) before lesson.preset_changed", async () => {
    const w = world();
    expect(await setLearningPreset(w.deps, { scope: project, value: "standard", requestedBy: "ann" })).toMatchObject({ ok: true, status: "needs_approval", changeId: "chg-1" });
    expect(await approvePresetChange(w.deps, { scope: project, changeId: "chg-1", approverId: "ann" })).toEqual({ ok: true, value: "standard" });
    expect(w.rows.get("project:" + PROJECT)).toBe("standard");
    const actions = w.audit.actions();
    expect(actions.filter((a) => a === "lesson.sole_owner_exception")).toHaveLength(1);
    expect(actions.indexOf("lesson.sole_owner_exception")).toBeLessThan(actions.indexOf("lesson.preset_changed"));
    expect(w.audit.events.find((e) => e.action === "lesson.sole_owner_exception")).toMatchObject({ actor: "ann", facts: { scope: "project", changeId: "chg-1", membershipVersion: 7, ownerCount: 1, exceptionReason: "sole_owner_no_other_eligible_24h_clear" } });
    expect(w.audit.events.find((e) => e.action === "lesson.preset_changed")).toMatchObject({ facts: { mode: "sole_owner_exception", from: "regulated", to: "standard" } });
  });

  it("a second person's approval writes no sole-owner entry", async () => {
    const w = world({ eligible: ["ann", "bob"] });
    await setLearningPreset(w.deps, { scope: project, value: "standard", requestedBy: "ann" });
    expect(await approvePresetChange(w.deps, { scope: project, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: true, value: "standard" });
    expect(w.audit.actions()).not.toContain("lesson.sole_owner_exception");
    expect(w.audit.events.find((e) => e.action === "lesson.preset_changed")).toMatchObject({ facts: { mode: "second_person" } });
  });

  it("when the sole-owner entry cannot be written the loosening is taken back and the proposal closed", async () => {
    const w = world();
    await setLearningPreset(w.deps, { scope: project, value: "standard", requestedBy: "ann" });
    w.audit.failing.add("lesson.sole_owner_exception");
    expect(await approvePresetChange(w.deps, { scope: project, changeId: "chg-1", approverId: "ann" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(w.rows.get("project:" + PROJECT)).toBe("regulated");
    expect(w.changes.get("chg-1")!.state).toBe("cancelled");
    expect(w.audit.actions()).not.toContain("lesson.preset_changed");
  });

  it("the cool-off path: an eligible person lost access less than 24 hours ago, so the sole owner waits (with the time it opens) and nothing changes, until the day has passed", async () => {
    const w = world({ loss: NOW - 3_600_000 });
    await setLearningPreset(w.deps, { scope: project, value: "standard", requestedBy: "ann" });
    expect(await approvePresetChange(w.deps, { scope: project, changeId: "chg-1", approverId: "ann" })).toEqual({ ok: false, code: "sole_owner_cool_off", availableAt: new Date(NOW - 3_600_000 + DAY).toISOString() });
    expect(w.rows.get("project:" + PROJECT)).toBe("regulated");
    expect(w.changes.get("chg-1")!.state).toBe("pending");
    expect(w.audit.actions()).not.toContain("lesson.sole_owner_exception");
    expect(w.audit.actions()).not.toContain("lesson.preset_changed");
    // The cool-off ends: the same proposal now goes through.
    w.group.lastEligibleLossAtMs = NOW - DAY - 1;
    expect(await approvePresetChange(w.deps, { scope: project, changeId: "chg-1", approverId: "ann" })).toEqual({ ok: true, value: "standard" });
  });

  it("with the company's sole-owner switch off the cool-off answer is a plain second-person requirement (it does not even say when)", async () => {
    const w = world({ loss: NOW - 3_600_000, soleOwnerAllowed: false });
    await setLearningPreset(w.deps, { scope: project, value: "standard", requestedBy: "ann" });
    expect(await approvePresetChange(w.deps, { scope: project, changeId: "chg-1", approverId: "ann" })).toEqual({ ok: false, code: "second_person_required" });
  });

  it("a proposal that loses the creation race leaves NO preset_proposed ledger entry", async () => {
    const w = world({ losesRace: true });
    expect(await setLearningPreset(w.deps, { scope: project, value: "standard", requestedBy: "ann" })).toEqual({ ok: false, code: "conflict" });
    expect(w.audit.actions()).not.toContain("lesson.preset_proposed");
    expect(w.changes.size).toBe(0);
  });

  it("a proposal whose ledger entry cannot be written is closed again, not left waiting for a second person", async () => {
    const w = world();
    w.audit.failing.add("lesson.preset_proposed");
    expect(await setLearningPreset(w.deps, { scope: project, value: "standard", requestedBy: "ann" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(w.changes.get("chg-1")!.state).toBe("cancelled");
    expect(await w.deps.changes.open(project, NOW)).toBeUndefined();
    // Positive control: with the ledger back the same request opens a proposal and writes the entry.
    w.audit.failing.clear();
    const again = world();
    expect(await setLearningPreset(again.deps, { scope: project, value: "standard", requestedBy: "ann" })).toMatchObject({ ok: true, status: "needs_approval" });
    expect(again.audit.actions()).toContain("lesson.preset_proposed");
  });

  it("needs_approval reports the value actually in force (the current one, read from the store)", async () => {
    const w = world();
    expect(await setLearningPreset(w.deps, { scope: project, value: "standard", requestedBy: "ann" })).toEqual({ ok: true, status: "needs_approval", changeId: "chg-1", value: "regulated" });
  });
});
