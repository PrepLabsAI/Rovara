// The `image-registry` point: an in-memory registry for tests (the conformance suite and every test of the saved environment rules), and the default that says "no registry".
//
// The fake holds repositories the way a registry does: an image is pushed by the test through `pushForTest` (the test plays the worker), a login names one repository and is refused for any other,
// and a repository somebody else made first is `unusable`. It keeps no real credential: a login's password is a random string the test can read back through `loginsGiven`.
import { randomBytes } from "node:crypto";
import {
  ImageRegistryError, SavedEnvRegistryAuthSchema, isSavedEnvRepositoryName,
  type ImageRegistry, type ImageRegistryCapabilities, type RegistryImage, type RepositoryCall,
} from "@agentx/contracts";

export interface FakeImageRegistryOptions {
  now?: () => number;
  capabilities?: Partial<ImageRegistryCapabilities>;
  /** The host a login names. Default: a loopback registry, which every adapter-independent test can use. */
  registryHost?: string;
}

interface Repository { images: RegistryImage[]; foreign: boolean; scans: string[] }

export interface FakeImageRegistry extends ImageRegistry {
  /** Plays the worker's push: the repository is made when it is absent (as a first push does). Returns the digest. */
  pushForTest(repository: string, input?: { digest?: string; tag?: string; pushedAt?: string }): string;
  /** Plays somebody else creating the repository first, with other settings. */
  makeForeignForTest(repository: string): void;
  repositories(): string[];
  scansStarted(): Array<{ repository: string; digest: string }>;
  loginsGiven(): Array<{ repository: string; access: "push" | "pull"; password: string; expiresAtMs: number }>;
  /** Makes every call throw `unavailable` until `false`. */
  setDown(down: boolean): void;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export function createFakeImageRegistry(options: FakeImageRegistryOptions = {}): FakeImageRegistry {
  const now = options.now ?? Date.now;
  const host = options.registryHost ?? "127.0.0.1:5999";
  const held = new Map<string, Repository>();
  const logins: Array<{ repository: string; access: "push" | "pull"; password: string; expiresAtMs: number }> = [];
  let down = false;
  let counter = 0;
  const capabilities: ImageRegistryCapabilities = { workerPush: true, workerPull: true, scan: true, ...options.capabilities };
  const check = (call: RepositoryCall): void => {
    if (down) throw new ImageRegistryError("unavailable", "the registry could not be reached");
    if (!isSavedEnvRepositoryName(call.repository)) throw new ImageRegistryError("refused", "not a saved environment repository name");
  };
  const registry: FakeImageRegistry = {
    capabilities,
    async inspect(call) {
      check(call);
      const found = held.get(call.repository);
      return found === undefined ? "absent" : found.foreign ? "unusable" : "matches";
    },
    async login(call) {
      check(call);
      if (!Number.isInteger(call.maxSeconds) || call.maxSeconds < 1) throw new ImageRegistryError("refused", "not a login lifetime");
      const found = held.get(call.repository);
      // A repository made by somebody else is never given a login, and a pull needs the repository to be there.
      if (found?.foreign === true || (call.access === "pull" && found === undefined)) throw new ImageRegistryError("unavailable", "the registry could not give a login");
      const expiresAtMs = now() + call.maxSeconds * 1000;
      const password = randomBytes(24).toString("hex");
      logins.push({ repository: call.repository, access: call.access, password, expiresAtMs });
      const auth = SavedEnvRegistryAuthSchema.parse({ registry: host, repository: call.repository, username: "rovara-local", password, expiresAt: new Date(expiresAtMs).toISOString() });
      return { auth, expiresAtMs };
    },
    async list(call) {
      check(call);
      const found = held.get(call.repository);
      return found === undefined ? "absent" : found.images.map((image) => ({ ...image, tags: [...image.tags] }));
    },
    async deleteImages(call) {
      check(call);
      for (const digest of call.digests) if (!DIGEST.test(digest)) throw new ImageRegistryError("refused", "not an image digest");
      const found = held.get(call.repository);
      if (found === undefined || found.foreign) return;
      found.images = found.images.filter((image) => !call.digests.includes(image.digest));
    },
    async deleteRepository(call) {
      check(call);
      return held.delete(call.repository) ? "deleted" : "absent";
    },
    async startScan(call) {
      check(call);
      if (!capabilities.scan) throw new ImageRegistryError("refused", "this registry does not scan");
      held.get(call.repository)?.scans.push(call.digest);
    },
    pushForTest(repository, input = {}) {
      let found = held.get(repository);
      if (found === undefined) { found = { images: [], foreign: false, scans: [] }; held.set(repository, found); }
      counter += 1;
      const digest = input.digest ?? `sha256:${counter.toString(16).padStart(64, "0")}`;
      found.images.unshift({ digest, tags: [input.tag ?? `t${String(counter)}`], pushedAt: input.pushedAt ?? new Date(now()).toISOString() });
      return digest;
    },
    makeForeignForTest(repository) { held.set(repository, { images: [], foreign: true, scans: [] }); },
    repositories: () => [...held.keys()],
    scansStarted: () => [...held.entries()].flatMap(([repository, value]) => value.scans.map((digest) => ({ repository, digest }))),
    loginsGiven: () => logins.map((entry) => ({ ...entry })),
    setDown(value) { down = value; },
  };
  return registry;
}

/**
 * The default `image-registry` adapter: there is none. Saved environments are off until one is configured (or `rovara up` finds a Docker daemon and registers the local one). It never reaches anything:
 * `inspect` says the repository is unusable, and every other call throws `unavailable`.
 */
export function createUnavailableImageRegistry(): ImageRegistry {
  const none = async (): Promise<never> => { throw new ImageRegistryError("unavailable", "no image registry is set up"); };
  return {
    capabilities: { workerPush: false, workerPull: false, scan: false },
    async inspect() { return "unusable"; },
    login: none,
    list: none,
    deleteImages: none,
    deleteRepository: none,
  };
}
