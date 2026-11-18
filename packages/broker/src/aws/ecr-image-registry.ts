// SE-2: the hosted image-registry adapter. Role assumption is injected by SE-6;
// this module never constructs a client with the broker's ambient credentials.
// Ported from Cloud's saved-env-aws.ts before 40ae82887 (bounded pages/batches).
import { ECRClient, BatchDeleteImageCommand, DeleteRepositoryCommand, DescribeImagesCommand, DescribeRepositoriesCommand, GetAuthorizationTokenCommand, GetRepositoryPolicyCommand } from "@aws-sdk/client-ecr";
import {
  HostedSavedEnvRegistryAuthSchema, ImageRegistryError, ImageDigestSchema, canonicalJson,
  isSavedEnvRepositoryName, savedEnvRepositoryName, savedEnvRepositoryPolicy,
  SAVED_ENV_MANAGE_SESSION_SECONDS, SAVED_ENV_PUSH_SESSION_SECONDS, SAVED_ENV_PULL_SESSION_SECONDS,
  type ImageRegistry, type RepositoryCall, type RegistryImage, type SavedEnvAccountScope,
} from "@agentx/contracts";
import type { CoreAdapterModule } from "../core-host/registry.js";
import { savedEnvEnabled } from "../core/test-env/saved-env-switch.js";

import { savedEnvRoleSessionSettings, savedEnvRoleSessionsFromEnvironment, type SavedEnvRoleSessions, type SavedEnvSession } from "./saved-env-role-sessions.js";

type EcrSender = { send(command: unknown): Promise<unknown> };
export type SavedEnvEcrFactory = (credentials: SavedEnvSession["credentials"]) => EcrSender;
const realEcr: (region: string) => SavedEnvEcrFactory = region => credentials => {
  const client = new ECRClient({ region, credentials });
  return { send: command => client.send(command as Parameters<ECRClient["send"]>[0]) };
};

export const SAVED_ENV_NOT_SET_UP = "saved environments are not set up on this install";
const unavailable = (): ImageRegistryError => new ImageRegistryError("unavailable", "saved environment registry is unavailable");
const refused = (): ImageRegistryError => new ImageRegistryError("refused", "saved environment registry request was refused");
const named = (error: unknown, name: string): boolean => error instanceof Error && error.name === name;
const LIST_PAGES_MAX = 10;
const BATCH = 100;

function configuration(env: NodeJS.ProcessEnv) {
  const envName = env["AGENTX_ENV"] ?? "";
  const region = env["AWS_REGION"] ?? "";
  const settings = savedEnvRoleSessionSettings(env, region);
  if (settings === undefined || settings.env !== envName) throw new ImageRegistryError("refused", SAVED_ENV_NOT_SET_UP);
  const scope: SavedEnvAccountScope = { partition: settings.partition, account: settings.account, region };
  return { envName, scope, pushRoleArn: settings.roleArns.push, pullRoleArn: settings.roleArns.pull, manageRoleArn: settings.roleArns.manage, host: `${scope.account}.dkr.ecr.${region}.amazonaws.com` };
}

export function createEcrImageRegistry(options: { env: NodeJS.ProcessEnv; sessions: Pick<SavedEnvRoleSessions, "assume">; ecr?: SavedEnvEcrFactory; now?: () => number }): ImageRegistry {
  const config = configuration(options.env);
  if (typeof options.sessions?.assume !== "function") throw new ImageRegistryError("refused", SAVED_ENV_NOT_SET_UP);
  const now = options.now ?? Date.now;
  const expectedPolicy = canonicalJson(savedEnvRepositoryPolicy(config));

  function check(call: RepositoryCall): void {
    try {
      // The port does not receive a project id: verify the company's hash AND
      // install prefix before accepting the project's opaque hash segment.
      const companyPrefix = savedEnvRepositoryName({ env: config.envName, orgId: call.companyId, projectId: "scope" }).slice(0, -33);
      if (!isSavedEnvRepositoryName(call.repository) || !call.repository.startsWith(companyPrefix)) throw refused();
    } catch { throw refused(); }
  }

  async function session(call: RepositoryCall, access: "push" | "pull" | "manage", seconds: number) {
    const start = now();
    const result = await options.sessions.assume({ access, companyId: call.companyId, repository: call.repository, maxSeconds: seconds });
    // STS has a 900-second minimum, but a login never outlives the caller's shorter request.
    const maximum = Math.max(900, seconds);
    if (!Number.isFinite(result.expiresAtMs) || result.expiresAtMs <= now() || result.expiresAtMs > start + (maximum + 5) * 1000) throw unavailable();
    return { ecr: (options.ecr ?? realEcr(config.scope.region))(result.credentials), expiresAtMs: Math.min(result.expiresAtMs, start + seconds * 1000) };
  }

  const registry: ImageRegistry = {
    capabilities: { workerPush: savedEnvEnabled(options.env), workerPull: savedEnvEnabled(options.env), scan: false },
    async inspect(call) {
      check(call);
      try {
        const { ecr } = await session(call, "manage", SAVED_ENV_MANAGE_SESSION_SECONDS);
        const result = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [call.repository] })) as { repositories?: Array<{ repositoryName?: string; registryId?: string; encryptionConfiguration?: { encryptionType?: string }; imageTagMutability?: string }> };
        const found = result.repositories?.[0];
        if (found === undefined || result.repositories?.length !== 1) throw unavailable();
        if (found.repositoryName !== call.repository || found.registryId !== config.scope.account || found.encryptionConfiguration?.encryptionType !== "AES256" || found.imageTagMutability !== "IMMUTABLE") return "unusable";
        let policyText: string | undefined;
        try { policyText = (await ecr.send(new GetRepositoryPolicyCommand({ repositoryName: call.repository })) as { policyText?: string }).policyText; }
        catch (error) { if (named(error, "RepositoryPolicyNotFoundException")) return "unusable"; throw error; }
        try { return typeof policyText === "string" && canonicalJson(JSON.parse(policyText)) === expectedPolicy ? "matches" : "unusable"; }
        catch { return "unusable"; }
      } catch (error) {
        if (named(error, "RepositoryNotFoundException")) return "absent";
        throw unavailable();
      }
    },
    async login(call) {
      if (!savedEnvEnabled(options.env)) throw refused();
      check(call);
      const ceiling = call.access === "push" ? SAVED_ENV_PUSH_SESSION_SECONDS : SAVED_ENV_PULL_SESSION_SECONDS;
      if ((call.access !== "push" && call.access !== "pull") || !Number.isSafeInteger(call.maxSeconds) || call.maxSeconds < 1) throw refused();
      try {
        const state = await registry.inspect(call);
        if (state === "unusable" || (state === "absent" && call.access === "pull")) throw unavailable();
        const requestedUntil = now() + Math.min(call.maxSeconds, ceiling) * 1000;
        const assumed = await session(call, call.access, Math.min(call.maxSeconds, ceiling));
        const answer = await assumed.ecr.send(new GetAuthorizationTokenCommand({})) as { authorizationData?: Array<{ authorizationToken?: string; proxyEndpoint?: string; expiresAt?: Date }> };
        const token = answer.authorizationData?.[0];
        if (answer.authorizationData?.length !== 1 || token?.proxyEndpoint !== `https://${config.host}` || typeof token.authorizationToken !== "string" || !(token.expiresAt instanceof Date)) throw unavailable();
        const decoded = Buffer.from(token.authorizationToken, "base64").toString("utf8");
        if (!decoded.startsWith("AWS:")) throw unavailable();
        const expiresAtMs = Math.min(assumed.expiresAtMs, token.expiresAt.getTime(), requestedUntil);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) throw unavailable();
        const auth = HostedSavedEnvRegistryAuthSchema.parse({ registry: config.host, repository: call.repository, username: "AWS", password: decoded.slice(4), expiresAt: new Date(expiresAtMs).toISOString() });
        return { auth, expiresAtMs };
      } catch { throw unavailable(); }
    },
    async list(call) {
      check(call);
      try {
        const { ecr } = await session(call, "manage", SAVED_ENV_MANAGE_SESSION_SECONDS);
        const images: RegistryImage[] = [];
        let nextToken: string | undefined;
        for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
          const result = await ecr.send(new DescribeImagesCommand({ repositoryName: call.repository, maxResults: 1000, ...(nextToken === undefined ? {} : { nextToken }) })) as { imageDetails?: Array<{ imageDigest?: string; imageTags?: string[]; imagePushedAt?: Date }>; nextToken?: string };
          if (!Array.isArray(result.imageDetails) || result.imageDetails.length > 1000) throw unavailable();
          for (const image of result.imageDetails) {
            if (!ImageDigestSchema.safeParse(image.imageDigest).success || !(image.imagePushedAt instanceof Date) || (image.imageTags !== undefined && (!Array.isArray(image.imageTags) || image.imageTags.some(tag => typeof tag !== "string")))) throw unavailable();
            images.push({ digest: image.imageDigest!, tags: image.imageTags ?? [], pushedAt: image.imagePushedAt.toISOString() });
          }
          nextToken = result.nextToken;
          if (nextToken === undefined) return images;
          if (typeof nextToken !== "string" || nextToken === "") throw unavailable();
        }
        throw unavailable(); // Never treat a truncated listing as complete.
      } catch (error) {
        if (named(error, "RepositoryNotFoundException")) return "absent";
        throw unavailable();
      }
    },
    async deleteImages(call) {
      check(call);
      if (!Array.isArray(call.digests) || call.digests.length > LIST_PAGES_MAX * 1000 || call.digests.some(digest => !ImageDigestSchema.safeParse(digest).success)) throw refused();
      if (call.digests.length === 0) return;
      try {
        const { ecr } = await session(call, "manage", SAVED_ENV_MANAGE_SESSION_SECONDS);
        for (let start = 0; start < call.digests.length; start += BATCH) {
          const result = await ecr.send(new BatchDeleteImageCommand({ repositoryName: call.repository, imageIds: call.digests.slice(start, start + BATCH).map((imageDigest: string) => ({ imageDigest })) })) as { failures?: Array<{ failureCode?: string }> };
          if ((result.failures ?? []).some(failure => failure.failureCode !== "ImageNotFound")) throw unavailable();
        }
      } catch (error) {
        if (!named(error, "RepositoryNotFoundException")) throw unavailable();
      }
    },
    async deleteRepository(call) {
      check(call);
      try {
        const { ecr } = await session(call, "manage", SAVED_ENV_MANAGE_SESSION_SECONDS);
        await ecr.send(new DeleteRepositoryCommand({ repositoryName: call.repository, force: true }));
        return "deleted";
      } catch (error) {
        if (named(error, "RepositoryNotFoundException")) return "absent";
        throw unavailable();
      }
    },
  };
  return registry;
}

/** Configured installs retain management for purge while use is off; sessions remain lazy. */
export function savedEnvImageModules(env: NodeJS.ProcessEnv, sessions?: Pick<SavedEnvRoleSessions, "assume">): CoreAdapterModule[] {
  if (!savedEnvEnabled(env) && savedEnvRoleSessionSettings(env, env["AWS_REGION"]) === undefined) return [];
  return [{ point: "image-registry", name: "ecr", owner: "Code", create: ({ now }) => {
    const bound = sessions ?? savedEnvRoleSessionsFromEnvironment(env);
    if (bound === undefined) throw new ImageRegistryError("refused", SAVED_ENV_NOT_SET_UP);
    return createEcrImageRegistry({ env, sessions: bound, now: () => now().getTime() });
  } }];
}
