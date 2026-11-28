// ~/.agentx/developer.yaml: which AgentX environments this computer has signed in to (FR-011).
// Never holds a token: tokens live in the system token store.
import { CLI_PACKAGE_NAME } from "@agentx/contracts";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AGENTX_CLI_CLIENT_ID, DEFAULT_ENVIRONMENT, DEVELOPER_TOKEN_AUDIENCE, EnvironmentNameSchema, agentXError } from "@agentx/contracts";
import YAML from "yaml";
import { z } from "zod";
import { tokenStoreKey } from "../auth.js";
import type { TokenStore } from "../token-store.js";

const EntrySchema = z.object({ url: z.string().url(), issuer: z.string().url(), tokenEndpoint: z.string().url(), revocationEndpoint: z.string().url() }).strict();
// Issue #1611: `default` is still read, so a file an older CLI wrote stays valid, but it is ignored
// and never written. Commands without --env always use production, whatever was signed in to last.
const ConfigSchema = z.object({ schemaVersion: z.literal(1), default: EnvironmentNameSchema.optional(), environments: z.record(EnvironmentNameSchema, EntrySchema) }).strict();
export type DeveloperEnvironment = z.infer<typeof EntrySchema>;
interface DeveloperConfig { environments: Record<string, DeveloperEnvironment> }

export const developerConfigPath = (home: string): string => join(home, ".agentx", "developer.yaml");
export const developerTokenKey = (issuer: string): string => tokenStoreKey({ issuer, clientId: AGENTX_CLI_CLIENT_ID, audience: DEVELOPER_TOKEN_AUDIENCE });

export async function readDeveloperConfig(home: string): Promise<DeveloperConfig> {
  let text: string;
  try {
    text = await readFile(developerConfigPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { environments: {} };
    throw error;
  }
  let document: unknown;
  try {
    document = YAML.parse(text);
  } catch {
    document = undefined;
  }
  const parsed = ConfigSchema.safeParse(document);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${developerConfigPath(home)} is invalid; delete it and run agentx login <url> again`);
  return { environments: parsed.data.environments };
}

/** Writes the whole file atomically (a 0600 temp file renamed over it). */
async function write(home: string, config: DeveloperConfig): Promise<void> {
  const path = developerConfigPath(home);
  await mkdir(join(home, ".agentx"), { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone: make it private either way.
  await chmod(join(home, ".agentx"), 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(YAML.stringify({ schemaVersion: 1, ...config }));
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Records a signed-in environment. It never becomes the default (issue #1611): that stays production. */
export async function saveDeveloperEnvironment(home: string, env: string, entry: DeveloperEnvironment): Promise<void> {
  const config = await readDeveloperConfig(home);
  await write(home, { environments: { ...config.environments, [env]: EntrySchema.parse(entry) } });
}

/** Drops an environment's entry. */
export async function removeDeveloperEnvironment(home: string, env: string): Promise<void> {
  const config = await readDeveloperConfig(home);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
  const { [env]: _removed, ...rest } = config.environments;
  await write(home, { environments: rest });
}

/**
 * Issue #221: forgets this computer's developer sign-in for an environment that no longer exists
 * (agentx destroy): its token and its entry. False when there was no entry for it.
 */
export async function forgetDeveloperSignIn(home: string, env: string, tokenStore: Pick<TokenStore, "delete">): Promise<boolean> {
  const entry = (await readDeveloperConfig(home)).environments[env];
  if (entry === undefined) return false;
  await tokenStore.delete(developerTokenKey(entry.issuer));
  await removeDeveloperEnvironment(home, env);
  return true;
}

/**
 * The environment named, or production when none is (issue #1611: the same default every command
 * and --help use, never the environment signed in to last). Not signed in to it names the
 * environments this computer is signed in to, so the person can add --env.
 */
export async function resolveDeveloperEnvironment(home: string, env: string | undefined): Promise<{ env: string; entry: DeveloperEnvironment }> {
  const config = await readDeveloperConfig(home);
  const name = env ?? DEFAULT_ENVIRONMENT;
  const entry = config.environments[name];
  if (entry === undefined) {
    const others = Object.keys(config.environments).sort();
    const signIn = `run npx ${CLI_PACKAGE_NAME} login <your AgentX URL>`;
    const next = others.length === 0 ? signIn : `it is signed in to ${others.join(", ")}: add --env ${others.length === 1 ? others[0] : "<name>"}, or ${signIn}`;
    throw agentXError("AUTH_REQUIRED", `this computer is not signed in to AgentX environment ${name}; ${next}`);
  }
  return { env: name, entry };
}
