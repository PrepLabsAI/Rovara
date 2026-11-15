// Hosted wiring (plan v3.2, the staging switch-over): what a deployed install hands the pieces that, on a laptop, the local runtime builds itself. Each builder reads the function's
// environment (never process.env directly, so it can be tested), makes no AWS call when it is built, and answers undefined where the install has not turned the piece on, so an install
// without the setting behaves exactly as before.
//
//   (c) policyHookInstallFromEnvironment: the policy hook's asker (the install's issuer and its question key, purpose `policy-question`; the broker alone may sign with it).
//   (d) companyReadsFromEnvironment: lanes AU and EV's company reads (#649) on the State table, the company resolved from membership (R4's reader), never from a claim;
//       auditSinkForDeployedCaller: every engine audit event names the caller it came through (`auditViaCaller`).
//   (e) hostedNightlyCompany: T8's nightly company check, bound to the consumer's own company and required.
//   (f) hostedSessionCapSeconds: the install's session cap (a developer session's length), for CoreDevWiring.sessionCapSeconds.
//
// The deployed core's composition root (R2's broker mount) takes (c), (e), (f) and the audit wrapper from here when it lands; (d)'s routes are wired into the broker's handler now.
import { AUDIT_VIA_PATTERN, DEVELOPER_SESSION_SECONDS, OrgIdSchema, type AuditSink, type DocumentStore, type OrgId } from "@agentx/contracts";
import { createDynamoStoreFromSettings } from "@rovara/aws-adapters/dynamodb";
import { auditViaCaller } from "../core/audit-read/index.js";
import type { TestEnvDeps } from "../core/test-env/deps.js";
import { createProjectCompanyResolver } from "../core/test-env/nightly-wiring.js";
import type { PolicyHookInstall } from "../core/policy-hook/index.js";
import type { CompanyReadsConfiguration } from "../developer/company-reads.js";
export type { CompanyReadsConfiguration } from "../developer/company-reads.js";
import { kmsTokenSigner } from "../developer/tokens.js";
import { companyMembershipFromDynamo } from "./company-check.js";

type KmsSender = Parameters<typeof kmsTokenSigner>[0]["kms"];
type DynamoSender = { send(command: unknown): Promise<unknown> };

/**
 * (c) The policy hook's asker: the install's sign-in issuer (DEVELOPER_TOKEN_ISSUER, its install id, as in the task token) and a KMS signer over POLICY_HOOK_KEY_ARN, the key the sign-in
 * server publishes with purpose `policy-question`. Undefined when either is missing: an install that sets a policy address without them does not start (`applyPolicyHook`).
 */
export function policyHookInstallFromEnvironment(env: NodeJS.ProcessEnv, kms: KmsSender): PolicyHookInstall | undefined {
  const issuer = env.DEVELOPER_TOKEN_ISSUER ?? "";
  const keyId = env.POLICY_HOOK_KEY_ARN ?? "";
  if (issuer === "" || keyId === "") return undefined;
  return { issuer, signer: kmsTokenSigner({ kms, keyId }) };
}

/** (f) The install's session cap in seconds: no token made on the deployed API outlives a developer session (DEVELOPER_SESSION_SECONDS, what the sign-in server gives every session). */
export function hostedSessionCapSeconds(): number {
  return DEVELOPER_SESSION_SECONDS;
}

/**
 * (d) The company reads, where the install turns them on (COMPANY_READS=enabled, named environments). The rows are the core's, in the State table (STATE_TABLE_NAME), read through
 * the same store the core writes with; only `query` is handed on. The company is the caller's membership (`COMPANY_MEMBER#<person>` in the sign-in table, DEVELOPER_SIGNIN_TABLE_NAME):
 * a person with none, or a read that fails, is refused. A missing table name builds nothing (the routes answer NOT_FOUND) rather than a reader that cannot work.
 */
export function companyReadsFromEnvironment(env: NodeJS.ProcessEnv, clients: { dynamo: DynamoSender; documentClient: DynamoSender }): CompanyReadsConfiguration | undefined {
  if (env.COMPANY_READS !== "enabled") return undefined;
  const stateTable = env.STATE_TABLE_NAME ?? "";
  const signInTable = env.DEVELOPER_SIGNIN_TABLE_NAME ?? "";
  if (stateTable === "" || signInTable === "") return undefined;
  let store: DocumentStore | undefined;
  const storeOnce = (): DocumentStore => (store ??= createDynamoStoreFromSettings({ tableName: stateTable, ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }) }, clients.dynamo));
  const membership = companyMembershipFromDynamo(clients.documentClient, signInTable);
  return {
    store: { query: (query) => storeOnce().query(query) },
    companyOf: (developerId) => membership.companyOf(developerId),
  };
}

/** The deployed callers' word in an audit event's `via`: the Rovara CLI (no sign-in client), or `client:<its id>`. A client id that is not a short lower-case word is `client`. */
export function deployedAuditVia(caller: { client?: string | undefined }): string {
  if (caller.client === undefined) return "cli";
  const via = `client:${caller.client}`;
  return AUDIT_VIA_PATTERN.test(via) ? via : "client";
}

/** (d) The engine's audit sink for one request: every event it stages or records names the caller it came through. */
export function auditSinkForDeployedCaller(sink: AuditSink, caller: { client?: string | undefined }): AuditSink {
  return auditViaCaller(sink, deployedAuditVia(caller));
}

/**
 * (e) T8's nightly company check for one consumer company's runtime: required (a missing resolver refuses), and bound to that company. The stored project is read by the host's own
 * lookup; it resolves to the consumer only when the record is the consumer's, so a fire for a project the record gives to another company, or with no record, is refused.
 */
export function hostedNightlyCompany(consumerCompanyId: string, readProject: (project: string) => Promise<Readonly<Record<string, unknown>> | undefined>): Required<Pick<TestEnvDeps, "projectCompany" | "projectCompanyRequired">> {
  const parsed = OrgIdSchema.safeParse(consumerCompanyId);
  if (!parsed.success) throw new Error("the nightly company check needs the consumer's company id");
  const consumer: OrgId = parsed.data;
  const resolve = createProjectCompanyResolver(readProject);
  return {
    projectCompanyRequired: true,
    projectCompany: async (project) => ((await resolve(project)) === consumer ? consumer : undefined),
  };
}
