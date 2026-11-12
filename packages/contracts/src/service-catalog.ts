// Test services, TS2 (design test-services.md, section 2.5 and 5.2): the image catalog. The schema of one entry (what Rovara may start as a dependency's backing, and how), and of the data file Rovara releases
// (`environments/service-catalog/catalog.json`). Pure contract and data: nothing reads the file yet.
//
// What the schema itself guarantees, so no builder has to remember it:
//   - an entry is started under a fixed hardening profile (4.1.4): a non-root user, bounded memory, CPUs and processes, a few named tmpfs mounts that fit inside the memory, ports, and a health check
//     from a closed list;
//   - extra start-up arguments come from a CLOSED list of fixed ones (`CATALOG_FIXED_ARGS`), each valid only for the families it names. An entry holds argument ids, never text, so no repository string
//     or free-form flag can become a Docker or process option;
//   - a connection template holds only the run's own placeholders and can never carry a literal password;
//   - the data file is either unpinned (no digest, scan or SBOM anywhere: the v1 state, until the pin task TS19) or pinned (at least one entry, and every pinned entry that is not retired has an image digest, an SBOM
//     and a scan with no critical finding open; an entry not pinned yet carries none of the three); a half-pinned ENTRY does not parse;
//   - at most one entry is the default of a family;
//   - Rovara local AWS (the emulator entry) lists the services it OVERRIDES in four tiers, each service in one tier; every other service of the generated table (`AWS_EMULATOR_SERVICES`) is `available`.
//     IAM is not enforced and storage is memory only.
// Nothing here imports a Node module.
import { z } from "zod";
import { AwsServiceIdSchema, CatalogIdSchema, ConnectTemplateSchema, DnsLabelSchema, EnvNameSchema, TEST_ENV_HELPER_CATALOG_NAMES, TEST_ENV_RESERVED_ALIASES, catalogIdName } from "./test-env-dependency.js";
import { reservedDependencyEnvName } from "./test-services-shared.js";
import { AWS_PLAN_SERVICES_MAX, awsEmulatorServiceRow, awsServiceKeyOrSelf } from "./aws-emulator-service-keys.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const CATALOG_SCHEMA_VERSION = 1;
export const CATALOG_STATUSES = ["default", "available", "retired"] as const;
export const CATALOG_BACKINGS = ["local", "emulated", "fake", "helper"] as const;
export const CATALOG_PLATFORMS = ["linux/arm64", "linux/amd64"] as const;
export const CATALOG_EDITIONS = ["public", "enterprise"] as const;
export const CATALOG_RESET_KINDS = ["template_db", "flush", "http_reset", "restart"] as const;
export const CATALOG_HEALTH_COMMANDS = ["pg_isready", "mysqladmin_ping", "redis_ping", "rabbitmq_ping"] as const;
export const CATALOG_START_TIMEOUT_MAX_S = 120;

/**
 * The fixed start-up arguments an entry may carry, by id. The id is all the data file holds; the arguments are here, in code, reviewed once. `families` lists the catalog families an argument is valid for.
 * Adding one is a catalog release, not a per-project decision (2.5).
 */
export const CATALOG_FIXED_ARGS = {
  postgres_fsync_off: { argv: ["-c", "fsync=off"], families: ["postgres"] },
  postgres_synchronous_commit_off: { argv: ["-c", "synchronous_commit=off"], families: ["postgres"] },
  postgres_full_page_writes_off: { argv: ["-c", "full_page_writes=off"], families: ["postgres"] },
  mysql_skip_log_bin: { argv: ["--skip-log-bin"], families: ["mysql"] },
  mysql_flush_log_lazily: { argv: ["--innodb-flush-log-at-trx-commit=0"], families: ["mysql"] },
  redis_save_off: { argv: ["--save", ""], families: ["redis"] },
  redis_appendonly_off: { argv: ["--appendonly", "no"], families: ["redis"] },
} as const satisfies Record<string, { argv: readonly string[]; families: readonly string[] }>;
export type CatalogFixedArgId = keyof typeof CATALOG_FIXED_ARGS;
export const CATALOG_FIXED_ARG_IDS = Object.keys(CATALOG_FIXED_ARGS) as [CatalogFixedArgId, ...CatalogFixedArgId[]];
export const CatalogFixedArgSchema = z.enum(CATALOG_FIXED_ARG_IDS);

/** The arguments of a list of fixed-argument ids, in order. */
export function catalogFixedArgv(ids: readonly CatalogFixedArgId[]): string[] {
  return ids.flatMap((id) => [...CATALOG_FIXED_ARGS[id].argv]);
}

// ---- Rovara local AWS: the services it supports (5.2)

/**
 * The four tiers of 5.2. `supported`: tested in Rovara's compatibility suite and seedable. `functions`: Lambda through Rovara's function runner. `model_endpoint_front`: SageMaker Runtime routed to a fake or a model
 * helper. `available`: present but never chosen by default. The chooser (3.4) may pick the first three. An entry lists the services it puts in a tier on purpose (an override); a service of the generated table that no
 * list names is `available` (`emulatorServiceTier`), so the entry never has to list the engine's whole catalogue.
 */
export const EMULATOR_SERVICE_TIERS = ["supported", "functions", "model_endpoint_front", "available"] as const;
export type EmulatorServiceTier = (typeof EMULATOR_SERVICE_TIERS)[number];
export const EMULATOR_CHOOSER_TIERS: readonly EmulatorServiceTier[] = ["supported", "functions", "model_endpoint_front"];

const ServiceList = z.array(AwsServiceIdSchema).max(AWS_PLAN_SERVICES_MAX);
export const EmulatorSchema = z
  .object({
    services: z.object({ supported: ServiceList.min(1), functions: ServiceList, model_endpoint_front: ServiceList, available: ServiceList.default([]) }).strict(),
    /** The engine release the entry runs (`AWS_EMULATOR_ENGINE_VERSION` of the table): `checkEmulatorEngine` refuses an entry whose version differs. Optional so an entry made before the pin still parses. */
    engineVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,5}$/u).optional(),
    /** The evidence says "permissions were not checked": the emulator does not enforce IAM, and the data file says so. */
    iamEnforced: z.literal(false),
    storage: z.literal("memory"),
  })
  .strict()
  .superRefine((emulator, context) => {
    // A legacy id and its key are one service.
    const all = EMULATOR_SERVICE_TIERS.flatMap((tier) => emulator.services[tier].map(awsServiceKeyOrSelf));
    if (new Set(all).size !== all.length) context.addIssue({ code: "custom", path: ["services"], message: "a service is in one tier only" });
  });
export type Emulator = z.infer<typeof EmulatorSchema>;

/**
 * The tier a service is in on an emulator entry: the tier that lists it (a legacy id and its key are the same service), `available` when the service is in the generated table and no tier lists it, and undefined
 * for anything the engine does not have.
 */
export function emulatorServiceTier(emulator: Emulator, serviceId: string): EmulatorServiceTier | undefined {
  const key = awsServiceKeyOrSelf(serviceId);
  const listed = EMULATOR_SERVICE_TIERS.find((tier) => emulator.services[tier].some((id) => awsServiceKeyOrSelf(id) === key));
  if (listed !== undefined) return listed;
  return awsEmulatorServiceRow(key) === undefined ? undefined : "available";
}

/** Whether the chooser may pick the emulator for a service (the service is in a tier the chooser uses). */
export function emulatorChoosable(emulator: Emulator, serviceId: string): boolean {
  const tier = emulatorServiceTier(emulator, serviceId);
  return tier !== undefined && EMULATOR_CHOOSER_TIERS.includes(tier);
}

// ---- one entry

const Port = z.number().int().min(1).max(65_535);
const TmpfsPath = z.string().regex(/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,6}$/u).refine((path) => !path.split("/").includes(".."), "an absolute path with no .. segment");
const StartTimeout = z.number().int().min(1).max(CATALOG_START_TIMEOUT_MAX_S);

export const CatalogHealthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tcp"), port: Port, startTimeoutS: StartTimeout }).strict(),
  z.object({ kind: z.literal("command"), check: z.enum(CATALOG_HEALTH_COMMANDS), startTimeoutS: StartTimeout }).strict(),
  z.object({ kind: z.literal("http"), port: Port, path: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,127}$/u).refine((path) => !path.includes("//") && !path.split("/").includes(".."), "a plain path"), startTimeoutS: StartTimeout }).strict(),
]);

export const CatalogRunSchema = z
  .object({
    /** `uid:gid`, neither of them 0: every helper runs without root (4.1.4). */
    user: z.string().regex(/^\d{1,5}:\d{1,5}$/u).refine((user) => user.split(":").every((part) => Number(part) !== 0), "not root"),
    readOnlyRoot: z.boolean(),
    tmpfs: z.array(z.object({ path: TmpfsPath, sizeMiB: z.number().int().min(1).max(4_096) }).strict()).max(4),
    ports: z.array(Port).max(4),
    extraArgs: z.array(CatalogFixedArgSchema).max(8),
  })
  .strict();

export const CatalogResourcesSchema = z.object({ memMiB: z.number().int().min(16).max(8_192), cpus: z.number().min(0.1).max(8), pids: z.number().int().min(8).max(4_096) }).strict();

export const CatalogScanSchema = z.object({ scannedAt: z.string().datetime(), criticalOpen: z.literal(0), highOpen: z.number().int().min(0).max(100_000) }).strict();

export const CatalogEntrySchema = z
  .object({
    id: CatalogIdSchema,
    /** What dependencies it serves: `postgres`, `redis` (Redis and Valkey both), `mysql`, `local-aws`, or the helper's own name. */
    family: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
    backing: z.enum(CATALOG_BACKINGS),
    version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/u),
    status: z.enum(CATALOG_STATUSES),
    image: z
      .object({
        /** The repository name under the registry Rovara (or a company's own install) serves it from; the registry host is the install's, not the catalog's. */
        repository: z.string().regex(/^svc\/[a-z0-9][a-z0-9._-]{0,62}$/u),
        digest: Sha256Schema.optional(),
        platforms: z.array(z.enum(CATALOG_PLATFORMS)).min(1).max(2),
      })
      .strict(),
    /** For the team-runner process backend (8.6), when one exists. */
    process: z.object({ artifactDigest: Sha256Schema, entry: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,6}$/u), args: z.array(CatalogFixedArgSchema).max(8) }).strict().optional(),
    run: CatalogRunSchema,
    health: CatalogHealthSchema,
    resources: CatalogResourcesSchema,
    connect: z.object({ templates: z.record(EnvNameSchema, ConnectTemplateSchema), defaultAliases: z.array(DnsLabelSchema).max(4) }).strict(),
    reset: z.object({ kind: z.enum(CATALOG_RESET_KINDS) }).strict(),
    licence: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+() -]{0,127}$/u, "an SPDX identifier or expression"),
    sbomRef: Sha256Schema.optional(),
    scan: CatalogScanSchema.optional(),
    editions: z.array(z.enum(CATALOG_EDITIONS)).min(1).max(2),
    /** Present exactly on the emulator entry. */
    emulator: EmulatorSchema.optional(),
    /**
     * Slice 3: this helper runs from the WORKER'S OWN image (by image id), as its program in `dist/`, not from an image of its own: the fake server, the DNS helper and the test-account proxy. It has no digest, SBOM or scan to
     * pin (the worker image is the release's), the catalog build carries it over untouched, and it is never in the pre-pull list. Absent on every other entry.
     */
    workerImage: z.literal(true).optional(),
    /**
     * Code on a laptop only (owner-image-list.ts): the entry was made from an image THE OWNER approved on their own page, pinned to the digest their Docker resolved, not from a signed catalog. It has a digest and no SBOM or scan
     * (nothing reviewed it but the owner). `loadSignedCatalog` refuses any catalog that carries one, so a signed catalog never holds an owner-approved entry; only `ownerCatalogOf` makes a catalog of them.
     */
    ownerApproved: z.literal(true).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    const name = catalogIdName(entry.id);
    const isHelperName = (TEST_ENV_HELPER_CATALOG_NAMES as readonly string[]).includes(name);
    if (entry.backing === "local" && isHelperName) problem(["backing"], "a local entry is real software, not one of Rovara's helpers");
    if (entry.backing === "emulated" && name !== "local-aws") problem(["backing"], "the emulated entry is Rovara local AWS");
    if (entry.backing === "fake" && name !== "fake-server") problem(["backing"], "the fake entry is the fake server");
    if (entry.backing === "helper" && name !== "test-account-proxy" && name !== "dns-helper") problem(["backing"], "a helper entry is the proxy or the DNS helper");
    if (entry.workerImage === true && name !== "fake-server" && name !== "dns-helper" && name !== "test-account-proxy") problem(["workerImage"], "only Rovara's own helpers run from the worker image");
    if (entry.ownerApproved === true && (entry.backing !== "local" || entry.image.digest === undefined || entry.sbomRef !== undefined || entry.scan !== undefined || entry.process !== undefined || entry.status === "retired" || entry.workerImage === true || entry.emulator !== undefined)) problem(["ownerApproved"], "an owner-approved entry is real software pinned to a digest, with no SBOM, scan or process of its own");
    if (entry.workerImage === true && (entry.image.digest !== undefined || entry.sbomRef !== undefined || entry.scan !== undefined || entry.process !== undefined)) problem(["workerImage"], "a helper that runs from the worker image has no image of its own to pin");
    if ((entry.backing === "emulated") !== (entry.emulator !== undefined)) problem(["emulator"], "the emulator block is on the emulated entry and nowhere else");
    if (entry.status === "default" && entry.backing === "helper") problem(["status"], "a helper is started by Rovara, never chosen: it has no default");
    if (new Set(entry.image.platforms).size !== entry.image.platforms.length) problem(["image", "platforms"], "a platform is listed once");
    if (new Set(entry.editions).size !== entry.editions.length) problem(["editions"], "an edition is listed once");
    if (new Set(entry.run.ports).size !== entry.run.ports.length) problem(["run", "ports"], "a port is listed once");
    if (new Set(entry.run.tmpfs.map((mount) => mount.path)).size !== entry.run.tmpfs.length) problem(["run", "tmpfs"], "a mount is listed once");
    // A tmpfs lives in the helper's memory, so the mounts must fit inside it.
    if (entry.run.tmpfs.reduce((total, mount) => total + mount.sizeMiB, 0) > entry.resources.memMiB) problem(["run", "tmpfs"], "the mounts fit inside the helper's memory");
    if ((entry.health.kind === "tcp" || entry.health.kind === "http") && !entry.run.ports.includes(entry.health.port)) problem(["health", "port"], "the health check is on one of the helper's ports");
    for (const [index, id] of entry.run.extraArgs.entries()) {
      if (!(CATALOG_FIXED_ARGS[id].families as readonly string[]).includes(entry.family)) problem(["run", "extraArgs", index], "this argument is not valid for this family");
    }
    if (new Set(entry.run.extraArgs).size !== entry.run.extraArgs.length) problem(["run", "extraArgs"], "an argument is listed once");
    for (const [index, id] of (entry.process?.args ?? []).entries()) {
      if (!(CATALOG_FIXED_ARGS[id].families as readonly string[]).includes(entry.family)) problem(["process", "args", index], "this argument is not valid for this family");
    }
    for (const envName of Object.keys(entry.connect.templates)) {
      // AWS access and endpoint variables are Rovara's own and exist only on the emulator entry; the other reserved names belong to the system.
      const awsOnEmulator = envName.startsWith("AWS_") && entry.backing === "emulated";
      if (reservedDependencyEnvName(envName) && !awsOnEmulator) problem(["connect", "templates", envName], "this variable name belongs to the system");
    }
    for (const alias of entry.connect.defaultAliases) {
      if ((TEST_ENV_RESERVED_ALIASES as readonly string[]).includes(alias)) problem(["connect", "defaultAliases"], "this name belongs to a Rovara helper");
    }
    if (new Set(entry.connect.defaultAliases).size !== entry.connect.defaultAliases.length) problem(["connect", "defaultAliases"], "an alias is listed once");
  });
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

// ---- the data file

export const ServiceCatalogSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    /** A new number for every catalog release. */
    revision: z.number().int().min(1),
    /** Whether the images are pinned (TS19). Until then no entry has a digest, a scan or an SBOM; after it, at least one entry is pinned, and an entry that is not retired has all three or none. */
    pinned: z.boolean(),
    entries: z.array(CatalogEntrySchema).min(1).max(64),
  })
  .strict()
  .superRefine((catalog, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    const ids = catalog.entries.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) problem(["entries"], "an id is listed once");
    const defaults = catalog.entries.filter((entry) => entry.status === "default").map((entry) => entry.family);
    if (new Set(defaults).size !== defaults.length) problem(["entries"], "a family has one default");
    catalog.entries.forEach((entry, index) => {
      const ownerPinned = entry.ownerApproved === true;
      if (ownerPinned && !catalog.pinned) problem(["entries", index], "an owner-approved entry must be in a pinned catalog");
      const carriesPin = entry.image.digest !== undefined || entry.sbomRef !== undefined || entry.scan !== undefined || entry.process !== undefined;
      if (!catalog.pinned && carriesPin) problem(["entries", index], "an unpinned catalog has no digest, SBOM, scan or process artifact");
      // Slice 1: a pinned catalog may hold entries that are not pinned YET (a release that pins one image at a time, `catalog-build --entries`). An entry is wholly pinned (digest, SBOM and scan) or carries none of the
      // three: a half-pinned ENTRY never parses. Nothing starts an unpinned entry (`catalogPins` leaves it out, `resolveCatalogImage` refuses it as `not_pinned`).
      const pinnedParts = [entry.image.digest, entry.sbomRef, entry.scan].filter((part) => part !== undefined).length;
      if (catalog.pinned && !ownerPinned && entry.status !== "retired" && pinnedParts !== 0 && pinnedParts !== 3) problem(["entries", index], "a pinned entry has a digest, an SBOM and a scan");
      if (catalog.pinned && entry.status !== "retired" && pinnedParts === 0 && entry.process !== undefined) problem(["entries", index], "an entry that is not pinned yet has no process artifact");
    });
    if (catalog.pinned && !catalog.entries.some((entry) => entry.status !== "retired" && entry.image.digest !== undefined)) problem(["entries"], "a pinned catalog pins at least one image");
  });
export type ServiceCatalog = z.infer<typeof ServiceCatalogSchema>;

/** The entry with this id, or undefined. A retired entry is found too (a pinned environment may still name it); callers check `status`. */
export function catalogEntryById(catalog: ServiceCatalog, id: string): CatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id);
}
