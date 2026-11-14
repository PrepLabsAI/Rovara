// Production deny list (design proof-test-env, section 4.7): a test environment refuses to point at anything the company has marked as production. The matchers here are pure and shared by the broker (which
// refuses an environment at approval) and the verifier (which refuses a fixture, a seed or a sample that names production at run time), so both read the list the same way.
//
// Fail closed:
//   - an environment that reaches a real remote (pre-prod, a shared environment, a preview stack, an account hook) with an EMPTY deny list is refused: "list production first";
//   - hosts are compared case-insensitively and a leading `*.` matches any subdomain (not the bare domain: list both to cover both);
//   - an ARN is production when it starts with a listed prefix or when its account field is a listed account.
// Nothing here is node-only.
import type { TestEnvironmentBody } from "./test-environment.js";

export interface TestEnvProdDeny {
  accountIds: readonly string[];
  hosts: readonly string[];
  arnPrefixes: readonly string[];
}

/** What a deny-list check found: a fixed code and the field it was found in (a path into the environment), never the value. */
export type TestEnvProdDenyViolation = { kind: "prod_host" | "prod_arn" | "prod_account" | "prod_deny_missing"; field: string };

export function prodDenyIsEmpty(deny: TestEnvProdDeny): boolean {
  return deny.accountIds.length === 0 && deny.hosts.length === 0 && deny.arnPrefixes.length === 0;
}

// ONE matcher for the whole product (the schema, the broker's store, pre-prod access, the data guard):
//   hosts: lower-cased, trailing dots removed, then compared with the entry as an anchored glob where `*` is any run of host characters. `*.prod.example.com` therefore covers every subdomain but not the bare
//          domain (list both to cover both). A host that is empty or not plain host characters is treated as production (when in doubt, it is).
//   ARNs:  an entry is a PREFIX, case-insensitive, where `*` is any run of characters (`arn:aws:sagemaker:*:111122223333:endpoint/*`). A wildcard can only widen what is denied, so a mistake errs on the side of refusing.
//   An ARN is also production when its account field is a listed account.
const escapeRegExp = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");

/** A host as it is compared: lower case, no trailing dots. Undefined when it is not plain host characters. */
export function normalizeDenyHost(host: string): string | undefined {
  const name = host.trim().toLowerCase().replace(/\.+$/u, "");
  return name !== "" && /^[a-z0-9.-]+$/u.test(name) ? name : undefined;
}

/** The host part of a URL (userinfo, port, path and trailing dot dropped), or undefined when the text is not a URL with a host. */
export function hostOfUrl(url: string): string | undefined {
  try {
    return normalizeDenyHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

function hostPattern(entry: string): RegExp | undefined {
  const pattern = entry.trim().toLowerCase().replace(/\.+$/u, "");
  if (pattern === "" || !/^[a-z0-9.*-]+$/u.test(pattern)) return undefined;
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[a-z0-9.-]*")}$`, "u");
}

/** Whether a host is on the list. An empty or malformed host counts as a match. */
export function prodDenyMatchesHost(deny: TestEnvProdDeny, host: string): boolean {
  const name = normalizeDenyHost(host);
  if (name === undefined) return true;
  return deny.hosts.some((entry) => hostPattern(entry)?.test(name) === true);
}

export function prodDenyMatchesAccount(deny: TestEnvProdDeny, accountId: string): boolean {
  return deny.accountIds.includes(accountId);
}

/** The account field of an ARN (`arn:aws:iam::123456789012:role/x`), or undefined when the text is not an ARN with one. */
export function arnAccountId(arn: string): string | undefined {
  const parts = arn.split(":");
  const account = parts[4];
  return parts[0] === "arn" && parts.length >= 6 && account !== undefined && /^\d{12}$/u.test(account) ? account : undefined;
}

function arnPrefixPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix.split("*").map(escapeRegExp).join(".*")}`, "iu");
}

export function prodDenyMatchesArn(deny: TestEnvProdDeny, arn: string): "prod_arn" | "prod_account" | undefined {
  if (deny.arnPrefixes.some((prefix) => arnPrefixPattern(prefix).test(arn))) return "prod_arn";
  const account = arnAccountId(arn);
  return account !== undefined && prodDenyMatchesAccount(deny, account) ? "prod_account" : undefined;
}

/**
 * A Cognito user pool carries no account in its id, so it is checked as the ARN it would have under each account the deny list knows (the listed accounts, and the account of each ARN entry) and under none: the
 * region-wide and account-wide entries (`arn:aws:cognito-idp:us-east-1:111122223333:`, `arn:aws:cognito-idp:*:*:userpool/`) all apply.
 */
export function prodDenyMatchesPool(deny: TestEnvProdDeny, region: string, poolId: string): boolean {
  const accounts = new Set<string>(["", ...deny.accountIds]);
  for (const prefix of deny.arnPrefixes) {
    const account = prefix.split(":")[4];
    if (account !== undefined && /^\d{12}$/u.test(account)) accounts.add(account);
  }
  for (const account of accounts) {
    const arn = `arn:aws:cognito-idp:${region}:${account}:userpool/${poolId}`;
    if (deny.arnPrefixes.some((prefix) => arnPrefixPattern(prefix).test(arn))) return true;
  }
  return false;
}

/** Every address, ARN and account the environment would reach for real, with the field it is in. The sandbox's own mocks and local seeds are not here. */
function reachedRemotes(env: TestEnvironmentBody): Array<{ field: string; host?: string; arn?: string; pool?: string; region?: string }> {
  const remotes: Array<{ field: string; host?: string; arn?: string; pool?: string; region?: string }> = [];
  env.services.forEach((service, index) => {
    const preprod = service.preprod;
    if (preprod === undefined) return;
    const base = `services[${String(index)}].preprod`;
    if (preprod.url !== undefined) remotes.push({ field: `${base}.url`, host: hostOfUrl(preprod.url) ?? "" });
    if (preprod.endpointArn !== undefined) remotes.push({ field: `${base}.endpointArn`, arn: preprod.endpointArn });
    if (preprod.roleArn !== undefined) remotes.push({ field: `${base}.roleArn`, arn: preprod.roleArn });
  });
  env.accounts.forEach((account, index) => {
    const base = `accounts[${String(index)}]`;
    if (account.provisioner === "cognito_test_pool") remotes.push({ field: `${base}.roleArn`, arn: account.roleArn });
    if (account.provisioner === "http_hook") {
      remotes.push({ field: `${base}.createUrl`, host: hostOfUrl(account.createUrl) ?? "" }, { field: `${base}.deleteUrl`, host: hostOfUrl(account.deleteUrl) ?? "" });
    }
  });
  env.accounts.forEach((account, index) => {
    // A pool id carries no account, so a pool is production when the deny list names its resource (`...:userpool/<id>`) in an ARN prefix.
    if (account.provisioner === "cognito_test_pool") remotes.push({ field: `accounts[${String(index)}].userPoolId`, pool: account.userPoolId, region: account.region });
  });
  if (env.preview !== undefined) remotes.push({ field: "preview.deployRoleArn", arn: env.preview.deployRoleArn });
  if (env.shared !== undefined) remotes.push({ field: "shared.baseUrl", host: hostOfUrl(env.shared.baseUrl) ?? "" });
  return remotes;
}

/**
 * Everything in the environment that names production, or `prod_deny_missing` when the environment reaches a remote and the company has not listed production at all. An environment that touches
 * no remote (the sandbox with mocks only) needs no list. Empty array: the environment may be approved as far as this check goes.
 */
export function testEnvProdDenyViolations(env: TestEnvironmentBody, alsoDeny?: TestEnvProdDeny): TestEnvProdDenyViolation[] {
  const remotes = reachedRemotes(env);
  if (remotes.length === 0) return [];
  if (prodDenyIsEmpty(env.prodDeny)) return [{ kind: "prod_deny_missing", field: "prodDeny" }];
  // `alsoDeny` is the list the approved environment had: removing a production entry in the same change that points at it must not hide it.
  const lists = alsoDeny === undefined ? [env.prodDeny] : [env.prodDeny, alsoDeny];
  const found: TestEnvProdDenyViolation[] = [];
  for (const remote of remotes) {
    if (remote.host !== undefined && lists.some((deny) => prodDenyMatchesHost(deny, remote.host as string))) found.push({ kind: "prod_host", field: remote.field });
    if (remote.pool !== undefined) {
      const pool = remote.pool;
      if (lists.some((deny) => prodDenyMatchesPool(deny, remote.region ?? "", pool))) found.push({ kind: "prod_arn", field: remote.field });
      continue;
    }
    if (remote.arn !== undefined) {
      const kind = lists.map((deny) => prodDenyMatchesArn(deny, remote.arn as string)).find((match) => match !== undefined);
      if (kind !== undefined) found.push({ kind, field: remote.field });
    }
  }
  return found;
}
