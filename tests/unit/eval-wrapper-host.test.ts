// L4-EVW4 (DEC 254zzz43, DEC 254zzz14): the eval wrapper does NOT depend on the deleted lessons repo-file code. The part it needs lives in core/setup-agent/eval-wrapper-host.ts (the repository-id guard) and
// eval-wrapper-targets.ts (the project's repositories as targets). Here: the guard still holds, the targets are the company's own, and no wrapper module imports anything from lessons/.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeHost, ProjectDefinition } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { RepositoryMismatch, Unconfirmed, guardTarget, headOf, readOwnPr, repositoryIdOfPlace, verifyRepository, type EvalWrapperTarget } from "../../packages/broker/src/core/setup-agent/eval-wrapper-host.js";
import { createEvalWrapperTargets } from "../../packages/broker/src/core/setup-agent/eval-wrapper-targets.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const URL_A = "https://github.com/acme/api";
const model = (id = "4242") => new FakeHostModel({ url: URL_A, id, fullName: "acme/api", webBase: "https://github.com" });
const targetOf = (host: CodeHost, place = "fake:repo/4242"): EvalWrapperTarget => ({ name: "api", place, repository: { url: URL_A }, scope: { orgId: COMPANY_A.orgId }, host });

describe("no dependency on the lessons repo-file code", () => {
  it("no eval wrapper module imports from lessons/, and the wrapper pull request code names no lesson branch or path", () => {
    const dir = join(import.meta.dirname, "../../packages/broker/src/core/setup-agent");
    const files = readdirSync(dir).filter((name) => /^eval-wrapper.*\.ts$/u.test(name) || name === "eval-card.ts" || name === "eval-discovery.ts");
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/from "\.\.\/\.\.\/lessons\//u);
      expect(text, file).not.toMatch(/repo-file-host|LESSON_FILE|lessons-file|RepoFileTarget/u);
    }
    expect(readFileSync(join(import.meta.dirname, "../../packages/broker/src/aws/core-engine-root.ts"), "utf8")).not.toMatch(/createLessonRepositories|lessons-repos/u);
  });
});

describe("the repository-id guard (moved from the lessons code)", () => {

  it("calls nothing but repositoryIdentity until the id matches, and refuses everything on a mismatch", async () => {
    const good = new FakeCodeHost(model());
    const guarded = guardTarget(targetOf(good));
    expect(guardTarget(guarded)).toBe(guarded);
    expect(await headOf(guarded, "main")).toBeDefined();
    expect((await verifyRepository(guarded)).ok).toBe(true);
    // The repository at the address is another one (the old one was deleted and the name given to a new one): every call is refused.
    const stranger = guardTarget(targetOf(new FakeCodeHost(model("9999"))));
    await expect(stranger.host.baseBranchHead(stranger.repository, "main", stranger.scope)).rejects.toBeInstanceOf(RepositoryMismatch);
    await expect(stranger.host.fileAtRevision(stranger.repository, "rovara/eval-wrapper.py", "a".repeat(40), stranger.scope)).rejects.toBeInstanceOf(RepositoryMismatch);
    expect((await verifyRepository(stranger)).ok).toBe(false);
  });

  it("is bound to ONE place, the helpers refuse a raw target, and a place that pins no id is a mismatch", async () => {
    const raw = targetOf(new FakeCodeHost(model()));
    expect(() => headOf(raw, "main")).toThrow(RepositoryMismatch);
    await expect(readOwnPr(raw, "1", "rovara/eval-wrapper-000000000001")).rejects.toBeInstanceOf(RepositoryMismatch);
    const guarded = guardTarget(raw);
    expect(() => guardTarget({ ...guarded, place: "fake:repo/9999" })).toThrow(RepositoryMismatch);
    expect((await verifyRepository({ ...raw, host: new FakeCodeHost(model()), place: "fake:somewhere" })).ok).toBe(false);
    expect(repositoryIdOfPlace("github:repo/1001")).toBe("1001");
    expect(repositoryIdOfPlace("github:somewhere")).toBeUndefined();
  });

  it("a pull request that cannot be read is never taken as Rovara's: the read fails closed", async () => {
    const target = guardTarget(targetOf(new FakeCodeHost(model())));
    await expect(readOwnPr(target, "7", "rovara/eval-wrapper-000000000001")).rejects.toBeInstanceOf(Unconfirmed);
  });
});

describe("the project's repositories as targets", () => {
  const definition = (url: string): ProjectDefinition => ({ name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x", repositories: [{ name: "api", url, path: "repo/api", defaultBranch: "main", credentialRef: "host-app" }] });
  const projects = (url: string) => ({ latest: async (name: string) => (name === "demo" ? { definition: definition(url) } : undefined), revision: async () => undefined, list: async () => [] }) as never;

  it("is the company's own code host: the place pins the host's own repository id, and the scope is the company's", async () => {
    const registry = createAdapterRegistry();
    registry.register("code-host", "github", Object.assign(Object.create(new FakeCodeHost(model())) as CodeHost, { kind: "github", provider: "github", defaultConnection: true }));
    const a = createEvalWrapperTargets({ flow: { projects: projects(URL_A) }, registry, companyId: COMPANY_A.orgId, now: () => 1 });
    const b = createEvalWrapperTargets({ flow: { projects: projects(URL_A) }, registry, companyId: COMPANY_B.orgId, now: () => 1 });
    expect(await a("demo")).toMatchObject([{ name: "api", place: "github:repo/4242", repository: { url: URL_A }, scope: { orgId: COMPANY_A.orgId } }]);
    expect(await b("demo")).toMatchObject([{ scope: { orgId: COMPANY_B.orgId } }]);
    await expect(a("nope")).rejects.toThrow();
  });

  it("leaves out a repository whose host cannot say who it is, and a project with no registered host", async () => {
    const empty = createAdapterRegistry();
    expect(await createEvalWrapperTargets({ flow: { projects: projects(URL_A) }, registry: empty, companyId: COMPANY_A.orgId, now: () => 1 })("demo")).toEqual([]);
    const registry = createAdapterRegistry();
    const silent = new FakeCodeHost(model());
    registry.register("code-host", "github", Object.assign(Object.create(silent) as CodeHost, { kind: "github", provider: "github", defaultConnection: true, repositoryIdentity: async () => undefined }));
    expect(await createEvalWrapperTargets({ flow: { projects: projects(URL_A) }, registry, companyId: COMPANY_A.orgId, now: () => 1 })("demo")).toEqual([]);
  });
});
