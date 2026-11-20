// Engine host (lane E2): the switch blockers. A blocker is a REQUIRED check the root runs before it hands out a company's runtime with an area on. The first one is honest CI: the core always
// reports honest CI states (unreadable, required_missing; "none" is never read as passing), so the deployment must hand in the project's own CI mode reader, the one its merge tracking and its
// task readers use. Without it the switch is refused for the merge area, never run on a default mode.
import { describe, expect, it } from "vitest";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import {
  CORE_SWITCH_BLOCKERS, CoreSwitchBlockedError, CI_MODE_UNREADABLE_WORDS, SWITCH_BLOCKED_WORDS, checkedCiReporting, createCoreHostApp, type CoreHostApp, type CoreService, type CoreServiceName, type CoreServiceWiring,
} from "../../packages/broker/src/core-host/index.js";
import type { TaskFlow } from "../../packages/broker/src/core/task-flow/flow.js";
import type { ProjectCiMode, TrackedTask } from "../../packages/broker/src/core/merge/index.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const ALL_SERVICES = () => ({
  "merge-tracking": { pass: async () => ({ swept: 0 }) }, "session-sweep": { pass: async () => ({ swept: 0 }) },
  "notify-deliver": { pass: async () => ({ sent: 0 }) }, "admission-hold-sweep": { pass: async () => ({ charged: 0 }) },
});
const TASK = { taskId: "t-1", companyId: FAKE_COMPANY } as unknown as TrackedTask;
const SECRET = "SECRET-sk-live-zzz org_leak000000000000000";

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv, ciReporting: unknown, extra: { services?: (flow: TaskFlow, wiring: CoreServiceWiring) => Partial<Record<CoreServiceName, CoreService>>; servedCompanies?: () => Promise<readonly string[]> } = {}): CoreHostApp {
  return createCoreHostApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    ...(extra.servedCompanies === undefined ? {} : { servedCompanies: extra.servedCompanies }),
    runtime: () => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
      services: extra.services ?? ALL_SERVICES,
      ...(ciReporting === undefined ? {} : { ciReporting: ciReporting as never }),
    }),
  });
}

/** The error a promise rejects with; a resolved promise fails the test. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (caught) { return caught as Error; }
  throw new Error("expected a rejection");
}
const honest = (...given: unknown[]) => { const mode = given.length === 0 ? "their_ci_fix" : given[0]; return { honest: true, ciMode: () => mode }; };

describe("the switch blockers list", () => {
  it("names honest CI as a required blocker of the merge area, in fixed plain words with an owner", () => {
    const blocker = CORE_SWITCH_BLOCKERS.find((entry) => entry.id === "honest-ci");
    expect(blocker).toMatchObject({ id: "honest-ci", area: "merge" });
    expect(blocker?.words).toMatch(/CI/u);
    expect(blocker?.owner.length).toBeGreaterThan(0);
    expect(new Set(CORE_SWITCH_BLOCKERS.map((entry) => entry.id)).size).toBe(CORE_SWITCH_BLOCKERS.length);
  });
});

describe("a dispatch-only root", () => {
  const ON = { ROVARA_CORE_ENGINE: "on" } as NodeJS.ProcessEnv;
  it("is not asked for honest CI (it runs no merge tracking), while an ordinary root with the merge area on is refused", async () => {
    const world = createFakeWorld();
    const dispatchOnly = createCoreHostApp({
      env: ON, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now, dispatchOnly: true, servedCompanies: async () => [],
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined }),
    });
    expect((await dispatchOnly.runtimeFor(FAKE_COMPANY)).companyId).toBe(FAKE_COMPANY);
    const ordinary = appOver(createFakeWorld(), ON, undefined);
    expect(await rejectionOf(ordinary.runtimeFor(FAKE_COMPANY))).toBeInstanceOf(CoreSwitchBlockedError);
  });
});

describe("checkedCiReporting: validated at run time, not only by the type", () => {
  it.each<[string, unknown]>([
    ["absent", undefined],
    ["null", null],
    ["honest false", { honest: false, ciMode: () => "sandbox_only" }],
    ["honest as text", { honest: "true", ciMode: () => "sandbox_only" }],
    ["honest missing", { ciMode: () => "sandbox_only" }],
    ["ciMode not a function", { honest: true, ciMode: "sandbox_only" }],
    ["ciMode missing", { honest: true }],
    ["not an object", "honest"],
  ])("refuses %s", (_name, given) => {
    expect(checkedCiReporting(given)).toBeUndefined();
  });

  it.each(["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"] as ProjectCiMode[])("passes the project's mode %s through unchanged", async (mode) => {
    expect(await checkedCiReporting(honest(mode))!.ciMode(TASK)).toBe(mode);
  });

  it.each([["an unknown mode", "trust_me"], ["undefined", undefined], ["a number", 3], ["an object", { mode: "sandbox_only" }]])("a reader answering %s is a fixed refusal, never the default mode", async (_name, answer) => {
    const reporting = checkedCiReporting(honest(answer))!;
    await expect(reporting.ciMode(TASK)).rejects.toThrow(CI_MODE_UNREADABLE_WORDS);
  });

  it("a reader that throws is the same fixed refusal and never echoes its text", async () => {
    const reporting = checkedCiReporting({ honest: true, ciMode: () => { throw new Error(SECRET); } })!;
    const error = await rejectionOf(reporting.ciMode(TASK));
    expect(error.message).toContain(CI_MODE_UNREADABLE_WORDS);
    expect(error.message).not.toContain("SECRET");
    expect(JSON.stringify(error)).not.toContain("SECRET");
  });
});

describe("the root refuses a company's runtime while a blocker stands", () => {
  it("merge on and no CI reporting wired: refused with the blocker's id and fixed words", async () => {
    const app = appOver(createFakeWorld(), { ROVARA_CORE_ENGINE: "on" }, undefined);
    const error = await rejectionOf(app.runtimeFor(FAKE_COMPANY)) as CoreSwitchBlockedError;
    expect(error).toBeInstanceOf(CoreSwitchBlockedError);
    expect(error.name).toBe("CoreSwitchBlockedError");
    expect(error.blockers).toEqual(["honest-ci"]);
    expect(error.message).toContain(SWITCH_BLOCKED_WORDS);
    expect(error.message).toContain("honest-ci");
  });

  it.each([["honest false", { honest: false, ciMode: () => "sandbox_only" }], ["honest as text", { honest: "true", ciMode: () => "sandbox_only" }], ["ciMode not a function", { honest: true, ciMode: SECRET }]])("refused when the wiring is %s, and the error names nothing it was given", async (_name, given) => {
    const error = await rejectionOf(appOver(createFakeWorld(), { ROVARA_CORE_ENGINE: `on:${FAKE_COMPANY}` }, given).runtimeFor(FAKE_COMPANY));
    expect(error).toBeInstanceOf(CoreSwitchBlockedError);
    expect(error.message).not.toContain("SECRET");
  });

  it("without a valid reader, the services still never get 'no reader' (merge tracking's default mode): they get one that always refuses", async () => {
    const seen: Array<((task: typeof TASK) => Promise<unknown>) | undefined> = [];
    const app = appOver(createFakeWorld(), { ROVARA_CORE_ENGINE: "on" }, { honest: false, ciMode: () => "sandbox_only" }, {
      services: (_flow, wiring) => { seen.push(wiring.ciMode); return ALL_SERVICES(); },
    });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toBeInstanceOf(CoreSwitchBlockedError);
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe("function");
    await expect(seen[0]!(TASK)).rejects.toThrow(CI_MODE_UNREADABLE_WORDS);
  });
});
