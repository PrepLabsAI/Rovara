// L4-SE6: the broker's role-assume seam for saved environment images (packages/broker/src/aws/saved-env-role-sessions.ts). Every case sends no STS call: the call is injected.
//   - the session policy names exactly ONE repository, and the only `*` is the registry token call (ECR cannot scope it);
//   - two companies: a company's session policy can never name another company's repository (the same project id in two companies gives two repositories; a call for the other's is refused BEFORE STS);
//   - the role, the duration (push 3,600 / pull 1,800 / manage 900 seconds at most) and the session name are what the access kind decides;
//   - an install without the variables, or with wrong ones, builds nothing; an STS failure is one fixed sentence.
import { describe, expect, it } from "vitest";
import {
  ImageRegistryError,
  SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE, SAVED_ENV_PULL_ROLE_ARN_VARIABLE, SAVED_ENV_PUSH_ROLE_ARN_VARIABLE, SAVED_ENV_REPO_PREFIX_VARIABLE,
  savedEnvManageSessionPolicy, savedEnvPullSessionPolicy, savedEnvPushSessionPolicy, savedEnvRepositoryArn, savedEnvRepositoryName,
} from "@agentx/contracts";
import {
  createSavedEnvRoleSessions, savedEnvRoleSessionSettings, savedEnvRoleSessionsFromEnvironment, type SavedEnvAccess, type SavedEnvAssumeRoleRequest,
} from "../../packages/broker/src/aws/saved-env-role-sessions.js";

const ACCOUNT = "123456789012";
const OTHER_ACCOUNT = "210987654321";
const REGION = "us-west-2";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const roleArn = (name: string, account = ACCOUNT) => `arn:aws:iam::${account}:role/agentx/staging/agentx-staging-img-${name}`;
const environment = (): Record<string, string> => ({
  [SAVED_ENV_PUSH_ROLE_ARN_VARIABLE]: roleArn("push"), [SAVED_ENV_PULL_ROLE_ARN_VARIABLE]: roleArn("pull"), [SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE]: roleArn("manage"),
  [SAVED_ENV_REPO_PREFIX_VARIABLE]: "rovara-env/staging", AWS_REGION: REGION,
});
const repositoryOf = (company: string, project = "project-1", env = "staging") => savedEnvRepositoryName({ env, orgId: company, projectId: project });
const FUTURE = () => new Date(Date.now() + 3_000_000);

function harness(answer: (request: SavedEnvAssumeRoleRequest) => unknown = () => ({ Credentials: { AccessKeyId: "AKIAEXAMPLE", SecretAccessKey: "secret", SessionToken: "token", Expiration: FUTURE() } })) {
  const calls: SavedEnvAssumeRoleRequest[] = [];
  const settings = savedEnvRoleSessionSettings(environment(), REGION)!;
  const sessions = createSavedEnvRoleSessions({ settings, assumeRole: async (request) => { calls.push(request); return answer(request); } });
  return { calls, sessions, settings };
}

/** Every Resource of a policy statement list, and which statements use `*`. */
function resourcesOf(policy: { Statement: Array<Record<string, unknown>> }): Array<{ sid: unknown; resources: string[]; actions: string[] }> {
  return policy.Statement.map((statement) => ({ sid: statement.Sid, resources: [statement.Resource].flat() as string[], actions: [statement.Action].flat() as string[] }));
}

describe("the session policy names exactly one repository", () => {
  const scope = { partition: "aws", region: REGION, account: ACCOUNT };
  for (const [access, build] of [["push", savedEnvPushSessionPolicy], ["pull", savedEnvPullSessionPolicy], ["manage", savedEnvManageSessionPolicy]] as const) {
    it(`${access}: one repository ARN, and a "*" only on the registry token call`, async () => {
      const { calls, sessions } = harness();
      const repository = repositoryOf(A);
      await sessions.assume({ access, companyId: A, repository });
      const sent = JSON.parse(calls[0]!.policy) as { Statement: Array<Record<string, unknown>> };
      expect(sent).toEqual(build(scope, repository));
      const arn = savedEnvRepositoryArn(scope, repository);
      const rows = resourcesOf(sent);
      const star = rows.filter((row) => row.resources.includes("*"));
      expect(star.every((row) => row.actions.length === 1 && row.actions[0] === "ecr:GetAuthorizationToken")).toBe(true);
      expect(access === "manage" ? star.length === 0 : star.length === 1).toBe(true);
      const named = rows.filter((row) => !row.resources.includes("*"));
      expect(named).toHaveLength(1);
      expect(named[0]!.resources).toEqual([arn]);
      expect(JSON.stringify(sent)).not.toMatch(/\$\{|rovara-env\/staging\/\*/u);
    });
  }
});

describe("what STS is asked for", () => {
  it("the fixed-name role of the access kind, with the inline policy, the session limits and a session name that holds no company or project id", async () => {
    const { calls, sessions } = harness();
    const repository = repositoryOf(A);
    for (const access of ["push", "pull", "manage"] as const satisfies readonly SavedEnvAccess[]) await sessions.assume({ access, companyId: A, repository });
    expect(calls.map((call) => [call.roleArn, call.durationSeconds])).toEqual([[roleArn("push"), 3600], [roleArn("pull"), 1800], [roleArn("manage"), 900]]);
    for (const call of calls) {
      expect(call.sessionName).toMatch(/^rovara-img-(push|pull|manage)-p[0-9a-f]{24}$/u);
      expect(call.sessionName.length).toBeLessThanOrEqual(64);
      expect(call.sessionName).not.toContain(A);
      expect(call.policy.length).toBeLessThanOrEqual(2048);
    }
  });

  it("never asks for more than the kind's limit, and never under STS's 900 seconds", async () => {
    const { calls, sessions } = harness();
    const repository = repositoryOf(A);
    await sessions.assume({ access: "push", companyId: A, repository, maxSeconds: 86_400 });
    await sessions.assume({ access: "pull", companyId: A, repository, maxSeconds: 3_600 });
    await sessions.assume({ access: "pull", companyId: A, repository, maxSeconds: 1_000 });
    await sessions.assume({ access: "pull", companyId: A, repository, maxSeconds: 60 });
    await sessions.assume({ access: "manage", companyId: A, repository, maxSeconds: 3_600 });
    expect(calls.map((call) => call.durationSeconds)).toEqual([3600, 1800, 1000, 900, 900]);
  });

  it("returns the credentials and when they end, and nothing else of STS's answer", async () => {
    const expiration = FUTURE();
    const { sessions } = harness(() => ({ Credentials: { AccessKeyId: "AKIAEXAMPLE", SecretAccessKey: "secret", SessionToken: "token", Expiration: expiration }, AssumedRoleUser: { Arn: "arn:aws:sts::1:assumed-role/x/y" } }));
    expect(await sessions.assume({ access: "pull", companyId: A, repository: repositoryOf(A) })).toEqual({ credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token" }, expiresAtMs: expiration.getTime() });
  });
});

describe("two companies", () => {
  it("the same project id in two companies is two repositories, and each company's session policy names only its own", async () => {
    const { calls, sessions } = harness();
    const a = repositoryOf(A);
    const b = repositoryOf(B);
    expect(a).not.toBe(b);
    await sessions.assume({ access: "push", companyId: A, repository: a });
    await sessions.assume({ access: "push", companyId: B, repository: b });
    const aOrg = a.split("/")[2]!;
    const bOrg = b.split("/")[2]!;
    expect(calls[0]!.policy).toContain(a);
    expect(calls[0]!.policy).not.toContain(bOrg);
    expect(calls[1]!.policy).toContain(b);
    expect(calls[1]!.policy).not.toContain(aOrg);
  });

  it("refuses, before any STS call, a repository of another company, of another project's company hash, or of another environment", async () => {
    const { calls, sessions } = harness();
    const refusals: Array<[string, string, string]> = [
      ["B's repository for A", A, repositoryOf(B)],
      ["A's repository for B", B, repositoryOf(A)],
      ["another environment's repository", A, repositoryOf(A, "project-1", "prod")],
    ];
    for (const [label, company, repository] of refusals) {
      for (const access of ["push", "pull", "manage"] as const) {
        const failure = await sessions.assume({ access, companyId: company, repository }).catch((error: unknown) => error);
        expect(failure, `${label} ${access}`).toBeInstanceOf(ImageRegistryError);
        expect((failure as ImageRegistryError).code, label).toBe("refused");
      }
    }
    expect(calls).toEqual([]);
  });

  it("refuses names that are not one repository: a wildcard, a prefix, a policy variable, a path trick, an empty name", async () => {
    const { calls, sessions } = harness();
    const own = repositoryOf(A);
    const [root, env, org] = own.split("/");
    for (const name of ["*", "rovara-env/staging/*", `${root}/${env}/${org}/*`, `${root}/${env}/*/p${"a".repeat(32)}`, `${own}/*`, `${own}/../x`, `${own}\u0000`, `${root}/${env}/${org}/\${aws:username}`, "", `${own}x`, own.toUpperCase()]) {
      const failure = await sessions.assume({ access: "pull", companyId: A, repository: name }).catch((error: unknown) => error);
      expect(failure, name).toBeInstanceOf(ImageRegistryError);
      expect((failure as ImageRegistryError).code).toBe("refused");
    }
    expect(calls).toEqual([]);
  });

  it("refuses an access kind that is not push, pull or manage, and a non-positive limit", async () => {
    const { calls, sessions } = harness();
    const repository = repositoryOf(A);
    await expect(sessions.assume({ access: "scan" as never, companyId: A, repository })).rejects.toMatchObject({ code: "refused" });
    for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) await expect(sessions.assume({ access: inherited as never, companyId: A, repository })).rejects.toMatchObject({ code: "refused" });
    await expect(sessions.assume({ access: "pull", companyId: A, repository, maxSeconds: 0 })).rejects.toMatchObject({ code: "refused" });
    await expect(sessions.assume({ access: "pull", companyId: A, repository, maxSeconds: Number.NaN })).rejects.toMatchObject({ code: "refused" });
    expect(calls).toEqual([]);
  });
});

describe("failures are fixed sentences", () => {
  it("an STS error becomes `unavailable` and none of its words, ARNs or request ids get out", async () => {
    const { sessions } = harness(() => { throw new Error(`AccessDenied: User arn:aws:sts::${ACCOUNT}:assumed-role/agentx-staging-broker-role/x is not authorized (request id 1234)`); });
    const failure = await sessions.assume({ access: "push", companyId: A, repository: repositoryOf(A) }).catch((error: unknown) => error) as ImageRegistryError;
    expect(failure).toBeInstanceOf(ImageRegistryError);
    expect(failure.code).toBe("unavailable");
    expect(failure.retryable).toBe(true);
    expect(failure.message).not.toMatch(new RegExp(`${ACCOUNT}|arn:|request id|AccessDenied`, "u"));
  });

  for (const [label, answer] of [
    ["no credentials", {}], ["no session token", { Credentials: { AccessKeyId: "a", SecretAccessKey: "b", Expiration: FUTURE() } }],
    ["an empty key", { Credentials: { AccessKeyId: "", SecretAccessKey: "b", SessionToken: "c", Expiration: FUTURE() } }],
    ["no expiry", { Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c" } }],
    ["an expiry in the past", { Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c", Expiration: new Date(Date.now() - 1000) } }],
  ] as const) {
    it(`a session STS answered with ${label} is not handed on`, async () => {
      const { sessions } = harness(() => answer);
      await expect(sessions.assume({ access: "push", companyId: A, repository: repositoryOf(A) })).rejects.toMatchObject({ code: "unavailable" });
    });
  }
});

describe("the install's settings", () => {
  it("are read from the four variables", () => {
    expect(savedEnvRoleSessionSettings(environment(), REGION)).toEqual({
      env: "staging", partition: "aws", region: REGION, account: ACCOUNT, roleArns: { push: roleArn("push"), pull: roleArn("pull"), manage: roleArn("manage") },
    });
  });

  const wrong: Array<[string, (variables: Record<string, string>) => void]> = [
    ["a missing push ARN", (v) => { delete v[SAVED_ENV_PUSH_ROLE_ARN_VARIABLE]; }],
    ["a missing pull ARN", (v) => { delete v[SAVED_ENV_PULL_ROLE_ARN_VARIABLE]; }],
    ["a missing manage ARN", (v) => { delete v[SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE]; }],
    ["a missing prefix", (v) => { delete v[SAVED_ENV_REPO_PREFIX_VARIABLE]; }],
    ["a prefix of another shape", (v) => { v[SAVED_ENV_REPO_PREFIX_VARIABLE] = "rovara-env/staging/"; }],
    ["a prefix of another environment", (v) => { v[SAVED_ENV_REPO_PREFIX_VARIABLE] = "rovara-env/prod"; }],
    ["the pull ARN in the push variable", (v) => { v[SAVED_ENV_PUSH_ROLE_ARN_VARIABLE] = roleArn("pull"); }],
    ["a role of another account", (v) => { v[SAVED_ENV_PULL_ROLE_ARN_VARIABLE] = roleArn("pull", OTHER_ACCOUNT); }],
    ["a role without the environment's path", (v) => { v[SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE] = `arn:aws:iam::${ACCOUNT}:role/agentx-staging-img-manage`; }],
    ["another role under the path", (v) => { v[SAVED_ENV_PUSH_ROLE_ARN_VARIABLE] = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-broker-role`; }],
    ["the right role name under another environment's path", (v) => { v[SAVED_ENV_PUSH_ROLE_ARN_VARIABLE] = `arn:aws:iam::${ACCOUNT}:role/agentx/prod/agentx-staging-img-push`; }],
    ["a wildcard role", (v) => { v[SAVED_ENV_PUSH_ROLE_ARN_VARIABLE] = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-*`; }],
    ["another partition on one ARN", (v) => { v[SAVED_ENV_PULL_ROLE_ARN_VARIABLE] = roleArn("pull").replace("arn:aws:", "arn:aws-cn:"); }],
    ["no region", (v) => { delete v.AWS_REGION; }],
  ];
  for (const [label, mutate] of wrong) {
    it(`give no sessions with ${label}`, () => {
      const variables = environment();
      mutate(variables);
      expect(savedEnvRoleSessionsFromEnvironment(variables, { assumeRole: async () => { throw new Error("must not be called"); } })).toBeUndefined();
    });
  }

  it("give a working seam from a good environment (the STS call injected)", async () => {
    const sent: SavedEnvAssumeRoleRequest[] = [];
    const sessions = savedEnvRoleSessionsFromEnvironment(environment(), { assumeRole: async (request) => { sent.push(request); return { Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c", Expiration: FUTURE() } }; } });
    expect(sessions).toBeDefined();
    await sessions!.assume({ access: "pull", companyId: A, repository: repositoryOf(A) });
    expect(sent[0]!.roleArn).toBe(roleArn("pull"));
  });
});
