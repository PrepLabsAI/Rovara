// "How we work" in Code's core: the file read through the code host, the stored item Cloud's readers read, the view, and the layers each step is given. Everything runs on the fakes: the in-memory
// store and the fake code host.
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID,
  PLAYBOOK_FILE_PATH,
  ProjectPlaybookSchema,
  agentXError,
  projectPlaybookKey,
  queryAll,
  type AuditEvent,
  type JsonValue,
  type PlaybookFile,
  type ProjectDefinition,
  type TransactItem,
} from "@rovara-code/contracts";
import { createAdapterRegistry } from "../../packages/core/src/ports/adapter-registry.js";
import { createStoreProjectSource } from "../../packages/core/src/core/task-flow/project-source.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { FakeCodeHost } from "../../packages/core/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/core/src/plugins/fake/model.js";
import { createPlaybookService, stepForMode, type PlaybookMode } from "../../packages/core/src/core/playbook/service.js";
import { createCodeHostPlaybookSource, fixedPlaybookSource } from "../../packages/core/src/core/playbook/source.js";
import { readProjectPlaybook, readStoredDesignReview } from "../../packages/core/src/core/playbook/store.js";
import { readEffectiveDesignReview } from "../../packages/core/src/core/design-review/setting.js";
import { runningProcessOf } from "../../packages/core/src/core/playbook/process.js";
import { computeHowWeWork } from "../../packages/core/src/core/playbook/view.js";
import { parsePlaybookText } from "../../packages/core/src/core/playbook/file.js";
import { TASK_FLOW_INDEXES } from "../../packages/core/src/core/task-flow/flow.js";
import { orgProjectCatalogKey, projectRevisionKey } from "@rovara-code/contracts";

const COMPANY = IMPLICIT_COMPANY_ID;
const URL_ = "https://examplehost.test/acme/app";
const DESIGN = "designReview:\n  mode: always\n  tier: light\n  allowSkip: false\n  capUsdPerTask: 8\n  highRiskApprover: { kind: maintainers }\n";
const FILE = `version: 1\nrules: |\n  PROJECT-RULE: mention the ticket.\nstages:\n  plan:\n    instructions: PLAN-RULE\n  review:\n    instructions: REVIEW-RULE\n  plan_critic:\n    instructions: CRITIC-RULE\n  build:\n    instructions: BUILD-RULE\n${DESIGN}`;

function projectDefinition(extra: Partial<ProjectDefinition["repositories"][number]> = {}): ProjectDefinition {
  return { name: "web", revision: 1, repositories: [{ name: "app", url: URL_, path: "repo/app", defaultBranch: "main", credentialRef: "host-app", host: { kind: "fake" }, ...extra }], setup: [], readiness: [], orchestratorInstructions: "x" };
}

async function world(options: { file?: string; definition?: ProjectDefinition; hostDefault?: string } = {}) {
  const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
  const definition = options.definition ?? projectDefinition();
  await store.put({ item: { ...projectRevisionKey(COMPANY, definition.name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
  await store.put({ item: { ...orgProjectCatalogKey(COMPANY, definition.name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", ...(options.hostDefault === undefined ? {} : { defaultBranch: options.hostDefault }), initialFiles: options.file === undefined ? { "README.md": "x" } : { "README.md": "x", [PLAYBOOK_FILE_PATH]: options.file } });
  const host = new FakeCodeHost(model);
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", host);
  const events: AuditEvent[] = [];
  // A transactional sink, as the install's: the event is an item of the change's own transaction, so a change that did not apply leaves no event.
  const audit = {
    stage(event: AuditEvent): readonly TransactItem[] {
      events.push(event);
      return [{ kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: `EVENT#${event.eventId}`, entityType: "AUDIT", action: event.action }, condition: { op: "notExists", path: ["pk"] } }];
    },
    async record(event: AuditEvent) { events.push(event); },
  };
  const clock = { now: Date.parse("2026-11-10T09:00:00.000Z") };
  const projects = createStoreProjectSource(store, COMPANY);
  const source = createCodeHostPlaybookSource({ companyId: COMPANY, projects, codeHosts: registry, now: () => clock.now });
  const service = createPlaybookService({ companyId: COMPANY, store, audit, projects, source, now: () => new Date(clock.now) });
  return { store, model, host, registry, events, clock, source, service, projects, stored: () => store.get(projectPlaybookKey(COMPANY, "web")) };
}

describe("reading the file through the code host", () => {
  it("reads nothing when the repository has no file, and the file when it has one", async () => {
    const none = await world();
    expect((await none.source.read("web")).status).toBe("none");
    const some = await world({ file: FILE });
    const reading = await some.source.read("web");
    expect(reading).toMatchObject({ status: "ok", repository: "app", commit: some.model.headOf("main") });
    expect(reading.status === "ok" && reading.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reads the default branch's head and never a working branch: a task cannot change its own rules", async () => {
    const w = await world({ file: "version: 1\nrules: ORIGINAL" });
    w.model.commit("rovara/task-1", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: CHANGED BY THE TASK" });
    const reading = await w.source.read("web");
    expect(reading.status === "ok" && reading.file.rules).toBe("ORIGINAL");
  });

  it("sees a newer commit on the default branch once the short head cache has passed, and not before", async () => {
    const w = await world({ file: "version: 1\nrules: ONE" });
    expect((await w.source.read("web")).status === "ok" && ((await w.source.read("web")) as { file: PlaybookFile }).file.rules).toBe("ONE");
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: TWO" });
    expect(((await w.source.read("web")) as { file: PlaybookFile }).file.rules).toBe("ONE");
    w.clock.now += 11_000;
    expect(((await w.source.read("web")) as { file: PlaybookFile }).file.rules).toBe("TWO");
  });

  it("answers `invalid` with the problems for a file that cannot be used, and says so once per commit", async () => {
    const w = await world({ file: "version: 1\nstages:\n  check:\n    instructions: x" });
    const reading = await w.source.read("web");
    expect(reading).toMatchObject({ status: "invalid", problems: [{ path: "stages.check" }] });
  });

  it("refuses a file over the size cap without reading it, as a file that cannot be used", async () => {
    const w = await world({ file: `version: 1\nrules: |\n${"  x\n".repeat(20_000)}` });
    expect(await w.source.read("web")).toMatchObject({ status: "invalid", problems: [{ path: "(file)" }] });
  });

  it("answers `unreadable` when the host fails, and never says what it said", async () => {
    const w = await world({ file: FILE });
    w.host.baseBranchHead = () => Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "https://secret.example/token=abc went wrong"));
    const reading = await w.source.read("web");
    expect(reading).toEqual({ status: "unreadable", reason: "the code host could not be reached just now" });
  });

  it("reads a project's meta repository when it has one, else its first repository; a project with no code host reads as no file", async () => {
    const withMeta = await world({ definition: { ...projectDefinition(), repositories: [{ name: "code", url: "https://examplehost.test/acme/other", path: "repo/code", defaultBranch: "main", credentialRef: "host-app", host: { kind: "fake" } }, { name: "meta", url: URL_, path: "repo/meta", defaultBranch: "main", credentialRef: "host-app", host: { kind: "fake" }, role: "meta" }] as never }, file: FILE });
    expect(await withMeta.source.read("web")).toMatchObject({ status: "ok", repository: "meta" });
    const bare = await world({ file: FILE });
    const noHost = createCodeHostPlaybookSource({ companyId: COMPANY, projects: bare.projects, codeHosts: undefined });
    expect(await noHost.read("web")).toEqual({ status: "none" });
    expect(await bare.source.read("missing")).toEqual({ status: "none" });
  });
});

describe("the stored item (Cloud's key and shape)", () => {
  it("writes the item at the project playbook key with Cloud's attributes, and nothing for a project with no file", async () => {
    const none = await world();
    expect((await none.service.current("web")).playbook).toEqual({ revision: 0, defaultProcess: { kind: "builtin" } });
    expect(await none.stored()).toBeUndefined();

    const w = await world({ file: FILE });
    const { playbook, file } = await w.service.current("web");
    expect(file?.rules).toContain("PROJECT-RULE");
    expect(playbook).toMatchObject({ revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode: "always", tier: "light", allowSkip: false, capUsdPerTask: 8 } });
    const item = (await w.stored())!;
    expect(item).toMatchObject({ pk: expect.stringContaining("PROJECT_PLAYBOOK#web") as string, sk: "META", entityType: "PROJECT_PLAYBOOK", orgId: COMPANY, revision: 1, defaultProcess: { kind: "builtin" }, updatedBy: "playbook-file" });
    // Cloud reads exactly these two attributes with its strict schema; the digest beside them is ignored.
    expect(ProjectPlaybookSchema.safeParse({ revision: item["revision"], defaultProcess: item["defaultProcess"] }).success).toBe(true);
    expect(item["fileDigest"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readProjectPlaybook({ store: w.store, companyId: COMPANY }, "web")).toEqual(playbook);
  });

  it("is quiet when the file did not change: the same digest writes nothing, a comment writes nothing, a changed rule goes up one revision", async () => {
    const w = await world({ file: FILE });
    await w.service.current("web");
    const before = w.events.length;
    await w.service.current("web");
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: `# a new comment\n${FILE}` });
    w.clock.now += 11_000;
    expect((await w.service.current("web")).playbook.revision).toBe(1);
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: FILE.replace("PROJECT-RULE", "OTHER-RULE") });
    w.clock.now += 11_000;
    expect((await w.service.current("web")).playbook.revision).toBe(2);
    // One file-changed event each time it moved, and the design review event only at the first write (the setting never changed).
    expect(w.events.slice(before).map((event) => event.action)).toEqual(["playbook.file_changed"]);
    expect(w.events.map((event) => event.action)).toEqual(["playbook.file_changed", "playbook.design_review_changed", "playbook.file_changed"]);
  });

  it("audits the design review change in fixed words and counts, and a removed file drops the setting (one revision more)", async () => {
    const w = await world({ file: FILE });
    await w.service.current("web");
    const design = w.events.find((event) => event.action === "playbook.design_review_changed")!;
    expect(design.details).toEqual({ revision: 1, mode: "always", tier: "light", allowSkip: false, capCents: 800, approverKind: "maintainers", approverCount: 0 });
    expect(design.actor).toEqual({ type: "system", id: "playbook-file" });
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: null });
    w.clock.now += 11_000;
    const after = await w.service.current("web");
    expect(after.file).toBeUndefined();
    expect(after.playbook).toEqual({ revision: 2, defaultProcess: { kind: "builtin" } });
    expect((await w.stored())?.["fileDigest"]).toBeUndefined();
    expect(w.events.at(-1)?.action).toBe("playbook.design_review_changed");
  });

  it("two syncs at once write once", async () => {
    const w = await world({ file: FILE });
    const [a, b] = await Promise.all([w.service.current("web"), w.service.current("web")]);
    expect(a.playbook.revision).toBe(1);
    expect(b.playbook.revision).toBe(1);
    const written = await queryAll(w.store, { pk: `AUDIT#${COMPANY}`, sk: { op: "beginsWith", prefix: "EVENT#" } });
    expect(written.filter((item) => item["action"] === "playbook.file_changed")).toHaveLength(1);
  });

  it("leaves an item Cloud wrote alone while there is no file, and a file then replaces it", async () => {
    const w = await world();
    await w.store.put({ item: { ...projectPlaybookKey(COMPANY, "web"), entityType: "PROJECT_PLAYBOOK", orgId: COMPANY, revision: 4, defaultProcess: { kind: "builtin" }, designReview: { mode: "never", tier: "light", allowSkip: true, capUsdPerTask: 2, highRiskApprover: { kind: "maintainers" } }, updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "someone" } });
    expect((await w.service.current("web")).playbook.revision).toBe(4);
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: x" });
    w.clock.now += 11_000;
    expect((await w.service.current("web")).playbook).toEqual({ revision: 5, defaultProcess: { kind: "builtin" } });
  });

  it("reads an unreadable stored design review setting as Off through the design review stage, never a looser one", async () => {
    const w = await world();
    await w.store.put({ item: { ...projectPlaybookKey(COMPANY, "web"), entityType: "PROJECT_PLAYBOOK", orgId: COMPANY, revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode: "sometimes" } } });
    expect((await readEffectiveDesignReview(w.store, COMPANY, "web")).setting.mode).toBe("never");
    expect(readStoredDesignReview({ mode: "sometimes" })).toEqual({ kind: "unreadable", reason: "unknown_mode" });
    expect(readStoredDesignReview("auto")).toEqual({ kind: "unreadable", reason: "wrong_type" });
    expect(readStoredDesignReview(undefined)).toEqual({ kind: "missing" });
    const empty = await world();
    // No setting stored is Off too (the owner's rule for the design review stage): a project turns it on by writing a `designReview` section.
    expect((await readEffectiveDesignReview(empty.store, COMPANY, "web")).setting.mode).toBe("never");
  });
});

describe("a file that cannot be used, and a host that did not answer, fail closed", () => {
  it("a file that is there and cannot be used is a refusal in words, never Rovara Code with the rules left out; the item stays as it was", async () => {
    const w = await world({ file: FILE });
    await w.service.current("web");
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nstages:\n  pull_request:\n    instructions: x" });
    w.clock.now += 11_000;
    await expect(w.service.current("web")).rejects.toMatchObject({ code: "PROCESS_UNAVAILABLE", message: expect.stringContaining("stages.pull_request: Rules for this stage aren't used yet.") as string });
    await expect(w.service.layersFor("web", "PLAN")).rejects.toMatchObject({ code: "PROCESS_UNAVAILABLE" });
    expect((await w.stored())?.["revision"]).toBe(1);
  });

  it("holds the file's design review setting to a company lock a hosted install wrote: a looser file is refused in words that name the field, and nothing is stored", async () => {
    const w = await world({ file: `version: 1\n${DESIGN.replace("allowSkip: false", "allowSkip: true")}` });
    await w.store.put({ item: { pk: `ORG#${COMPANY}`, sk: "DESIGNREVIEW#LOCK", revision: 1, lock: { allowSkip: false } } });
    await expect(w.service.current("web")).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("designReview.allowSkip: your company has set a stricter rule for design review") as string });
    expect(await w.stored()).toBeUndefined();
    // A file that holds the lock is stored.
    const ok = await world({ file: `version: 1\n${DESIGN}` });
    await ok.store.put({ item: { pk: `ORG#${COMPANY}`, sk: "DESIGNREVIEW#LOCK", revision: 1, lock: { allowSkip: false } } });
    expect((await ok.service.current("web")).playbook.revision).toBe(1);
  });

  it("a host that did not answer is `RUNTIME_UNAVAILABLE`: the step waits", async () => {
    const w = await world({ file: FILE });
    w.host.baseBranchHead = () => Promise.reject(new Error("down"));
    await expect(w.service.layersFor("web", "PLAN")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("the page's state shows what is wrong beside Rovara Code as it is, and refuses nothing", async () => {
    const w = await world({ file: "version: 1\nrules: [1, 2" });
    const state = await w.service.state("web");
    expect(state.file).toMatchObject({ status: "invalid", problems: [{ path: "(file)" }] });
    expect(state.view.stages.map((stage) => stage.id)).toEqual(["plan", "plan_critic", "build", "check", "review", "pull_request"]);
    expect(state.view.rules).toEqual([]);
    await expect(w.service.state("nobody")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("what each step is given from the file", () => {
  const layers = async (mode: PlaybookMode | undefined) => (await (await world({ file: FILE })).service.layersFor("web", mode)).map((layer) => layer.text);

  it("plan, understand and build get the project-wide rules, then their own stage's", async () => {
    expect(await layers("PLAN")).toEqual(["PROJECT-RULE: mention the ticket.", "PLAN-RULE"]);
    expect(await layers("UNDERSTAND")).toEqual(["PROJECT-RULE: mention the ticket.", "PLAN-RULE"]);
    expect(await layers("SETUP_DRAFT")).toEqual(["PROJECT-RULE: mention the ticket.", "PLAN-RULE"]);
    expect(await layers("IMPLEMENT")).toEqual(["PROJECT-RULE: mention the ticket.", "BUILD-RULE"]);
    expect(await layers(undefined)).toEqual(["PROJECT-RULE: mention the ticket.", "BUILD-RULE"]);
  });

  it("the stages that check work get their own stage's rule and never the project-wide one", async () => {
    expect(await layers("PLAN_CRITIQUE")).toEqual(["CRITIC-RULE"]);
    expect(await layers("REVIEW")).toEqual(["REVIEW-RULE"]);
    expect(await layers("FEEDBACK_REVIEW")).toEqual([]);
  });

  it("a project with no file gives nothing, and the built-in's own guidance is never moved into the block", async () => {
    const none = await world();
    for (const mode of ["PLAN", "IMPLEMENT", "REVIEW"] as const) expect(await none.service.layersFor("web", mode)).toEqual([]);
  });

  it("names where the text came from: the file's path", async () => {
    const w = await world({ file: FILE });
    expect((await w.service.layersFor("web", "PLAN")).map((layer) => layer.agentName)).toEqual([".rovara/playbook.yaml", ".rovara/playbook.yaml"]);
  });

  it("maps the modes to the stages Cloud maps them to", () => {
    const recipe = runningProcessOf(undefined).recipe;
    const kinds = (mode: PlaybookMode) => stepForMode(recipe, mode)?.kind;
    expect([kinds("UNDERSTAND"), kinds("PLAN"), kinds("PLAN_CRITIQUE"), kinds("IMPLEMENT"), kinds("REVIEW"), kinds("CHECKS"), kinds("FEEDBACK_REVIEW"), kinds("SPEC_WRITE")])
      .toEqual(["plan", "plan", "plan_critic", "build", "review", "check", "pull_request", "plan"]);
  });
});

describe("the effective view (Cloud's How we work view)", () => {
  const view = async (text: string | undefined) => {
    const parsed = text === undefined ? undefined : parsePlaybookText(text);
    if (parsed !== undefined && !parsed.ok) throw new Error("bad file");
    const w = await world();
    const registered = await w.projects.latest("web");
    return computeHowWeWork({ project: "web", playbookRevision: 3, file: parsed?.ok === true ? parsed.file : undefined, definition: registered?.definition, codeSettings: { allowSelfApproval: false, mergeMethod: "squash", codeReviewers: [], revision: 0 } });
  };

  it("with no file it is Rovara Code as it is: every stage, every value Rovara's", async () => {
    const v = await view(undefined);
    expect(v).toMatchObject({ project: "web", playbookRevision: 3, process: { kind: "builtin", agentId: "rovara-code" }, rules: [], modelsEditable: false });
    expect(v.stages.map((stage) => stage.id)).toEqual(["plan", "plan_critic", "build", "check", "review", "pull_request"]);
    for (const stage of v.stages) for (const row of stage.knows.instructions) expect(row.source).toBe("rovara");
    expect(v.stages.find((stage) => stage.id === "pull_request")?.approves.items.map((item) => item.value)).toContain("Rovara never merges on its own: a person merges the pull request");
  });

  it("marks what the file wrote as the project's, and leaves the project-wide rules out of the stages that check work, with the fixed note", async () => {
    const v = await view(FILE);
    expect(v.rules).toEqual([{ value: "PROJECT-RULE: mention the ticket.", source: "project", locked: false }]);
    const texts = (id: string) => v.stages.find((stage) => stage.id === id)!.knows.instructions.filter((row) => row.source === "project").map((row) => row.value);
    expect(texts("plan")).toEqual(["PROJECT-RULE: mention the ticket.", "PLAN-RULE"]);
    expect(texts("build")).toEqual(["PROJECT-RULE: mention the ticket.", "BUILD-RULE"]);
    expect(texts("plan_critic")).toEqual(["CRITIC-RULE"]);
    expect(texts("review")).toEqual(["REVIEW-RULE"]);
    expect(texts("pull_request")).toEqual([]);
    expect(v.stages.find((stage) => stage.id === "review")?.knows.note).toBe("Project rules apply to Understand, Plan and Build. Reviewers only follow rules written for them.");
    expect(v.stages.find((stage) => stage.id === "plan")?.knows.note).toBeUndefined();
  });

  it("keeps the safety facts: reviewers are read-only and locked by Rovara, a person approves the plan, and nothing is locked by a company", async () => {
    const v = await view(FILE);
    const review = v.stages.find((stage) => stage.id === "review")!;
    expect(review.may.readOnly).toBe(true);
    expect(review.may.tools.locked).toBe(true);
    expect(v.stages.find((stage) => stage.id === "plan")?.approves.items.map((item) => item.value)).toEqual(["A person approves the plan before any code is written"]);
    const lockedBy = v.stages.flatMap((stage) => [stage.who.differentCompanyFrom, stage.may.tools, ...stage.checked.items, ...stage.approves.items]).filter((entry) => entry.locked).map((entry) => entry.lockedBy);
    expect(new Set(lockedBy)).toEqual(new Set(["rovara"]));
  });

  it("a draft is looked at and never applied: nothing is written, and a bad draft says what is wrong", async () => {
    const w = await world({ file: FILE });
    await w.service.current("web");
    const before = await w.stored();
    const good = await w.service.preview("web", "version: 1\nrules: DRAFT-RULE");
    expect("view" in good && good.view.rules.map((row) => row.value)).toEqual(["DRAFT-RULE"]);
    const bad = await w.service.preview("web", "version: 1\nstages:\n  check:\n    instructions: x");
    expect(bad).toEqual({ problems: [{ path: "stages.check", message: "Rules for this stage aren't used yet." }] });
    expect(await w.stored()).toEqual(before);
  });
});

describe("which branch the rules are read from", () => {
  /** A host that answers a branch it does not have as a real one does: not found. */
  function noBranch(w: Awaited<ReturnType<typeof world>>, ...names: string[]) {
    const real = w.host.baseBranchHead.bind(w.host);
    w.host.baseBranchHead = (repository, branch, scope) => names.includes(branch) ? Promise.reject(agentXError("NOT_FOUND", "no such branch")) : real(repository, branch, scope);
  }
  const rulesOf = async (w: Awaited<ReturnType<typeof world>>) => {
    const reading = await w.source.read("web");
    return reading.status === "ok" ? reading.file.rules : reading.status;
  };

  it("reads the branch the repository record names, never a stray `main` beside it", async () => {
    const w = await world({ hostDefault: "trunk", file: "version: 1\nrules: TRUNK", definition: projectDefinition({ defaultBranch: "trunk" }) });
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: A STRAY MAIN" });
    expect(await rulesOf(w)).toBe("TRUNK");
  });

  it("reads the host's default when the branch the record names is not there, and nothing guessed beside it", async () => {
    const w = await world({ hostDefault: "trunk", file: "version: 1\nrules: TRUNK", definition: projectDefinition({ defaultBranch: "develop" }) });
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: A STRAY MAIN" });
    w.model.commit("master", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: A STRAY MASTER" });
    noBranch(w, "develop");
    expect(await rulesOf(w)).toBe("TRUNK");
  });

  it("when neither the record's branch nor the host's default can be read it is unreadable, and a stray main or master is never read in their place", async () => {
    const w = await world({ hostDefault: "trunk", file: "version: 1\nrules: TRUNK", definition: projectDefinition({ defaultBranch: "develop" }) });
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: A STRAY MAIN" });
    w.model.commit("master", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: A STRAY MASTER" });
    noBranch(w, "develop", "trunk");
    expect(await w.source.read("web")).toEqual({ status: "unreadable", reason: "the code host could not be reached just now" });
    await expect(w.service.layersFor("web", "PLAN")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("Couldn't read the project's rules from the code host") as string });
    await expect(w.service.pin("web")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("a repository the code host refuses outright (an address it does not serve) reads as no file, never as a refusal; a refused branch name on a repository it serves still fails closed", async () => {
    const foreign = await world({ file: FILE });
    foreign.host.baseBranchHead = () => Promise.reject(agentXError("CONFIG_INVALID", "only github.com repositories are supported"));
    foreign.host.repositoryIdentity = () => Promise.reject(agentXError("CONFIG_INVALID", "only github.com repositories are supported"));
    expect(await foreign.source.read("web")).toEqual({ status: "none", repository: "app" });
    expect(await foreign.service.layersFor("web", "PLAN")).toEqual([]);
    expect(await foreign.service.pin("web")).toBeUndefined();
    const badBranch = await world({ file: FILE });
    badBranch.host.baseBranchHead = () => Promise.reject(agentXError("CONFIG_INVALID", "branch name is invalid"));
    expect(await badBranch.source.read("web")).toMatchObject({ status: "unreadable" });
  });

  it("a repository that has no playbook file on its default branch is still no file, and is fine", async () => {
    const w = await world({ hostDefault: "trunk", definition: projectDefinition({ defaultBranch: "trunk" }) });
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: A STRAY MAIN" });
    expect(await w.source.read("web")).toMatchObject({ status: "none" });
    expect(await w.service.layersFor("web", "PLAN")).toEqual([]);
  });
});

describe("one playbook revision for a task (the pin)", () => {
  it("pin says the default branch's head the file was read at, for a file and for no file", async () => {
    const some = await world({ file: FILE });
    expect(await some.service.pin("web")).toBe(some.model.headOf("main"));
    const none = await world();
    expect(await none.service.pin("web")).toBe(none.model.headOf("main"));
  });

  it("pin refuses, in words, a file that cannot be used: a task does not start under rules that are not there", async () => {
    const w = await world({ file: "version: 1\nstages:\n  check:\n    instructions: x" });
    await expect(w.service.pin("web")).rejects.toMatchObject({ code: "PROCESS_UNAVAILABLE", message: expect.stringContaining("stages.check") as string });
  });

  it("a read at a pinned commit gives that commit's file, not the head's, and writes nothing", async () => {
    const w = await world({ file: "version: 1\nrules: |\n  RULES-ONE" });
    const pinned = await w.service.pin("web");
    await w.service.current("web");
    const before = (await w.stored())?.["revision"];
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: |\n  RULES-TWO" });
    w.clock.now += 11_000;
    expect((await w.service.layersFor("web", "PLAN", pinned)).map((layer) => layer.text).join()).toContain("RULES-ONE");
    expect((await w.service.layersFor("web", "PLAN")).map((layer) => layer.text).join()).toContain("RULES-TWO");
    // The unpinned read brought the item up to the head; the pinned one never moves it back.
    const after = (await w.stored())?.["revision"];
    expect(after).toBe((before as number) + 1);
    await w.service.layersFor("web", "PLAN", pinned);
    expect((await w.stored())?.["revision"]).toBe(after);
  });
});

describe("the page's state is a read", () => {
  it("writes nothing to the store, however many times it is asked: the item is brought up when a task starts or a step is sent", async () => {
    const w = await world({ file: FILE });
    await w.service.state("web");
    await w.service.state("web");
    expect(await w.stored()).toBeUndefined();
    expect(w.events).toEqual([]);
    await w.service.current("web");
    expect((await w.stored())?.["revision"]).toBe(1);
  });

  it("shows a company lock the file is looser than as a problem of the file, in words, instead of a refusal", async () => {
    const w = await world({ file: `version: 1\n${DESIGN.replace("allowSkip: false", "allowSkip: true")}` });
    await w.store.put({ item: { pk: `ORG#${COMPANY}`, sk: "DESIGNREVIEW#LOCK", revision: 1, lock: { allowSkip: false } } });
    const state = await w.service.state("web");
    expect(state.file).toMatchObject({ status: "invalid", problems: [{ path: "designReview", message: expect.stringContaining("designReview.allowSkip: your company has set a stricter rule for design review") as string }] });
    expect(await w.stored()).toBeUndefined();
  });
});

describe("a fixed source", () => {
  it("reads text for a laptop that has the file in a folder, and for tests", async () => {
    const source = fixedPlaybookSource({ web: "version: 1\nrules: x", broken: "version: 9" });
    expect((await source.read("web")).status).toBe("ok");
    expect((await source.read("broken")).status).toBe("invalid");
    expect((await source.read("other")).status).toBe("none");
  });
});
