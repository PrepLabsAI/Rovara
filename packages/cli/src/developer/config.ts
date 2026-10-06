// ~/.agentx/developer.yaml: which AgentX environments this computer has signed in to (FR-011).
// Never holds a token: tokens live in the system token store.
import { CLI_PACKAGE_NAME } from "@agentx/contracts";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AGENTX_CLI_CLIENT_ID, DEVELOPER_TOKEN_AUDIENCE, EnvironmentNameSchema, agentXError } from "@agentx/contracts";
import YAML from "yaml";
import { z } from "zod";
import { tokenStoreKey } from "../auth.js";
import type { TokenStore } from "../token-store.js";

const EntrySchema = z.object({ url: z.string().url(), issuer: z.string().url(), tokenEndpoint: z.string().url(), revocationEndpoint: z.string().url() }).strict();
const ConfigSchema = z.object({ schemaVersion: z.literal(1), default: EnvironmentNameSchema.optional(), environments: z.record(EnvironmentNameSchema, EntrySchema) }).strict();
export type DeveloperEnvironment = z.infer<typeof EntrySchema>;
interface DeveloperConfig { default?: string; environments: Record<string, DeveloperEnvironment> }

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
  return { ...(parsed.data.default === undefined ? {} : { default: parsed.data.default }), environments: parsed.data.environments };
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

/** Records a signed-in environment; it becomes the default. */
export async function saveDeveloperEnvironment(home: string, env: string, entry: DeveloperEnvironment): Promise<void> {
  const config = await readDeveloperConfig(home);
  await write(home, { default: env, environments: { ...config.environments, [env]: EntrySchema.parse(entry) } });
}

/** Drops an environment's entry; a default it was moves to the first remaining one, or is cleared. Returns the default after. */
export async function removeDeveloperEnvironment(home: string, env: string): Promise<string | undefined> {
  const config = await readDeveloperConfig(home);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
  const { [env]: _removed, ...rest } = config.environments;
  const nextDefault = config.default === env ? Object.keys(rest).sort()[0] : config.default;
  await write(home, { ...(nextDefault === undefined ? {} : { default: nextDefault }), environments: rest });
  return nextDefault;
}

/**
 * Issue #221: forgets this computer's developer sign-in for an environment that no longer exists
 * (agentx destroy): its token and its entry, moving the default as removeDeveloperEnvironment does.
 * Undefined when there was no entry for it; otherwise the default after.
 */
export async function forgetDeveloperSignIn(home: string, env: string, tokenStore: Pick<TokenStore, "delete">): Promise<{ default: string | undefined } | undefined> {
  const entry = (await readDeveloperConfig(home)).environments[env];
  if (entry === undefined) return undefined;
  await tokenStore.delete(developerTokenKey(entry.issuer));
  return { default: await removeDeveloperEnvironment(home, env) };
}

/** The environment named, or the default one agentx login set. */
export async function resolveDeveloperEnvironment(home: string, env: string | undefined): Promise<{ env: string; entry: DeveloperEnvironment }> {
  const config = await readDeveloperConfig(home);
  const name = env ?? config.default;
  const entry = name === undefined ? undefined : config.environments[name];
  if (name === undefined || entry === undefined) {
    throw agentXError("AUTH_REQUIRED", `this computer is not signed in to AgentX${name === undefined ? "" : ` environment ${name}`}; run npx ${CLI_PACKAGE_NAME} login <your AgentX URL>`);
  }
  return { env: name, entry };
}
