// Browser testing in a project's setup (owner decision 421: source-backed, nothing typed): what Rovara reads from the repository, the sign-in snippet it offers, and the policy an owner's choices make.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { E2EApplicationProjectContractSchema, E2EPolicySchema, canonicalJson, readE2EApplicationProjectContract, type E2ESourceSnapshot } from "@agentx/contracts";
import {
  browserPolicy, decodeSnapshot, foundFacts, proposalObject, readApproved, readRepository, readSource, signInSnippetFor, sourceObject, storeProposalObject, storeSourceObject,
} from "../../packages/broker/src/core/setup-agent/browser-testing-proposal.js";
import { contractSnapshot, inferredSnapshot, sha, snapshotOf, PROFILE } from "../support/e2e-application-plan-fixtures.js";
import { memoryObjects } from "../support/browser-testing-world.js";

const accountsApp = readFileSync(new URL("../fixtures/e2e-accounts-app/package.json", import.meta.url), "utf8");
const READY = [{ kind: "web" as const, profileId: PROFILE }];
const REPOSITORY = { name: "demo", url: "https://github.com/example/demo.git", defaultBranch: "main" };

describe("what the repository says", () => {
  it("an app with no contract: Rovara's usual way, no user kinds, signed-out pages only, and a snippet", () => {
    const read = readRepository(inferredSnapshot, READY);
    const [app] = read.found.applications;
    expect(read.found.problem).toBeNull();
    expect(app).toMatchObject({ recipeSource: "inferred", start: "npm start", healthPath: "/", healthStatus: 200, userKinds: [], signInDeclared: false });
    expect(app!.build.join(" ")).toContain("npm ci");
    expect(app!.snippet).not.toBeNull();
  });

  it("an app whose repository declares its kinds of user: they are served as found, and no snippet is offered", () => {
    const snapshot = snapshotOf({ "package.json": accountsApp, "seed.mjs": "// seeds from the accounts file\n" });
    const read = readRepository(snapshot, READY);
    const [app] = read.found.applications;
    expect(app).toMatchObject({ recipeSource: "repo", signInDeclared: true, snippet: null, healthPath: "/health" });
    expect(app!.userKinds.map((kind) => [kind.profileId, kind.roleRef, kind.signInPath])).toEqual([["orders-viewer", "viewer", "/"], ["orders-owner", "owner", "/"], ["orders-owner-b", "owner", "/"]]);
  });

  it("a contract that declares kinds of user but no sign-in form says so and offers no snippet (a file there already decides it)", () => {
    const [app] = readRepository(contractSnapshot, READY).found.applications;
    expect(app!.userKinds.length).toBeGreaterThan(0);
    expect(app).toMatchObject({ signInDeclared: false, snippet: null });
  });

  it("a repository with no web or API app Rovara can start is a problem the page can say", () => {
    const read = readRepository(snapshotOf({ "README.md": "# nothing to start\n" }), READY);
    expect(read.found).toMatchObject({ applications: [], problem: "no-application" });
  });

  it("serves nothing that looks like a password, a token or a secret (the snippet's own test ids aside)", () => {
    for (const snapshot of [inferredSnapshot, contractSnapshot, snapshotOf({ "package.json": accountsApp })]) {
      const found = readRepository(snapshot, READY).found;
      const served = JSON.stringify({ ...found, applications: found.applications.map((application) => ({ ...application, snippet: null })) });
      expect(served).not.toMatch(/password|passwd|secret|token|api[_-]?key|credential/iu);
    }
  });
});

describe("the sign-in snippet comes from the contract's own schema", () => {
  const snippet = () => readRepository(inferredSnapshot, READY).found.applications[0]!.snippet!;

  it("is valid JSON and parses against the real project contract schema", () => {
    const text = snippet().text;
    const parsed = JSON.parse(text) as { agentx: { e2e: unknown } };
    expect(E2EApplicationProjectContractSchema.safeParse(parsed.agentx.e2e).success).toBe(true);
    // No comment line inside, so what [Copy snippet] copies is the document itself.
    expect(text.trimStart().startsWith("{")).toBe(true);
    expect(text).not.toMatch(/^\s*\/\//mu);
  });

  it("is read back as the application's contract when it sits where it says it goes", () => {
    const { path, text } = snippet();
    expect(path).toBe("package.json");
    const manifest = { ...JSON.parse(text) as Record<string, unknown>, name: "shop-web", scripts: { start: "node server.js" } };
    const contract = readE2EApplicationProjectContract(snapshotOf({ "package.json": JSON.stringify(manifest), "package-lock.json": "{}" }), "shop-web");
    expect(contract?.accountProfiles.map((profile) => profile.profileId)).toEqual(["user"]);
    expect(contract?.accountProfiles[0]?.login?.path).toBe("/login");
  });

  it("says it needs a seed step beside it, and declares the one the host runs", () => {
    const shown = snippet();
    expect(shown.needsSeedStep).toBe(true);
    const contract = (JSON.parse(shown.text) as { agentx: { e2e: { recipe: { seed: { args: string[] }; seedProfileId: string } } } }).agentx.e2e;
    expect(contract.recipe.seedProfileId).toBe("rovara-accounts-file/v1");
    expect(contract.recipe.seed.args).toEqual(["run", "rovara-seed"]);
  });

  it("holds no password, token or secret", () => { expect(snippet().text).not.toMatch(/password"\s*:\s*"[^"]/iu); expect(snippet().text.replace(/passwordTestId/gu, "")).not.toMatch(/secret|token|api[_-]?key/iu); });

  it("is refused (null) for a launch that is not a service, never a hand-drawn guess", () => {
    const read = readRepository(inferredSnapshot, READY);
    const recipe = read.proposal.applications[0]!.recipe!;
    expect(signInSnippetFor({ applicationId: "x", packagePath: "package.json", recipe: { ...recipe, launch: { kind: "contract", adapterProfileId: "a", operationIds: ["o"] } }, targetIds: [] })).toBeNull();
  });
});

describe("the policy an owner's choices make", () => {
  const read = () => readRepository(inferredSnapshot, READY);

  it("is a valid policy with the owner's time limit, no AI route, and the web target on the READY profile", () => {
    const policy = browserPolicy({ proposal: read().proposal, proof: { screenshotMode: "failed", video: false }, runTimeoutMs: 300_000, policyRevision: 1 });
    expect(E2EPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy).toMatchObject({ policyRevision: 1, modelRouteRevision: null, fallback: "mock-unconnected", limits: { runTimeoutMs: 300_000 } });
    expect(policy.targets.some((target) => target.runtimeProfileId === PROFILE)).toBe(true);
  });

  it("writes the screenshot mode only when a strip is asked for, and the recording only when ticked", () => {
    const failed = browserPolicy({ proposal: read().proposal, proof: { screenshotMode: "failed", video: false }, runTimeoutMs: 600_000, policyRevision: 2 });
    const all = browserPolicy({ proposal: read().proposal, proof: { screenshotMode: "all", video: true }, runTimeoutMs: 600_000, policyRevision: 2 });
    expect(failed.capture).toEqual({ screenshots: true, traces: false, video: false, downloads: true });
    expect(all.capture).toEqual({ screenshots: true, traces: false, video: true, downloads: true, screenshotMode: "all" });
  });

  it("refuses a time limit past Rovara's hard limit", () => {
    expect(() => browserPolicy({ proposal: read().proposal, proof: { screenshotMode: "failed", video: false }, runTimeoutMs: 1_800_001, policyRevision: 1 })).toThrow();
  });
});

describe("the stored objects", () => {
  it("round-trip: the source object reads back to the same files and proposal, and a changed byte is refused", async () => {
    const objects = memoryObjects();
    const read = readRepository(inferredSnapshot, READY);
    const source = sourceObject({ companyId: "org_x", project: "demo", repository: REPOSITORY, read });
    await storeSourceObject(objects, source);
    await storeSourceObject(objects, source); // the same bytes are the same object
    const back = await readSource(objects, source.ref, source.sha256, REPOSITORY);
    expect(back?.candidateDigest).toBe(read.candidateDigest);
    expect(canonicalJson(back?.proposal)).toBe(canonicalJson(read.proposal));
    expect(await readSource(objects, source.ref, "f".repeat(64), REPOSITORY)).toBeUndefined();
    expect(await readSource(objects, source.ref, source.sha256, { ...REPOSITORY, url: "https://github.com/other/demo.git" })).toBeUndefined();
    objects.map.set(source.ref, Buffer.from(`${source.bytes} `));
    expect(await readSource(objects, source.ref, source.sha256, REPOSITORY)).toBeUndefined();
  });

  it("the proposal object is the artifact the planning seam verifies: issuer, repository, policy and files, all re-checked on read", async () => {
    const objects = memoryObjects();
    const read = readRepository(inferredSnapshot, READY);
    const policy = browserPolicy({ proposal: read.proposal, proof: { screenshotMode: "failed", video: false }, runTimeoutMs: 600_000, policyRevision: 1 });
    const proposal = proposalObject({ companyId: "org_x", project: "demo", issuerOwnerKey: "owner-key", repository: REPOSITORY, read, policy })!;
    await storeProposalObject(objects, proposal);
    expect(sha(proposal.bytes)).toBe(proposal.sha256);
    const approval = { proposalRef: proposal.ref, proposalSha256: proposal.sha256, candidateDigest: read.candidateDigest };
    const back = await readApproved(objects, approval, REPOSITORY, "owner-key");
    expect(canonicalJson(back?.policy)).toBe(canonicalJson(policy));
    expect(await readApproved(objects, approval, REPOSITORY, "someone-else")).toBeUndefined();
    expect(await readApproved(objects, { ...approval, candidateDigest: "e".repeat(64) }, REPOSITORY, "owner-key")).toBeUndefined();
    expect(await readApproved(objects, approval, { ...REPOSITORY, name: "other" }, "owner-key")).toBeUndefined();
    expect(decodeSnapshot((JSON.parse(proposal.bytes) as { snapshot: unknown }).snapshot).commitSha).toBe(inferredSnapshot.commitSha);
  });

  it("a repository that is not on GitHub has no proposal object (the sandbox reads only what it can name)", () => {
    const read = readRepository(inferredSnapshot, READY);
    const policy = browserPolicy({ proposal: read.proposal, proof: { screenshotMode: "failed", video: false }, runTimeoutMs: 600_000, policyRevision: 1 });
    expect(proposalObject({ companyId: "org_x", project: "demo", issuerOwnerKey: "k", repository: { ...REPOSITORY, url: "https://example.test/repo.git" }, read, policy })).toBeUndefined();
  });

  it("an unverifiable snapshot is refused before anything is stored", () => {
    const broken: E2ESourceSnapshot = { ...inferredSnapshot, sources: inferredSnapshot.sources.map((source) => ({ ...source, sha256: "0".repeat(64) })) };
    expect(() => readRepository(broken, READY)).toThrow();
    expect(foundFacts).toBeTypeOf("function");
  });
});
