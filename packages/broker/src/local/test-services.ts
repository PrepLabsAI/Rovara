// Test services on the local Docker worker: the broker's side (the host, which holds the real Docker socket; the worker only ever talks to the guard).
//
// What a worker needs before it may run a plan with dependencies (packages/worker/src/test-services-run.ts):
//   1. its configuration in the environment: the registry the catalog images came from, the catalog environment name, a run folder, its own image as a PINNED id, and the list of images that did not pull;
//   2. the catalog that its image ships (`service-catalog/catalog.json`), which names each dependency by digest, and every digest it may start already on this machine (the worker never pulls);
//   3. a Docker socket guard that lets it make a run network and start exactly those images (isolation/docker-socket-guard-services-source.ts).
// This file makes 1 and 3's inputs and does 2's pull, on the host and by digest only. The catalog comes from a SIGNED catalog this release trusts (`loadSignedCatalog` with the keys compiled into the contracts):
// a release with no trusted catalog key (every build until the project names one) has no catalog that verifies, so no digest is pinned, nothing is pulled, the guard's list is empty and the worker has nothing to
// start: it fails closed with the sentence below. A catalog is never taken on trust from a file, a setting or the network.
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CATALOG_FILE, CATALOG_SIGNATURE_FILE, catalogImageReference, catalogPins, catalogRepositoryName, loadSignedCatalog,
  type CatalogEdition, type VerifiedCatalog,
} from "@agentx/contracts";
import type { DockerRunner } from "./docker-runner.js";

/** What `DockerWorkerMachines` is given to run test services. */
export interface LocalTestServices {
  /** The registry the catalog images are named under (`CatalogRegistryHostSchema`: a host with an optional port). */
  registry: string;
  /** The environment name in `rovara-catalog/<env>/svc/...`. */
  catalogEnv: string;
  /** The full digest references of the images that are on this machine (what `prepareTestServiceImages` returns). The guard lets exactly these start as helpers. */
  images: readonly string[];
  /** Catalog repositories (`svc/<name>`) that could not be pulled: the worker offers no dependency that needs one of them. */
  notPulled?: readonly string[] | undefined;
  /** The most memory one helper may be given, in MiB. Default 3072. */
  maxMemoryMiB?: number | undefined;
  /** Where each worker's run folder is made (one folder per worker, outside every workspace). Default: `<state folder>/test-services`. */
  runDirectoryParent?: string | undefined;
}

/** The worker's environment for test services. Never a secret: a registry host, names and paths. */
export function testServicesEnvironment(services: LocalTestServices, input: { runDirectory: string; workerImageId: string }): Record<string, string> {
  const notPulled = services.notPulled ?? [];
  return {
    AGENTX_TEST_SERVICES_REGISTRY: services.registry,
    AGENTX_TEST_SERVICES_ENV: services.catalogEnv,
    AGENTX_TEST_SERVICES_RUN_DIR: input.runDirectory,
    AGENTX_WORKER_IMAGE: input.workerImageId,
    ...(services.maxMemoryMiB === undefined ? {} : { AGENTX_TEST_SERVICES_MAX_MEM_MIB: String(services.maxMemoryMiB) }),
    ...(notPulled.length === 0 ? {} : { AGENTX_TEST_SERVICES_NOT_PULLED: notPulled.join(",") }),
  };
}

/** What changes the machine's configuration beyond its environment: the images the guard lets start. */
export function localTestServicesDigestPart(services: LocalTestServices, imageId: string | undefined): unknown {
  return [services.registry, services.catalogEnv, [...services.images].sort(), services.maxMemoryMiB ?? null, imageId ?? null];
}

// ---- the catalog

export const NO_TRUSTED_CATALOG_SENTENCE = "Test services are not available: this release has no signed service catalog it trusts (no catalog signing key is built in, or the catalog files are missing), so no dependency image can be pinned and nothing is started.";

export type LocalCatalog = { ok: true; catalog: VerifiedCatalog } | { ok: false; sentence: string; reason: string };

/** The catalog and its signature from a folder, verified with the keys compiled into the contracts. Any problem is a refusal with the one sentence (and the contract's own fixed reason, for the doctor). */
export async function loadLocalServiceCatalog(directory: string, read: (file: string) => Promise<Buffer> = (file) => readFile(file)): Promise<LocalCatalog> {
  let catalogBytes: Buffer;
  let signatureBytes: Buffer;
  try {
    catalogBytes = await read(join(directory, CATALOG_FILE));
    signatureBytes = await read(join(directory, CATALOG_SIGNATURE_FILE));
  } catch {
    return { ok: false, sentence: NO_TRUSTED_CATALOG_SENTENCE, reason: "the catalog files are missing" };
  }
  const loaded = loadSignedCatalog({ catalogBytes, signatureBytes });
  return loaded.ok ? { ok: true, catalog: loaded.catalog } : { ok: false, sentence: NO_TRUSTED_CATALOG_SENTENCE, reason: loaded.reason };
}

// ---- the images

const IMAGES_FILE = "test-services-images.json";
const PULL_TIMEOUT_MS = 10 * 60_000;
const QUICK_MS = 60_000;

export interface PreparedTestServiceImages {
  /** The references that are on this machine now (pulled now, or there already). */
  images: string[];
  /** The catalog repositories (`svc/<name>`) of every image that is NOT here. */
  notPulled: string[];
  failed: Array<{ id: string; reason: string }>;
  /** The references this call pulled (and so may remove again). */
  pulledNow: string[];
}

interface Bookkeeping { schemaVersion: 1; references: string[] }

async function readBookkeeping(file: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Bookkeeping>;
    return new Set(Array.isArray(parsed.references) ? parsed.references.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}
async function writeBookkeeping(file: string, references: ReadonlySet<string>): Promise<void> {
  const temporary = `${file}.${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, references: [...references].sort() } satisfies Bookkeeping)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Pulls, on the host and by digest only, the images the verified catalog pins for this edition. `docker pull <registry>/rovara-catalog/<env>/<repository>@sha256:<digest>`: a tag cannot be built here
 * (`catalogImageReference`), and an image that is already on this machine is left exactly as it is. The references this call pulled are written to `<state folder>/test-services-images.json`, and only those
 * are ever removed by `removePulledTestServiceImages`: an image the owner already had is never touched. A pull that fails (or runs past ten minutes) leaves its repository in `notPulled`, so the worker offers
 * nothing that needs it.
 */
export async function prepareTestServiceImages(input: {
  docker: DockerRunner; catalog: VerifiedCatalog; registry: string; catalogEnv: string; stateDirectory: string; edition?: CatalogEdition;
}): Promise<PreparedTestServiceImages> {
  const file = join(input.stateDirectory, IMAGES_FILE);
  const ours = await readBookkeeping(file);
  const result: PreparedTestServiceImages = { images: [], notPulled: [], failed: [], pulledNow: [] };
  const seen = new Set<string>();
  for (const pin of catalogPins(input.catalog, input.edition ?? "public")) {
    let reference: string;
    try {
      reference = catalogImageReference({ registry: input.registry, repositoryName: catalogRepositoryName(input.catalogEnv, pin.repository), digest: pin.digest });
    } catch {
      result.failed.push({ id: pin.id, reason: "the registry or the repository is not a name the catalog makes" });
      result.notPulled.push(pin.repository);
      continue;
    }
    if (seen.has(reference)) continue;
    seen.add(reference);
    const present = await input.docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: QUICK_MS });
    if (present.exitCode === 0) {
      result.images.push(reference);
      continue;
    }
    const pulled = await input.docker.run(["pull", "--quiet", reference], { timeoutMs: PULL_TIMEOUT_MS });
    if (pulled.exitCode !== 0) {
      result.failed.push({ id: pin.id, reason: (pulled.stderr.trim().split("\n").slice(-1)[0] ?? "the pull failed").slice(0, 200) });
      result.notPulled.push(pin.repository);
      continue;
    }
    result.images.push(reference);
    result.pulledNow.push(reference);
    ours.add(reference);
  }
  if (result.pulledNow.length > 0) await writeBookkeeping(file, ours);
  result.notPulled = [...new Set(result.notPulled)].sort();
  return result;
}

/** Removes the images `prepareTestServiceImages` pulled, and only those (a reference not in the bookkeeping file is never removed). Returns what was removed. */
export async function removePulledTestServiceImages(input: { docker: DockerRunner; stateDirectory: string }): Promise<string[]> {
  const file = join(input.stateDirectory, IMAGES_FILE);
  const ours = await readBookkeeping(file);
  const removed: string[] = [];
  for (const reference of ours) {
    const result = await input.docker.run(["rmi", reference], { timeoutMs: QUICK_MS });
    if (result.exitCode === 0 || /no such image/iu.test(result.stderr)) { removed.push(reference); ours.delete(reference); }
  }
  if (ours.size === 0) await rm(file, { force: true });
  else await writeBookkeeping(file, ours);
  return removed;
}

/**
 * What `DockerWorkerMachines` is given from a prepare: the options when at least one image is on this machine, otherwise none, so a worker is never told about test services it has nothing to start for (it would
 * list the feature and refuse every plan). `rovara up` calls this after `prepareTestServiceImages`, and gives the answer (or nothing) to the machines.
 */
export function localTestServicesFrom(input: { registry: string; catalogEnv: string; prepared: PreparedTestServiceImages; maxMemoryMiB?: number; runDirectoryParent?: string }): LocalTestServices | undefined {
  if (input.prepared.images.length === 0) return undefined;
  return {
    registry: input.registry, catalogEnv: input.catalogEnv, images: input.prepared.images, notPulled: input.prepared.notPulled,
    ...(input.maxMemoryMiB === undefined ? {} : { maxMemoryMiB: input.maxMemoryMiB }), ...(input.runDirectoryParent === undefined ? {} : { runDirectoryParent: input.runDirectoryParent }),
  };
}
