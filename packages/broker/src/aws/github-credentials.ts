// The GitHub App credentials as the broker and the plan evidence job build them: one definition, from the same environment
// (GITHUB_APP_CREDENTIAL_REF, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN) and the same secret.
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AgentXError, agentXError, companyScoped, GITHUB_DISCONNECTED_MESSAGE, IMPLICIT_COMPANY_ID, OrgIdSchema, REPOSITORY_ACCESS_STATES, type ClientRepositoriesResponse, type RepositoryAccessState } from "@agentx/contracts";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { boundedCompanyReads } from "./company-check.js";
import { isConditional } from "./broker-shared.js";
import { appIdFromSecret, GitHubAppCredentialProvider, isWebhookSecretMissing, privateKeyFromSecret, webhookSecretFromSecret } from "../github-app.js";
import { requiredEnvironment } from "./lambda.js";

export interface GitHubAppCredentials {
  provider: GitHubAppCredentialProvider;
  /** The secret's ARN, for the connector credential registry. */
  privateKeySecretArn: string;
  /**
   * Reads the GitHub webhook HMAC key from the same secret. A copy with no valid key, or `refresh: true`, re-reads the
   * secret (at most once per REREAD_INTERVAL_MS per container), so a key added or changed after the container started is
   * picked up without a redeploy.
   */
  webhookSecret: (options?: { refresh?: boolean }) => Promise<string>;
  /**
   * Core switch-on lane L1b: the same App's settings for the full App client the core's code host is built on (aws/core-code-host.ts), reading the same secret through the same
   * loaders (one read per container, re-read after a failure), so the core and the broker never hold two copies of the App.
   */
  clientOptions: { credentialRef: string; appId: string | (() => Promise<string>); getPrivateKey: () => Promise<string>; getAppSecret: (options?: { refresh?: boolean }) => Promise<string> };
}

const REREAD_INTERVAL_MS = 30_000;

export function createGitHubAppCredentials(secretsManager: Pick<SecretsManagerClient, "send">): GitHubAppCredentials {
  const privateKeySecretArn = requiredEnvironment("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
  const appIdSetting = process.env.GITHUB_APP_ID ?? "";
  let appSecret: Promise<string> | undefined;
  const loadSecret = (): Promise<string> => {
    appSecret ??= secretsManager.send(new GetSecretValueCommand({
      SecretId: privateKeySecretArn,
    })).then((response) => {
      const secret = response.SecretString ?? (
        response.SecretBinary === undefined
          ? undefined
          : Buffer.from(response.SecretBinary).toString("utf8")
      );
      if (!secret) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty");
      return secret;
    }).catch((error: unknown) => {
      appSecret = undefined;
      // The secret has no version until `agentx init` creates the GitHub App.
      if (error instanceof Error && error.name === "ResourceNotFoundException") {
        throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty; finish agentx init to create the GitHub App");
      }
      throw error;
    });
    return appSecret;
  };
  let app: Promise<{ appId: string; privateKey: string }> | undefined;
  const loadApp = (): Promise<{ appId: string; privateKey: string }> => {
    app ??= loadSecret().then((secret) => ({
      appId: appIdSetting !== "" ? appIdSetting : appIdFromSecret(secret),
      privateKey: privateKeyFromSecret(secret),
    })).catch((error: unknown) => {
      app = undefined;
      throw error;
    });
    return app;
  };
  // Forced re-reads are spaced out so a stream of unsigned requests cannot hammer Secrets Manager.
  let lastReread: number | undefined;
  const reread = (): Promise<string> => {
    const now = Date.now();
    if (lastReread === undefined || now - lastReread >= REREAD_INTERVAL_MS) {
      lastReread = now;
      appSecret = undefined;
      app = undefined;
    }
    return loadSecret();
  };
  const clientOptions: GitHubAppCredentials["clientOptions"] = {
    credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"),
    appId: appIdSetting !== "" ? appIdSetting : async () => (await loadApp()).appId,
    getPrivateKey: () => loadSecret().then(privateKeyFromSecret),
    getAppSecret: (options) => (options?.refresh === true ? reread() : loadSecret()),
  };
  const provider = new GitHubAppCredentialProvider({
    credentialRef: clientOptions.credentialRef,
    appId: clientOptions.appId,
    getPrivateKey: clientOptions.getPrivateKey,
  });
  const webhookSecret = async (options?: { refresh?: boolean }): Promise<string> => {
    if (options?.refresh === true) return webhookSecretFromSecret(await reread());
    try {
      return webhookSecretFromSecret(await loadSecret());
    } catch (error) {
      if (isWebhookSecretMissing(error)) return webhookSecretFromSecret(await reread());
      throw error;
    }
  };
  return { provider, privateKeySecretArn, webhookSecret, clientOptions };
}


// T5 lives in this existing module until the public port guard permits new AWS files.
const bindingKey = (installationId: number) => ({ pk: `GITHUB_INSTALLATION#${installationId}`, sk: "BINDING" });
const backfillKey = { pk: "GITHUB_INSTALLATION_BINDING", sk: "BACKFILL" };
const installationIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bindingText = z.string().min(1).max(256);
const installationSchema = z.object({ installationId: installationIdSchema, accountLogin: bindingText });
/** Guided onboarding PR 3: an installation's state as GitHub's webhook last said (absent on a row written before: active). */
export const InstallationStateSchema = z.enum(["active", "suspended", "uninstalled"]);
export type InstallationState = z.infer<typeof InstallationStateSchema>;
const bindingSchema = installationSchema.extend({
  entityType: z.literal("GITHUB_INSTALLATION_BINDING"), companyId: OrgIdSchema,
  boundAt: z.iso.datetime(), boundBy: bindingText,
  state: InstallationStateSchema.optional(), stateAt: z.iso.datetime().optional(), accountType: z.enum(["User", "Organization"]).optional(),
});
const markerSchema = z.object({ pk: z.literal("GITHUB_INSTALLATION_BINDING"), sk: z.literal("BACKFILL") }).strict();
/** Guided onboarding PR 1: the company's own list of the installations bound to it (written in the binding's transaction), for its Connections read. */
export const companyInstallationKey = (companyId: string, installationId: number) => ({ pk: `ORG#${companyId}#GITHUB_INSTALLATIONS`, sk: `INSTALLATION#${installationId}` });
const companyInstallationRow = (companyId: string, row: { installationId: number; accountLogin: string; boundAt: string; boundBy: string }) => ({
  ...companyInstallationKey(companyId, row.installationId), entityType: "GITHUB_COMPANY_INSTALLATION", companyId,
  installationId: row.installationId, accountLogin: row.accountLogin, boundAt: row.boundAt, boundBy: row.boundBy,
});
const companyInstallationSchema = z.object({ entityType: z.literal("GITHUB_COMPANY_INSTALLATION"), companyId: OrgIdSchema, installationId: installationIdSchema,
  accountLogin: bindingText, boundAt: z.iso.datetime(), boundBy: bindingText });
/**
 * DEC 254zc(1): a repository GitHub says is no longer the company's to reach (moved to another owner, or taken off the App's repository list). One row per company and full name, in the
 * company's own partition (ORG#<company>#GITHUB_REPOSITORY_MOVED / REPO#<lowercase owner/name>), written only by a verified `installation_repositories` or `repository` webhook for an installation
 * that company holds. The project setup-status read puts it on the repos row. Nothing here carries a token, a payload or a person's words.
 */
export const repositoryFullName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(300);
export const repositoryMovedKey = (companyId: string, fullName: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "GITHUB_REPOSITORY_MOVED"), sk: `REPO#${repositoryFullName.parse(fullName).toLowerCase()}` });
const repositoryMovedSchema = z.object({ entityType: z.literal("GITHUB_REPOSITORY_MOVED"), companyId: OrgIdSchema, fullName: repositoryFullName, reason: z.enum(REPOSITORY_ACCESS_STATES),
  installationId: installationIdSchema, at: z.iso.datetime(), deliveryId: z.string().regex(/^[0-9a-f-]{36}$/) });
/** At most this many repositories one webhook delivery may name; more refuses the whole delivery (never a part of it). */
export const REPOSITORY_MOVES_MAX = 100;
/**
 * Which of `fullNames` the company has marked, as a map of lowercase name to reason. Each name is one consistent read of this company's own key; a row that names another company, another
 * name or is not a mark is unreadable (throws), never applied.
 */
export async function readRepositoryMoves(client: { send(command: unknown): Promise<unknown> }, tableName: string, companyId: string, fullNames: readonly string[]): Promise<Map<string, RepositoryAccessState>> {
  const found = new Map<string, RepositoryAccessState>();
  for (const name of new Set(fullNames.map((entry) => entry.toLowerCase()))) {
    const item = (await client.send(new GetCommand({ TableName: tableName, Key: repositoryMovedKey(companyId, name), ConsistentRead: true })) as { Item?: unknown }).Item;
    if (item === undefined) continue;
    const row = repositoryMovedSchema.parse(item);
    if (row.companyId !== companyId || row.fullName.toLowerCase() !== name) throw agentXError("RUNTIME_UNAVAILABLE", "repository state unavailable");
    found.set(name, row.reason);
  }
  return found;
}
/** At most this many installations are listed for one company; more refuses the whole read. */
export const COMPANY_INSTALLATIONS_MAX = 100;
const PersonIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type PersonClaimOutcome = "bound" | "already_bound" | "reconnected" | "taken";
export function githubBindingRefusal() { return agentXError("GITHUB_NOT_CONNECTED", "the GitHub installation is not connected"); }
/** Guided onboarding PR 3: the refusal for the company's OWN installation that GitHub says is uninstalled or suspended. Never said about another company's. */
export function githubDisconnectedRefusal() { return agentXError("GITHUB_NOT_CONNECTED", GITHUB_DISCONNECTED_MESSAGE); }
export function isGithubDisconnected(error: unknown): boolean { return error instanceof AgentXError && error.code === "GITHUB_NOT_CONNECTED" && error.message.endsWith(GITHUB_DISCONNECTED_MESSAGE); }
/** What GitHub's webhook said happened to an installation, and the state each moves a binding from and to. An uninstalled binding moves again only by a claim. */
export const LIFECYCLE_TRANSITIONS = {
  deleted: { from: ["active", "suspended"], to: "uninstalled" },
  suspend: { from: ["active"], to: "suspended" },
  unsuspend: { from: ["suspended"], to: "active" },
} as const satisfies Record<string, { from: readonly InstallationState[]; to: InstallationState }>;
export type LifecycleAction = keyof typeof LIFECYCLE_TRANSITIONS;
export type LifecycleOutcome = { outcome: "unbound" } | { outcome: "unchanged"; companyId: string } | { outcome: "marked"; companyId: string; from: InstallationState; to: InstallationState };
export type DisconnectOutcome = { outcome: "not_found" } | { outcome: "disconnected"; accountLogin: string; accountType?: "User" | "Organization" };
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stateOf = (row: { state?: InstallationState | undefined }): InstallationState => row.state ?? "active";
/** The condition that the binding is still exactly what was read: same company, same bind, same state. */
function sameBinding(row: { companyId: string; boundAt: string; state?: InstallationState | undefined }) {
  return {
    ConditionExpression: `companyId = :company AND boundAt = :boundAt AND ${row.state === undefined ? "attribute_not_exists(#state)" : "#state = :read"}`,
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: { ":company": row.companyId, ":boundAt": row.boundAt, ...(row.state === undefined ? {} : { ":read": row.state }) },
  };
}

/** Operator writers, plus claimPerson (guided onboarding PR 1: the GitHub connect routes, after the person proved control on GitHub). No HTTP path calls claim. The host owns
 * I/O cancellation; one joined budget checks every await, without detached writes. */
export class GithubInstallationBindings {
  constructor(private readonly client: { send(command: unknown): Promise<unknown> }, private readonly tableName: string, private readonly clock: () => number = Date.now) {}

  withBudget(budget: ReturnType<typeof boundedCompanyReads>): GithubInstallationBindings {
    return new GithubInstallationBindings({ send: (command) => budget.read(() => this.client.send(command)) }, this.tableName, this.clock);
  }

  private async run<T>(work: (send: (command: unknown) => Promise<{ Item?: unknown }>, check: () => void) => Promise<T>): Promise<T> {
    const started = this.clock(); let commands = 0; let bytes = 0;
    const check = () => { if (this.clock() - started > 10_000 || commands > 304 || bytes > 1_000_000) throw githubBindingRefusal(); };
    const send = async (command: unknown) => {
      commands++; check();
      const response = await this.client.send(command) as { Item?: unknown };
      bytes += Buffer.byteLength(JSON.stringify(response) ?? ""); check(); return response;
    };
    try { return await work(send, check); } catch { throw githubBindingRefusal(); }
  }

  private async marker(send: (command: unknown) => Promise<{ Item?: unknown }>): Promise<boolean> {
    const response = await send(new GetCommand({ TableName: this.tableName, Key: backfillKey, ConsistentRead: true }));
    if (response.Item === undefined) return false;
    markerSchema.parse(response.Item); return true;
  }

  private async binding(send: (command: unknown) => Promise<{ Item?: unknown }>, installationId: number) {
    const response = await send(new GetCommand({ TableName: this.tableName, Key: bindingKey(installationId), ConsistentRead: true }));
    if (response.Item === undefined) return undefined;
    const row = bindingSchema.parse(response.Item);
    if (row.installationId !== installationId) throw githubBindingRefusal();
    return row;
  }

  async ownerOf(installationId: number): Promise<string | undefined> {
    return this.run(async (send) => {
      installationIdSchema.parse(installationId);
      const row = await this.binding(send, installationId);
      if (row !== undefined) return row.companyId;
      return await this.marker(send) ? undefined : IMPLICIT_COMPANY_ID;
    });
  }

  /** A list shares the backfill marker and the store's total command/byte/time budget. */
  async ownersOf(installationIds: number[]): Promise<Array<string | undefined>> {
    return this.run(async (send) => {
      const ids = z.array(installationIdSchema).max(100).parse(installationIds);
      let marker: Promise<boolean> | undefined;
      const owners: Array<string | undefined> = [];
      for (const id of ids) {
        const row = await this.binding(send, id);
        if (row !== undefined) owners.push(row.companyId);
        else { marker ??= this.marker(send); owners.push(await marker ? undefined : IMPLICIT_COMPANY_ID); }
      }
      return owners;
    });
  }

  /** The owner and state of an installation: its binding's, or (no binding) the implicit company's before backfill and nobody's after. */
  private async ownerAndState(installationId: number): Promise<{ owner: string | undefined; state: InstallationState }> {
    return this.run(async (send) => {
      installationIdSchema.parse(installationId);
      const row = await this.binding(send, installationId);
      if (row !== undefined) return { owner: row.companyId, state: stateOf(row) };
      return { owner: await this.marker(send) ? undefined : IMPLICIT_COMPANY_ID, state: "active" as const };
    });
  }

  /**
   * Before every mint for a company: the installation must be bound to it, and (guided onboarding PR 3) active. The company's own uninstalled or suspended
   * installation gets the one clear sentence (GITHUB_DISCONNECTED_MESSAGE); everything else, another company's included, the one fixed refusal.
   */
  readonly requireBound = async (companyId: string, installationId: number, _repository?: { owner: string; name: string }): Promise<void> => {
    void _repository;
    if (!OrgIdSchema.safeParse(companyId).success) throw githubBindingRefusal();
    const { owner, state } = await this.ownerAndState(installationId);
    if (owner !== companyId) throw githubBindingRefusal();
    if (state !== "active") throw githubDisconnectedRefusal();
  };

  /**
   * Guided onboarding PR 3: whether a repository owner's only connection for `companyId` is one GitHub said is uninstalled or suspended (so a repository GitHub no longer
   * shows the App is the company's disconnected GitHub, not an unknown one). False when any of the company's bindings for that owner is active, or none names it.
   */
  async disconnectedFor(companyId: string, owner: string): Promise<boolean> {
    const rows = await this.companyInstallations(companyId);
    const named = rows.filter((row) => row.accountLogin.toLowerCase() === owner.toLowerCase());
    return named.length > 0 && named.every((row) => row.state !== "active");
  }

  /**
   * Guided onboarding PR 3: GitHub's signed webhook says an installation was uninstalled, suspended or unsuspended. The binding (whichever company holds it, found by the
   * installation id alone) moves state with one conditional transaction, on exactly what was read, with an audit row (actor "github", keyed by the delivery so a redelivery of
   * a processed event changes nothing). Nothing is deleted. An unbound installation is left alone; an uninstalled one moves again only by a claim.
   */
  async markLifecycle(installationId: number, action: LifecycleAction, deliveryId: string, accountLogin?: string): Promise<LifecycleOutcome> {
    return this.run(async (send) => {
      installationIdSchema.parse(installationId);
      if (accountLogin !== undefined) bindingText.parse(accountLogin);
      if (!DELIVERY.test(deliveryId) || !Object.hasOwn(LIFECYCLE_TRANSITIONS, action)) throw githubBindingRefusal();
      const transition = LIFECYCLE_TRANSITIONS[action];
      const auditKey = { pk: `GITHUB_INSTALLATION#${installationId}`, sk: `AUDIT#LIFECYCLE#${deliveryId.toLowerCase()}` };
      for (let attempt = 0; attempt < 2; attempt++) {
        const row = await this.binding(send, installationId);
        if (row === undefined) return { outcome: "unbound" };
        // The event must name the account the binding was made for (a body signed for another event, replayed under this header, names none or another).
        if (accountLogin !== undefined && accountLogin.toLowerCase() !== row.accountLogin.toLowerCase()) return { outcome: "unchanged", companyId: row.companyId };
        const done = await send(new GetCommand({ TableName: this.tableName, Key: auditKey, ConsistentRead: true }));
        const from = stateOf(row);
        if (done.Item !== undefined || !(transition.from as readonly InstallationState[]).includes(from)) return { outcome: "unchanged", companyId: row.companyId };
        const at = new Date(this.clock()).toISOString();
        const fence = sameBinding(row);
        try {
          await send(new TransactWriteCommand({ TransactItems: [
            { Update: { TableName: this.tableName, Key: bindingKey(installationId), UpdateExpression: "SET #state = :to, stateAt = :at", ...fence,
              ExpressionAttributeValues: { ...fence.ExpressionAttributeValues, ":to": transition.to, ":at": at } } },
            { Put: { TableName: this.tableName, Item: { ...auditKey, entityType: "GITHUB_INSTALLATION_LIFECYCLE_AUDIT", installationId, companyId: row.companyId,
              action, from, to: transition.to, at, actor: "github", deliveryId: deliveryId.toLowerCase() }, ConditionExpression: "attribute_not_exists(pk)" } },
          ] }));
          return { outcome: "marked", companyId: row.companyId, from, to: transition.to };
        } catch (error) {
          if (!isConditional(error)) throw error;
        }
      }
      throw githubBindingRefusal();
    });
  }

  /**
   * DEC 254zc(1): GitHub's signed webhook says repositories left this installation (`installation_repositories` removed: reason "removed") or moved to another owner (`repository`
   * transferred: reason "transferred"). The company is the installation's, found by the installation id alone (its binding; before the backfill marker, the implicit company), so one
   * company's event never marks another's. Each name gets one mark in the company's own partition; a "removed" never replaces a "transferred" (the more exact word stays). When the
   * event names the installation's account (`accountLogin`) it must be the binding's, else nothing is written (a body signed for another event, replayed). An unbound installation
   * writes nothing. More than REPOSITORY_MOVES_MAX names refuses the whole delivery.
   */
  async markRepositories(installationId: number, moves: ReadonlyArray<{ fullName: string; reason: RepositoryAccessState }>, deliveryId: string, accountLogin?: string): Promise<{ outcome: "unbound" | "unchanged" } | { outcome: "marked"; companyId: string; count: number }> {
    return this.run(async (send) => {
      const owner = await this.repositoryOwner(send, installationId, deliveryId, accountLogin, moves.length);
      if (typeof owner === "string") return { outcome: owner };
      const at = new Date(this.clock()).toISOString();
      for (const move of moves) {
        const reason = z.enum(REPOSITORY_ACCESS_STATES).parse(move.reason);
        const fullName = repositoryFullName.parse(move.fullName);
        const item = { ...repositoryMovedKey(owner.companyId, fullName), entityType: "GITHUB_REPOSITORY_MOVED", companyId: owner.companyId, fullName, reason, installationId, at, deliveryId: deliveryId.toLowerCase() };
        try {
          await send(new PutCommand({ TableName: this.tableName, Item: item,
            ...(reason === "removed" ? { ConditionExpression: "attribute_not_exists(pk) OR #reason <> :transferred", ExpressionAttributeNames: { "#reason": "reason" }, ExpressionAttributeValues: { ":transferred": "transferred" } } : {}) }));
        } catch (error) { if (!isConditional(error)) throw error; }
      }
      return { outcome: "marked", companyId: owner.companyId, count: moves.length };
    });
  }

  /** DEC 254zc(1): `installation_repositories` added: the company's marks for these names go (GitHub shows the repository to the App again). Same company and account rules as markRepositories. */
  async clearRepositories(installationId: number, fullNames: readonly string[], deliveryId: string, accountLogin?: string): Promise<{ outcome: "unbound" | "unchanged" } | { outcome: "cleared"; companyId: string; count: number }> {
    return this.run(async (send) => {
      const owner = await this.repositoryOwner(send, installationId, deliveryId, accountLogin, fullNames.length);
      if (typeof owner === "string") return { outcome: owner };
      for (const name of fullNames) await send(new DeleteCommand({ TableName: this.tableName, Key: repositoryMovedKey(owner.companyId, repositoryFullName.parse(name)) }));
      return { outcome: "cleared", companyId: owner.companyId, count: fullNames.length };
    });
  }

  /** The company a repository event writes for: the installation's binding (its account must match the event's, when the event names one), else the implicit company before the backfill marker. */
  private async repositoryOwner(send: (command: unknown) => Promise<{ Item?: unknown }>, installationId: number, deliveryId: string, accountLogin: string | undefined, names: number): Promise<{ companyId: string } | "unbound" | "unchanged"> {
    installationIdSchema.parse(installationId);
    if (accountLogin !== undefined) bindingText.parse(accountLogin);
    if (!DELIVERY.test(deliveryId) || names > REPOSITORY_MOVES_MAX) throw githubBindingRefusal();
    const row = await this.binding(send, installationId);
    if (row !== undefined) return accountLogin !== undefined && accountLogin.toLowerCase() !== row.accountLogin.toLowerCase() ? "unchanged" : { companyId: row.companyId };
    return await this.marker(send) ? "unbound" : { companyId: IMPLICIT_COMPANY_ID };
  }

  /**
   * Guided onboarding PR 3: a company owner unbinds the company's installation (the route checked the role and that no project uses it). One conditional
   * transaction on exactly the binding that was read: the binding and the company's list row go, an audit row naming the person stays (with the claim audits, history is kept),
   * and the backfill marker must exist (before it, an unbound installation would read as the implicit company's). Another company's, or none: not_found, nothing written.
   */
  async disconnect(companyId: string, installationId: number, personId: string): Promise<DisconnectOutcome> {
    return this.run(async (send) => {
      OrgIdSchema.parse(companyId); installationIdSchema.parse(installationId); PersonIdSchema.parse(personId);
      const row = await this.binding(send, installationId);
      if (row === undefined || row.companyId !== companyId) return { outcome: "not_found" };
      const at = new Date(this.clock()).toISOString();
      const fence = sameBinding(row);
      const auditKey = { pk: `GITHUB_INSTALLATION#${installationId}`, sk: `AUDIT#DISCONNECT#${at}#${personId}` };
      try {
        await send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: this.tableName, Key: backfillKey, ConditionExpression: "attribute_exists(pk)" } },
          { Delete: { TableName: this.tableName, Key: bindingKey(installationId), ...fence } },
          { Delete: { TableName: this.tableName, Key: companyInstallationKey(companyId, installationId) } },
          { Put: { TableName: this.tableName, Item: { ...auditKey, entityType: "GITHUB_INSTALLATION_DISCONNECT_AUDIT",
            installationId, accountLogin: row.accountLogin, companyId, state: stateOf(row), boundAt: row.boundAt, boundBy: row.boundBy, at, actor: personId }, ConditionExpression: "attribute_not_exists(pk)" } },
        ] }));
      } catch (error) {
        // Lost a race: whatever is stored now decides. Gone or someone else's: not found; still ours (changed meanwhile): refused, try again.
        // A transaction error can mean it committed: our own audit row says so.
        const committed = await send(new GetCommand({ TableName: this.tableName, Key: auditKey, ConsistentRead: true }));
        if (committed.Item !== undefined) return { outcome: "disconnected", accountLogin: row.accountLogin, ...(row.accountType === undefined ? {} : { accountType: row.accountType }) };
        const now = await this.binding(send, installationId);
        if (now === undefined || now.companyId !== companyId) return { outcome: "not_found" };
        throw error;
      }
      return { outcome: "disconnected", accountLogin: row.accountLogin, ...(row.accountType === undefined ? {} : { accountType: row.accountType }) };
    });
  }

  async claim(companyId: string, installationId: number, accountLogin: string, by: string): Promise<void> {
    return this.run(async (send) => {
      OrgIdSchema.parse(companyId); installationSchema.parse({ installationId, accountLogin }); bindingText.parse(by);
      if (!await this.marker(send) && companyId !== IMPLICIT_COMPANY_ID) throw githubBindingRefusal();
      await this.put(send, companyId, installationId, accountLogin, by);
    });
  }

  /** Only the direct operator event calls this; the conditional transaction is the
   * claim and its durable audit record. Replays, including same-company, refuse. */
  async claimOperator(companyId: string, installation: { installationId: number; accountLogin: string }): Promise<void> {
    return this.run(async send => {
      OrgIdSchema.parse(companyId); installationSchema.parse(installation);
      const at = new Date(this.clock()).toISOString();
      await send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { ...bindingKey(installation.installationId), ...installation,
          entityType: "GITHUB_INSTALLATION_BINDING", companyId, boundAt: at, boundBy: "operator-lambda" }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.tableName, Item: { pk: `GITHUB_INSTALLATION#${installation.installationId}`, sk: "AUDIT#CLAIM",
          entityType: "GITHUB_INSTALLATION_CLAIM_AUDIT", ...installation, companyId, at, actor: "operator-lambda" }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.tableName, Item: companyInstallationRow(companyId, { ...installation, boundAt: at, boundBy: "operator-lambda" }) } },
      ] }));
    });
  }

  /**
   * Guided onboarding PR 1: a company owner or admin binds an installation they proved they control (the route checked that against GitHub first).
   * First binder wins with one conditional transaction: the binding (absent), its audit row naming the person, the company's list row, and the
   * backfill marker (present: before backfill every unbound installation is the implicit company's, so the person path never binds then).
   * Already this company's: nothing is overwritten (the company's list row is put back if it is missing, only while that binding still stands). Another company's: "taken", nothing written.
   * Guided onboarding PR 3: this company's binding that GitHub said is uninstalled or suspended is reconnected by the claim alone (`reconnected`): its state moves to what the
   * person's GitHub check saw (active, or suspended if GitHub still says so), conditionally on what was read, with an audit row naming the person. A webhook never re-activates
   * an uninstalled binding. `seen.accountType` is kept on a new binding (for the uninstall page's address).
   */
  async claimPerson(companyId: string, installation: { installationId: number; accountLogin: string }, personId: string, seen: { accountType?: "User" | "Organization"; suspended?: boolean } = {}): Promise<PersonClaimOutcome> {
    return this.run(async send => {
      OrgIdSchema.parse(companyId); installationSchema.parse(installation); PersonIdSchema.parse(personId);
      const fields = { installationId: installation.installationId, accountLogin: installation.accountLogin, ...(seen.accountType === undefined ? {} : { accountType: z.enum(["User", "Organization"]).parse(seen.accountType) }) };
      const target: InstallationState = seen.suspended === true ? "suspended" : "active";
      // `retry`: after a lost race. A reconnect is then never re-attempted on the strength of a GitHub check made before the race (the person claims again).
      const decide = async (retry = false): Promise<PersonClaimOutcome | undefined> => {
        const row = await this.binding(send, installation.installationId);
        if (row !== undefined) {
          if (row.companyId !== companyId) return "taken";
          const fence = sameBinding(row);
          const at = new Date(this.clock()).toISOString();
          if (stateOf(row) === "active" || stateOf(row) === target) {
            try {
              await send(new TransactWriteCommand({ TransactItems: [
                { ConditionCheck: { TableName: this.tableName, Key: bindingKey(installation.installationId), ...fence } },
                { Put: { TableName: this.tableName, Item: companyInstallationRow(companyId, row) } },
              ] }));
            } catch { return undefined; }
            return "already_bound";
          }
          if (retry) return undefined;
          try {
            await send(new TransactWriteCommand({ TransactItems: [
              { Update: { TableName: this.tableName, Key: bindingKey(installation.installationId), UpdateExpression: "SET #state = :to, stateAt = :at", ...fence,
                ExpressionAttributeValues: { ...fence.ExpressionAttributeValues, ":to": target, ":at": at } } },
              { Put: { TableName: this.tableName, Item: { pk: `GITHUB_INSTALLATION#${installation.installationId}`, sk: `AUDIT#RECONNECT#${at}#${personId}`,
                entityType: "GITHUB_INSTALLATION_CLAIM_AUDIT", ...fields, companyId, from: stateOf(row), to: target, at, actor: personId }, ConditionExpression: "attribute_not_exists(pk)" } },
              { Put: { TableName: this.tableName, Item: companyInstallationRow(companyId, row) } },
            ] }));
          } catch { return undefined; }
          return "reconnected";
        }
        if (!await this.marker(send)) return companyId === IMPLICIT_COMPANY_ID ? "already_bound" : "taken";
        return undefined;
      };
      const before = await decide();
      if (before !== undefined) return before;
      const at = new Date(this.clock()).toISOString();
      try {
        await send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: this.tableName, Key: backfillKey, ConditionExpression: "attribute_exists(pk)" } },
          { Put: { TableName: this.tableName, Item: { ...bindingKey(installation.installationId), ...fields,
            entityType: "GITHUB_INSTALLATION_BINDING", companyId, boundAt: at, boundBy: personId, ...(target === "active" ? {} : { state: target, stateAt: at }) }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName: this.tableName, Item: { pk: `GITHUB_INSTALLATION#${installation.installationId}`, sk: `AUDIT#CLAIM#${at}#${personId}`,
            entityType: "GITHUB_INSTALLATION_CLAIM_AUDIT", ...installation, companyId, at, actor: personId }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName: this.tableName, Item: companyInstallationRow(companyId, { ...installation, boundAt: at, boundBy: personId }) } },
        ] }));
        return "bound";
      } catch (error) {
        // Lost a race (or the marker vanished): the stored binding decides; nothing is overwritten.
        const after = await decide(true);
        if (after === undefined) throw error;
        return after;
      }
    });
  }

  /** Guided onboarding PR 1: the installations bound to `companyId`, from its list, each re-checked against its binding row (a row the binding no longer backs is left out). */
  async companyInstallations(companyId: string): Promise<Array<z.infer<typeof companyInstallationSchema> & { state: InstallationState; accountType?: "User" | "Organization" }>> {
    return this.run(async send => {
      OrgIdSchema.parse(companyId);
      const pk = companyInstallationKey(companyId, 1).pk;
      const response = await send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "INSTALLATION#" }, Limit: COMPANY_INSTALLATIONS_MAX + 1, ConsistentRead: true })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
      const items = z.array(z.unknown()).max(COMPANY_INSTALLATIONS_MAX).parse(response.Items ?? []);
      if (response.LastEvaluatedKey !== undefined && items.length >= COMPANY_INSTALLATIONS_MAX) throw githubBindingRefusal();
      const rows = items.map(item => {
        const row = companyInstallationSchema.parse(item);
        const raw = item as { pk?: unknown; sk?: unknown };
        if (row.companyId !== companyId || raw.pk !== pk || raw.sk !== `INSTALLATION#${row.installationId}`) throw githubBindingRefusal();
        return row;
      });
      const listed = [];
      for (const row of rows) {
        const binding = await this.binding(send, row.installationId);
        if (binding?.companyId === companyId) listed.push({ ...row, accountLogin: binding.accountLogin, boundAt: binding.boundAt, boundBy: binding.boundBy, state: stateOf(binding),
          ...(binding.accountType === undefined ? {} : { accountType: binding.accountType }) });
      }
      return listed;
    });
  }

  /** Each operator invocation reads one page and writes at most 25 bindings. The
   * durable page number prevents a forged/skipped continuation from sealing early. */
  async backfillPage(list: (page: number) => Promise<{ installations: Array<{ installationId: number; accountLogin: string }>; more: boolean }>, page = 1): Promise<{ more: boolean; continuation?: number }> {
    const progressKey = { pk: "GITHUB_INSTALLATION_BINDING", sk: "PROGRESS" };
    const expected = await this.run(async send => {
      z.number().int().positive().max(1_000_000).parse(page);
      if (await this.marker(send)) return undefined;
      const saved = await send(new GetCommand({ TableName: this.tableName, Key: progressKey, ConsistentRead: true }));
      return saved.Item === undefined ? 1 : z.object({ page: z.number().int().positive().max(1_000_000) }).parse(saved.Item).page;
    });
    if (expected === undefined) return { more: false };
    if (page !== expected) throw githubBindingRefusal();
    // Listing has its own bounded HTTP request; its latency never spends the write budget.
    let input: { installations: Array<{ installationId: number; accountLogin: string }>; more: boolean };
    try {
      const value = await list(page);
      if (Buffer.byteLength(JSON.stringify(value) ?? "") > 1_000_000) throw githubBindingRefusal();
      input = z.object({ installations: z.array(installationSchema).max(25), more: z.boolean() }).strict().parse(value);
      if (new Set(input.installations.map(row => row.installationId)).size !== input.installations.length) throw githubBindingRefusal();
    } catch { throw githubBindingRefusal(); }
    return this.run(async send => {
      for (const installation of input.installations) {
        // A pilot explicitly claimed before backfill belongs to that company permanently.
        if (await this.binding(send, installation.installationId) === undefined) {
          try { await this.put(send, IMPLICIT_COMPANY_ID, installation.installationId, installation.accountLogin, "operator-backfill"); }
          catch { if (await this.binding(send, installation.installationId) === undefined) throw githubBindingRefusal(); }
        }
      }
      // Page advancement and the completion marker share the same compare-and-swap.
      await send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { ...progressKey, page: page + 1 },
          ConditionExpression: page === 1 ? "attribute_not_exists(pk)" : "#page = :page",
          ...(page === 1 ? {} : { ExpressionAttributeNames: { "#page": "page" }, ExpressionAttributeValues: { ":page": page } }) } },
        ...(input.more ? [] : [{ Put: { TableName: this.tableName, Item: backfillKey, ConditionExpression: "attribute_not_exists(pk)" } }]),
      ] }));
      return input.more ? { more: true, continuation: page + 1 } : { more: false };
    });
  }

  private async put(send: (command: unknown) => Promise<{ Item?: unknown }>, companyId: string, installationId: number, accountLogin: string, by: string) {
    const existing = await this.binding(send, installationId);
    if (existing !== undefined) {
      if (existing.companyId !== companyId) throw githubBindingRefusal();
      return;
    }
    try {
      await send(new PutCommand({ TableName: this.tableName, Item: { ...bindingKey(installationId),
        entityType: "GITHUB_INSTALLATION_BINDING", installationId, companyId, accountLogin, boundAt: new Date(this.clock()).toISOString(), boundBy: by },
        ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (error) {
      if (!isConditional(error) || (await this.binding(send, installationId))?.companyId !== companyId) throw githubBindingRefusal();
    }
  }

  async backfill(listInstallations: () => Promise<Array<{ installationId: number; accountLogin: string }>>): Promise<{ more: boolean }> {
    return this.run(async (send, check) => {
      if (await this.marker(send)) return { more: false };
      const input = await listInstallations(); check();
      if (!Array.isArray(input)) throw githubBindingRefusal();
      // Never seal a truncated listing: the operator must supply a complete bounded list.
      if (input.length > 100) return { more: true };
      const installations = z.array(installationSchema).max(100).parse(input);
      if (new Set(installations.map(row => row.installationId)).size !== installations.length) throw githubBindingRefusal();
      for (const installation of installations) await this.put(send, IMPLICIT_COMPANY_ID, installation.installationId, installation.accountLogin, "operator-backfill");
      check();
      try { await send(new PutCommand({ TableName: this.tableName, Item: backfillKey, ConditionExpression: "attribute_not_exists(pk)" })); }
      catch (error) { if (!isConditional(error) || !await this.marker(send)) throw githubBindingRefusal(); }
      return { more: false };
    });
  }
}

const listedInstallationsSchema = z.array(installationSchema.extend({
  accountType: z.enum(["User", "Organization"]), repositorySelection: z.enum(["all", "selected"]),
  status: z.enum(["active", "suspended"]),
  repositories: z.array(z.object({ fullName: z.string().min(1).max(201), githubRepositoryId: installationIdSchema,
    private: z.boolean(), defaultBranch: bindingText }).strict()).max(100),
}).strict()).max(100);

/** One whole validated page, one budget for every binding read; never return a partial list. */
export async function filterInstallationsFor(companyId: string, listed: ClientRepositoriesResponse["installations"], bindings: GithubInstallationBindings,
  budget = boundedCompanyReads({ send: async () => undefined })): Promise<ClientRepositoriesResponse["installations"]> {
  try {
    OrgIdSchema.parse(companyId);
    if (Buffer.byteLength(JSON.stringify(listed) ?? "") > 4_000_000) throw githubBindingRefusal();
    const rows = listedInstallationsSchema.parse(listed);
    if (new Set(rows.map(row => row.installationId)).size !== rows.length) throw githubBindingRefusal();
    const scoped = bindings.withBudget(budget);
    const owners = await scoped.ownersOf(rows.map(row => row.installationId));
    const visible: ClientRepositoriesResponse["installations"] = [];
    for (let index = 0; index < rows.length; index++) {
      if (owners[index] === companyId) visible.push(listed[index]!);
    }
    budget.check(); return visible;
  } catch { throw githubBindingRefusal(); }
}
