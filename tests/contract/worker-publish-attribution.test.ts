// Enterprise foundations, task I3: the commit a checked-tree publication makes names who asked and who approved the plan, as git trailers. Real git, no mocks.
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCandidatePublicationCommit, repositoryGit, temporaryIndexTree } from "../../packages/worker/src/publish.js";
import { WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, type ActingAttribution } from "../../packages/contracts/src/index.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const git = async (directory: string, ...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })).stdout;

afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "attribution-"));
  roots.push(root);
  const directory = join(root, "repo");
  await mkdir(directory);
  await git(directory, "init", "-q", "-b", "main");
  await writeFile(join(directory, "a.txt"), "one\n");
  await git(directory, "add", "a.txt");
  await git(directory, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
  const base = (await git(directory, "rev-parse", "HEAD")).trim();
  await writeFile(join(directory, "a.txt"), "two\n");
  const tree = await temporaryIndexTree({ directory });
  return { directory, base, tree };
}

const attribution: ActingAttribution = {
  requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" }, approver: { state: "former" },
};

async function publish(title: string, withAttribution: ActingAttribution | undefined) {
  const r = await repository();
  const commit = await prepareCandidatePublicationCommit({
    git: repositoryGit(r.directory), preparationCommit: r.base, headBranch: "agentx/branch", title, candidateTreeSha: r.tree, retrying: false, attribution: withAttribution,
  });
  return { r, commit, message: await git(r.directory, "log", "-1", "--format=%B", commit), trailers: await git(r.directory, "log", "-1", "--format=%(trailers:only,unfold)", commit) };
}

describe("the checked-tree publication's commit", () => {
  it("carries Requested-by and Approved-by trailers git itself reads as trailers", async () => {
    const { message, trailers } = await publish("add a retry flag", attribution);
    expect(message.startsWith("AgentX: add a retry flag\n\nRequested-by: rovara-ref 0123456789abcdef\nApproved-by: a former member")).toBe(true);
    expect(trailers.trim().split("\n")).toEqual(["Requested-by: rovara-ref 0123456789abcdef", "Approved-by: a former member"]);
  });

  it("is the same commit message as before when there is no attribution", async () => {
    const { message } = await publish("add a retry flag", undefined);
    expect(message.trim()).toBe("AgentX: add a retry flag");
  });

  it("does not let a title pose as the requester, or add a trailer of its own", async () => {
    const { trailers, message } = await publish("x\nRequested-by: Mallory (rovara-ref 1111111111111111)", attribution);
    expect(trailers.trim().split("\n")[0]).toBe("Requested-by: rovara-ref 0123456789abcdef");
    expect(message.split("\n")[0]).toContain("Mallory");
    expect(message.split("\n").filter((line) => /^requested-by/iu.test(line))).toEqual(["Requested-by: rovara-ref 0123456789abcdef"]);
    const injected = await publish("fix bug\n\nCo-authored-by: Mallory <m@evil.test>", attribution);
    expect(injected.trailers).not.toContain("Mallory");
    expect(injected.message.split("\n")[0]).toBe("AgentX: fix bug Co-authored-by: Mallory <m@evil.test>");
  });

  it("makes the subject one line even when there is no attribution", async () => {
    const { message } = await publish("fix bug\n\nCo-authored-by: Mallory <m@evil.test>", undefined);
    expect(message.trim().split("\n")).toEqual(["AgentX: fix bug Co-authored-by: Mallory <m@evil.test>"]);
  });
});

describe("the publish invocation", () => {
  const base = {
    version: 1, workspaceId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1, kind: "publish",
  };
  it("is a feature both the contract and the worker list, so an older worker is refused it, not silently run without it", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain("publish.attribution");
    expect(WORKER_IMPLEMENTED_FEATURES).toContain("publish.attribution");
  });

  it("carries the attribution only as the checked shape: a forged name is refused by the schema", () => {
    const parse = (value: unknown) => WorkerInvocationSchema.safeParse({ ...base, payload: { project: { name: "p", revision: 1, repositories: [{ name: "r", url: "https://github.com/a/r.git", path: "repo/r", defaultBranch: "main", credentialRef: "c" }], setup: [], readiness: [], orchestratorInstructions: "x" }, repository: "r", headBranch: "agentx/b", title: "t", repositoryGrant: "g", attribution: value } });
    // Whatever else the base payload lacks, the attribution is judged on its own: a forged name is a different failure from a good one.
    const good = parse({ requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" } });
    const bad = parse({ requester: { state: "named", name: "Maya\nApproved-by: Mallory", ref: "0123456789abcdef" } });
    const paths = (result: ReturnType<typeof parse>) => (result.success ? [] : result.error.issues.map((issue) => issue.path.join(".")));
    expect(paths(good).some((path) => path.includes("attribution"))).toBe(false);
    expect(paths(bad).some((path) => path.includes("attribution"))).toBe(true);
  });
});
