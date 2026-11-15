// The GitHub App credentials as the broker and the plan evidence job build them: one definition, from the same environment
// (GITHUB_APP_CREDENTIAL_REF, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN) and the same secret.
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { agentXError, IMPLICIT_COMPANY_ID, OrgIdSchema, type ClientRepositoriesResponse } from "@agentx/contracts";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
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
  const provider = new GitHubAppCredentialProvider({
    credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"),
    appId: appIdSetting !== "" ? appIdSetting : async () => (await loadApp()).appId,
    getPrivateKey: () => loadSecret().then(privateKeyFromSecret),
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
  return { provider, privateKeySecretArn, webhookSecret };
}


// T5 lives in this existing module until the public port guard permits new AWS files.
const bindingKey = (installationId: number) => ({ pk: `GITHUB_INSTALLATION#${installationId}`, sk: "BINDING" });
const backfillKey = { pk: "GITHUB_INSTALLATION_BINDING", sk: "BACKFILL" };
const installationIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bindingText = z.string().min(1).max(256);
const installationSchema = z.object({ installationId: installationIdSchema, accountLogin: bindingText });
const bindingSchema = installationSchema.extend({
  entityType: z.literal("GITHUB_INSTALLATION_BINDING"), companyId: OrgIdSchema,
  boundAt: z.iso.datetime(), boundBy: bindingText,
});
const markerSchema = z.object({ pk: z.literal("GITHUB_INSTALLATION_BINDING"), sk: z.literal("BACKFILL") }).strict();
export function githubBindingRefusal() { return agentXError("GITHUB_NOT_CONNECTED", "the GitHub installation is not connected"); }

/** Operator-only writer. No HTTP or company-admin path calls claim. The host owns
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

  readonly requireBound = async (companyId: string, installationId: number, _repository?: { owner: string; name: string }): Promise<void> => {
    void _repository;
    if (!OrgIdSchema.safeParse(companyId).success || await this.ownerOf(installationId) !== companyId) throw githubBindingRefusal();
  };

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
      ] }));
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
