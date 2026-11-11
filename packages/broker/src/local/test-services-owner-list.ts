// Test services on a laptop: the owner's own approved image list (owner decision 2026-11-11), in place of Cloud's signed catalog.
//
// Where the list comes from, from most to least trusted:
//   1. the STARTER LIST, in Code's source (`@agentx/contracts` owner-starter-images.ts, a guard file): Postgres 16 and 17, MySQL 8, Redis 7 and MongoDB 7, each pinned to a digest. Pre-approved, no click.
//   2. the images the owner APPROVED on the test environment page: one approval each, which pulls the image through the owner's own Docker and pins the digest that Docker resolved at that moment (`registry/repository@sha256:...`),
//      stored in Code's state. A later move of the tag changes nothing: the pin is what counts, and a new pin needs a new approval.
//   3. `ROVARA_TEST_SERVICE_IMAGES`, a comma list of references for scripts. A tag entry is pinned to a digest the first time it is pulled (and kept), a `name:tag@sha256:...` entry is used as written. The page shows them.
// What a repository asks for (its compose files, its dev container, the setup agent's draft) is only ever a PROPOSAL: it names a family and a version, `proposeServiceImages` turns it into an image the owner may approve, and
// nothing in it is approved by being proposed. A repository can name any image, so no repository text becomes an image name: the image is the official Docker Hub one of that family and version.
// Cloud keeps its signed catalog. When this build compiles in a catalog signing key the signed catalog is the only way (`prepareLocalTestServices`), and the owner's list is never read.
import { orgScoped, queryAll, type AuditSink, type DocumentStore, type OrgId, type OwnerListEntry, type OwnerServiceImage, type TestEnvDependencyCandidate } from "@agentx/contracts";
import {
  OWNER_IMAGE_REFUSALS, OWNER_STARTER_IMAGES, OwnerServiceImageSchema, describeImage, imageNameOf, isStarterReference, normalizeOwnerList, ownerCatalogIdOf, ownerImageRequest, ownerStarterEntries, parseImageReference, pinnedImageReference,
  starterImageFor, type OwnerImageFamily,
} from "@agentx/contracts";
import type { DockerRunner } from "./docker-runner.js";

/** The owner's comma list of image references, for scripts (the page shows them, and they are pinned the first time they are pulled). */
export const TEST_SERVICE_IMAGES_VARIABLE = "ROVARA_TEST_SERVICE_IMAGES";

export const NO_IMAGES_SENTENCE = `Test services are not available: none of the approved images could be pulled to this computer. Check that Docker is running, then restart \`rovara up\`. More images are approved on a project's test environment page (\`rovara test-env open <project>\`) or listed in ${TEST_SERVICE_IMAGES_VARIABLE}.`;

const PULL_TIMEOUT_MS = 10 * 60_000;
const QUICK_MS = 60_000;

// ---- what a project asks for (a proposal, never an approval)

export interface ProposedServiceImage {
  /** `postgres:16`: what approving would pin. */
  requested: string;
  family: OwnerImageFamily;
  version: string;
  /** Where the repository showed it: path and line, at most three. Shown as quoted repository text. */
  evidence: Array<{ path: string; line: number }>;
}

const REPOSITORY_OF: Record<OwnerImageFamily, string> = { postgres: "postgres", mysql: "mysql", redis: "redis", mongodb: "mongo" };
const FAMILY_OF_CANDIDATE: Readonly<Record<string, OwnerImageFamily>> = { postgres: "postgres", mysql: "mysql", redis: "redis", mongodb: "mongodb" };

/**
 * The service images a project asks for, from what the readers found (the compose files, the dev container's compose files, the CI services and the setup agent's draft all end as dependency CANDIDATES: a family and a major
 * version). Each becomes the official image of that family and version. This reads nothing and approves nothing; a candidate with no version, or of a family Rovara has no profile for, is left out.
 */
export function proposeServiceImages(candidates: readonly TestEnvDependencyCandidate[]): ProposedServiceImage[] {
  const found = new Map<string, ProposedServiceImage>();
  for (const candidate of candidates) {
    const family = FAMILY_OF_CANDIDATE[candidate.family];
    const version = candidate.hints.version;
    if (family === undefined || version === undefined) continue;
    // The version is 1 to 3 digits, checked here and not only by the draft schema; and the image must come out as Docker Hub's official one of that family, so no repository text can ever name another.
    if (!/^\d{1,3}$/u.test(version)) continue;
    const requested = `${REPOSITORY_OF[family]}:${version}`;
    const parsed = parseImageReference(requested);
    if (!ownerImageRequest(requested).ok || parsed?.registry !== "docker.io" || parsed.repository !== `library/${REPOSITORY_OF[family]}`) continue;
    const entry = found.get(requested) ?? { requested, family, version, evidence: [] };
    for (const place of candidate.evidence) if (entry.evidence.length < 3 && !entry.evidence.some((seen) => seen.path === place.path && seen.line === place.line)) entry.evidence.push({ path: place.path, line: place.line });
    found.set(requested, entry);
  }
  return [...found.values()].sort((a, b) => (a.requested < b.requested ? -1 : 1));
}

// ---- the stored approvals

const PARTITION = "TEST_SERVICE_IMAGES";
const ENTITY = "TEST_SERVICE_IMAGE";

export interface OwnerImageStore {
  /** Every stored image, as it was written (a damaged row is left out). */
  list(): Promise<OwnerServiceImage[]>;
  /** Stores an image under its catalog id AND origin: an image of the same family, version and origin is replaced (re-approval), and a page approval and an env pin never share or overwrite a row. */
  put(image: OwnerServiceImage): Promise<void>;
  /** Removes the stored images with this reference (only those of this origin when one is given). False when there is none. */
  remove(reference: string, origin?: OwnerServiceImage["origin"]): Promise<boolean>;
}

/** `store` may be a function: it is called on each use, for a store that is registered after this is made (a storage plug-in). */
export function createOwnerImageStore(input: { store: DocumentStore | (() => DocumentStore); companyId: OrgId }): OwnerImageStore {
  const documents = (): DocumentStore => (typeof input.store === "function" ? input.store() : input.store);
  const pk = orgScoped(input.companyId, PARTITION);
  const key = (image: Pick<OwnerServiceImage, "family" | "version" | "origin">) => ({ pk, sk: `IMAGE#${ownerCatalogIdOf(image.family, image.version)}#${image.origin}` });
  const list = async (): Promise<OwnerServiceImage[]> => {
    const rows = await queryAll(documents(), { pk, sk: { op: "beginsWith", prefix: "IMAGE#" } });
    return rows.flatMap((row) => {
      if (row["entityType"] !== ENTITY) return [];
      const parsed = OwnerServiceImageSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([name]) => name !== "pk" && name !== "sk" && name !== "entityType")));
      return parsed.success ? [parsed.data] : [];
    });
  };
  return {
    list,
    async put(image) {
      const parsed = OwnerServiceImageSchema.parse(image);
      await documents().put({ item: { ...key(parsed), entityType: ENTITY, ...JSON.parse(JSON.stringify(parsed)) as Record<string, never> } });
    },
    async remove(reference, origin) {
      const found = (await list()).filter((image) => image.reference === reference && (origin === undefined || image.origin === origin));
      for (const image of found) await documents().delete({ key: key(image) });
      return found.length > 0;
    },
  };
}

// ---- pinning through the owner's Docker

export type PinResult = { ok: true; reference: string } | { ok: false; reason: "pull_failed" | "no_digest" | "ambiguous" | "not_here" };

/**
 * Pulls `registry/repository:tag` through the owner's own Docker NOW and returns the reference `registry/repository@sha256:<digest>` of the digest Docker resolved for it: the one the pulled image's `RepoDigests` holds for that
 * name (the multi-platform index digest). Anything but exactly one such digest is a refusal, and the pinned reference must then be found on this computer. `docker pull` is the one place the tag is looked at.
 */
export async function pinImageThroughDocker(docker: DockerRunner, request: { registry: string; repository: string; tag: string }): Promise<PinResult> {
  const name = `${imageNameOf(request)}:${request.tag}`;
  const pulled = await docker.run(["pull", "--quiet", name], { timeoutMs: PULL_TIMEOUT_MS }).catch(() => undefined);
  if (pulled === undefined || pulled.exitCode !== 0) return { ok: false, reason: "pull_failed" };
  const inspected = await docker.run(["image", "inspect", "--format", "{{json .RepoDigests}}", name], { timeoutMs: QUICK_MS }).catch(() => undefined);
  if (inspected === undefined || inspected.exitCode !== 0) return { ok: false, reason: "no_digest" };
  let digests: string[];
  try {
    const parsed: unknown = JSON.parse(inspected.stdout.trim());
    digests = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return { ok: false, reason: "no_digest" };
  }
  const mine = new Set<string>();
  for (const entry of digests) {
    const parsed = parseImageReference(entry);
    if (parsed?.digest !== undefined && imageNameOf(parsed) === imageNameOf(request)) mine.add(parsed.digest);
  }
  if (mine.size === 0) return { ok: false, reason: "no_digest" };
  if (mine.size > 1) return { ok: false, reason: "ambiguous" };
  const reference = pinnedImageReference(request, [...mine][0]!);
  const here = await docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: QUICK_MS }).catch(() => undefined);
  return here !== undefined && here.exitCode === 0 ? { ok: true, reference } : { ok: false, reason: "not_here" };
}

/** Whether the exact pinned reference is on this computer; if not, pulls it BY DIGEST (the daemon holds the bytes to the digest). */
export async function ensureImagePresent(docker: DockerRunner, reference: string): Promise<boolean> {
  const present = await docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: QUICK_MS }).catch(() => undefined);
  if (present !== undefined && present.exitCode === 0) return true;
  const pulled = await docker.run(["pull", "--quiet", reference], { timeoutMs: PULL_TIMEOUT_MS }).catch(() => undefined);
  return pulled !== undefined && pulled.exitCode === 0;
}

// ---- the service the page and the install use

export type ImageApproval =
  | { ok: true; image: OwnerServiceImage }
  | { ok: false; reason: "refused" | "builtin" | "pin_failed"; message: string };

const PIN_FAILURES: Record<Extract<PinResult, { ok: false }>["reason"], string> = {
  pull_failed: "Docker could not pull that image. Check the name and that Docker is running.",
  no_digest: "Docker pulled it but did not report a digest for that name, so it cannot be pinned.",
  ambiguous: "Docker reported more than one digest for that name, so it cannot be pinned.",
  not_here: "The pinned image is not on this computer after the pull, so it cannot be used.",
};

export interface OwnerImageService {
  /** The owner's own entries (approved on the page, or pinned from the env list), as stored. */
  list(): Promise<OwnerServiceImage[]>;
  /** Approves one image the owner chose: pulls it through Docker, pins the digest Docker resolved, stores it. The caller (the page) has checked that the owner is here and the form is fresh and single-use. */
  approve(input: { requested: string; project?: string | undefined }): Promise<ImageApproval>;
  /** Stores the pin of an env-list entry (the first time it was pulled). Not an approval from the page: the env list is the owner's own setting. */
  storePin(image: OwnerServiceImage): Promise<void>;
  /** Forgets an approval (it stops being offered from the next `rovara up`). With an origin, only the entry of that origin. */
  remove(reference: string, origin?: OwnerServiceImage["origin"]): Promise<boolean>;
  /** The page's view of the install: the starter list, the owner's entries, and which are in effect since this `rovara up`. */
  view(): Promise<OwnerImagesView>;
  /** Set once at install: the references that are in effect (on this computer, in the guard's list) since this `rovara up`. */
  setInEffect(references: readonly string[], envRequested: readonly string[]): void;
}

export interface OwnerImagesView {
  starter: Array<{ requested: string; registry: string; reference: string; source: string; inEffect: boolean }>;
  owned: Array<{ family: OwnerImageFamily; version: string; requested: string; registry: string; reference: string; origin: "page" | "env"; approvedAt: string; inEffect: boolean; /** An env entry that is no longer in the variable. */ stale: boolean }>;
  envRequested: string[];
}

export function createOwnerImageService(input: { store: OwnerImageStore; docker: DockerRunner; now: () => number; audit?: AuditSink | undefined; companyId?: string | undefined; log?: ((entry: Record<string, unknown>) => void) | undefined }): OwnerImageService {
  let inEffect = new Set<string>();
  let envRequested: string[] = [];
  const log = input.log ?? (() => undefined);
  const audit = async (action: string, image: Pick<OwnerServiceImage, "reference" | "requested">): Promise<void> => {
    if (input.audit === undefined || input.companyId === undefined) return;
    await input.audit.record({ eventId: `test_services.${action}.${image.reference}.${String(input.now())}`, companyId: input.companyId, at: new Date(input.now()).toISOString(), actor: { type: "person", id: "owner" }, action: `test_services.${action}`, details: { reference: image.reference, requested: image.requested } }).catch(() => undefined);
  };
  return {
    list: () => input.store.list(),
    storePin: (image) => input.store.put(image),
    async approve({ requested, project }) {
      const asked = ownerImageRequest(requested);
      if (!asked.ok) return { ok: false, reason: "refused", message: OWNER_IMAGE_REFUSALS[asked.reason] };
      // A starter's place (the same family and major version) is Rovara's: an image with another digest cannot take it, and one with the same digest needs no approval.
      const starter = starterImageFor(asked.family, asked.version);
      if (starter !== undefined) return { ok: false, reason: "builtin", message: `${starter.requested} is built in at a pinned digest, so no other build of it can take its place here. Rovara's release updates the built-in images.` };
      const pinned = await pinImageThroughDocker(input.docker, asked.reference);
      if (!pinned.ok) return { ok: false, reason: "pin_failed", message: PIN_FAILURES[pinned.reason] };
      const image: OwnerServiceImage = {
        reference: pinned.reference, family: asked.family, version: asked.version, requested: asked.requested, origin: "page", approvedAt: new Date(input.now()).toISOString(),
        ...(project === undefined ? {} : { project: project.slice(0, 128) }),
      };
      await input.store.put(image);
      log({ component: "test-services", event: "test_services.image_approved", family: image.family });
      await audit("image_approved", image);
      return { ok: true, image };
    },
    async remove(reference, origin) {
      const found = (await input.store.list()).find((image) => image.reference === reference && (origin === undefined || image.origin === origin));
      const removed = await input.store.remove(reference, origin);
      if (removed && found !== undefined) await audit("image_removed", found);
      return removed;
    },
    setInEffect(references, requested) { inEffect = new Set(references); envRequested = [...requested]; },
    async view() {
      const stored = await input.store.list();
      return {
        starter: OWNER_STARTER_IMAGES.map((image) => ({ requested: image.requested, registry: parseImageReference(image.reference)?.registry ?? "", reference: image.reference, source: image.source, inEffect: inEffect.has(image.reference) })),
        owned: stored.map((image) => ({
          family: image.family, version: image.version, requested: image.requested, registry: parseImageReference(image.reference)?.registry ?? "", reference: image.reference, origin: image.origin, approvedAt: image.approvedAt, inEffect: inEffect.has(image.reference),
          stale: image.origin === "env" && !envRequested.includes(image.requested),
        })),
        envRequested: [...envRequested],
      };
    },
  };
}

/** What the page says for a stored image: `postgres:15 from Docker Hub`. */
export function describeStored(image: Pick<OwnerServiceImage, "requested">): string {
  const parsed = parseImageReference(image.requested);
  return parsed === undefined ? image.requested : describeImage(parsed);
}

// ---- the list in effect at `rovara up`

export interface ResolvedOwnerImages {
  /** The entries in effect: the starter list first, then the owner's. Only images that are on this computer by digest. */
  entries: OwnerListEntry[];
  /** The references that could not be pulled (left out). */
  failed: string[];
  /** The env list as written, for the page. */
  envRequested: string[];
}

/** The tokens of the env list: at most 16, each a plain reference. Anything unreadable is dropped (and logged by the caller as a count). */
function envTokens(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(",").map((part) => part.trim()).filter((part) => part !== ""))].slice(0, 16);
}

/**
 * The images that are in effect for this `rovara up`: the starter list, the owner's approvals and the env list, each present on this computer by digest (a missing one is pulled by digest; one that cannot be is left out and logged).
 * An env entry given as a tag is pinned the first time (pulled, the digest Docker resolved is stored) and the stored pin is reused after; one that names a starter's place is ignored (the starter is already there). An env pin
 * that is no longer in the variable is removed. Never throws: a store that cannot be read counts as holding nothing.
 */
export async function resolveOwnerImages(input: {
  service: OwnerImageService; environment: NodeJS.ProcessEnv; docker: DockerRunner; now: () => number; log?: ((entry: Record<string, unknown>) => void) | undefined;
}): Promise<ResolvedOwnerImages> {
  const log = input.log ?? (() => undefined);
  const tokens = envTokens(input.environment[TEST_SERVICE_IMAGES_VARIABLE]);
  let stored: OwnerServiceImage[] = [];
  try { stored = await input.service.list(); } catch { log({ component: "test-services", event: "test_services.owner_list_unreadable" }); }
  const wanted: OwnerListEntry[] = [...ownerStarterEntries()];
  // 1. what the owner approved on the page
  for (const image of stored) if (image.origin === "page") wanted.push({ reference: image.reference, family: image.family, version: image.version });
  // 2. the env list
  for (const token of tokens) {
    const parsed = parseImageReference(token);
    const asked = parsed === undefined ? undefined : parsed.digest !== undefined ? ownerImageRequest(token.slice(0, token.indexOf("@"))) : ownerImageRequest(token);
    if (parsed === undefined || asked === undefined || !asked.ok) { log({ component: "test-services", event: "test_services.env_image_refused" }); continue; }
    if (starterImageFor(asked.family, asked.version) !== undefined) { log({ component: "test-services", event: "test_services.env_image_builtin" }); continue; }
    // An image the owner approved on the page for this family and version stands: the env list never overwrites or shadows an approval.
    if (stored.some((image) => image.origin === "page" && ownerCatalogIdOf(image.family, image.version) === ownerCatalogIdOf(asked.family, asked.version))) { log({ component: "test-services", event: "test_services.env_image_approved_on_page" }); continue; }
    if (parsed.digest !== undefined) { wanted.push({ reference: pinnedImageReference(parsed, parsed.digest), family: asked.family, version: asked.version }); continue; }
    const kept = stored.find((image) => image.origin === "env" && image.requested === token);
    if (kept !== undefined) { wanted.push({ reference: kept.reference, family: kept.family, version: kept.version }); continue; }
    const pinned = await pinImageThroughDocker(input.docker, asked.reference);
    if (!pinned.ok) { log({ component: "test-services", event: "test_services.env_image_not_pinned", reason: pinned.reason }); continue; }
    const image: OwnerServiceImage = { reference: pinned.reference, family: asked.family, version: asked.version, requested: token, origin: "env", approvedAt: new Date(input.now()).toISOString() };
    wanted.push({ reference: image.reference, family: image.family, version: image.version });
    await input.service.storePin(image).catch(() => log({ component: "test-services", event: "test_services.env_pin_not_stored" }));
  }
  // An env pin that the variable no longer names goes (so naming it again pins it afresh).
  for (const image of stored) if (image.origin === "env" && !tokens.includes(image.requested)) await input.service.remove(image.reference, "env").catch(() => false);
  const entries: OwnerListEntry[] = [];
  const failed: string[] = [];
  for (const entry of normalizeOwnerList(wanted)) {
    if (await ensureImagePresent(input.docker, entry.reference)) entries.push(entry);
    else { failed.push(entry.reference); log({ component: "test-services", event: "test_services.image_not_pulled", reference: entry.reference }); }
  }
  return { entries, failed, envRequested: tokens };
}

/** Whether a reference is one the guard may list: pinned, with a digest, and (for the starter) from the source list. Re-exported for the page. */
export { isStarterReference };
