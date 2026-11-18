// L4-EVS2 (DEC 254zzz20 D3): the broker fills the `eval-plan` answer's `environment` from the project's own saved environment (the saved-image row and the pull login of #952's store) or its approved
// install steps, for THIS company and project only, and says nothing when neither is there. Every guard has a test that fails without it (mutants in briefs/lead4/L4-EVS2-MUTANTS-20261118.md; the producer's own `savedEnvRepositoryIsFor` check is defence in depth behind `mintPullSession`'s, so it has no mutant test).
import { describe, expect, it } from "vitest";
import {
  EvalEnvironmentSchema, TestEnvironmentBodySchema, evalCommandFingerprint, evalQuestionHash, savedEnvRepositoryIsFor, savedEnvRepositoryName, testEnvDigest,
  type Approvers, type EvalPlanBody, type EvalSpendPlan, type OrgId, type Principal, type ProjectCommand, type SavedEnvManifest, type TestEnvironmentBody,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createFakeImageRegistry, type FakeImageRegistry } from "../../packages/broker/src/ports/fake-image-registry.js";
import { createEvalEnvironmentSource, evalSavedEnvDepsOf, installStepsOf, repositoryPathsOf, type EvalEnvironmentSourceEvent } from "../../packages/broker/src/core/setup-agent/eval-environment-source.js";
import { createEvalPlanSources } from "../../packages/broker/src/core/setup-agent/eval-plan-source.js";
import { documentSavedEnvStore, SAVED_ENV_INDEXES } from "../../packages/broker/src/core/test-env/saved-env-store.js";
import type { SavedEnvImageRecord, SavedEnvState } from "../../packages/broker/src/core/test-env/saved-env.js";
import { documentOf } from "../../packages/broker/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { EVAL_SPEND_KIND, createEvalSpendSubject, proposeEvalSpendApproval } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createNoopAuditSink } from "../../packages/broker/src/ports/policy-defaults.js";
import type { SessionMembers } from "../../packages/broker/src/core/sessions/access.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const WEB = "web";
const NOW = Date.parse("2026-11-18T08:00:00.000Z");
const AT = new Date(NOW - 3_600_000).toISOString();
const IMAGE = `sha256:${"1".repeat(64)}`;
const KEY = "c".repeat(64);
const ON = { ROVARA_SAVED_ENVIRONMENTS: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

const cmd = (executable: string, args: string[] = [], cwd = "demo", extra: Partial<ProjectCommand> = {}): ProjectCommand => ({ cwd, executable, args, timeoutSeconds: 600, ...extra });
const body = (repos?: TestEnvironmentBody["repos"]): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: repos ?? [{ repositoryId: "demo", setupCommands: [cmd("pip", ["install", "-r", "requirements.txt"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("python3", ["-m", "pytest"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["unit"], fullSuiteOn: ["requirements.txt"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});

/** An approved revision, written the way an approval writes it (the revision row and the pointer). */
async function approve(db: MemoryDocumentStore, org: OrgId, project: string, environment: TestEnvironmentBody, revision = 1): Promise<{ revision: number; digest: string }> {
  const digest = testEnvDigest(environment);
  await db.put({ item: documentOf({ ...testEnvRevisionKey(org, project, revision), entityType: "TEST_ENV_REVISION", orgId: org, project, revision, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "owner", digest, requestId: "r".repeat(12), lessSafe: [], environment }) });
  await db.put({ item: { ...testEnvLatestKey(org, project), entityType: "TEST_ENV_LATEST", orgId: org, project, revision, digest } });
  return { revision, digest };
}

const manifest = (revision: number, repositoryId = "demo"): SavedEnvManifest => ({ schemaVersion: 1, environmentKey: KEY, testEnvRevision: revision, commits: [{ repositoryId, sha: "f".repeat(40) }], proveReportDigest: "b".repeat(64), imageDigest: IMAGE, builtAt: AT });
async function putImage(db: MemoryDocumentStore, org: OrgId, project: string, approved: { revision: number; digest: string }, over: { image?: Partial<SavedEnvImageRecord>; state?: Partial<SavedEnvState>; repositoryId?: string; rowOrg?: OrgId; rowProject?: string } = {}): Promise<void> {
  const image: SavedEnvImageRecord = { approved, digest: IMAGE, tag: "k1", manifest: manifest(approved.revision, over.repositoryId), recordedAt: AT, status: "ready", ...over.image };
  const state: SavedEnvState = { orgId: over.rowOrg ?? org, projectId: over.rowProject ?? project, version: 1, enabled: true, images: [image], health: "healthy", ...over.state };
  // The row is written at the key of (org, project) whatever it says about itself (the damaged cases).
  const key = { pk: `ORG#${org}`, sk: `SAVED_ENV#${project}` };
  const written = documentSavedEnvStore({ store: db, now: () => NOW });
  expect(await written.commit({ ...state, orgId: org, projectId: project }, null, { action: "build_recorded", orgId: org, projectId: project, at: AT })).toBe(true);
  if (over.rowOrg !== undefined || over.rowProject !== undefined) await db.put({ item: { ...(await db.get(key))!, orgId: state.orgId, projectId: state.projectId } as never });
}

function world(options: { env?: NodeJS.ProcessEnv; paths?: Map<string, string> | undefined; registry?: FakeImageRegistry; hosted?: boolean; company?: OrgId } = {}) {
  const db = new MemoryDocumentStore({ indexes: SAVED_ENV_INDEXES });
  const registry = options.registry ?? createFakeImageRegistry({ now: () => NOW });
  const events: EvalEnvironmentSourceEvent[] = [];
  const company = options.company ?? A;
  const env = options.env ?? ON;
  const paths = "paths" in options ? options.paths : new Map([["demo", "demo"]]);
  const source = createEvalEnvironmentSource({
    store: db, companyId: company, now: () => NOW, env, repositoryPaths: async () => paths,
    savedEnv: () => evalSavedEnvDepsOf({ store: db, registry: () => registry, envName: "local", now: () => NOW, env, ...(options.hosted === true ? { hosted: true } : {}) }),
    log: (event) => { events.push(event); },
  });
  const repositoryName = (org: OrgId = A, project = WEB): string => savedEnvRepositoryName({ env: "local", orgId: org, projectId: project });
  /** The image is in the registry (the worker's push) and its row is recorded for the approved environment. */
  const withImage = async (org: OrgId = A, project = WEB, over: Parameters<typeof putImage>[4] = {}) => {
    const approved = await approve(db, org, project, body());
    registry.pushForTest(repositoryName(org, project), { digest: IMAGE });
    await putImage(db, org, project, approved, over);
    return approved;
  };
  return { db, registry, events, source, repositoryName, withImage };
}
const scope = (org: OrgId = A, project = WEB) => ({ companyId: org, project });
const FALLBACK = [{ executable: "pip", args: ["install", "-r", "requirements.txt"], cwd: "." }];

describe("the saved image", () => {
  it("is chosen when one is ready for this project's approved environment, with a login for its one repository and the approved install steps as the fallback", async () => {
    const w = world();
    await w.withImage();
    const environment = await w.source(scope(), undefined);
    expect(environment).toMatchObject({ kind: "saved", repository: w.repositoryName(), digest: IMAGE, environmentKey: KEY, testEnvRevision: 1, directory: "demo", fallbackInstall: FALLBACK });
    expect(EvalEnvironmentSchema.safeParse(environment).success).toBe(true);
    if (environment?.kind !== "saved") throw new Error("not saved");
    expect(environment.login.repository).toBe(w.repositoryName());
    expect(savedEnvRepositoryIsFor(environment.login.repository, { orgId: A, projectId: WEB })).toBe(true);
    // one login, for the pull of that one repository
    expect(w.registry.loginsGiven()).toEqual([expect.objectContaining({ repository: w.repositoryName(), access: "pull" })]);
  });

  it("names the plan's own repository (several repositories), and is the repository's folder in the seed", async () => {
    const w = world({ paths: new Map([["demo", "repo/demo"], ["web", "repo/web"]]) });
    const two = body([
      { repositoryId: "demo", setupCommands: [cmd("npm", ["ci"], "repo/demo")], checks: [{ id: "unit", label: "Unit", command: cmd("npm", ["test"], "repo/demo"), kind: "test" }] },
      { repositoryId: "web", setupCommands: [cmd("npm", ["ci"], "repo/web/app")], checks: [] },
    ]);
    const approved = await approve(w.db, A, WEB, two);
    w.registry.pushForTest(w.repositoryName(), { digest: IMAGE });
    await putImage(w.db, A, WEB, approved, { repositoryId: "web" });
    expect(await w.source(scope(), "web")).toMatchObject({ kind: "saved", directory: "repo/web", fallbackInstall: [{ executable: "npm", args: ["ci"], cwd: "app" }] });
    // the image holds `web` and not `demo`: the plan for `demo` does not get it (its install steps only)
    expect(await w.source(scope(), "demo")).toEqual({ kind: "install", commands: [{ executable: "npm", args: ["ci"], cwd: "." }] });
    // two repositories and a plan that names none: which one is not known, so nothing
    expect(await w.source(scope(), undefined)).toBeUndefined();
    expect(await w.source(scope(), "other")).toBeUndefined();
  });

  it("carries no fallback when the approved environment has no install steps", async () => {
    const w = world();
    const approved = await approve(w.db, A, WEB, body([{ repositoryId: "demo", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }]));
    w.registry.pushForTest(w.repositoryName(), { digest: IMAGE });
    await putImage(w.db, A, WEB, approved);
    const environment = await w.source(scope(), undefined);
    expect(environment).toMatchObject({ kind: "saved" });
    expect(environment).not.toHaveProperty("fallbackInstall");
  });

  it("is not used when it is stale, built for another approved revision or digest, too old, not ready, or the project is turned off, archived or deleted: the install steps instead", async () => {
    const cases: Array<[string, (approved: { revision: number; digest: string }) => Parameters<typeof putImage>[4]]> = [
      ["stale", () => ({ image: { status: "stale" } })],
      ["another revision", (approved) => ({ image: { approved: { ...approved, revision: 9 } } })],
      ["another digest", (approved) => ({ image: { approved: { ...approved, digest: "9".repeat(64) } } })],
      ["manifest of another revision", () => ({ image: { manifest: manifest(7) } })],
      ["too old", () => ({ image: { recordedAt: new Date(NOW - 9 * 86_400_000).toISOString() } })],
      ["turned off", () => ({ state: { enabled: false } })],
      ["archived", () => ({ state: { archived: true } })],
      ["deleted", () => ({ state: { deleted: true } })],
    ];
    for (const [name, over] of cases) {
      const w = world();
      const approved = await approve(w.db, A, WEB, body());
      w.registry.pushForTest(w.repositoryName(), { digest: IMAGE });
      await putImage(w.db, A, WEB, approved, over(approved));
      expect(await w.source(scope(), undefined), name).toEqual({ kind: "install", commands: FALLBACK });
    }
  });

  it("is not used when the saved-environments switch is off, the registry cannot serve a pull, or it cannot give a login (down, repository made by someone else): the install steps instead", async () => {
    const off = world({ env: OFF });
    await off.withImage();
    expect(await off.source(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
    expect(off.registry.loginsGiven()).toEqual([]);

    const noPull = world({ registry: createFakeImageRegistry({ now: () => NOW, capabilities: { workerPull: false } }) });
    await noPull.withImage();
    expect(await noPull.source(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
    expect(noPull.registry.loginsGiven()).toEqual([]);

    const down = world();
    await down.withImage();
    down.registry.setDown(true);
    expect(await down.source(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });

    const foreign = world();
    await foreign.withImage();
    foreign.registry.makeForeignForTest(foreign.repositoryName());
    expect(await foreign.source(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
    expect(foreign.events).toContain("eval_environment_saved_unusable");
  });

  it("a hosted install refuses a login that names a loopback registry (a cloud registry host only)", async () => {
    const hosted = world({ hosted: true });
    await hosted.withImage();
    expect(await hosted.source(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
    const local = world();
    await local.withImage();
    expect((await local.source(scope(), undefined))?.kind).toBe("saved");
  });
});

describe("the approved install steps", () => {
  it("are the answer when there is no image: an argv each, the directory made relative to the checkout", async () => {
    const w = world({ paths: new Map([["demo", "repo/demo"]]) });
    await approve(w.db, A, WEB, body([{ repositoryId: "demo", setupCommands: [cmd("pip", ["install", "-r", "requirements.txt"], "repo/demo"), cmd("npm", ["ci"], "repo/demo/web/ui")], checks: [{ id: "unit", label: "Unit", command: cmd("pytest", [], "repo/demo"), kind: "test" }] }]));
    expect(await w.source(scope(), "demo")).toEqual({ kind: "install", commands: [{ executable: "pip", args: ["install", "-r", "requirements.txt"], cwd: "." }, { executable: "npm", args: ["ci"], cwd: "web/ui" }] });
    expect(await w.source(scope(), undefined)).toEqual(await w.source(scope(), "demo"));
  });

  it("are not given as a part: a step with its own variables, one outside the repository, a shape the worker refuses or more than the limit is no install at all", async () => {
    const bad: Array<[string, ProjectCommand[]]> = [
      ["env", [cmd("npm", ["ci"]), cmd("npm", ["run", "x"], "demo", { env: { NODE_ENV: "test" } })]],
      ["outside the repository", [cmd("npm", ["ci"]), cmd("npm", ["ci"], "other")]],
      ["a sibling of the same prefix", [cmd("npm", ["ci"], "demo-two")]],
      ["an executable the worker refuses", [cmd("npm ci && curl x", [])]],
      ["too many", Array.from({ length: 9 }, () => cmd("npm", ["ci"]))],
    ];
    for (const [name, setupCommands] of bad) {
      const w = world();
      await approve(w.db, A, WEB, body([{ repositoryId: "demo", setupCommands, checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }]));
      expect(await w.source(scope(), undefined), name).toBeUndefined();
      expect(w.events, name).toContain("eval_environment_install_unusable");
    }
    // a list over the byte bound is no install (never a part, never a reason to withhold the plan)
    const wide = Array.from({ length: 8 }, () => cmd("npm", ["install", ...Array.from({ length: 4 }, () => "x".repeat(8_000))]));
    expect(installStepsOf(wide, "demo")).toBeUndefined();
    // an empty env object is no variable
    expect(installStepsOf([cmd("npm", ["ci"], "demo", { env: {} })], "demo")).toEqual([{ executable: "npm", args: ["ci"], cwd: "." }]);
    expect(installStepsOf([], "demo")).toBeUndefined();
  });

  it("a saved image still comes with no fallback when the install steps cannot be given", async () => {
    const w = world();
    const approved = await approve(w.db, A, WEB, body([{ repositoryId: "demo", setupCommands: [cmd("npm", ["ci"], "elsewhere")], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }]));
    w.registry.pushForTest(w.repositoryName(), { digest: IMAGE });
    await putImage(w.db, A, WEB, approved);
    const environment = await w.source(scope(), undefined);
    expect(environment?.kind).toBe("saved");
    expect(environment).not.toHaveProperty("fallbackInstall");
  });
});

describe("absent", () => {
  it("is the answer with no approved environment (even with an image row), with the test environment switched off, and with no steps and no image", async () => {
    const none = world();
    expect(await none.source(scope(), undefined)).toBeUndefined();
    const orphan = world();
    orphan.registry.pushForTest(orphan.repositoryName(), { digest: IMAGE });
    await putImage(orphan.db, A, WEB, { revision: 1, digest: testEnvDigest(body()) });
    expect(await orphan.source(scope(), undefined)).toBeUndefined();

    const off = world({ env: { ...ON, ROVARA_TEST_ENVIRONMENT: "off" } });
    await off.withImage();
    expect(await off.source(scope(), undefined)).toBeUndefined();

    const bare = world();
    await approve(bare.db, A, WEB, body([{ repositoryId: "demo", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }]));
    expect(await bare.source(scope(), undefined)).toBeUndefined();
  });

  it("is the answer when the project's repositories cannot be read or do not name the plan's repository", async () => {
    const w = world({ paths: undefined });
    await w.withImage();
    expect(await w.source(scope(), undefined)).toBeUndefined();
    const other = world({ paths: new Map([["other", "other"]]) });
    await other.withImage();
    expect(await other.source(scope(), undefined)).toBeUndefined();
  });
});

describe("company and project scope", () => {
  it("never uses another project's or another company's image, install steps or login", async () => {
    const w = world();
    // company B's project `web` and company A's other project `api` have images and approved environments; A's `web` has nothing.
    await w.withImage(B, WEB);
    await w.withImage(A, "api");
    const logins = w.registry.loginsGiven().length;
    expect(await w.source(scope(A, WEB), undefined)).toBeUndefined();
    expect(w.registry.loginsGiven()).toHaveLength(logins);
    // A's `api` gets its own repository's login, never B's or `web`'s
    const own = await w.source(scope(A, "api"), undefined);
    expect(own).toMatchObject({ kind: "saved", repository: w.repositoryName(A, "api") });
    expect(own).not.toMatchObject({ repository: w.repositoryName(B, WEB) });
    // a source for company A is not for company B's scope, whatever B holds
    expect(await w.source(scope(B, WEB), undefined)).toBeUndefined();
    // and A's `web`, once it has its own steps (no image), gets only those
    await approve(w.db, A, WEB, body([{ repositoryId: "demo", setupCommands: [cmd("make", ["deps"])], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }]));
    expect(await w.source(scope(A, WEB), undefined)).toEqual({ kind: "install", commands: [{ executable: "make", args: ["deps"], cwd: "." }] });
  });

  it("refuses a scope of another company before anything is read, even when this company holds the very same approved environment (no login is minted for the other)", async () => {
    const w = world();
    await w.withImage(A, WEB);
    await w.withImage(B, WEB);
    const before = w.registry.loginsGiven().length;
    expect(await w.source(scope(B, WEB), undefined)).toBeUndefined();
    expect(w.registry.loginsGiven()).toHaveLength(before);
    expect(await w.source(scope(A, WEB), undefined)).toMatchObject({ kind: "saved", repository: w.repositoryName(A, WEB) });
  });

  it("does not take a row that says it is another company's or project's, whatever key it is stored at", async () => {
    for (const over of [{ rowOrg: B }, { rowProject: "api" }]) {
      const w = world();
      const approved = await approve(w.db, A, WEB, body());
      w.registry.pushForTest(w.repositoryName(), { digest: IMAGE });
      await putImage(w.db, A, WEB, approved, over);
      expect(await w.source(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
      expect(w.registry.loginsGiven()).toEqual([]);
    }
  });

  it("an approved environment of another project is not this project's steps (the rows are keyed by company and project)", async () => {
    const w = world();
    await approve(w.db, A, "api", body([{ repositoryId: "demo", setupCommands: [cmd("make", ["api"])], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }]));
    expect(await w.source(scope(A, WEB), undefined)).toBeUndefined();
    expect(await w.source(scope(A, "api"), undefined)).toEqual({ kind: "install", commands: [{ executable: "make", args: ["api"], cwd: "." }] });
  });
});

describe("unreadable stores fail closed", () => {
  /** A store whose reads of rows whose sort key starts with `prefix` throw. */
  const breaking = (db: MemoryDocumentStore, prefix: string): MemoryDocumentStore => {
    const get = db.get.bind(db);
    db.get = (async (key: { pk: string; sk: string }) => { if (key.sk.startsWith(prefix)) throw new Error("store down"); return get(key as never); }) as never;
    return db;
  };

  it("the approved environment unreadable gives absent: no install steps, no image, no login", async () => {
    const w = world();
    await w.withImage();
    breaking(w.db, "TESTENV#");
    expect(await w.source(scope(), undefined)).toBeUndefined();
    expect(w.registry.loginsGiven()).toEqual([]);
    expect(w.events).toContain("eval_environment_unreadable");
  });

  it("a damaged approved environment gives absent", async () => {
    const w = world();
    await w.withImage();
    const latest = (await w.db.get(testEnvLatestKey(A, WEB)))!;
    await w.db.put({ item: { ...latest, revision: 5 } });
    expect(await w.source(scope(), undefined)).toBeUndefined();
  });

  it("the saved-image row unreadable (store down, or a row that does not read back) gives no image, never another's; the project's own approved steps still stand", async () => {
    const down = world();
    await down.withImage();
    breaking(down.db, "SAVED_ENV#");
    expect(await down.source(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
    expect(down.registry.loginsGiven()).toEqual([]);

    const damaged = world();
    await damaged.withImage();
    const row = (await damaged.db.get({ pk: `ORG#${A}`, sk: `SAVED_ENV#${WEB}` }))!;
    await damaged.db.put({ item: { ...row, enabled: "yes" } as never });
    expect(await damaged.source(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
    expect(damaged.registry.loginsGiven()).toEqual([]);
  });

  it("a store of the approved environment that never answers cleanly, and every unexpected fault, give absent rather than throw", async () => {
    const w = world();
    await w.withImage();
    const failing = createEvalEnvironmentSource({
      store: { get: async () => { throw new Error("x"); } } as never, companyId: A, now: () => NOW, env: ON, repositoryPaths: async () => { throw new Error("x"); },
    });
    expect(await failing(scope(), undefined)).toBeUndefined();
    const throwingSaved = createEvalEnvironmentSource({
      store: w.db, companyId: A, now: () => NOW, env: ON, repositoryPaths: async () => new Map([["demo", "demo"]]), savedEnv: () => { throw new Error("no registry"); },
    });
    expect(await throwingSaved(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
  });
});

describe("an archived project", () => {
  it("is given no environment, not even its install steps", async () => {
    const w = world();
    await approve(w.db, A, WEB, body());
    const archived = createEvalEnvironmentSource({ store: w.db, companyId: A, now: () => NOW, env: ON, repositoryPaths: repositoryPathsOf({ latest: async () => ({ archived: true, definition: { repositories: [{ name: "demo", path: "demo" }] } }) as never }) });
    expect(await archived(scope(), undefined)).toBeUndefined();
    const live = createEvalEnvironmentSource({ store: w.db, companyId: A, now: () => NOW, env: ON, repositoryPaths: repositoryPathsOf({ latest: async () => ({ definition: { repositories: [{ name: "demo", path: "demo" }] } }) as never }) });
    expect(await live(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
  });

  it("an install install-list too big for the answer, and an unbound registry, are no fault", async () => {
    const w = world();
    await approve(w.db, A, WEB, body());
    const noRegistry = createEvalEnvironmentSource({
      store: w.db, companyId: A, now: () => NOW, env: OFF, repositoryPaths: async () => new Map([["demo", "demo"]]),
      savedEnv: () => evalSavedEnvDepsOf({ store: w.db, registry: () => { throw new Error("no registry"); }, envName: "local", now: () => NOW, env: OFF }), log: (event) => w.events.push(event),
    });
    expect(await noRegistry(scope(), undefined)).toEqual({ kind: "install", commands: FALLBACK });
    expect(w.events).toEqual([]);
  });
});

describe("repositoryPathsOf", () => {
  it("is the project's registered repositories by name, and undefined when there is no project or it cannot be read", async () => {
    const definition = { repositories: [{ name: "demo", path: "repo/demo" }, { name: "docs", path: "repo/docs" }] };
    expect([...(await repositoryPathsOf({ latest: async () => ({ definition }) as never })("p"))!]).toEqual([["demo", "repo/demo"], ["docs", "repo/docs"]]);
    expect(await repositoryPathsOf({ latest: async () => undefined })("p")).toBeUndefined();
    expect(await repositoryPathsOf({ latest: async () => { throw new Error("x"); } })("p")).toBeUndefined();
  });
});

describe("the eval plan source", () => {
  const settings = { imageDigest: "sha256:" + "e".repeat(64), route: "gateway" };
  const judgePin = "b".repeat(64);
  const inputs = { evalSetHash: "a".repeat(64), judgePin, modelVersion: "version-1", model: "model", catalogRowId: "model", commandFingerprint: evalCommandFingerprint("npm run eval"), settingsFingerprint: evalSettingsFingerprint(settings, judgePin) };
  const evalPlan = (): EvalPlanBody => ({
    selection: "evals/demo", inputs: { ...inputs }, key: { commandFingerprint: inputs.commandFingerprint, catalogRowId: "model", model: "model", modelVersion: "version-1" }, settings, evalSetHash: inputs.evalSetHash, evalConfigured: true,
    judgePin, baselineJudgePin: judgePin, subsetSupported: true, questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt", hash: evalQuestionHash(Buffer.from("question one\n")) }], maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10,
    repository: "demo",
  });
  const spendPlan = (): Omit<EvalSpendPlan, "evalPlanDigest"> => ({ selection: "evals/demo", inputs: { ...inputs }, estimate: { calls: 6, costMicros: 60 }, budget: { usual: { calls: 6, costMicros: 60 }, maximum: { calls: 400, costMicros: 4_000_000 } } });
  const BASE = "c".repeat(40);
  const run = { bases: [{ repositoryId: "demo", baseCommitSha: BASE }] };

  /** An approved eval plan of company A's project `web`, and a plan source over it with `environment`. */
  async function approvedSources(environment: Parameters<typeof createEvalPlanSources>[0]["environment"]) {
    const store = new MemoryDocumentStore();
    const principal: Principal = { companyId: A, personId: "person", roles: ["owner"], provider: "test-identity", displayName: "Test" };
    const members: SessionMembers = { companyRole: p => p.companyId === A && p.developerId === developerIdOf(principal) ? "owner" : undefined, projectGrant: () => undefined };
    const deps = { store, companyId: A, members, monthlyCapMicros: 50_000_000 };
    const approvers: Approvers = { requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }), verify: async (_request, proof) => ({ approved: true, approver: principal, method: proof.method, proofId: proof.proofId }) };
    const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [createEvalSpendSubject(deps)], now: () => new Date("2026-11-16T05:00:00.000Z") });
    const row = await proposeEvalSpendApproval(deps, WEB, spendPlan(), evalPlan());
    const decided = await gate.decide({ companyId: A, kind: EVAL_SPEND_KIND, subjectId: WEB, requestId: "eval-decision-1-approve", outcome: "approve", seen: { revision: row.revision, artifactDigest: row.digest }, credentials: [{ method: "local-session", token: ["fake", "session"].join("-") }] });
    expect(decided.status).toBe("decided");
    return createEvalPlanSources({ store, companyId: A, registry: { names: () => [], get: () => undefined } as never, ...(environment === undefined ? {} : { environment }) });
  }

  it("answers the environment of the run's own company and project and the plan's own repository, with the plan", async () => {
    const asked: unknown[] = [];
    const sources = await approvedSources(async (sc, repository) => { asked.push([sc, repository]); return { kind: "install", commands: [{ executable: "pip", args: ["install", "-r", "requirements.txt"], cwd: "." }] }; });
    const read = await sources.read({ companyId: A, project: WEB }, run);
    expect(read?.environment).toEqual({ kind: "install", commands: [{ executable: "pip", args: ["install", "-r", "requirements.txt"], cwd: "." }] });
    expect(read?.plan).toMatchObject({ company: A, project: WEB, repository: "demo" });
    expect(asked).toEqual([[{ companyId: A, project: WEB }, "demo"]]);
  });

  it("answers no environment (and still the plan) when there is none, when none is wired, and when reading it fails", async () => {
    for (const environment of [undefined, async () => undefined, async () => { throw new Error("boom"); }, (() => { throw new Error("sync boom"); }) as never]) {
      const read = await (await approvedSources(environment)).read({ companyId: A, project: WEB }, run);
      expect(read?.plan).toMatchObject({ project: WEB });
      expect(read).not.toHaveProperty("environment");
    }
  });

  it("is delivered end to end through the real source: the plan, then the project's own install steps", async () => {
    const w = world();
    await approve(w.db, A, WEB, body());
    const read = await (await approvedSources(w.source)).read({ companyId: A, project: WEB }, run);
    expect(read?.environment).toEqual({ kind: "install", commands: FALLBACK });
    // a run of another company's scope is answered nothing at all
    expect(await (await approvedSources(w.source)).read({ companyId: B, project: WEB }, run)).toBeUndefined();
  });
});
