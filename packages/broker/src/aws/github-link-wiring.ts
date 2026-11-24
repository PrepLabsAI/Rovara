// L4-GH: the broker's wiring of the person's own GitHub link routes (github-account-link-routes.ts): the links live in the State table (the core's own store, STATE_TABLE_NAME), read and
// written through the same document-store adapter the core uses; the GitHub check is the App client's user authorization (the same OAuth client as "Connect GitHub"). Nothing new is needed
// from the install: no secret, no table, no GitHub App setting.
import type { DocumentStore } from "@agentx/contracts";
import { createDynamoStoreFromSettings } from "@rovara/aws-adapters/dynamodb";
import type { GithubLinkWiring } from "./github-account-link-routes.js";

export interface GithubLinkClients {
  /** The raw DynamoDB client the document-store adapter is built over. */
  dynamo: Parameters<typeof createDynamoStoreFromSettings>[1];
  /** The GitHub App client (its `oauthClient` and `githubUserOfCode`). */
  github: GithubLinkWiring["github"];
  log: GithubLinkWiring["log"];
}

/**
 * The State table as a document store, built on first use; undefined when the table is not named. Shared by the person's own link routes (GitHub's, and Linear's in linear-wiring.ts): each reads and
 * writes its rows in the core's own store.
 */
export function stateStoreFromEnvironment(env: NodeJS.ProcessEnv, dynamo: GithubLinkClients["dynamo"]): DocumentStore | undefined {
  const tableName = env.STATE_TABLE_NAME ?? "";
  if (tableName === "") return undefined;
  let store: DocumentStore | undefined;
  const storeOnce = (): DocumentStore => (store ??= createDynamoStoreFromSettings({ tableName, ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }) }, dynamo));
  return new Proxy({} as DocumentStore, { get: (_target, field) => {
    const value = (storeOnce() as unknown as Record<PropertyKey, unknown>)[field];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(storeOnce()) : value;
  } });
}

/** Undefined (the routes answer "route not found") when the State table is not named. The store is built on first use. */
export function githubLinkWiringFromEnvironment(env: NodeJS.ProcessEnv, clients: GithubLinkClients): GithubLinkWiring | undefined {
  const store = stateStoreFromEnvironment(env, clients.dynamo);
  return store === undefined ? undefined : { store, github: clients.github, log: clients.log };
}
