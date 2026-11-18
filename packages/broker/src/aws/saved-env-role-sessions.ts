// Saved environment images on hosted (lane L4-SE6): the broker's role-assume seam. The ECR adapter of the hosted `image-registry` port (aws/ecr-image-registry.ts, lane L4-SE) asks THIS port for
// credentials, and makes every ECR call with them and nothing else, so a call can reach only the one repository the session policy names. This file is the only place that calls STS for it.
//
// The port is `SavedEnvRoleSessions` (the Codex lane injects it into its adapter; a fake in tests). One method, `assume`:
//   - the repository NAME comes from the caller, but it is checked here against the company: it must be a name `savedEnvRepositoryName` makes, in THIS install's environment, under THIS company's
//     hash. A company's session policy can therefore never name another company's repository, even if the caller passes one (the repository name is a one-way hash of org + project built by the broker);
//   - the role is the fixed-name role of the access kind (`agentx-<env>-img-push|pull|manage`), the policy is the contracts' session policy for ONE repository (`savedEnvPushSessionPolicy` and its
//     siblings: one Allow with the repository's own ARN, plus the registry token call, which ECR cannot scope), passed inline to AssumeRole, and the session lasts at most 60 minutes for a push, 30 for a
//     pull and 15 for housekeeping (STS refuses under 900 seconds, so a shorter request gets 900: the adapter ends the login at the caller's own limit);
//   - the role ARNs, the prefix and the account come from the install's own variables (`ROVARA_SAVED_ENV_*`, set by infra/lib/saved-env-images.ts, named environments only); with any missing, wrong
//     or from another account, nothing is built ("saved environments are not set up on this install");
//   - `listCompanyRepositories` (company erase, owner-approved 2026-11-18, lane L4-SE6b): ONE manage session whose policy is exactly `ecr:DescribeRepositories` on THIS company's prefix
//     (`rovara-env/<env>/o<hash>/*`), then a bounded, paginated DescribeRepositories walk with that session's credentials. Isolation is three layers: the session policy (IAM), the fixed prefix of the
//     company the call is for (built from the one derivation), and a filter here that drops any name outside `rovara-env/<env>/o<hash>/` before it is returned. A list that does not end inside the bound
//     is an error, never a partial list: erase must PROVE nothing is left;
//   - an error is one of two fixed sentences (`ImageRegistryError`): never STS's own words, which can quote an ARN, a session name or a request id. Nothing is cached or logged.
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import {
  AssumeRoleCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import {
  ImageRegistryError,
  SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE,
  SAVED_ENV_MANAGE_SESSION_SECONDS,
  SAVED_ENV_PULL_ROLE_ARN_VARIABLE,
  SAVED_ENV_PULL_SESSION_SECONDS,
  SAVED_ENV_PUSH_ROLE_ARN_VARIABLE,
  SAVED_ENV_PUSH_SESSION_SECONDS,
  SAVED_ENV_REPO_PREFIX_VARIABLE,
  isSavedEnvRepositoryName,
  savedEnvCompanyRepositoryPrefix,
  savedEnvManageListSessionPolicy,
  savedEnvManageRoleName,
  savedEnvManageSessionPolicy,
  savedEnvPullRoleName,
  savedEnvPullSessionPolicy,
  savedEnvPushRoleName,
  savedEnvPushSessionPolicy,
  savedEnvRepositoryName,
  type SessionPolicyJson,
} from "@agentx/contracts";

export type SavedEnvAccess = "push" | "pull" | "manage";

/** What STS gives back, and nothing of its own words. `expiresAtMs` is when the credentials stop working. */
export interface SavedEnvSession {
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  expiresAtMs: number;
}

export interface SavedEnvRoleSessionRequest {
  access: SavedEnvAccess;
  /** The company the call is for (`RepositoryCall.companyId`). */
  companyId: string;
  /** A name `savedEnvRepositoryName` made for that company. */
  repository: string;
  /** The longest the caller wants the session to last, in seconds. Never more than the access kind's limit. */
  maxSeconds?: number;
}

/** The port: credentials limited to ONE repository, and the one company-wide listing. Throws `ImageRegistryError` ("refused": never retried; "unavailable": retry later). */
export interface SavedEnvRoleSessions {
  assume(request: SavedEnvRoleSessionRequest): Promise<SavedEnvSession>;
  /**
   * Every repository this install holds for ONE company (company erase uses it to prove each image store is gone): the names under `rovara-env/<env>/o<hash>/`, sorted, nothing of another company. A
   * company with none gets `[]`. A list that cannot be read to its end (an error, a session that ends, more than `SAVED_ENV_LIST_MAX_REPOSITORIES`) throws `unavailable`: never a partial list.
   */
  listCompanyRepositories(request: { companyId: string }): Promise<string[]>;
}

/** What goes to ECR (DescribeRepositories) for one page. The call is injected so a test sends none. */
export interface SavedEnvDescribeRepositoriesRequest {
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  /** The previous page's `nextToken`; absent for the first page. */
  nextToken?: string;
  maxResults: number;
}
export type SavedEnvDescribeRepositories = (request: SavedEnvDescribeRepositoriesRequest) => Promise<unknown>;

/** The page size, and the most pages one listing reads: at most 2,000 repositories of one company (one per project). Beyond that the answer is `unavailable`, so erase never proves "gone" from a part. */
export const SAVED_ENV_LIST_PAGE_SIZE = 100;
export const SAVED_ENV_LIST_MAX_PAGES = 20;
export const SAVED_ENV_LIST_MAX_REPOSITORIES = SAVED_ENV_LIST_PAGE_SIZE * SAVED_ENV_LIST_MAX_PAGES;

/** What goes to STS (AssumeRole). The call is injected so a test sends none. */
export interface SavedEnvAssumeRoleRequest {
  roleArn: string;
  sessionName: string;
  /** The inline session policy, as the JSON text AssumeRole takes. */
  policy: string;
  durationSeconds: number;
}
export type SavedEnvAssumeRole = (request: SavedEnvAssumeRoleRequest) => Promise<unknown>;

/** The most each access kind lives, and (the contracts' limits) what its role may do. */
const LIMITS: Record<SavedEnvAccess, { seconds: number; roleName: (env: string) => string; policy: (scope: Scope, repository: string) => SessionPolicyJson }> = {
  push: { seconds: SAVED_ENV_PUSH_SESSION_SECONDS, roleName: savedEnvPushRoleName, policy: savedEnvPushSessionPolicy },
  pull: { seconds: SAVED_ENV_PULL_SESSION_SECONDS, roleName: savedEnvPullRoleName, policy: savedEnvPullSessionPolicy },
  manage: { seconds: SAVED_ENV_MANAGE_SESSION_SECONDS, roleName: savedEnvManageRoleName, policy: savedEnvManageSessionPolicy },
};
type Scope = { partition: string; region: string; account: string };

/** STS will not issue a session of under 15 minutes. */
const STS_MINIMUM_SECONDS = 900;
/** AssumeRole's limit on the inline session policy (plain text characters). The policies here are under a third of it; a bigger one is refused rather than cut. */
const SESSION_POLICY_MAX_CHARACTERS = 2048;

const NOT_SET_UP = "saved environments are not set up on this install";
const REFUSED = "this saved environment call is not one this install makes";
const UNAVAILABLE = "the saved environment registry could not give a session now";

/** `arn:<partition>:iam::<account>:role/agentx/<env>/<name>` (the environment's role path). */
const ROLE_ARN = /^arn:(aws|aws-cn|aws-us-gov):iam::(\d{12}):role\/agentx\/([a-z][a-z0-9-]{0,19})\/(agentx-[a-z][a-z0-9-]{0,19}-img-(?:push|pull|manage))$/u;

export interface SavedEnvRoleSessionSettings {
  env: string;
  partition: string;
  region: string;
  account: string;
  roleArns: Record<SavedEnvAccess, string>;
}

/**
 * The install's settings from its variables, or undefined when saved environments are not set up on it. All of it must hold: the prefix is `rovara-env/<env>`, each ARN is the fixed-name role of that
 * environment under its path, in one account, in one partition. Anything else is "not set up", so a variable that names another role (or another account's) is never used to assume.
 */
export function savedEnvRoleSessionSettings(environment: Readonly<Record<string, string | undefined>>, region: string | undefined): SavedEnvRoleSessionSettings | undefined {
  const prefix = environment[SAVED_ENV_REPO_PREFIX_VARIABLE];
  const arns = { push: environment[SAVED_ENV_PUSH_ROLE_ARN_VARIABLE], pull: environment[SAVED_ENV_PULL_ROLE_ARN_VARIABLE], manage: environment[SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE] };
  if (prefix === undefined || arns.push === undefined || arns.pull === undefined || arns.manage === undefined) return undefined;
  if (region === undefined || !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(region)) return undefined;
  const env = /^rovara-env\/([a-z][a-z0-9-]{0,19})$/u.exec(prefix)?.[1];
  if (env === undefined) return undefined;
  let partition: string | undefined;
  let account: string | undefined;
  for (const access of ["push", "pull", "manage"] as const) {
    const parsed = ROLE_ARN.exec(arns[access]!);
    if (parsed === null || parsed[3] !== env || parsed[4] !== LIMITS[access].roleName(env)) return undefined;
    if ((partition ?? parsed[1]) !== parsed[1] || (account ?? parsed[2]) !== parsed[2]) return undefined;
    partition = parsed[1];
    account = parsed[2];
  }
  return { env, partition: partition!, region, account: account!, roleArns: { push: arns.push, pull: arns.pull, manage: arns.manage } };
}

/** Whether `repository` is a name this install makes for this company: this environment's prefix and this company's hash, any project. Built from the one derivation (`savedEnvRepositoryName`), never a second one. */
function repositoryIsThisCompanys(settings: Pick<SavedEnvRoleSessionSettings, "env">, companyId: string, repository: string): boolean {
  if (!isSavedEnvRepositoryName(repository)) return false;
  let own: string[];
  try { own = savedEnvRepositoryName({ env: settings.env, orgId: companyId, projectId: "-" }).split("/"); } catch { return false; }
  const given = repository.split("/");
  return given[0] === own[0] && given[1] === own[1] && given[2] === own[2];
}

export function createSavedEnvRoleSessions(options: { settings: SavedEnvRoleSessionSettings; assumeRole: SavedEnvAssumeRole; describeRepositories?: SavedEnvDescribeRepositories; now?: () => number }): SavedEnvRoleSessions {
  const { settings } = options;
  const now = options.now ?? Date.now;
  const scope: Scope = { partition: settings.partition, region: settings.region, account: settings.account };
  const describeRepositories = options.describeRepositories ?? realSavedEnvDescribeRepositories(settings.region);

  /** STS, and the answer checked: the one place a session comes from. */
  async function openSession(call: SavedEnvAssumeRoleRequest): Promise<SavedEnvSession> {
    let answer: unknown;
    try {
      answer = await options.assumeRole(call);
    } catch { throw new ImageRegistryError("unavailable", UNAVAILABLE); }
    const credentials = (answer as { Credentials?: { AccessKeyId?: unknown; SecretAccessKey?: unknown; SessionToken?: unknown; Expiration?: unknown } } | undefined)?.Credentials;
    const expiresAtMs = credentials?.Expiration instanceof Date ? credentials.Expiration.getTime() : Number.NaN;
    if (typeof credentials?.AccessKeyId !== "string" || credentials.AccessKeyId === "" || typeof credentials.SecretAccessKey !== "string" || credentials.SecretAccessKey === ""
      || typeof credentials.SessionToken !== "string" || credentials.SessionToken === "" || !Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
      throw new ImageRegistryError("unavailable", UNAVAILABLE);
    }
    return { credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken }, expiresAtMs };
  }

  return {
    async listCompanyRepositories(request) {
      // The company's prefix, from the one derivation; an id that is not text (or an empty one) is refused before STS.
      let companyPrefix: string;
      let policy: string;
      try {
        companyPrefix = savedEnvCompanyRepositoryPrefix({ env: settings.env, orgId: request.companyId });
        policy = JSON.stringify(savedEnvManageListSessionPolicy(scope, { env: settings.env, orgId: request.companyId }));
      } catch { throw new ImageRegistryError("refused", REFUSED); }
      if (policy.length > SESSION_POLICY_MAX_CHARACTERS) throw new ImageRegistryError("refused", REFUSED);
      // The session name is the company's hash segment: CloudTrail ties the listing to a company without its id in it.
      const sessionName = `rovara-img-list-${companyPrefix.split("/")[2]!.slice(0, 25)}`;
      const session = await openSession({ roleArn: settings.roleArns.manage, sessionName, policy, durationSeconds: STS_MINIMUM_SECONDS });
      const own = `${companyPrefix}/`;
      const found = new Set<string>();
      let nextToken: string | undefined;
      const seenTokens = new Set<string>();
      for (let page = 0; page < SAVED_ENV_LIST_MAX_PAGES; page += 1) {
        // A session that ends mid-walk gives a partial list: erase must not see one.
        if (session.expiresAtMs <= now()) throw new ImageRegistryError("unavailable", UNAVAILABLE);
        let answer: unknown;
        try {
          answer = await describeRepositories({ credentials: session.credentials, ...(nextToken === undefined ? {} : { nextToken }), maxResults: SAVED_ENV_LIST_PAGE_SIZE });
        } catch { throw new ImageRegistryError("unavailable", UNAVAILABLE); }
        const body = answer as { repositories?: unknown; nextToken?: unknown } | undefined;
        if (body === undefined || body === null || typeof body !== "object" || (body.repositories !== undefined && !Array.isArray(body.repositories))) throw new ImageRegistryError("unavailable", UNAVAILABLE);
        for (const repository of (body.repositories ?? []) as unknown[]) {
          const name = (repository as { repositoryName?: unknown } | null | undefined)?.repositoryName;
          // Only this company's names leave this function, whatever ECR answered. A name outside the prefix is dropped (the session policy makes it unreachable; this is the second layer).
          if (typeof name === "string" && name.length <= 256 && name.startsWith(own) && name.length > own.length && !name.includes("*") && !name.includes("\u0000")) found.add(name);
        }
        const token = body.nextToken;
        if (token === undefined || token === null || token === "") return [...found].sort();
        // A token that comes back, or is not text, would loop or lose the end of the list.
        if (typeof token !== "string" || seenTokens.has(token)) throw new ImageRegistryError("unavailable", UNAVAILABLE);
        seenTokens.add(token);
        nextToken = token;
      }
      // Still more after the bound: not a list erase can trust.
      throw new ImageRegistryError("unavailable", UNAVAILABLE);
    },
    async assume(request) {
      // An own property only: "constructor" or "toString" is not an access kind.
      const limit = Object.hasOwn(LIMITS, request.access) ? LIMITS[request.access] : undefined;
      if (limit === undefined || !repositoryIsThisCompanys(settings, request.companyId, request.repository)) throw new ImageRegistryError("refused", REFUSED);
      if (request.maxSeconds !== undefined && (!Number.isFinite(request.maxSeconds) || request.maxSeconds <= 0)) throw new ImageRegistryError("refused", REFUSED);
      let policy: string;
      try {
        policy = JSON.stringify(limit.policy(scope, request.repository));
      } catch { throw new ImageRegistryError("refused", REFUSED); }
      if (policy.length > SESSION_POLICY_MAX_CHARACTERS) throw new ImageRegistryError("refused", REFUSED);
      const durationSeconds = Math.max(STS_MINIMUM_SECONDS, Math.min(limit.seconds, Math.floor(request.maxSeconds ?? limit.seconds)));
      // The session name is the project's hash segment: CloudTrail ties a session to a repository without a company or project id in it.
      const sessionName = `rovara-img-${request.access}-${request.repository.split("/")[3]!.slice(0, 25)}`;
      return openSession({ roleArn: settings.roleArns[request.access], sessionName, policy, durationSeconds });
    },
  };
}

/** The real STS call (the broker's own role signs it). Built once per broker; nothing here keeps a credential. */
export function realSavedEnvAssumeRole(region: string): SavedEnvAssumeRole {
  const client = new STSClient({ region });
  return (request) => client.send(new AssumeRoleCommand({ RoleArn: request.roleArn, RoleSessionName: request.sessionName, Policy: request.policy, DurationSeconds: request.durationSeconds }));
}

/** The real ECR call (one DescribeRepositories page), signed with the session's credentials and nothing else. Built per broker; nothing here keeps a credential past the call. */
export function realSavedEnvDescribeRepositories(region: string): SavedEnvDescribeRepositories {
  return async (request) => {
    // A client per call: its credentials are the one session's, and it is dropped with it.
    const client = new ECRClient({ region, credentials: { accessKeyId: request.credentials.accessKeyId, secretAccessKey: request.credentials.secretAccessKey, sessionToken: request.credentials.sessionToken } });
    try {
      return await client.send(new DescribeRepositoriesCommand({ maxResults: request.maxResults, ...(request.nextToken === undefined ? {} : { nextToken: request.nextToken }) }));
    } finally { client.destroy(); }
  };
}

/** What the hosted root builds: the seam from the install's variables, or `undefined` ("saved environments are not set up on this install": the adapter refuses). */
export function savedEnvRoleSessionsFromEnvironment(environment: Readonly<Record<string, string | undefined>>, options: { region?: string; assumeRole?: SavedEnvAssumeRole; describeRepositories?: SavedEnvDescribeRepositories; now?: () => number } = {}): SavedEnvRoleSessions | undefined {
  const region = options.region ?? environment.AWS_REGION;
  const settings = savedEnvRoleSessionSettings(environment, region);
  if (settings === undefined) return undefined;
  return createSavedEnvRoleSessions({ settings, assumeRole: options.assumeRole ?? realSavedEnvAssumeRole(settings.region), ...(options.describeRepositories === undefined ? {} : { describeRepositories: options.describeRepositories }), ...(options.now === undefined ? {} : { now: options.now }) });
}

export const SAVED_ENV_NOT_SET_UP = NOT_SET_UP;
