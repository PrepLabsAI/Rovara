// Test services, TS19 (design test-services.md, sections 2.5, 4.1.5, 5.3 and 10): what the catalog's PINS mean once the images are mirrored. Pure logic, no Node module and no I/O:
//
//   - where a catalog image lives in a registry (`rovara-catalog/<env>/<repository>`) and how it is named in a pull: always by digest, never by a tag;
//   - the worker pre-pull list, generated from the pinned catalog;
//   - the Enterprise signed bundle: the bundle image name of a catalog entry, and a check that a bundle holds exactly the digests the catalog pins;
//   - `resolveCatalogImage`: the one place that decides which digest a backing may start (owner Q9). It takes a `VerifiedCatalog` (only `loadSignedCatalog` returns one) and, for what the install serves, the RESULT of a
//     digest check (`MirrorCheck` from the registry check, or `BundleImageCheck` from `checkBundleImages`), never a bare digest. The image served must be the catalog's digest. A company-built substitute is allowed only for an Enterprise
//     install, only for a local (real software) entry, and only when DC-TS-1's two checks hold:
//       1. `substituteImage.catalogDigest` equals the digest of the catalog entry named by the backing's `catalogId`;
//       2. `substituteImage.approvalRef` resolves, through the `SubstituteApprovalPort`, to an admin approval whose catalog id is that `catalogId` and whose two digests are exactly the substitute's
//          `catalogDigest` and `digest` (an approval for one image or one digest pair never covers another).
//     A mismatch without an approved substitute stops THAT image only (`resolveCatalogImages` never throws and never lets one image's refusal reach another).
//
// The approval record itself is a later task (TS40): this file knows it only as a port that returns a live approval or nothing.
import { z } from "zod";
import { type CATALOG_EDITIONS, type CatalogEntry, type ServiceCatalog, catalogEntryById } from "./service-catalog.js";
import { CatalogIdSchema, SubstituteImageSchema, catalogIdName, type SubstituteImage } from "./test-env-dependency.js";
import { isBundleCheck, isMirrorCheck, isOwnerListCatalog, isVerifiedCatalog, registerBundleCheck } from "./service-catalog-brand.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type CatalogEdition = (typeof CATALOG_EDITIONS)[number];

declare const verifiedCatalogBrand: unique symbol;
/**
 * A catalog whose signature was checked over its exact bytes and whose strict schema held. The ONLY function that returns one is `loadSignedCatalog` (service-catalog-verify.ts); `resolveCatalogImage` takes nothing
 * else, so an unsigned or hand-built catalog cannot decide which image starts. The brand is also checked at run time (a private registry, `service-catalog-brand.ts`): a raw or cloned catalog is refused.
 */
export type VerifiedCatalog = ServiceCatalog & { readonly [verifiedCatalogBrand]: true };

// ---- where an image lives

/** Every catalog repository is under this root in the install's registry: `rovara-catalog/<env>/svc/<name>`. */
export const CATALOG_REGISTRY_ROOT = "rovara-catalog";
const EnvNameForRegistry = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/u);
const CatalogRepositorySchema = z.string().regex(/^svc\/[a-z0-9][a-z0-9._-]{0,62}$/u);
/** A registry host with an optional port: no scheme, no path, no credentials. */
export const CatalogRegistryHostSchema = z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u, "a registry host name, with an optional port");

/** The registry repository of a catalog repository (`svc/postgres`) in a named environment. Refuses anything that is not a name the catalog makes. */
export function catalogRepositoryName(env: string, repository: string): string {
  return `${CATALOG_REGISTRY_ROOT}/${EnvNameForRegistry.parse(env)}/${CatalogRepositorySchema.parse(repository)}`;
}

/**
 * The repositories of the released catalog (`environments/service-catalog/catalog.json`), for code that cannot read the file (the CDK app is bundled for an Enterprise install). A contract test compares it with the
 * data file, so a catalog release that adds a repository fails until this list says so.
 */
export const SERVICE_CATALOG_REPOSITORIES: readonly string[] = ["svc/dns-helper", "svc/fake-server", "svc/local-aws", "svc/mysql", "svc/postgres", "svc/rabbitmq", "svc/redis", "svc/test-account-proxy", "svc/valkey"];

/** The distinct repositories of a catalog, sorted. One registry repository exists per entry of this list (postgres 15, 16 and 17 share one). */
export function catalogRepositories(catalog: ServiceCatalog): string[] {
  return [...new Set(catalog.entries.map((entry) => entry.image.repository))].sort();
}

/** `<registry>/<repository name>@sha256:<digest>`: the only form in which a catalog image is ever named for a pull. A tag cannot be built with this function. */
export function catalogImageReference(input: { registry: string; repositoryName: string; digest: string }): string {
  const registry = CatalogRegistryHostSchema.parse(input.registry);
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(input.repositoryName) || input.repositoryName.length > 256) throw new Error("not a registry repository name");
  return `${registry}/${input.repositoryName}@sha256:${Sha256Schema.parse(input.digest)}`;
}

// ---- the pinned images

export interface CatalogPin {
  readonly id: string;
  readonly repository: string;
  readonly digest: string;
  readonly platforms: readonly string[];
  readonly editions: readonly CatalogEdition[];
}

/** The entries that can be started: not retired, and pinned. An unpinned catalog has none. */
export function catalogPins(catalog: ServiceCatalog, edition?: CatalogEdition): CatalogPin[] {
  if (!catalog.pinned) return [];
  return catalog.entries.flatMap((entry) => {
    if (entry.status === "retired" || entry.image.digest === undefined) return [];
    if (edition !== undefined && !entry.editions.includes(edition)) return [];
    return [{ id: entry.id, repository: entry.image.repository, digest: entry.image.digest, platforms: [...entry.image.platforms], editions: [...entry.editions] }];
  });
}

// ---- the worker pre-pull list

/** The helpers every run uses, whatever the project: pulled ahead with the defaults. Test-account proxies are not here (only with `ta`). */
export const PREPULL_ALWAYS_HELPER_NAMES = ["dns-helper"] as const;
export const PREPULL_MAX_IMAGES = 16;

export const PrepullListSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The revision of the pinned catalog this list was made from. */
    catalogRevision: z.number().int().min(1),
    images: z
      .array(z.object({ id: CatalogIdSchema, repository: CatalogRepositorySchema, digest: Sha256Schema, platforms: z.array(z.enum(["linux/arm64", "linux/amd64"])).min(1).max(2) }).strict())
      .max(PREPULL_MAX_IMAGES),
  })
  .strict()
  .superRefine((list, context) => {
    const ids = list.images.map((image) => image.id);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["images"], message: "an id is listed once" });
  });
export type PrepullList = z.infer<typeof PrepullListSchema>;

/**
 * The images a worker pulls ahead of its first run, sorted by id: EVERY pinned, non-retired entry that a run can start from a real image (backing `local` or `emulated`: Postgres 15/16/17, MySQL, Valkey, Redis, RabbitMQ, the
 * emulator), plus the pinned defaults of the other families (the fake server) and the always-used helpers. A `helper` that is not always used (the test-account proxy, only with `ta`) and a non-default `fake` are not here. An unpinned
 * catalog gives an empty list (nothing is pulled before there is a digest). The broker refuses any dependency whose entry is not in this list (`isPrepulledEntry`), because the worker pulls nothing at run time.
 * It names a repository and a digest and nothing else: the registry host is the install's.
 */
export function catalogPrepullList(catalog: ServiceCatalog): PrepullList {
  const images = catalog.entries
    .filter((entry) => catalog.pinned && entry.status !== "retired" && entry.image.digest !== undefined
      && (entry.backing === "local" || entry.backing === "emulated" || entry.status === "default" || (PREPULL_ALWAYS_HELPER_NAMES as readonly string[]).includes(catalogIdName(entry.id))))
    .map((entry) => ({ id: entry.id, repository: entry.image.repository, digest: entry.image.digest as string, platforms: [...entry.image.platforms] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return PrepullListSchema.parse({ schemaVersion: 1, catalogRevision: catalog.revision, images });
}

// ---- the Enterprise signed bundle

/** The name of a catalog image inside a release bundle (`svc-postgres-16`). Within the bundle's own name rule (BundleImageName). */
export function catalogBundleImageName(catalogId: string): string {
  CatalogIdSchema.parse(catalogId);
  const name = `svc-${catalogId.replace("@", "-").replace(/[._]/gu, "-").toLowerCase()}`;
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/u.test(name)) throw new Error(`catalog id ${catalogId} makes a bundle image name that is too long`);
  return name;
}

/** The images a bundle must carry for this catalog's Enterprise entries: name and digest reference, for the bundle builder. `source` is the registry the images were mirrored into and the environment it is for. */
export function catalogBundleImages(catalog: ServiceCatalog, source: { registry: string; env: string }): Array<{ name: string; sourceRef: string }> {
  const images = catalogPins(catalog, "enterprise").map((pin) => ({
    name: catalogBundleImageName(pin.id),
    sourceRef: catalogImageReference({ registry: source.registry, repositoryName: catalogRepositoryName(source.env, pin.repository), digest: pin.digest }),
  }));
  if (new Set(images.map((image) => image.name)).size !== images.length) throw new Error("two catalog ids make the same bundle image name");
  return images;
}

export type BundleCatalogProblem =
  | { id: string; problem: "missing" }
  | { id: string; problem: "digest_mismatch"; bundleDigest: string }
  | { id: string; problem: "unexpected_image"; bundleImage: string };

/**
 * Whether a signed bundle's image list holds, for every Enterprise entry the catalog pins, an image of the entry's bundle name whose digest is exactly the catalog's. A bundle image with the catalog's name prefix that
 * the catalog does not pin is reported too (a bundle may not carry an image the catalog never reviewed). The bundle's signature is checked elsewhere (`verifyBundleSignature`); this reads the list that signature covers.
 */
export function bundleCatalogProblems(bundle: { images: ReadonlyArray<{ name: string; sourceRef: string }> }, catalog: ServiceCatalog): BundleCatalogProblem[] {
  const problems: BundleCatalogProblem[] = [];
  const digestOf = (reference: string): string | undefined => /@sha256:([a-f0-9]{64})$/u.exec(reference)?.[1];
  const pins = catalogPins(catalog, "enterprise");
  const expectedNames = new Set(pins.map((pin) => catalogBundleImageName(pin.id)));
  for (const pin of pins) {
    const image = bundle.images.find((candidate) => candidate.name === catalogBundleImageName(pin.id));
    if (image === undefined) problems.push({ id: pin.id, problem: "missing" });
    else if (digestOf(image.sourceRef) !== pin.digest) problems.push({ id: pin.id, problem: "digest_mismatch", bundleDigest: digestOf(image.sourceRef) ?? "none" });
  }
  for (const image of bundle.images) {
    if (image.name.startsWith("svc-") && !expectedNames.has(image.name)) problems.push({ id: image.name, problem: "unexpected_image", bundleImage: image.name });
  }
  return problems;
}

/** The result of checking one image of a bundle against the catalog: the bundle holds the catalog's digest (`ok`), or does not (`missing`, `digest_mismatch`). The bundle's own signature is checked elsewhere. */
export type BundleImageCheck =
  | { readonly id: string; readonly ok: true; readonly digest: string }
  | { readonly id: string; readonly ok: false; readonly code: "missing" | "digest_mismatch"; readonly message: string };

/** One result per Enterprise entry the catalog pins; the `digest` of an `ok` result is the digest the bundle's image reference names, which equals the catalog's. */
export function checkBundleImages(bundle: { images: ReadonlyArray<{ name: string; sourceRef: string }> }, catalog: ServiceCatalog): BundleImageCheck[] {
  const digestOf = (reference: string): string | undefined => /@sha256:([a-f0-9]{64})$/u.exec(reference)?.[1];
  return catalogPins(catalog, "enterprise").map((pin): BundleImageCheck => {
    const service = catalogIdName(pin.id);
    const image = bundle.images.find((candidate) => candidate.name === catalogBundleImageName(pin.id));
    if (image === undefined) return registerBundleCheck({ id: pin.id, ok: false, code: "missing", message: `${service} image: the signed bundle does not hold it` });
    return registerBundleCheck(
      digestOf(image.sourceRef) === pin.digest
        ? { id: pin.id, ok: true, digest: pin.digest }
        : { id: pin.id, ok: false, code: "digest_mismatch", message: `${service} image: the signed bundle holds other bytes than the catalog's digest` },
    );
  });
}

/** The result of asking a registry for the manifest of a digest and hashing the bytes (`checkMirrorServesDigest`, service-catalog-verify.ts). */
export type MirrorCheck =
  | { id: string; ok: true; digest: string }
  | { id: string; ok: false; code: "missing" | "digest_mismatch" | "unreachable"; message: string };

// ---- resolving an image to start (owner Q9; DC-TS-1)

export const CATALOG_IMAGE_SOURCES = ["rovara_registry", "signed_bundle", "company_registry"] as const;
/**
 * What the install actually serves for an entry: where it comes from and the RESULT of the check that the source holds a digest (the registry's bytes hashed, or the bundle's image list read). Not a bare digest: a
 * caller has to have run a check to have one, and a check that failed is a refusal.
 */
export type ServedImage =
  | { readonly source: "signed_bundle"; readonly check: BundleImageCheck }
  | { readonly source: "rovara_registry" | "company_registry"; readonly check: MirrorCheck };

/** An admin approval of a substitute image (TS40 makes the record). The port returns a LIVE approval, or nothing (never a revoked one). */
export interface SubstituteApprovalRecord {
  readonly approvalRef: string;
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly digest: string;
}
export interface SubstituteApprovalPort {
  find(approvalRef: string): Promise<SubstituteApprovalRecord | undefined>;
}

export const CATALOG_IMAGE_REFUSALS = [
  "unknown_entry",
  "retired",
  "not_pinned",
  "edition_not_offered",
  "source_not_allowed",
  "digest_mismatch",
  "substitute_not_allowed",
  "substitute_replaces_other_digest",
  "substitute_approval_missing",
  "substitute_approval_mismatch",
  "substitute_not_served",
  "not_verified",
] as const;
export type CatalogImageRefusal = (typeof CATALOG_IMAGE_REFUSALS)[number];

export type ResolvedCatalogImage =
  | { ok: true; id: string; kind: "catalog"; repository: string; digest: string; source: ServedImage["source"] }
  | { ok: true; id: string; kind: "substitute"; repository: string; digest: string; catalogDigest: string; approvalRef: string; source: ServedImage["source"]; label: string }
  | { ok: false; id: string; code: CatalogImageRefusal; message: string };

/** Fixed words (4.1.5 and DC-TS-1). `service` is the catalog id's name part. */
export const CATALOG_IMAGE_MESSAGES: Record<CatalogImageRefusal, (service: string) => string> = {
  unknown_entry: (service) => `${service} is not in the image catalog`,
  retired: (service) => `${service} image is retired in the catalog`,
  not_pinned: (service) => `${service} image has no pinned digest in the catalog`,
  edition_not_offered: (service) => `${service} image is not offered in this edition`,
  source_not_allowed: (service) => `${service} image does not come from a source this edition allows`,
  digest_mismatch: (service) => `${service} image digest does not match the catalog and has no approved substitute`,
  substitute_not_allowed: (service) => `${service} image: a company-built substitute is not allowed here`,
  substitute_replaces_other_digest: (service) => `${service} image: the substitute does not replace the catalog's digest`,
  substitute_approval_missing: (service) => `${service} image: the substitute has no admin approval`,
  substitute_approval_mismatch: (service) => `${service} image: the admin approval is not for this image and these digests`,
  substitute_not_served: (service) => `${service} image: the registry does not serve the approved substitute's digest`,
  not_verified: (service) => `${service} image could not be verified in the registry or bundle`,
};

/** The evidence label of a substitute (2.4): never plain "real". */
export const substituteImageLabel = (catalogId: string): string => `company-approved ${catalogIdName(catalogId)} image`;

export interface ResolveCatalogImageInput {
  /** From `loadSignedCatalog`: nothing else is accepted. */
  readonly catalog: VerifiedCatalog;
  readonly catalogId: string;
  readonly edition: CatalogEdition;
  /** What the install serves for this id, with the result of the digest check. */
  readonly served: ServedImage;
  /** The backing's substitute image, when it names one. */
  readonly substitute?: SubstituteImage | undefined;
  readonly approvals: SubstituteApprovalPort;
}

/** The sources an edition may use: Public pulls from Rovara's registry; Enterprise uses the signed bundle or the company's own registry. */
export const CATALOG_EDITION_SOURCES: Record<CatalogEdition, readonly ServedImage["source"][]> = {
  public: ["rovara_registry"],
  enterprise: ["signed_bundle", "company_registry"],
};

const refuse = (catalogId: string, code: CatalogImageRefusal): ResolvedCatalogImage => ({ ok: false, id: catalogId, code, message: CATALOG_IMAGE_MESSAGES[code](catalogIdName(catalogId)) });

/**
 * Decides whether an image may start, and which digest it is. Fails closed: bad input, a port that throws and every unmet check are refusals, never exceptions. A started image is ALWAYS pinned by digest.
 */
export async function resolveCatalogImage(input: ResolveCatalogImageInput): Promise<ResolvedCatalogImage> {
  const { catalogId } = input;
  try {
    const id = CatalogIdSchema.safeParse(catalogId);
    if (!id.success) return refuse(catalogId, "unknown_entry");
    // Run-time brands (service-catalog-brand.ts): the catalog is the object `loadSignedCatalog` returned, and the check is the object a real checker returned, of the kind the source needs. A raw or cloned catalog, a
    // hand-built check, and a bundle check offered for a registry (or the reverse) are refused, whatever their fields say.
    // An owner-list catalog (a laptop's own approved images, owner-image-list.ts) is never a signed one: the signed-catalog rule refuses it.
    if (!isVerifiedCatalog(input.catalog) || isOwnerListCatalog(input.catalog)) return refuse(catalogId, "not_verified");
    const check = (input.served as { check?: { id?: unknown; ok?: unknown; digest?: unknown } } | undefined)?.check;
    const source = z.enum(CATALOG_IMAGE_SOURCES).safeParse((input.served as { source?: unknown } | undefined)?.source);
    if (!source.success || !(source.data === "signed_bundle" ? isBundleCheck(check) : isMirrorCheck(check))) return refuse(catalogId, "not_verified");
    // The check must also have passed, be for THIS id, and carry a digest: a failed or foreign check is a refusal, whatever else is true.
    if (check === undefined || check === null || check.ok !== true || check.id !== catalogId || !Sha256Schema.safeParse(check.digest).success) return refuse(catalogId, "not_verified");
    const served = { source: source.data, digest: check.digest as string };
    const entry: CatalogEntry | undefined = catalogEntryById(input.catalog, catalogId);
    if (entry === undefined) return refuse(catalogId, "unknown_entry");
    if (entry.status === "retired") return refuse(catalogId, "retired");
    const pinned = entry.image.digest;
    if (!input.catalog.pinned || pinned === undefined) return refuse(catalogId, "not_pinned");
    if (!entry.editions.includes(input.edition)) return refuse(catalogId, "edition_not_offered");
    if (!CATALOG_EDITION_SOURCES[input.edition].includes(served.source)) return refuse(catalogId, "source_not_allowed");
    const repository = entry.image.repository;

    if (input.substitute === undefined) {
      if (served.digest !== pinned) return refuse(catalogId, "digest_mismatch");
      return { ok: true, id: catalogId, kind: "catalog", repository, digest: pinned, source: served.source };
    }

    // A substitute: Enterprise only, and only for real software from the catalog (Rovara's own emulator, fake server and helpers are never swapped).
    const substitute = SubstituteImageSchema.safeParse(input.substitute);
    if (!substitute.success || input.edition !== "enterprise" || entry.backing !== "local") return refuse(catalogId, "substitute_not_allowed");
    // DC-TS-1 check 1: it replaces THIS entry's digest.
    if (substitute.data.catalogDigest !== pinned) return refuse(catalogId, "substitute_replaces_other_digest");
    // DC-TS-1 check 2: an admin approval for this catalog id and exactly this pair of digests.
    // A port that throws (the approval store was unreachable, say) is a refusal of this image, not of the run.
    const approval = await (async () => input.approvals.find(substitute.data.approvalRef))().catch((): undefined => undefined);
    if (approval === undefined) return refuse(catalogId, "substitute_approval_missing");
    if (approval.approvalRef !== substitute.data.approvalRef || approval.catalogId !== catalogId || approval.catalogDigest !== substitute.data.catalogDigest || approval.digest !== substitute.data.digest) {
      return refuse(catalogId, "substitute_approval_mismatch");
    }
    // What starts is the approved digest: the registry must serve exactly it.
    if (served.digest !== substitute.data.digest) return refuse(catalogId, "substitute_not_served");
    return {
      ok: true, id: catalogId, kind: "substitute", repository, digest: substitute.data.digest, catalogDigest: pinned, approvalRef: substitute.data.approvalRef, source: served.source,
      label: substituteImageLabel(catalogId),
    };
  } catch {
    return refuse(catalogId, "unknown_entry");
  }
}

/** Every request resolved on its own. One image's refusal (or failure) never reaches another's result. */
export async function resolveCatalogImages(requests: readonly ResolveCatalogImageInput[]): Promise<ResolvedCatalogImage[]> {
  return Promise.all(requests.map((request) => resolveCatalogImage(request)));
}
