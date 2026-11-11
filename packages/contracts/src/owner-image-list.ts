// Test services on a laptop: the OWNER'S OWN approved image list, used where Cloud uses its signed catalog.
//
// Rovara Code ships no catalog signing key, so a signed catalog never verifies and test services stayed off. On a laptop the person who owns the machine decides which service images may run, the same way
// they decide which registries a dev container may pull from. This file is the pure part of that:
//   - reading an image reference the way Docker does (`postgres:16` is `docker.io/library/postgres:16`), and refusing anything that is not a plain, lower-case name;
//   - the closed list of families Rovara knows how to run safely (Postgres, MySQL, Redis/Valkey, MongoDB) and the fixed run profile of each (non-root user, memory, processes, tmpfs, ports, health check, reset): the profile is in
//     CODE, reviewed once, never read from the image, the repository or the owner's list;
//   - the entry the owner's Docker pinned (`registry/repository@sha256:<digest>`) and the one catalog `ownerCatalogOf` builds from a list of them.
// The catalog it builds is marked verified (so the broker, the worker and the guard's list all work from one shape) AND as an owner-list catalog, which `resolveCatalogImage` (the rule Cloud keeps) refuses and which a signed
// catalog can never be (`loadSignedCatalog` refuses an entry with `ownerApproved`). Nothing in this file reads a file, an environment variable or Docker: the owner's approval, the digest and the list are the broker's.
import { z } from "zod";
import { registerOwnerListCatalog, isOwnerListCatalog } from "./service-catalog-brand.js";
import { ServiceCatalogSchema, type CatalogEntry, type ServiceCatalog } from "./service-catalog.js";
import type { VerifiedCatalog } from "./service-catalog-images.js";

export { isOwnerListCatalog };

// ---- reading a reference

const REGISTRY = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u;
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const DIGEST = /^sha256:([a-f0-9]{64})$/u;
export const OWNER_IMAGE_DEFAULT_REGISTRY = "docker.io";
export const OWNER_IMAGE_REFERENCE_MAX = 300;

export interface ImageReference {
  /** The registry host (with an optional port). `docker.io` for a name with no host; `index.docker.io` and `registry-1.docker.io` are `docker.io`. */
  registry: string;
  /** The repository path; a Docker Hub name with no `/` is under `library/`. */
  repository: string;
  tag?: string;
  /** The 64 hex characters of a `@sha256:` digest. */
  digest?: string;
}

/**
 * An image reference as Docker reads it, or undefined for anything that is not a plain one: lower-case names only, no scheme, no credentials, no spaces or control characters, a digest only in the `@sha256:<64 hex>` form.
 * A first part is a registry host only when it holds a `.` or a `:` or is `localhost` (Docker's own rule).
 */
export function parseImageReference(text: unknown): ImageReference | undefined {
  // eslint-disable-next-line no-control-regex -- a reference is one line of plain text
  if (typeof text !== "string" || text.length === 0 || text.length > OWNER_IMAGE_REFERENCE_MAX || /[\s\u0000-\u001f\u007f]/u.test(text)) return undefined;
  let rest = text;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    const found = DIGEST.exec(rest.slice(at + 1));
    if (found === null) return undefined;
    digest = found[1];
    rest = rest.slice(0, at);
  }
  const parts = rest.split("/");
  let registry: string = OWNER_IMAGE_DEFAULT_REGISTRY;
  if (parts.length > 1 && (parts[0]!.includes(".") || parts[0]!.includes(":") || parts[0] === "localhost")) registry = parts.shift()!;
  const lastIndex = parts.length - 1;
  const colon = parts[lastIndex]!.lastIndexOf(":");
  let tag: string | undefined;
  if (colon >= 0) {
    tag = parts[lastIndex]!.slice(colon + 1);
    parts[lastIndex] = parts[lastIndex]!.slice(0, colon);
    if (!TAG.test(tag)) return undefined;
  }
  if (parts.some((part) => !PATH_COMPONENT.test(part))) return undefined;
  if (registry === "index.docker.io" || registry === "registry-1.docker.io") registry = OWNER_IMAGE_DEFAULT_REGISTRY;
  if (!REGISTRY.test(registry)) return undefined;
  if (registry === OWNER_IMAGE_DEFAULT_REGISTRY && parts.length === 1) parts.unshift("library");
  const repository = parts.join("/");
  if (registry.length + repository.length > 250) return undefined;
  return { registry, repository, ...(tag === undefined ? {} : { tag }), ...(digest === undefined ? {} : { digest }) };
}

/** `registry/repository` of a parsed reference: the name an image has with no tag or digest. */
export const imageNameOf = (reference: Pick<ImageReference, "registry" | "repository">): string => `${reference.registry}/${reference.repository}`;

/** `registry/repository@sha256:<digest>`: the only form in which an owner-approved image is ever started, inspected or pulled. */
export const pinnedImageReference = (reference: Pick<ImageReference, "registry" | "repository">, digest: string): string => `${imageNameOf(reference)}@sha256:${z.string().regex(/^[a-f0-9]{64}$/u).parse(digest)}`;

/** How a person reads where an image comes from: "Docker Hub" for docker.io, otherwise the host. */
export const registryLabelOf = (registry: string): string => (registry === OWNER_IMAGE_DEFAULT_REGISTRY ? "Docker Hub" : registry);

/** The image as a person reads it: `postgres:16 from Docker Hub` (the official Docker Hub images lose their `library/`). */
export function describeImage(reference: ImageReference): string {
  const name = reference.registry === OWNER_IMAGE_DEFAULT_REGISTRY && reference.repository.startsWith("library/") ? reference.repository.slice("library/".length) : reference.repository;
  return `${name}${reference.tag === undefined ? "" : `:${reference.tag}`}${reference.digest === undefined ? "" : `@sha256:${reference.digest.slice(0, 12)}...`} from ${registryLabelOf(reference.registry)}`;
}

// ---- the families Rovara runs

export const OWNER_IMAGE_FAMILIES = ["postgres", "mysql", "redis", "mongodb"] as const;
export type OwnerImageFamily = (typeof OWNER_IMAGE_FAMILIES)[number];
export const OwnerImageFamilySchema = z.enum(OWNER_IMAGE_FAMILIES);

/** The family an image is by its repository's last name (`postgres`, `mysql`, `redis`, `mongo`; `valkey` runs as Redis), or undefined for any other image: nothing else has a run profile, so nothing else can be approved. */
export function familyOfRepository(repository: string): OwnerImageFamily | undefined {
  const name = repository.split("/").at(-1);
  return name === "postgres" ? "postgres" : name === "mysql" ? "mysql" : name === "redis" || name === "valkey" ? "redis" : name === "mongo" ? "mongodb" : undefined;
}

/** The version a tag names (`16`, `16.4`, `16.4-alpine`, `v7.2`: the leading numbers), or undefined for a tag with none (`latest`, `stable`, a branch name). */
export function versionOfTag(tag: string | undefined): string | undefined {
  return tag === undefined ? undefined : /^v?(\d{1,3}(?:\.\d{1,3}){0,2})(?:[.-]|$)/u.exec(tag)?.[1];
}
export const majorOfVersion = (version: string): string => version.split(".")[0] ?? version;
/** The catalog id an owner-approved image has: `postgres@16`. */
export const ownerCatalogIdOf = (family: OwnerImageFamily, version: string): string => `${family}@${majorOfVersion(version)}`;

/**
 * What Rovara starts a family with, fixed here and read from nowhere else: the same profile the signed catalog gives Postgres 16, MySQL 8 and Redis 7 (a non-root user, a read-only root, bounded memory, processes and CPUs, only
 * named tmpfs mounts that fit in the memory, one port, a health check from the closed list, the reset kind). The official Debian-based images run as user 999; an image that expects another user fails its health check.
 */
const PROFILES: Record<OwnerImageFamily, Pick<CatalogEntry, "run" | "health" | "resources" | "connect" | "reset">> = {
  postgres: {
    run: { user: "999:999", readOnlyRoot: true, tmpfs: [{ path: "/var/lib/postgresql/data", sizeMiB: 256 }, { path: "/run/postgresql", sizeMiB: 8 }, { path: "/tmp", sizeMiB: 32 }], ports: [5432], extraArgs: ["postgres_fsync_off", "postgres_synchronous_commit_off", "postgres_full_page_writes_off"] },
    health: { kind: "command", check: "pg_isready", startTimeoutS: 30 },
    resources: { memMiB: 512, cpus: 1, pids: 256 },
    connect: { templates: { DATABASE_URL: "postgres://{user}:{password}@{host}:{port}/{db}", PGHOST: "{host}", PGPORT: "{port}", PGUSER: "{user}", PGPASSWORD: "{password}", PGDATABASE: "{db}" }, defaultAliases: ["postgres"] },
    reset: { kind: "template_db" },
  },
  mysql: {
    run: { user: "999:999", readOnlyRoot: true, tmpfs: [{ path: "/var/lib/mysql", sizeMiB: 384 }, { path: "/run/mysqld", sizeMiB: 8 }, { path: "/tmp", sizeMiB: 32 }], ports: [3306], extraArgs: ["mysql_skip_log_bin", "mysql_flush_log_lazily"] },
    health: { kind: "command", check: "mysqladmin_ping", startTimeoutS: 90 },
    resources: { memMiB: 768, cpus: 1, pids: 256 },
    connect: { templates: { DATABASE_URL: "mysql://{user}:{password}@{host}:{port}/{db}", MYSQL_HOST: "{host}", MYSQL_TCP_PORT: "{port}" }, defaultAliases: ["mysql"] },
    reset: { kind: "restart" },
  },
  redis: {
    run: { user: "999:999", readOnlyRoot: true, tmpfs: [{ path: "/data", sizeMiB: 32 }, { path: "/tmp", sizeMiB: 16 }], ports: [6379], extraArgs: ["redis_save_off", "redis_appendonly_off"] },
    health: { kind: "command", check: "redis_ping", startTimeoutS: 15 },
    resources: { memMiB: 128, cpus: 0.5, pids: 64 },
    connect: { templates: { REDIS_URL: "redis://:{password}@{host}:{port}" }, defaultAliases: ["redis"] },
    reset: { kind: "flush" },
  },
  // The official image run as its own non-root user (999); no authentication: the run network is sealed (no route in or out but the run's own containers), a connection template may not carry the `authSource` a Mongo login needs, and a per-run root user would be useless without it. A plain TCP health check (the closed command list has no Mongo client).
  mongodb: {
    run: { user: "999:999", readOnlyRoot: true, tmpfs: [{ path: "/data/db", sizeMiB: 256 }, { path: "/data/configdb", sizeMiB: 8 }, { path: "/tmp", sizeMiB: 32 }], ports: [27017], extraArgs: [] },
    health: { kind: "tcp", port: 27017, startTimeoutS: 60 },
    resources: { memMiB: 512, cpus: 1, pids: 512 },
    connect: { templates: { MONGODB_URL: "mongodb://{host}:{port}/{db}" }, defaultAliases: ["mongo"] },
    reset: { kind: "restart" },
  },
};

// ---- the owner's entries

const Hex64 = /^[a-f0-9]{64}$/u;

/** The least an entry carries that the worker needs to rebuild the same catalog: the pinned reference, its family and its version. */
export const OwnerListEntrySchema = z
  .object({ reference: z.string().max(OWNER_IMAGE_REFERENCE_MAX), family: OwnerImageFamilySchema, version: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){0,2}$/u) })
  .strict()
  .superRefine((entry, context) => {
    const parsed = parseImageReference(entry.reference);
    // Pinned means a digest and NOTHING else: a tag is a name that can move, so a reference with one is refused here, in the broker, in the worker and in the guard's list alike.
    if (parsed === undefined || parsed.digest === undefined || parsed.tag !== undefined || !Hex64.test(parsed.digest)) context.addIssue({ code: "custom", path: ["reference"], message: "an owner-approved image is named by registry, repository and digest only" });
    else if (entry.reference !== pinnedImageReference(parsed, parsed.digest)) context.addIssue({ code: "custom", path: ["reference"], message: "the reference is written in its full form" });
    else if (familyOfRepository(parsed.repository) !== entry.family) context.addIssue({ code: "custom", path: ["family"], message: "the family is the image's own" });
  });
export type OwnerListEntry = z.infer<typeof OwnerListEntrySchema>;

/** What Code keeps for each image the owner approved (or a script listed): the entry and how and when it came to be approved. */
export const OwnerServiceImageSchema = z
  .object({
    reference: OwnerListEntrySchema.shape.reference,
    family: OwnerImageFamilySchema,
    version: OwnerListEntrySchema.shape.version,
    /** What was approved, as the person saw it and as Docker resolved it: `postgres:16` (a tag). The pin below is what counts. */
    requested: z.string().max(OWNER_IMAGE_REFERENCE_MAX),
    /** `page`: approved on the test environment page. `env`: named in `ROVARA_TEST_SERVICE_IMAGES` and pinned the first time it was pulled. */
    origin: z.enum(["page", "env"]),
    approvedAt: z.string().datetime(),
    /** The project page it was approved from (shown only: an approval is the install's). */
    project: z.string().max(128).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (!OwnerListEntrySchema.safeParse({ reference: entry.reference, family: entry.family, version: entry.version }).success) context.addIssue({ code: "custom", path: ["reference"], message: "not a pinned owner-approved image" });
    if (parseImageReference(entry.requested) === undefined) context.addIssue({ code: "custom", path: ["requested"], message: "not an image reference" });
  });
export type OwnerServiceImage = z.infer<typeof OwnerServiceImageSchema>;

/** The version and family a tag-form reference stands for, or the reason it cannot be approved. Pure: nothing is pulled. */
export type OwnerImageRequest =
  | { ok: true; requested: string; reference: ImageReference & { tag: string }; family: OwnerImageFamily; version: string }
  | { ok: false; reason: "not_a_reference" | "has_digest" | "no_tag" | "unsupported_family" | "no_version" };

export const OWNER_IMAGE_REFUSALS: Record<Extract<OwnerImageRequest, { ok: false }>["reason"], string> = {
  not_a_reference: "That is not an image name Rovara can read (a plain lower-case name such as postgres:16).",
  has_digest: "Name the image with a tag such as postgres:16: Rovara pins the digest itself when you approve it.",
  no_tag: "Name the image with a version tag such as postgres:16: a name with no tag changes under you.",
  unsupported_family: "Rovara can run Postgres, MySQL, Redis (or Valkey) and MongoDB images here. Any other image has no safe profile yet.",
  no_version: "The tag has to start with a version number, such as 16 or 7.2, so Rovara knows which one it is.",
};

/** What `requested` (a tag-form reference such as `postgres:16`) would approve. */
export function ownerImageRequest(requested: unknown): OwnerImageRequest {
  const parsed = parseImageReference(requested);
  if (parsed === undefined) return { ok: false, reason: "not_a_reference" };
  if (parsed.digest !== undefined) return { ok: false, reason: "has_digest" };
  if (parsed.tag === undefined) return { ok: false, reason: "no_tag" };
  const family = familyOfRepository(parsed.repository);
  if (family === undefined) return { ok: false, reason: "unsupported_family" };
  const version = versionOfTag(parsed.tag);
  if (version === undefined) return { ok: false, reason: "no_version" };
  return { ok: true, requested: requested as string, reference: { ...parsed, tag: parsed.tag }, family, version };
}

/**
 * The valid entries of a list, one per catalog id, sorted by id. When two name the same family and major version the FIRST in the order given is kept (the broker lists the built-in starter images first, so an image can never take
 * a starter's place). The broker, the worker and the guard's image list all use this, so they agree.
 */
export function normalizeOwnerList(entries: readonly unknown[]): OwnerListEntry[] {
  const seen = new Set<string>();
  const kept = entries.flatMap((entry): OwnerListEntry[] => {
    const parsed = OwnerListEntrySchema.safeParse(entry);
    if (!parsed.success) return [];
    const id = ownerCatalogIdOf(parsed.data.family, parsed.data.version);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ reference: parsed.data.reference, family: parsed.data.family, version: parsed.data.version }];
  });
  return kept.sort((a, b) => (ownerCatalogIdOf(a.family, a.version) < ownerCatalogIdOf(b.family, b.version) ? -1 : 1));
}

/** The key a plan names an owner-approved image by: its catalog repository and digest. */
export const ownerImageKey = (repository: string, digest: string): string => `${repository}@sha256:${digest}`;

/** The references an owner list lets start, by key (`svc/postgres@sha256:<digest>`): what the worker turns a plan's repository and digest back into. */
export function ownerImageReferences(entries: readonly unknown[]): Map<string, string> {
  const references = new Map<string, string>();
  for (const entry of normalizeOwnerList(entries)) {
    const parsed = parseImageReference(entry.reference);
    if (parsed?.digest !== undefined) references.set(ownerImageKey(`svc/${entry.family}`, parsed.digest), entry.reference);
  }
  return references;
}

/** The full digest references of a list, in its order: what the guard lets start. */
export const ownerListReferences = (entries: readonly unknown[]): string[] => normalizeOwnerList(entries).map((entry) => entry.reference);

export const OWNER_LIST_CATALOG_REVISION = 1_000;
/** The registry host and environment name an owner-list install gives the worker where the signed path gives its mirror: placeholders, never used to name an image (an `.invalid` host resolves nowhere). The images are named by `ownerImageReferences`. */
export const OWNER_LIST_REGISTRY = "owner-list.invalid";
export const OWNER_LIST_CATALOG_ENV = "owner";

/**
 * The catalog of an owner list, or undefined for an empty one. Every entry is `backing: "local"`, `ownerApproved`, digest-pinned, in the public edition, with the family's fixed profile; there is no emulator, fake or helper entry, so a
 * dependency that needs one is "not available yet" at the broker. The highest version of each family is its default. Deterministic: the same list gives the same catalog in the broker and in the worker.
 */
export function ownerCatalogOf(entries: readonly unknown[]): VerifiedCatalog | undefined {
  const list = normalizeOwnerList(entries);
  if (list.length === 0) return undefined;
  const highest = new Map<OwnerImageFamily, number>();
  for (const entry of list) highest.set(entry.family, Math.max(highest.get(entry.family) ?? -1, Number(majorOfVersion(entry.version))));
  const catalogEntries = list.map((entry): CatalogEntry => {
    const digest = parseImageReference(entry.reference)!.digest!;
    const profile = PROFILES[entry.family];
    return {
      id: ownerCatalogIdOf(entry.family, entry.version), family: entry.family, backing: "local", version: entry.version,
      status: Number(majorOfVersion(entry.version)) === highest.get(entry.family) ? "default" : "available",
      image: { repository: `svc/${entry.family}`, digest, platforms: ["linux/arm64", "linux/amd64"] },
      run: structuredClone(profile.run), health: structuredClone(profile.health), resources: structuredClone(profile.resources), connect: structuredClone(profile.connect), reset: structuredClone(profile.reset),
      licence: "owner-approved", editions: ["public"], ownerApproved: true,
    };
  });
  const catalog: ServiceCatalog = ServiceCatalogSchema.parse({ schemaVersion: 1, revision: OWNER_LIST_CATALOG_REVISION, pinned: true, entries: catalogEntries });
  return registerOwnerListCatalog(catalog);
}
