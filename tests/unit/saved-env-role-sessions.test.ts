// L4-SE6: the broker's role-assume seam for saved environment images (packages/broker/src/aws/saved-env-role-sessions.ts). Every case sends no STS call: the call is injected.
//   - the session policy names exactly ONE repository, and the only `*` is the registry token call (ECR cannot scope it);
//   - two companies: a company's session policy can never name another company's repository (the same project id in two companies gives two repositories; a call for the other's is refused BEFORE STS);
//   - the role, the duration (push 3,600 / pull 1,800 / manage 900 seconds at most) and the session name are what the access kind decides;
//   - an install without the variables, or with wrong ones, builds nothing; an STS failure is one fixed sentence.
import { describe, expect, it } from "vitest";
import { ImageRegistryError, SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE, SAVED_ENV_PULL_ROLE_ARN_VARIABLE, SAVED_ENV_PUSH_ROLE_ARN_VARIABLE, SAVED_ENV_REPO_PREFIX_VARIABLE, savedEnvManageSessionPolicy, savedEnvPullSessionPolicy, savedEnvPushSessionPolicy, savedEnvRepositoryArn, savedEnvRepositoryName } from "@agentx/contracts";
import { SAVED_ENV_LIST_MAX_PAGES, SAVED_ENV_LIST_PAGE_SIZE, createSavedEnvRoleSessions, savedEnvRoleSessionSettings, savedEnvRoleSessionsFromEnvironment, type SavedEnvAssumeRoleRequest, type SavedEnvDescribeRepositoriesRequest } from "../../packages/broker/src/aws/saved-env-role-sessions.js";

const ACCOUNT = "123456789012";
const OTHER_ACCOUNT = "210987654321";
const REGION = "us-west-2";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
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

describe("two companies", () => {

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

// ---- L4-SE6b (owner-approved 2026-11-18): company erase lists ONE company's repositories, with a manage session whose policy names that company's prefix and one action.
describe("listCompanyRepositories (company erase)", () => {
  const nameOf = (company: string, project: string) => repositoryOf(company, project);
  const SESSION = { Credentials: { AccessKeyId: "AKIALIST", SecretAccessKey: "secret", SessionToken: "token", Expiration: FUTURE() } };

  /** A fake ECR holding repositories of several companies, paged by `pageSize` (ECR itself, with a session policy, would return only the company's; the fake returns EVERYTHING to prove the code's own filter). */
  function listing(all: string[], pageSize = SAVED_ENV_LIST_PAGE_SIZE) {
    const pages: SavedEnvDescribeRepositoriesRequest[] = [];
    const assumed: SavedEnvAssumeRoleRequest[] = [];
    const settings = savedEnvRoleSessionSettings(environment(), REGION)!;
    const sessions = createSavedEnvRoleSessions({
      settings,
      assumeRole: async (request) => { assumed.push(request); return SESSION; },
      describeRepositories: async (request) => {
        pages.push(request);
        const start = request.nextToken === undefined ? 0 : Number(request.nextToken);
        const slice = all.slice(start, start + pageSize);
        return { repositories: slice.map((repositoryName) => ({ repositoryName })), ...(start + pageSize < all.length ? { nextToken: String(start + pageSize) } : {}) };
      },
    });
    return { sessions, pages, assumed };
  }

  it("a session that ends in the middle of the walk is `unavailable`, never the part read so far", async () => {
    const settings = savedEnvRoleSessionSettings(environment(), REGION)!;
    let clock = Date.now();
    let calls = 0;
    const sessions = createSavedEnvRoleSessions({
      settings, now: () => clock, assumeRole: async () => ({ Credentials: { ...SESSION.Credentials, Expiration: new Date(clock + 60_000) } }),
      describeRepositories: async () => { calls += 1; clock += 120_000; return { repositories: [{ repositoryName: nameOf(A, "p1") }], nextToken: "more" }; },
    });
    await expect(sessions.listCompanyRepositories({ companyId: A })).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toBe(1);
  });

  it("is bounded: a list that does not end within the page bound is `unavailable`, never a partial list", async () => {
    const all = Array.from({ length: SAVED_ENV_LIST_MAX_PAGES * 10 + 1 }, (_, index) => nameOf(A, `project-${String(index)}`));
    const { sessions, pages } = listing(all, 10);
    await expect(sessions.listCompanyRepositories({ companyId: A })).rejects.toMatchObject({ code: "unavailable" });
    expect(pages).toHaveLength(SAVED_ENV_LIST_MAX_PAGES);
    // exactly the bound is fine
    const exact = listing(all.slice(0, SAVED_ENV_LIST_MAX_PAGES * 10), 10);
    expect(await exact.sessions.listCompanyRepositories({ companyId: A })).toHaveLength(SAVED_ENV_LIST_MAX_PAGES * 10);
  });

  it("a repeated or non-text token, a malformed page, an ECR error and an expired session are `unavailable` (fixed words)", async () => {
    const settings = savedEnvRoleSessionSettings(environment(), REGION)!;
    const make = (describeRepositories: (request: SavedEnvDescribeRepositoriesRequest) => Promise<unknown>, now?: () => number) => createSavedEnvRoleSessions({ settings, assumeRole: async () => SESSION, describeRepositories, ...(now === undefined ? {} : { now }) });
    let repeated = 0;
    let numeric = 0;
    const cases: Array<[string, ReturnType<typeof make>]> = [
      ["a repeated token", make(async () => { repeated += 1; return { repositories: [], nextToken: "same" }; })],
      ["a numeric token", make(async () => { numeric += 1; return { repositories: [], nextToken: 7 }; })],
      ["a non-array list", make(async () => ({ repositories: "x" }))],
      ["no answer", make(async () => undefined)],
      ["an ECR error", make(async () => { throw new Error(`AccessDeniedException: arn:aws:iam::${ACCOUNT}:role/x is not authorized to perform ecr:DescribeRepositories (request id 99)`); })],
      ["a session that ends before the first page", make(async () => ({ repositories: [] }), () => Date.now() + 10_000_000)],
    ];
    for (const [label, sessions] of cases) {
      const failure = await sessions.listCompanyRepositories({ companyId: A }).catch((error: unknown) => error) as ImageRegistryError;
      expect(failure, label).toBeInstanceOf(ImageRegistryError);
      expect(failure.code, label).toBe("unavailable");
      expect(failure.message, label).not.toMatch(new RegExp(`${ACCOUNT}|arn:|request id|AccessDenied`, "u"));
    }
    // stopped at once, not at the page bound
    expect([repeated, numeric]).toEqual([2, 1]);
  });

  it("an STS failure is `unavailable` and no ECR call is made; a bad company id is refused before STS", async () => {
    const settings = savedEnvRoleSessionSettings(environment(), REGION)!;
    let ecr = 0;
    const failing = createSavedEnvRoleSessions({ settings, assumeRole: async () => { throw new Error("AccessDenied"); }, describeRepositories: async () => { ecr += 1; return {}; } });
    await expect(failing.listCompanyRepositories({ companyId: A })).rejects.toMatchObject({ code: "unavailable" });
    expect(ecr).toBe(0);
    const { sessions, assumed, pages } = listing([]);
    for (const bad of ["", "a".repeat(201), "x\u0000y", 7 as never]) await expect(sessions.listCompanyRepositories({ companyId: bad }), String(bad)).rejects.toMatchObject({ code: "refused" });
    expect(assumed).toEqual([]);
    expect(pages).toEqual([]);
    // an id is hashed into the prefix, so a wildcard or a path trick as a company id can never reach the policy as one
    for (const odd of ["*", "../x", "o*", "${aws:username}"]) await sessions.listCompanyRepositories({ companyId: odd });
    expect(assumed.map((call) => (JSON.parse(call.policy) as { Statement: Array<{ Resource: string }> }).Statement[0]!.Resource)).toSatisfy((resources: string[]) => resources.every((resource) => /:repository\/rovara-env\/staging\/o[0-9a-f]{32}\/\*$/u.test(resource)));
  });

  it("the seam built from the install's variables carries the listing too", async () => {
    const sessions = savedEnvRoleSessionsFromEnvironment(environment(), {
      assumeRole: async () => SESSION,
      describeRepositories: async () => ({ repositories: [{ repositoryName: nameOf(A, "p1") }] }),
    });
    expect(await sessions!.listCompanyRepositories({ companyId: A })).toEqual([nameOf(A, "p1")]);
  });
});
