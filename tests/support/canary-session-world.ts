// tests/support/canary-session-world.ts
// The canary session function over the wire-level fake table: the real stores, the real KMS signer over a fake KMS, and the people a real GitHub sign-in and invite leave behind
// (one company, its admin, and the canary person as its only plain member). Shared by canary-session.test.ts and canary-session-infrastructure.test.ts.
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import type { DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { CanaryMintStore, createCanarySession, type CanarySessionConfig, type CanarySessionDependencies } from "../../packages/broker/src/developer/canary-session.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { GITHUB_ISSUER } from "../../packages/broker/src/developer/providers.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { expect } from "vitest";
import { ISSUER, localSigner, T0 } from "./developer-fakes.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

export const COMPANY = "org_canaryco0000000000a1";
export const OTHER_COMPANY = "org_otherco000000000000b2";
export const CANARY = ownerKeyForSubject(GITHUB_ISSUER, "canary-bot");
export const OWNER = ownerKeyForSubject(GITHUB_ISSUER, "canary-owner");
export const ENV = "beta-test";
export const TABLE = "signin";
export const CONFIG: CanarySessionConfig = { developerId: CANARY, companyId: COMPANY, issuer: ISSUER, environment: ENV };
export const SECONDS = (ms: number) => Math.floor(ms / 1000);

export interface World {
  db: FakeDynamoDb; clock: { now: number }; store: DeveloperSignInStore; company: CompanySignInStore; counter: CanaryMintStore; logs: Array<Record<string, unknown>>;
  deps: CanarySessionDependencies; run: (event: unknown) => Promise<unknown>; signer: ReturnType<typeof localSigner>; routes: DeveloperRouteDependencies;
}

/** `wrap`: the document client the function itself uses (to run it under an IAM policy); seeding and the broker-side checks use the table directly. */
export async function world(options: { config?: CanarySessionConfig | undefined; seed?: boolean; wrap?: (db: FakeDynamoDb) => { send(command: never): Promise<unknown> } } = {}): Promise<World> {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const now = () => clock.now;
  const seeding = new DeveloperSignInStore({ documentClient: db, tableName: TABLE, now });
  const seedingCompany = new CompanySignInStore({ documentClient: db, tableName: TABLE, now });
  const client = options.wrap === undefined ? db : options.wrap(db);
  const store = new DeveloperSignInStore({ documentClient: client, tableName: TABLE, now });
  const company = new CompanySignInStore({ documentClient: client, tableName: TABLE, now });
  const counter = new CanaryMintStore({ documentClient: client, tableName: TABLE, now });
  const logs: Array<Record<string, unknown>> = [];
  const signer = localSigner();
  const deps: CanarySessionDependencies = { config: "config" in options ? options.config : CONFIG, store, company, counter, signer, now, log: (entry) => logs.push(entry) };
  const routes: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now, companies: companyMembershipFromDynamo(db, TABLE),
    developer: { issuer: ISSUER, env: ENV, methods: { slack: false, oidc: false, github: true }, signInTableName: TABLE, verifyAccessToken: async () => ({}), channelMembers: async (r: { channelIds: string[] }) => ({ ok: true, memberOf: r.channelIds }) },
  } as unknown as DeveloperRouteDependencies;
  if (options.seed !== false) {
    // The people the owner's real GitHub sign-in and invite make: one company, its admin, and the canary person as its only plain member.
    await seedingCompany.create(COMPANY, "Canary company", "owner@example.test", 24);
    await seeding.upsertDeveloper({ developerId: OWNER, provider: "github", issuer: GITHUB_ISSUER, subject: "canary-owner", displayName: "Owner" }, COMPANY, { unmerged: true });
    await seeding.upsertDeveloper({ developerId: CANARY, provider: "github", issuer: GITHUB_ISSUER, subject: "canary-bot", displayName: "Canary" }, COMPANY, { unmerged: true });
    expect((await seedingCompany.join({ personId: OWNER, companyId: COMPANY, email: "owner@example.test" })).ok).toBe(true);
    await seedingCompany.preapprove(COMPANY, "canary@example.test", "member", 24);
    expect((await seedingCompany.join({ personId: CANARY, companyId: COMPANY, email: "canary@example.test" })).ok).toBe(true);
  }
  return { db, clock, store, company, counter, logs, deps, run: createCanarySession(deps), signer, routes };
}

