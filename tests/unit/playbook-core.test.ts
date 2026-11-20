// "How we work" in Code's core: the file read through the code host, the stored item Cloud's readers read, the view, and the layers each step is given. Everything runs on the fakes: the in-memory
// store and the fake code host.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, PLAYBOOK_FILE_PATH, agentXError, projectPlaybookKey, queryAll, type AuditEvent, type JsonValue, type ProjectDefinition, type TransactItem } from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createPlaybookService, type PlaybookMode } from "../../packages/broker/src/core/playbook/service.js";
import { createCodeHostPlaybookSource, fixedPlaybookSource } from "../../packages/broker/src/core/playbook/source.js";
import { readStoredDesignReview } from "../../packages/broker/src/core/playbook/store.js";
import { readEffectiveDesignReview } from "../../packages/broker/src/core/design-review/setting.js";
import { computeHowWeWork } from "../../packages/broker/src/core/playbook/view.js";
import { parsePlaybookText } from "../../packages/broker/src/core/playbook/file.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { orgProjectCatalogKey, projectRevisionKey } from "@agentx/contracts";

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

  it("refuses a file over the size cap without reading it, as a file that cannot be used", async () => {
    const w = await world({ file: `version: 1\nrules: |\n${"  x\n".repeat(20_000)}` });
    expect(await w.source.read("web")).toMatchObject({ status: "invalid", problems: [{ path: "(file)" }] });
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

});

describe("what each step is given from the file", () => {
  const layers = async (mode: PlaybookMode | undefined) => (await (await world({ file: FILE })).service.layersFor("web", mode)).map((layer) => layer.text);

  it("the stages that check work get their own stage's rule and never the project-wide one", async () => {
    expect(await layers("PLAN_CRITIQUE")).toEqual(["CRITIC-RULE"]);
    expect(await layers("REVIEW")).toEqual(["REVIEW-RULE"]);
    expect(await layers("FEEDBACK_REVIEW")).toEqual([]);
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

  it("reads the host's default when the branch the record names is not there, and nothing guessed beside it", async () => {
    const w = await world({ hostDefault: "trunk", file: "version: 1\nrules: TRUNK", definition: projectDefinition({ defaultBranch: "develop" }) });
    w.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: A STRAY MAIN" });
    w.model.commit("master", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: A STRAY MASTER" });
    noBranch(w, "develop");
    expect(await rulesOf(w)).toBe("TRUNK");
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
