// ECR helpers for Code's model gateway image step (#1578): content-addressed `ctx-<64hex>` tags,
// immutable-repository reuse in beta, cross-account digest copy in production, and the beta repository pull policy.
import { modelGatewayImagesStackName } from "./context.js";
import { StageError } from "./types.js";
import type { GatewayManifest, PipelineEnv, Ports } from "./types.js";

export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TAG = /^[A-Za-z0-9._-]{1,128}$/u;
const BUILT_TAG = /^(?:ctx-[0-9a-f]{64}|pipe-[0-9a-f]{8}-[0-9a-f]{9})$/u;
const CONTEXT_SHA256 = /^[0-9a-f]{64}$/u;
const URI = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]*)$/u;

export const PULL_BETA_MODEL_GATEWAY_ACTIONS = [
  "ecr:BatchCheckLayerAvailability",
  "ecr:BatchGetImage",
  "ecr:DescribeImages",
  "ecr:GetDownloadUrlForLayer",
] as const;

export interface Repository {
  uri: string;
  registry: string;
  name: string;
  account: string;
  region: string;
}

export interface ImageRow {
  digest: string;
  tags: string[];
  pushedAt: string | null;
}

export function parseRepositoryUri(uri: string): Repository {
  const match = URI.exec(uri);
  if (match === null) throw new StageError("REFUSED", "the gateway-images stack RepositoryUri output is not an ECR repository address");
  const [, account, region, name] = match;
  return { uri, registry: uri.slice(0, uri.indexOf("/")), name: name!, account: account!, region: region! };
}

export function contentTagFor(contextSha256: string): string {
  if (!CONTEXT_SHA256.test(contextSha256)) throw new StageError("FAILED", "the model gateway image context hash is not 64 hex characters");
  return `ctx-${contextSha256}`;
}

export function imageTagFor(manifest: Readonly<GatewayManifest>): string {
  const recorded = manifest.gateway.imageTag;
  if (recorded !== null && BUILT_TAG.test(recorded)) return recorded;
  return `pipe-${manifest.exec8}-${manifest.code.sha.slice(0, 9)}`;
}

export function assertTag(tag: string): string {
  if (!TAG.test(tag)) throw new StageError("REFUSED", "the image tag has characters ECR does not allow");
  return tag;
}

/** The environment's own gateway-images repository, read from its stack; refused when absent or in another account. */
export async function ownRepository(ports: Ports, env: PipelineEnv): Promise<Repository> {
  const stack = modelGatewayImagesStackName(env);
  const described = await ports.cfn.describeStack(stack);
  if (described === null) throw new StageError("REFUSED", `the stack ${stack} does not exist: nothing to push the model gateway image to`);
  const uri = described.outputs.RepositoryUri;
  if (uri === undefined) throw new StageError("REFUSED", `the stack ${stack} has no RepositoryUri output`);
  const repository = parseRepositoryUri(uri);
  const account = await ports.sts.account();
  if (repository.account !== account) throw new StageError("REFUSED", `the repository of ${stack} is not in the account this run uses: refusing to push or copy there`);
  return repository;
}

function isImageNotFound(error: unknown): boolean {
  const stderr = error instanceof Error ? (error as { stderr?: unknown }).stderr : undefined;
  const text = error instanceof Error ? `${error.message} ${typeof stderr === "string" ? stderr : ""}` : String(error);
  return /ImageNotFoundException/u.test(text);
}

export async function findImage(
  ports: Ports,
  repositoryName: string,
  by: { tag: string } | { digest: string },
  registryId?: string,
): Promise<ImageRow | null> {
  const id = "tag" in by ? `imageTag=${assertTag(by.tag)}` : `imageDigest=${by.digest}`;
  if ("digest" in by && !IMAGE_DIGEST.test(by.digest)) throw new StageError("REFUSED", "an image digest must look like sha256:<64 hex>");
  try {
    const args = ["ecr", "describe-images", "--repository-name", repositoryName, "--image-ids", id, ...(registryId === undefined ? [] : ["--registry-id", registryId])];
    const doc = (await ports.aws.json(args)) as { imageDetails?: Array<{ imageDigest?: string; imageTags?: string[]; imagePushedAt?: string }> } | null;
    const detail = doc?.imageDetails?.[0];
    if (detail === undefined || typeof detail.imageDigest !== "string") return null;
    return {
      digest: detail.imageDigest,
      tags: Array.isArray(detail.imageTags) ? detail.imageTags.filter((tag) => typeof tag === "string") : [],
      pushedAt: typeof detail.imagePushedAt === "string" ? detail.imagePushedAt : null,
    };
  } catch (error) {
    if (isImageNotFound(error)) return null;
    throw error;
  }
}

export async function registryLogin(
  ports: Ports,
  tool: "docker" | "crane",
  ownRegistry: string,
  registries: readonly string[],
  configDir: string,
): Promise<void> {
  const answer = (await ports.aws.json(["ecr", "get-authorization-token"])) as { authorizationData?: Array<{ authorizationToken?: string; proxyEndpoint?: string }> } | null;
  const entry = answer?.authorizationData?.[0];
  if (entry === undefined || typeof entry.authorizationToken !== "string" || typeof entry.proxyEndpoint !== "string") {
    throw new StageError("FAILED", "ECR returned no registry login");
  }
  if (entry.proxyEndpoint.replace(/^https:\/\//u, "") !== ownRegistry) {
    throw new StageError("REFUSED", "the registry login is for a different registry than this run's own");
  }
  const decoded = Buffer.from(entry.authorizationToken, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) throw new StageError("FAILED", "ECR returned a malformed registry login");
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  ports.fs.mkdirp(configDir);
  for (const registry of registries) {
    const args = tool === "docker"
      ? ["login", "--username", user, "--password-stdin", registry]
      : ["auth", "login", registry, "--username", user, "--password-stdin"];
    const result = await ports.exec(tool, args, { env: { DOCKER_CONFIG: configDir }, input: password });
    if (result.code === 127) throw new StageError("FAILED", `${tool} is not installed on this build machine`);
    if (result.code !== 0) throw new StageError("FAILED", `${tool} could not log in to the registry (exit ${result.code})`);
  }
}

export async function removeDir(ports: Ports, dir: string): Promise<void> {
  await ports.exec("rm", ["-rf", dir]);
}

/**
 * Repository policy for beta's gateway image repository so Code's production gateway build role can pull beta's digest
 * cross-account with its own credentials (read-only). Applied once in the beta account.
 */
export function betaModelGatewayPullPolicy(productionBuildRoleArn: string): { Version: string; Statement: Array<Record<string, unknown>> } {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ProductionCodeReleasePull",
        Effect: "Allow",
        Principal: { AWS: productionBuildRoleArn },
        Action: [...PULL_BETA_MODEL_GATEWAY_ACTIONS],
      },
    ],
  };
}
