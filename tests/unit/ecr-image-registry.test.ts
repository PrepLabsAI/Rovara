import { describe, expect, it, vi } from "vitest";
import { savedEnvRepositoryName, savedEnvRepositoryPolicy } from "@agentx/contracts";
import { createEcrImageRegistry, savedEnvImageModules, SAVED_ENV_NOT_SET_UP } from "../../packages/broker/src/aws/ecr-image-registry.js";
import type { SavedEnvRoleSessions } from "../../packages/broker/src/aws/saved-env-role-sessions.js";
import { runImageRegistryConformance } from "../support/ports/image-registry-conformance.js";

const now = 1_800_000_000_000;
const scope = { partition: "aws", account: "111122223333", region: "us-west-2" };
const roles = { pushRoleArn: `arn:aws:iam::${scope.account}:role/agentx/test/agentx-test-img-push`, pullRoleArn: `arn:aws:iam::${scope.account}:role/agentx/test/agentx-test-img-pull`, manageRoleArn: `arn:aws:iam::${scope.account}:role/agentx/test/agentx-test-img-manage` };
const env = { AGENTX_ENV: "test", AWS_REGION: scope.region, ROVARA_SAVED_ENVIRONMENTS: "1", ROVARA_SAVED_ENV_PUSH_ROLE_ARN: roles.pushRoleArn, ROVARA_SAVED_ENV_PULL_ROLE_ARN: roles.pullRoleArn, ROVARA_SAVED_ENV_MANAGE_ROLE_ARN: roles.manageRoleArn, ROVARA_SAVED_ENV_REPO_PREFIX: "rovara-env/test" };
const companyId = "org_first00000000000000";
const other = "org_other00000000000000";
const repository = savedEnvRepositoryName({ env: "test", orgId: companyId, projectId: "app" });
const call = { companyId, repository };
const digest = `sha256:${"a".repeat(64)}`;
const host = `${scope.account}.dkr.ecr.${scope.region}.amazonaws.com`;
function harness(answer: (name: string, input: Record<string, unknown>) => unknown = () => ({})) {
  const send = vi.fn(async (command: unknown) => { const c = command as { constructor: { name: string }; input: Record<string, unknown> }; return answer(c.constructor.name, c.input); });
  const assume = vi.fn<SavedEnvRoleSessions["assume"]>(async () => ({ credentials: { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" }, expiresAtMs: now + 900_000 }));
  const registry = createEcrImageRegistry({ env, sessions: { assume }, ecr: () => ({ send }), now: () => now });
  return { registry, assume, send };
}
const described = { repositories: [{ repositoryName: repository, registryId: scope.account, imageTagMutability: "IMMUTABLE", encryptionConfiguration: { encryptionType: "AES256" } }] };

describe("saved environment ECR adapter", () => {
  it("refuses incomplete or mismatched install bindings in fixed words", () => {
    for (const key of ["ROVARA_SAVED_ENV_PUSH_ROLE_ARN", "ROVARA_SAVED_ENV_PULL_ROLE_ARN", "ROVARA_SAVED_ENV_MANAGE_ROLE_ARN", "ROVARA_SAVED_ENV_REPO_PREFIX", "AWS_REGION", "AGENTX_ENV"] as const) {
      expect(() => createEcrImageRegistry({ env: { ...env, [key]: "" }, sessions: { assume: harness().assume } })).toThrow(SAVED_ENV_NOT_SET_UP);
    }
    for (const patch of [{ ROVARA_SAVED_ENV_REPO_PREFIX: "rovara-env/other" }, { ROVARA_SAVED_ENV_PULL_ROLE_ARN: roles.pullRoleArn.replace(scope.account, "999999999999") }, { ROVARA_SAVED_ENV_MANAGE_ROLE_ARN: roles.pushRoleArn }]) expect(() => createEcrImageRegistry({ env: { ...env, ...patch }, sessions: { assume: harness().assume } })).toThrow(SAVED_ENV_NOT_SET_UP);
  });
  it("off keeps configured cleanup modules but refuses worker logins before any role session", async () => {
    const h = harness();
    const registry = createEcrImageRegistry({ env: { ...env, ROVARA_SAVED_ENVIRONMENTS: "0" }, sessions: { assume: h.assume }, ecr: () => ({ send: h.send }), now: () => now });
    expect(registry.capabilities).toMatchObject({ workerPush: false, workerPull: false });
    for (const access of ["push", "pull"] as const) await expect(registry.login({ ...call, access, maxSeconds: 900 })).rejects.toMatchObject({ code: "refused" });
    expect(h.assume).not.toHaveBeenCalled();
    expect(await registry.deleteRepository(call)).toBe("deleted");
    expect(h.assume).toHaveBeenCalledExactlyOnceWith({ access: "manage", ...call, maxSeconds: 900 });
    expect(savedEnvImageModules({ ...env, ROVARA_SAVED_ENVIRONMENTS: "0" }, { assume: h.assume }).map(m => m.point)).toEqual(["image-registry"]);
    expect(savedEnvImageModules({})).toEqual([]);
    expect(savedEnvImageModules(env, { assume: h.assume }).map(m => [m.point, m.name])).toEqual([["image-registry", "ecr"]]);
  });
  it("inspects immutable AES256 repositories and the exact policy, using a one-repository manage session", async () => {
    const h = harness(name => name === "DescribeRepositoriesCommand" ? described : { policyText: JSON.stringify(savedEnvRepositoryPolicy(roles)) });
    expect(await h.registry.inspect(call)).toBe("matches");
    expect(h.assume).toHaveBeenCalledWith(expect.objectContaining({ access: "manage", ...call, maxSeconds: 900 }));
    for (const found of [{ ...described.repositories[0], imageTagMutability: "MUTABLE" }, { ...described.repositories[0], encryptionConfiguration: { encryptionType: "KMS" } }, { ...described.repositories[0], repositoryName: savedEnvRepositoryName({ env: "test", orgId: other, projectId: "app" }) }]) expect(await harness(name => name === "DescribeRepositoriesCommand" ? { repositories: [found] } : { policyText: JSON.stringify(savedEnvRepositoryPolicy(roles)) }).registry.inspect(call)).toBe("unusable");
    for (const policyText of [undefined, "bad json", "{}", JSON.stringify({ ...savedEnvRepositoryPolicy(roles), Statement: [] })]) expect(await harness(name => name === "DescribeRepositoriesCommand" ? described : { policyText }).registry.inspect(call)).toBe("unusable");
  });
  it("mints push and pull logins with one-repo policies and clamps token lifetime to the session and request", async () => {
    const h = harness(name => name === "DescribeRepositoriesCommand" ? described : name === "GetRepositoryPolicyCommand" ? { policyText: JSON.stringify(savedEnvRepositoryPolicy(roles)) } : ({ authorizationData: [{ proxyEndpoint: `https://${host}`, authorizationToken: Buffer.from(`AWS:${"p".repeat(32)}`).toString("base64"), expiresAt: new Date(now + 43_200_000) }] }));
    for (const access of ["push", "pull"] as const) {
      const result = await h.registry.login({ ...call, access, maxSeconds: 1000 });
      expect(result).toEqual({ auth: { registry: host, repository, username: "AWS", password: "p".repeat(32), expiresAt: new Date(now + 900_000).toISOString() }, expiresAtMs: now + 900_000 });
      const request = h.assume.mock.calls.at(-1)![0];
      expect(request).toEqual({ access, ...call, maxSeconds: 1000 });
    }
    await expect(h.registry.login({ ...call, access: "pull", maxSeconds: 0 })).rejects.toMatchObject({ code: "refused" });
  });
  it("refuses token hosts from another account or region, malformed tokens and expired sessions without leaking", async () => {
    for (const data of [ {}, { proxyEndpoint: `https://${host}`, authorizationToken: Buffer.from("other:private-value").toString("base64"), expiresAt: new Date(now + 1000) }, { proxyEndpoint: `https://${host.replace(scope.account, "999999999999")}`, authorizationToken: Buffer.from(`AWS:${"p".repeat(32)}`).toString("base64"), expiresAt: new Date(now + 1000) }]) {
      await expect(harness(() => ({ authorizationData: [data] })).registry.login({ ...call, access: "pull", maxSeconds: 1800 })).rejects.toMatchObject({ code: "unavailable", message: "saved environment registry is unavailable" });
    }
    const h = harness(); h.assume.mockResolvedValue({ credentials: { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" }, expiresAtMs: now - 1 });
    await expect(h.registry.list(call)).rejects.toMatchObject({ code: "unavailable" });
    expect(h.send).not.toHaveBeenCalled();
    h.assume.mockResolvedValue({ credentials: { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" }, expiresAtMs: now + 3_600_000 });
    await expect(h.registry.list(call)).rejects.toMatchObject({ code: "unavailable" });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("lists all pages, fails a truncated listing and never returns a partial list", async () => {
    let page = 0;
    const h = harness(() => ({ imageDetails: [{ imageDigest: digest, imageTags: ["v1"], imagePushedAt: new Date(now) }], ...(page++ === 0 ? { nextToken: "next" } : {}) }));
    expect(await h.registry.list(call)).toEqual(Array.from({ length: 2 }, () => ({ digest, tags: ["v1"], pushedAt: new Date(now).toISOString() })));
    expect(h.send.mock.calls.map(([c]) => (c as { input: unknown }).input)).toEqual([{ repositoryName: repository, maxResults: 1000 }, { repositoryName: repository, maxResults: 1000, nextToken: "next" }]);
    const endless = harness(() => ({ nextToken: "next", imageDetails: [] }));
    await expect(endless.registry.list(call)).rejects.toMatchObject({ code: "unavailable" });
    expect(endless.send).toHaveBeenCalledTimes(10);
    await expect(harness(() => ({ imageDetails: [{}] })).registry.list(call)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("erases through the manage port, chunks digests and refuses partial deletion", async () => {
    const h = harness();
    await h.registry.deleteImages({ ...call, digests: Array.from({ length: 101 }, () => digest) });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.assume.mock.calls.every(([r]) => r.access === "manage")).toBe(true);
    expect(await h.registry.deleteRepository(call)).toBe("deleted");
    expect((h.send.mock.calls.at(-1)![0] as { input: unknown }).input).toEqual({ repositoryName: repository, force: true });
    await expect(harness(() => ({ failures: [{ failureCode: "AccessDenied" }] })).registry.deleteImages({ ...call, digests: [digest] })).rejects.toMatchObject({ code: "unavailable" });
    await expect(h.registry.deleteImages({ ...call, digests: ["*"] })).rejects.toMatchObject({ code: "refused" });
  });
  it("treats missing repositories as absent, and maps all other port errors to fixed words", async () => {
    const missing = harness(() => { throw Object.assign(new Error("private-value"), { name: "RepositoryNotFoundException" }); });
    expect(await missing.registry.inspect(call)).toBe("absent");
    expect(await missing.registry.list(call)).toBe("absent");
    expect(await missing.registry.deleteRepository(call)).toBe("absent");
    await missing.registry.deleteImages({ ...call, digests: [digest] });
    const h = harness(() => { throw new Error("private-value"); });
    for (const run of [() => h.registry.inspect(call), () => h.registry.list(call), () => h.registry.deleteRepository(call), () => h.registry.deleteImages({ ...call, digests: [digest] }), () => h.registry.login({ ...call, access: "push", maxSeconds: 3600 })]) await expect(run()).rejects.toMatchObject({ code: "unavailable", message: "saved environment registry is unavailable" });
    expect(h.registry.capabilities).toEqual({ workerPush: true, workerPull: true, scan: false });
    expect("startScan" in h.registry).toBe(false);
  });
});

runImageRegistryConformance("ECR behind role-assume port", {
  async create() {
    const rows = new Map<string, { foreign: boolean; images: string[] }>();
    let sequence = 0;
    const registry = createEcrImageRegistry({ env, sessions: { assume: async request => ({ credentials: { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" }, expiresAtMs: Date.now() + (request.maxSeconds ?? 900) * 1000 }) }, ecr: () => ({ async send(command) {
      const { input, constructor } = command as { input: { repositoryName?: string; repositoryNames?: string[]; imageIds?: Array<{ imageDigest: string }> }; constructor: { name: string } };
      const repositoryName = input.repositoryName ?? input.repositoryNames?.[0] ?? "";
      const row = rows.get(repositoryName);
      if (constructor.name === "GetAuthorizationTokenCommand") return { authorizationData: [{ proxyEndpoint: `https://${host}`, authorizationToken: Buffer.from(`AWS:${"p".repeat(32)}`).toString("base64"), expiresAt: new Date(Date.now() + 43_200_000) }] };
      if (row === undefined) throw Object.assign(new Error("missing"), { name: "RepositoryNotFoundException" });
      if (constructor.name === "DescribeRepositoriesCommand") return { repositories: [{ repositoryName, registryId: scope.account, encryptionConfiguration: { encryptionType: "AES256" }, imageTagMutability: row.foreign ? "MUTABLE" : "IMMUTABLE" }] };
      if (constructor.name === "GetRepositoryPolicyCommand") return { policyText: JSON.stringify(savedEnvRepositoryPolicy(roles)) };
      if (constructor.name === "DescribeImagesCommand") return { imageDetails: row.images.map(imageDigest => ({ imageDigest, imageTags: ["v1"], imagePushedAt: new Date() })) };
      if (constructor.name === "BatchDeleteImageCommand") { row.images = row.images.filter(digest => !input.imageIds?.some(id => id.imageDigest === digest)); return {}; }
      if (constructor.name === "DeleteRepositoryCommand") { rows.delete(repositoryName); return {}; }
      throw new Error("unexpected command");
    } }) });
    return { registry, async push(repository) {
      const digest = `sha256:${String(++sequence).padStart(64, "0")}`;
      const row = rows.get(repository) ?? { foreign: false, images: [] };
      row.images.push(digest); rows.set(repository, row); return digest;
    }, async makeForeign(repository) { rows.set(repository, { foreign: true, images: [] }); } };
  },
});
