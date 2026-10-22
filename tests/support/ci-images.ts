import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_DELAYS_MS, aliasEnvName } from "../../scripts/ci-images.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * The ref a Linux test uses for a pinned public image. In CI, `scripts/ci-images.ts pull` has already fetched the image (from the GHCR mirror, by digest), checked its digest,
 * tagged a local alias and exported it as ROVARA_CI_IMAGE_<NAME>, so nothing pulls from a public registry again. Anywhere else the pinned ref itself is used.
 */
export const ciImage = (name: string, pinned: string): string => process.env[aliasEnvName(name)] ?? pinned;

/** The `sha256:...` part of a digest-pinned ref. */
export function pinnedDigest(pinned: string): string {
  const digest = /@(sha256:[0-9a-f]{64})$/.exec(pinned)?.[1];
  if (digest === undefined) throw new Error(`${pinned} is not pinned by digest`);
  return digest;
}

async function inspect(image: string): Promise<{ repoDigests: string[] } | null> {
  try {
    const { stdout } = await execFileAsync("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", image]);
    return { repoDigests: (JSON.parse(stdout.trim()) as string[] | null) ?? [] };
  } catch { return null; }
}

/**
 * Makes sure the outer daemon holds `image` and that it is the pinned image: its repo digests carry the pinned digest, whichever registry (the mirror or the upstream) it came from.
 * An image that is already there is never pulled; one that is missing (a developer's machine, or a CI run without the pull step) is pulled with a bounded retry.
 */
export async function ensureLocalImage(image: string, pinned: string): Promise<void> {
  const digest = pinnedDigest(pinned);
  let found = await inspect(image);
  for (let attempt = 0; found === null && attempt <= DEFAULT_DELAYS_MS.length; attempt += 1) {
    try {
      // A local alias is not a registry name: pull the pinned ref and give it the alias.
      await execFileAsync("docker", ["pull", "--quiet", pinned]);
      if (image !== pinned) await execFileAsync("docker", ["tag", pinned, image]);
    } catch (error) {
      if (attempt === DEFAULT_DELAYS_MS.length) throw new Error(`could not pull ${pinned}: ${(error as { stderr?: string }).stderr?.trim().split("\n").at(-1) ?? "docker pull failed"}`, { cause: error });
      await sleep(DEFAULT_DELAYS_MS[attempt]!);
    }
    found = await inspect(image);
  }
  if (found === null) throw new Error(`${image} is not on the Docker host`);
  if (!found.repoDigests.some((entry) => entry.endsWith(`@${digest}`))) throw new Error(`${image} is not the pinned image: its digests are ${JSON.stringify(found.repoDigests)}, not ${digest}`);
}
