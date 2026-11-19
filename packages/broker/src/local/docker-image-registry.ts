// The local Docker adapter for the `image-registry` point: where a project's saved environment image lives on a laptop.
//
// It runs ONE registry container (the plain `registry` image) on the owner's own Docker, and talks to the registry over its HTTP API (v2: tags, manifests by digest, delete by digest). What it keeps apart
// from every other container on the daemon:
//   - the container is named `rovara-image-registry-<hash of the state folder>` and carries the label `rovara.local.registry=1`; before it is started, stopped-and-started, read or used, its label is checked, and a
//     container of that name WITHOUT the label is never touched (the adapter reports the registry as unavailable instead);
//   - its port is published on 127.0.0.1 only, on a port Docker chooses, never on every interface; images are stored in a folder under the state folder (owner only);
//   - deletes are switched on (`REGISTRY_STORAGE_DELETE_ENABLED`), because the broker deletes by digest (keep the newest N, the age ceiling, a deleted project);
//   - nothing here runs an image, builds one, or pushes one: a worker does the push, and only with a login for ONE repository.
//
// WHAT THE LOGIN IS (and is not): the registry listens on loopback only and holds only what Rovara put there, so the login this adapter gives is the shape a worker's Docker login file needs (a user name and a
// fresh password, with an expiry no later than asked), NOT a secret boundary: any process on this computer can reach 127.0.0.1. A login names exactly one repository, and the adapter refuses a repository name that is
// not the shape `savedEnvRepositoryName` makes. The boundary that keeps a worker from another project's images is the worker's own socket guard (it may be given a rule for this one repository only).
//
// DORMANT: this registry has no authentication, so ANY process on the Docker host can list, pull, push or delete every project's saved environment images. The worker's Docker socket guard also refuses image builds,
// pushes and pulls today. So `workerPush` and `workerPull` are false, and asking for `workerAccess: true` THROWS: worker access stays off until the registry runs with an authentication the login is checked against
// (and a pull only by the digest the broker recorded). With them false the core queues no rebuild and names no image to a worker; `list`, `delete` and `login` still work.
//
// `pushedAt` is the time this adapter FIRST SAW the digest (a registry keeps no push time): a small file in the state folder holds it. A digest the adapter first sees late looks younger than it is; the age ceiling
// is a day-scale rule, so a pass that listed after a push (every recorded build is followed by a walk) sets it within minutes.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ImageRegistryError, SAVED_ENV_REGISTRY_USERNAMES, SavedEnvRegistryAuthSchema, isSavedEnvRepositoryName,
  type ImageRegistry, type RegistryImage, type RepositoryCall,
} from "@agentx/contracts";
import type { DockerRunner } from "./docker-runner.js";

/**
 * The registry image, pinned by digest (the multi-architecture manifest of `registry:2` as it was when this was written: the tag only says which line it follows). A new release of the
 * registry is a deliberate change of this constant, so a tag that moves under the owner never changes what runs beside their Docker.
 */
export const LOCAL_REGISTRY_IMAGE = "registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
export const REGISTRY_LABEL = "rovara.local.registry";
export const REGISTRY_STATE_LABEL = "rovara.local.state";
const CONTAINER_PORT = "5000";
const USERNAME = SAVED_ENV_REGISTRY_USERNAMES[1];
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MANIFEST_ACCEPT = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json", "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"].join(", ");
const HTTP_TIMEOUT_MS = 15_000;
const DOCKER_TIMEOUT_MS = 60_000;

export interface DockerImageRegistryOptions {
  docker: DockerRunner;
  /** The state folder: the container's name and the data and the first-seen file are under it. */
  stateDirectory: string;
  /** Where the registry keeps its images. Default `<state folder>/registry`. */
  dataDirectory?: string;
  image?: string;
  /** The HTTP client for the registry's API. Default: the global `fetch`. */
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => string;
  /** The worker can push to and pull from this registry. Default false (see the file's header). */
  workerAccess?: boolean;
  /** An address already known (a registry the caller started itself, a test): `127.0.0.1:<port>`. Skips starting a container. */
  address?: string;
}

const hashOf = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);
const unavailable = (): ImageRegistryError => new ImageRegistryError("unavailable", "the local image registry could not be reached");

export function createDockerImageRegistry(options: DockerImageRegistryOptions): ImageRegistry & { address(): Promise<string>; stop(): Promise<void> } {
  if (options.workerAccess === true) throw new Error("worker access to the local image registry needs a registry that checks the login, which is not built yet");
  const docker = options.docker;
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => randomBytes(24).toString("hex"));
  const stateHash = hashOf(options.stateDirectory);
  const name = `rovara-image-registry-${stateHash}`;
  const dataDirectory = options.dataDirectory ?? join(options.stateDirectory, "registry");
  const firstSeenFile = join(options.stateDirectory, "registry-first-seen.json");
  let known: string | undefined = options.address;
  let starting: Promise<string> | undefined;

  async function dockerCall(args: string[]): Promise<{ exitCode: number; stdout: string }> {
    const result = await docker.run(args, { timeoutMs: DOCKER_TIMEOUT_MS });
    return { exitCode: result.exitCode, stdout: result.stdout };
  }

  /** The container's state, only when it is ours: label checked. `foreign`: a container of the name that is not ours. */
  async function ownContainer(): Promise<"none" | "foreign" | "running" | "stopped"> {
    const inspected = await dockerCall(["inspect", "--format", `{{index .Config.Labels "${REGISTRY_LABEL}"}}\t{{index .Config.Labels "${REGISTRY_STATE_LABEL}"}}\t{{.State.Running}}`, name]);
    if (inspected.exitCode !== 0) return "none";
    const [label, state, running] = inspected.stdout.trim().split("\t");
    if (label !== "1" || state !== stateHash) return "foreign";
    return running === "true" ? "running" : "stopped";
  }

  async function publishedAddress(): Promise<string | undefined> {
    const answer = await dockerCall(["port", name, `${CONTAINER_PORT}/tcp`]);
    if (answer.exitCode !== 0) return undefined;
    // `127.0.0.1:49153` (a second line may name another family; only the loopback one counts).
    const line = answer.stdout.split("\n").map((entry) => entry.trim()).find((entry) => /^127\.0\.0\.1:\d{4,5}$/u.test(entry));
    return line;
  }

  async function ensureRunning(): Promise<string> {
    if (known !== undefined) return known;
    starting ??= (async () => {
      const state = await ownContainer();
      if (state === "foreign") throw unavailable();
      if (state === "none") {
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        const created = await dockerCall([
          "run", "--detach", "--name", name, "--label", `${REGISTRY_LABEL}=1`, "--label", `${REGISTRY_STATE_LABEL}=${stateHash}`,
          "--publish", `127.0.0.1::${CONTAINER_PORT}`, "--env", "REGISTRY_STORAGE_DELETE_ENABLED=true",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
          "--volume", `${dataDirectory}:/var/lib/registry`, options.image ?? LOCAL_REGISTRY_IMAGE,
        ]);
        if (created.exitCode !== 0) throw unavailable();
      } else if (state === "stopped") {
        if ((await dockerCall(["start", name])).exitCode !== 0) throw unavailable();
      }
      const address = await publishedAddress();
      if (address === undefined) throw unavailable();
      known = address;
      return address;
    })().finally(() => { starting = undefined; });
    return starting;
  }

  async function request(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; text: string }> {
    const address = await ensureRunning();
    try {
      const response = await http(`http://${address}${path}`, { method, headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });
      return { status: response.status, headers: response.headers, text: method === "HEAD" ? "" : await response.text() };
    } catch {
      throw unavailable();
    }
  }

  const check = (call: RepositoryCall): void => {
    if (!isSavedEnvRepositoryName(call.repository)) throw new ImageRegistryError("refused", "not a saved environment repository name");
  };

  async function tagsOf(repository: string): Promise<string[] | "absent"> {
    const answer = await request("GET", `/v2/${repository}/tags/list`);
    if (answer.status === 404) return "absent";
    if (answer.status !== 200) throw unavailable();
    try {
      const parsed = JSON.parse(answer.text) as { tags?: unknown };
      const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : [];
      // A repository with no tag holds nothing the core can name: it is absent.
      return tags.length === 0 ? "absent" : tags;
    } catch {
      throw unavailable();
    }
  }

  async function digestOfTag(repository: string, tag: string): Promise<string | undefined> {
    const answer = await request("HEAD", `/v2/${repository}/manifests/${encodeURIComponent(tag)}`, { accept: MANIFEST_ACCEPT });
    const digest = answer.headers.get("docker-content-digest");
    return answer.status === 200 && digest !== null && DIGEST.test(digest) ? digest : undefined;
  }

  async function readFirstSeen(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(firstSeenFile, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    } catch {
      return {};
    }
  }
  async function writeFirstSeen(value: Record<string, string>): Promise<void> {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${firstSeenFile}.${random().slice(0, 8)}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, firstSeenFile);
  }

  async function imagesOf(repository: string): Promise<RegistryImage[] | "absent"> {
    const tags = await tagsOf(repository);
    if (tags === "absent") return "absent";
    const byDigest = new Map<string, string[]>();
    for (const tag of tags) {
      const digest = await digestOfTag(repository, tag);
      if (digest !== undefined) byDigest.set(digest, [...(byDigest.get(digest) ?? []), tag]);
    }
    const seen = await readFirstSeen();
    let changed = false;
    const out: RegistryImage[] = [];
    for (const [digest, imageTags] of byDigest) {
      const key = `${repository}@${digest}`;
      if (seen[key] === undefined) { seen[key] = new Date(now()).toISOString(); changed = true; }
      out.push({ digest, tags: imageTags, pushedAt: seen[key] ?? new Date(now()).toISOString() });
    }
    if (changed) await writeFirstSeen(seen).catch(() => undefined);
    return out;
  }

  async function deleteDigests(repository: string, digests: readonly string[]): Promise<void> {
    for (const digest of digests) {
      const answer = await request("DELETE", `/v2/${repository}/manifests/${digest}`);
      // 202: deleted; 404: not there (already gone); anything else is the registry refusing (deletes off), which must not be read as done.
      if (answer.status !== 202 && answer.status !== 404) throw unavailable();
    }
    // Space is given back by the registry's own garbage collector; a failure of it only leaves the blobs for the next pass.
    await dockerCall(["exec", name, "registry", "garbage-collect", "--delete-untagged", "/etc/docker/registry/config.yml"]).catch(() => undefined);
  }

  return {
    capabilities: { workerPush: false, workerPull: false, scan: false },

    async inspect(call) {
      check(call);
      // Nobody else writes to this registry (it listens on loopback and holds only Rovara's repositories), so a repository is either there or not; there is no repository "made first with other settings".
      return (await tagsOf(call.repository)) === "absent" ? "absent" : "matches";
    },

    async login(call) {
      check(call);
      if (!Number.isInteger(call.maxSeconds) || call.maxSeconds < 1) throw new ImageRegistryError("refused", "not a login lifetime");
      const address = await ensureRunning();
      const expiresAtMs = now() + call.maxSeconds * 1000;
      const auth = SavedEnvRegistryAuthSchema.parse({ registry: address, repository: call.repository, username: USERNAME, password: random(), expiresAt: new Date(expiresAtMs).toISOString() });
      return { auth, expiresAtMs };
    },

    async list(call) {
      check(call);
      return imagesOf(call.repository);
    },

    async deleteImages(call) {
      check(call);
      for (const digest of call.digests) if (!DIGEST.test(digest)) throw new ImageRegistryError("refused", "not an image digest");
      await deleteDigests(call.repository, call.digests);
    },

    async deleteRepository(call) {
      check(call);
      const listed = await imagesOf(call.repository);
      if (listed === "absent") return "absent";
      await deleteDigests(call.repository, listed.map((image) => image.digest));
      return "deleted";
    },

    async address() { return ensureRunning(); },

    /** Stops the registry container (kept, with its images, for the next start). Only a container that is ours. */
    async stop() {
      if ((await ownContainer()) === "running") await dockerCall(["stop", name]);
      known = options.address;
    },
  };
}
