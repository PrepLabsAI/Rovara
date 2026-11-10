// Test services, TS1 (design test-services.md, section 2.2 and 2.3): a DEPENDENCY is anything outside the code that the tests talk to; a BACKING is what Rovara puts behind it for a run.
// This is the contract only. Nothing reads it yet: the approved environment still carries `services` (see `TestEnvServiceSchema` in test-environment.ts), `readTestEnvDependencies` turns that old
// shape into this one, and a later task wires the environment body to it.
// Replaces (once wired): `TestEnvServiceSchema`'s kinds and modes. A pre-prod service becomes a test-account backing, a mocked one a fake backing, and `auto` a test account plus a fake fallback.
//
// What the schema itself guarantees, so no builder has to remember it:
//   - a fallback is only ever a fake or none: a run never falls back from real software to anything that looks real, and the fall back is recorded elsewhere;
//   - the coding agent's working backing is never a test account (test-account secrets exist only in sealed check rounds);
//   - `none` with excluded tests, a test account, a project image, a company-approved substitute image, a fake that makes up answers and a raised run cap are LESS-SAFE (a second person approves);
//   - a company-approved substitute image carries its approval reference and a digest that differs from the catalog's, so it is never a silent swap;
//   - an environment holds at most 24 dependencies and starts at most 12 (16 at the Rovara maximum) in one run;
//   - a connection template can carry a password only as the run's own `{password}` placeholder, and a variable name Rovara or the system owns can never be set from here;
//   - nothing here is a secret: a credential is only ever the run's placeholder or a test-account id.
// Nothing here imports a Node module.
import { z } from "zod";
import type { DecisionRisk } from "./decision-cards.js";
import { RelativeWorkspacePathSchema, ProjectCommandSchema } from "./project.js";
import type { TestEnvService } from "./test-environment.js";
import { TestEnvValueSourceSchema } from "./test-env-value-source.js";
import { SeedScriptLockSchema } from "./seed-script-lock.js";
import { TestServiceHostSchema, looksLikeSecretValue, reservedDependencyEnvName } from "./test-services-shared.js";
import { sha256Hex } from "./web-hash.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const TEST_ENV_DEPENDENCY_KINDS = ["database", "cache", "queue", "stream", "object_store", "search", "cloud_api", "model_endpoint", "http_api", "identity", "email", "other"] as const;
export const TestEnvDependencyKindSchema = z.enum(TEST_ENV_DEPENDENCY_KINDS);
export type TestEnvDependencyKind = z.infer<typeof TestEnvDependencyKindSchema>;

export const TEST_ENV_DEPENDENCY_USED_BY = ["unit", "integration", "e2e", "app_boot"] as const;
export const TEST_ENV_DEPENDENCY_RESETS = ["fresh_per_round", "between_checks"] as const;
export const TEST_ENV_BACKING_KINDS = ["local", "project_image", "emulated", "test_account", "fake", "none"] as const;
export const TEST_ENV_NONE_REASONS = ["not_supported", "declined", "faked_by_tests"] as const;
/** What a fake does with a request it has no recording for (the same words as the v1 mock's `unmatched`). */
export const TEST_ENV_FAKE_UNMATCHED = ["fail", "schema_synth"] as const;

/** The caps of 11.2: how many dependencies an environment holds, and how many a run starts (the company may raise the second, never past the Rovara maximum). */
export const TEST_ENV_DEPENDENCY_LIMITS = { dependencies: 24, started: 12, startedMax: 16, excludedTests: 64, awsServices: 24, sources: 8, connectEnv: 16, hostAliases: 4, seeds: 8 } as const;

// ---- identifiers

/** A dependency's own id: `postgres`, `aws-s3`, `payments-api`. */
export const TestEnvDependencyIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u, "a lower-case id of at most 40 characters");

/** A family: `postgres`, `redis`, `kafka`, `aws:s3`, `aws:sagemaker-runtime`, `http:<host>`. An `http:` family names a host, never an address, a wildcard or a single-label name. */
export const FamilyIdSchema = z
  .string()
  .max(260)
  .superRefine((family, context) => {
    if (family.startsWith("http:")) {
      // The one host rule (shared with test accounts): a name of at least two labels that can never be read as an address, short and hex spellings included.
      if (!TestServiceHostSchema.safeParse(family.slice(5)).success) context.addIssue({ code: "custom", message: "an http family names a host (at least two labels), not an address" });
      return;
    }
    if (!/^(?:aws:)?[a-z][a-z0-9-]{0,39}$/u.test(family)) context.addIssue({ code: "custom", message: "a family is a name, aws:<service> or http:<host>" });
  });
export type FamilyId = z.infer<typeof FamilyIdSchema>;

/** `postgres@16`, `valkey@8`, `local-aws@1`: a name and a version, as the image catalog lists them. */
export const CatalogIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}@[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/u, "a catalog id is name@version");
/** The helper names no backing may use as a catalog entry: they are Rovara's own, started for other reasons. */
export const TEST_ENV_HELPER_CATALOG_NAMES = ["local-aws", "fake-server", "test-account-proxy", "dns-helper"] as const;
export const catalogIdName = (catalogId: string): string => catalogId.slice(0, catalogId.indexOf("@"));

export const ProjectImageIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const TestAccountIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const AwsServiceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/u);
export const TestEnvRegionSchema = z.string().max(32).regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u);
export const DnsLabelSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
/** Names no dependency may use as an alias on the run's network: they are the helpers' and the system's own. */
export const TEST_ENV_RESERVED_ALIASES = ["localhost", "dns", "dns-helper", "proxy", "test-account-proxy", "sinkhole", "rovara", "host", "gateway"] as const;

// ---- connection variables

export const EnvNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u, "an upper-case variable name");

/** The only placeholders a connection template may hold: each is filled from the run's own values. */
export const CONNECT_TEMPLATE_PLACEHOLDERS = ["user", "password", "host", "port", "db", "region", "endpoint"] as const;

export type ConnectTemplateProblem = "shape" | "shell_character" | "placeholder" | "secret_shaped" | "password_literal" | "userinfo" | "host" | "query_secret";

/** The shell and quoting characters no template may hold: a template becomes an environment value that a shell may read. */
const SHELL_CHARACTERS = /[`$;|&<>"'\\]/u;
const SECRET_QUERY_NAME = /pass|pwd|token|key|secret|auth|sig|cred|bearer|session/iu;
const WHOLE_PLACEHOLDER = /^\{[a-z]+\}$/u;

/**
 * Why a connection template is not acceptable, or undefined when it is. A fixed code, never the template's text. A template is one of the run's own placeholders, a `scheme://` address, or a short list of
 * placeholders joined by `:` or `,`. In an address the user information is only `{user}` and `{password}`, the host is only `{host}` or `{endpoint}` (with an optional `{port}`), and a query parameter
 * whose name says it holds a password, token, key or secret holds exactly a placeholder. Nothing in it looks like a key, and no shell or quoting character is allowed.
 */
export function connectTemplateProblem(template: string): ConnectTemplateProblem | undefined {
  if (template.length < 1 || template.length > 256 || !/^[\x21-\x7e]+$/u.test(template)) return "shape";
  if (SHELL_CHARACTERS.test(template)) return "shell_character";
  const allowed = new Set<string>(CONNECT_TEMPLATE_PLACEHOLDERS);
  for (const match of template.matchAll(/\{([^{}]*)\}/gu)) if (!allowed.has(match[1] ?? "")) return "placeholder";
  if (template.replace(/\{[^{}]*\}/gu, "").match(/[{}]/u) !== null) return "placeholder";
  if (looksLikeSecretValue(template)) return "secret_shaped";
  let tail: string;
  const address = /^([a-z][a-z0-9+.-]{0,15}):\/\/(.*)$/u.exec(template);
  if (address !== null) {
    const rest = address[2] ?? "";
    const end = rest.search(/[/?]/u);
    const authority = end < 0 ? rest : rest.slice(0, end);
    tail = end < 0 ? "" : rest.slice(end);
    const at = authority.lastIndexOf("@");
    const userinfo = at < 0 ? undefined : authority.slice(0, at);
    const hostPort = at < 0 ? authority : authority.slice(at + 1);
    if (userinfo !== undefined) {
      const parts = userinfo.split(":");
      // Whatever follows the colon must be exactly the run's `{password}`, so a literal password can never be written into a template.
      if (parts.length === 2 && parts[1] !== "{password}") return "password_literal";
      if (parts.length > 2 || (parts[0] !== "" && parts[0] !== "{user}")) return "userinfo";
    }
    if (!/^\{(?:host|endpoint)\}(?::\{port\})?$/u.test(hostPort)) return "host";
  } else {
    const end = template.search(/[/?]/u);
    const first = end < 0 ? template : template.slice(0, end);
    tail = end < 0 ? "" : template.slice(end);
    if (!/^(?:\{[a-z]+\}|[:,])+$/u.test(first)) return "host";
  }
  const queryAt = tail.indexOf("?");
  if (queryAt >= 0) {
    const query = tail.slice(queryAt + 1);
    const equals = query.indexOf("=");
    const name = equals < 0 ? query : query.slice(0, equals);
    const value = equals < 0 ? "" : query.slice(equals + 1);
    if (SECRET_QUERY_NAME.test(name) && !WHOLE_PLACEHOLDER.test(value)) return "query_secret";
  }
  return undefined;
}
const TEMPLATE_MESSAGES: Record<ConnectTemplateProblem, string> = {
  shape: "a template is plain printable text, at most 256 characters",
  shell_character: "a template holds no shell or quoting character",
  placeholder: "only the known placeholders may be used",
  secret_shaped: "a template never holds a key",
  password_literal: "a password is only ever the {password} placeholder",
  userinfo: "the user part is only {user} and the password part only {password}",
  host: "the host is only {host} or {endpoint}",
  query_secret: "a password, token, key or secret parameter holds only a placeholder",
};
export const ConnectTemplateSchema = z.string().superRefine((template, context) => {
  const problem = connectTemplateProblem(template);
  if (problem !== undefined) context.addIssue({ code: "custom", message: TEMPLATE_MESSAGES[problem] });
});

/**
 * A synthetic-data seed: a command the sandbox runs, or a file inside the repository. Same two shapes as the environment's own `data.seeds`.
 * SEED-RISK-1: a command may carry the `lock` the BROKER put on it (seed-script-lock.ts): the hash of the repository's own seed script it runs. The worker re-hashes it from its checkout before every run and refuses
 * on a difference. A lock is not trust by itself (anyone can write one into an edited body): only the broker's own record of the proposal makes a locked seed medium (`verifiedSeeds`). A seed without one parses as before.
 */
export const SeedRefSchema = z.union([z.object({ command: ProjectCommandSchema, lock: SeedScriptLockSchema.optional() }).strict(), z.object({ fixturePath: RelativeWorkspacePathSchema }).strict()]);
export type SeedRef = z.infer<typeof SeedRefSchema>;

/** The signature of one seed of one dependency: a command (and its lock's hash, when it has one) or a file. A changed command or lock is another seed. */
export function testEnvSeedSignature(dependencyId: string, seed: SeedRef): string {
  if (!("command" in seed)) return `${dependencyId}/file/${seed.fixturePath}`;
  return `${dependencyId}/${JSON.stringify(seed.command)}${seed.lock === undefined ? "" : `#${seed.lock.hash}`}`;
}

/** SEED-RISK-1: the seeds the broker checked itself against the repository (signatures, `testEnvSeedSignature`). Absent or empty: every seed command is unchecked. */
export interface TestEnvSeedTrust { verifiedSeeds?: ReadonlySet<string> | undefined }

/** Whether a backing is software Rovara starts from its own catalog and throws away (no substitute image), or nothing at all. */
const disposable = (backing: { kind: string; substituteImage?: unknown; excludedTests?: unknown } | undefined): boolean =>
  backing === undefined || (backing.kind === "local" && backing.substituteImage === undefined) || (backing.kind === "none" && backing.excludedTests === undefined);

/**
 * SEED-RISK-1 condition (c): a seed of `dependencyId` reaches ONLY Rovara's disposable sealed test database: the seeded dependency is a database Rovara starts from its catalog (in every slot), and nothing else the
 * run can reach is outside Rovara: no other dependency backed by anything but catalog software (no test account, project or substitute image, fake or emulator), no pre-prod or auto service, no shared
 * environment, preview or account, and the sandbox tier. Anything else, or a dependency that is not there, is false.
 */
export function seedTargetsOnlySealedTestDb(body: { tier: string; services: ReadonlyArray<{ mode: string }>; accounts: readonly unknown[]; shared?: unknown; preview?: unknown; dependencies?: readonly TestEnvDependency[] | undefined }, dependencyId: string): boolean {
  if (body.tier !== "sandbox" || body.shared !== undefined || body.preview !== undefined || body.accounts.length > 0 || body.services.some((service) => service.mode !== "mock")) return false;
  const dependencies = body.dependencies ?? [];
  const seeded = dependencies.find((dependency) => dependency.id === dependencyId);
  if (seeded === undefined || seeded.kind !== "database" || seeded.backing.kind !== "local" || seeded.backing.substituteImage !== undefined) return false;
  return dependencies.every((dependency) => disposable(dependency.backing) && disposable(dependency.workingBacking) && disposable(dependency.fallback));
}

// ---- backings

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u);
/** What is carried over from a project's own service definition: names and files, never a password. */
export const CatalogConfigSchema = z
  .object({
    database: Identifier.optional(),
    user: Identifier.optional(),
    extensions: z.array(Identifier).max(16).optional(),
    initFiles: z.array(RelativeWorkspacePathSchema).max(8).optional(),
  })
  .strict();
export type CatalogConfig = z.infer<typeof CatalogConfigSchema>;

/**
 * A company-approved image run in place of the catalog's (4.1.5): its digest, Rovara's digest it replaces, and the approval that allowed it. Without the reference there is no substitute.
 *
 * This schema checks SHAPE only: that the digests differ and that a reference is there. It cannot know the catalog or the approvals, so TS19 and TS40 MUST check, where the entry is used:
 *   1. `catalogDigest` equals the digest of the catalog entry named by the backing's `catalogId` (a substitute that "replaces" some other digest replaces nothing);
 *   2. `approvalRef` resolves to an admin approval record whose catalog id is this backing's `catalogId` and whose two digests are exactly `catalogDigest` and `digest`
 *      (an approval for one image or one digest pair never covers another).
 * Until both checks exist and pass, a substitute image must not be started. Listed in DEFERRED-CHECKS.
 */
export const SubstituteImageSchema = z
  .object({
    digest: Sha256Schema,
    catalogDigest: Sha256Schema,
    approvalRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$/u, "the reference of the admin approval"),
  })
  .strict()
  .refine((image) => image.digest !== image.catalogDigest, { message: "a substitute image has a digest that differs from the catalog's", path: ["digest"] });
export type SubstituteImage = z.infer<typeof SubstituteImageSchema>;

export const IacSeedRefSchema = z.object({ provider: z.enum(["cloudformation", "terraform", "cdk"]), path: RelativeWorkspacePathSchema }).strict();

const TestSelectorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_@%+=:,./*?{}[\]!-]+$/u, "a test selector")
  .refine((selector) => !selector.startsWith("/") && !selector.split("/").includes(".."), "a relative selector");

const LocalBackingSchema = z.object({ kind: z.literal("local"), catalogId: CatalogIdSchema, config: CatalogConfigSchema, substituteImage: SubstituteImageSchema.optional() }).strict();
const ProjectImageBackingSchema = z.object({ kind: z.literal("project_image"), imageId: ProjectImageIdSchema }).strict();
const EmulatedBackingSchema = z
  .object({
    kind: z.literal("emulated"),
    catalogId: CatalogIdSchema,
    awsServices: z.array(AwsServiceIdSchema).min(1).max(TEST_ENV_DEPENDENCY_LIMITS.awsServices),
    region: TestEnvRegionSchema,
    resources: IacSeedRefSchema.optional(),
  })
  .strict();
const TestAccountBackingSchema = z.object({ kind: z.literal("test_account"), accountId: TestAccountIdSchema }).strict();
const FakeBackingSchema = z.object({ kind: z.literal("fake"), fixtureSetRef: Sha256Schema, unmatched: z.enum(TEST_ENV_FAKE_UNMATCHED) }).strict();
const NoneBackingSchema = z.object({ kind: z.literal("none"), reason: z.enum(TEST_ENV_NONE_REASONS), excludedTests: z.array(TestSelectorSchema).min(1).max(TEST_ENV_DEPENDENCY_LIMITS.excludedTests).optional() }).strict();

function backingProblems(backing: z.infer<typeof BackingUnionSchema>, context: z.RefinementCtx, path: (string | number)[]): void {
  const problem = (sub: (string | number)[], message: string) => context.addIssue({ code: "custom", path: [...path, ...sub], message });
  if (backing.kind === "local" && (TEST_ENV_HELPER_CATALOG_NAMES as readonly string[]).includes(catalogIdName(backing.catalogId))) problem(["catalogId"], "a local backing is real software from the catalog, not one of Rovara's helpers");
  if (backing.kind === "emulated") {
    if (catalogIdName(backing.catalogId) !== "local-aws") problem(["catalogId"], "an emulated backing runs Rovara local AWS");
    if (new Set(backing.awsServices).size !== backing.awsServices.length) problem(["awsServices"], "a service is listed once");
  }
  if (backing.kind === "none" && backing.reason === "faked_by_tests" && backing.excludedTests !== undefined) problem(["excludedTests"], "tests that fake the dependency themselves are not excluded");
}

const BackingUnionSchema = z.discriminatedUnion("kind", [LocalBackingSchema, ProjectImageBackingSchema, EmulatedBackingSchema, TestAccountBackingSchema, FakeBackingSchema, NoneBackingSchema]);

/** What runs behind a dependency in check rounds, Prove and nightly. */
export const TestEnvBackingSchema = BackingUnionSchema.superRefine((backing, context) => backingProblems(backing, context, []));
export type TestEnvBacking = z.infer<typeof TestEnvBackingSchema>;

/** What the coding agent's working sandbox gets when it differs: any backing but a test account (the secret exists only in sealed check rounds, 4.0.2). */
export const TestEnvWorkingBackingSchema = z
  .discriminatedUnion("kind", [LocalBackingSchema, ProjectImageBackingSchema, EmulatedBackingSchema, FakeBackingSchema, NoneBackingSchema])
  .superRefine((backing, context) => backingProblems(backing, context, []));

/** Used when the backing cannot start: only a fake or none. A fallback to real software or to a test account is not a thing. */
export const TestEnvFallbackSchema = z.discriminatedUnion("kind", [FakeBackingSchema, NoneBackingSchema]).superRefine((backing, context) => backingProblems(backing, context, []));

// ---- the dependency

const SLOT = ["backing", "workingBacking", "fallback"] as const;
const STARTING_KINDS = new Set<TestEnvBacking["kind"]>(["local", "project_image", "emulated", "fake"]);

export const TestEnvDependencySchema = z
  .object({
    id: TestEnvDependencyIdSchema,
    /** Shown to people. */
    name: line(80),
    kind: TestEnvDependencyKindSchema,
    family: FamilyIdSchema,
    /** Where Rovara learned of it: a file and line, a detector, the setup agent's observation, a recipe, a person or the model. At least one, so a dependency is never unexplained. */
    found: z.array(TestEnvValueSourceSchema).min(1).max(TEST_ENV_DEPENDENCY_LIMITS.sources),
    usedBy: z.array(z.enum(TEST_ENV_DEPENDENCY_USED_BY)).min(1).max(TEST_ENV_DEPENDENCY_USED_BY.length),
    backing: TestEnvBackingSchema,
    workingBacking: TestEnvWorkingBackingSchema.optional(),
    fallback: TestEnvFallbackSchema.optional(),
    /** The endpoint name of a model endpoint (`aws:sagemaker-runtime`). */
    config: z.object({ endpointName: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/u).optional() }).strict().optional(),
    connect: z
      .object({
        env: z.array(z.object({ name: EnvNameSchema, template: ConnectTemplateSchema }).strict()).max(TEST_ENV_DEPENDENCY_LIMITS.connectEnv),
        hostAliases: z.array(DnsLabelSchema).max(TEST_ENV_DEPENDENCY_LIMITS.hostAliases),
      })
      .strict(),
    seeds: z.array(SeedRefSchema).max(TEST_ENV_DEPENDENCY_LIMITS.seeds),
    reset: z.enum(TEST_ENV_DEPENDENCY_RESETS),
  })
  .strict()
  .superRefine((dependency, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    const { backing, family } = dependency;
    if (new Set(dependency.usedBy).size !== dependency.usedBy.length) problem(["usedBy"], "a use is listed once");
    if (new Set(dependency.connect.env.map((entry) => entry.name)).size !== dependency.connect.env.length) problem(["connect", "env"], "a variable is set once");
    if (new Set(dependency.connect.hostAliases).size !== dependency.connect.hostAliases.length) problem(["connect", "hostAliases"], "an alias is listed once");
    dependency.connect.env.forEach((entry, index) => {
      if (reservedDependencyEnvName(entry.name)) problem(["connect", "env", index, "name"], "this variable is set by Rovara or the system, not by a dependency");
    });
    dependency.connect.hostAliases.forEach((alias, index) => {
      if ((TEST_ENV_RESERVED_ALIASES as readonly string[]).includes(alias)) problem(["connect", "hostAliases", index], "this name belongs to a Rovara helper");
    });
    if (backing.kind === "emulated") {
      if (!family.startsWith("aws:")) problem(["backing"], "Rovara local AWS backs AWS families only");
      if (family.startsWith("aws:") && !backing.awsServices.includes(family.slice(4))) problem(["backing", "awsServices"], "the emulated services include the family's own service");
    }
    const endpointFamily = family === "aws:sagemaker-runtime";
    if (endpointFamily && (dependency.kind !== "model_endpoint" || dependency.config?.endpointName === undefined)) problem(["config"], "a SageMaker Runtime dependency is a model endpoint with its endpoint name");
    if (!endpointFamily && dependency.config?.endpointName !== undefined) problem(["config", "endpointName"], "only a SageMaker Runtime dependency has an endpoint name");
    // A reset between checks needs something Rovara can reset: a helper it starts. A customer's account is never reset by Rovara.
    if (dependency.reset === "between_checks" && !STARTING_KINDS.has(backing.kind)) problem(["reset"], "only a helper Rovara starts can be reset between checks");
    if (backing.kind === "none" && (dependency.connect.env.length > 0 || dependency.connect.hostAliases.length > 0)) problem(["connect"], "nothing backs this dependency, so there is nothing to point the code at");
  });
export type TestEnvDependency = z.infer<typeof TestEnvDependencySchema>;

// ---- the list

/** How many helpers a run starts: one for each local, project-image and fake backing, one shared by all emulated ones, and one proxy when any test account is used. A fallback starts nothing until it is used. */
export function testEnvStartedCount(dependencies: readonly TestEnvDependency[]): number {
  const kinds = dependencies.map((dependency) => dependency.backing.kind);
  const each = kinds.filter((kind) => kind === "local" || kind === "project_image" || kind === "fake").length;
  return each + (kinds.includes("emulated") ? 1 : 0) + (kinds.includes("test_account") ? 1 : 0);
}

/** The run caps a company may set: only the number of helpers started is part of this contract. Raising it is less safe. */
export interface TestEnvRunCaps { maxStarted: number }
export const TEST_ENV_DEFAULT_RUN_CAPS: TestEnvRunCaps = { maxStarted: TEST_ENV_DEPENDENCY_LIMITS.started };

function listProblems(dependencies: readonly TestEnvDependency[], caps: TestEnvRunCaps, problem: (path: (string | number)[], message: string) => void): void {
  const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
  if (!unique(dependencies.map((dependency) => dependency.id))) problem([], "dependency ids are unique");
  if (!unique(dependencies.flatMap((dependency) => dependency.connect.env.map((entry) => entry.name)))) problem([], "two dependencies set the same variable");
  if (!unique(dependencies.flatMap((dependency) => dependency.connect.hostAliases))) problem([], "two dependencies use the same alias");
  if (caps.maxStarted > TEST_ENV_DEPENDENCY_LIMITS.startedMax) problem([], `a run starts at most ${String(TEST_ENV_DEPENDENCY_LIMITS.startedMax)} dependencies`);
  if (testEnvStartedCount(dependencies) > caps.maxStarted) problem([], `a run starts at most ${String(caps.maxStarted)} dependencies`);
}

/** The list schema for a given cap on helpers started (the default is 12; a company may lock lower or raise to 16). */
export function testEnvDependenciesSchemaFor(caps: TestEnvRunCaps) {
  return z
    .array(TestEnvDependencySchema)
    .max(TEST_ENV_DEPENDENCY_LIMITS.dependencies)
    .superRefine((dependencies, context) => listProblems(dependencies, caps, (path, message) => context.addIssue({ code: "custom", path, message })));
}
export const TestEnvDependenciesSchema = testEnvDependenciesSchemaFor(TEST_ENV_DEFAULT_RUN_CAPS);

// ---- less-safe fields and the approval card's risk (2.2, 2.7)

/** The dependency fields whose change is a less-safe change (a second person and a fresh sign-in), added to the environment's own list (`TEST_ENV_LESS_SAFE_FIELDS`) when the body is wired. */
export const TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS = ["test_account", "project_image", "substitute_image", "schema_synth", "none_excluded_tests", "dependency_seed", "run_cap_raised"] as const;
export type TestEnvDependencyLessSafeField = (typeof TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS)[number];

/** Each less-safe field a dependency list turns on, with a signature per use, so a moved or added use is a change and a removed one is not. */
function lessSafeSignatures(dependencies: readonly TestEnvDependency[], verified?: ReadonlySet<string>): Map<TestEnvDependencyLessSafeField, Set<string>> {
  const found = new Map<TestEnvDependencyLessSafeField, Set<string>>(TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS.map((field) => [field, new Set<string>()]));
  const add = (field: TestEnvDependencyLessSafeField, signature: string) => found.get(field)?.add(signature);
  for (const dependency of dependencies) {
    // A seed COMMAND runs with the dependency's network access after it starts, so a new or changed one is less safe (a second person sees it). A seed that is a repository file is data the project already holds.
    // SEED-RISK-1: a LOCKED seed the caller says the broker verified (and only such a one) is not counted: it is the repository's own script, unchanged, on the sealed test database (the caller checks the target).
    for (const seed of dependency.seeds) {
      if (!("command" in seed)) continue;
      const signature = testEnvSeedSignature(dependency.id, seed);
      if (seed.lock !== undefined && verified?.has(signature) === true) continue;
      add("dependency_seed", signature);
    }
    for (const slot of SLOT) {
      const backing = dependency[slot];
      if (backing === undefined) continue;
      const where = `${dependency.id}/${slot}`;
      if (backing.kind === "test_account") add("test_account", `${where}/${backing.accountId}`);
      if (backing.kind === "project_image") add("project_image", `${where}/${backing.imageId}`);
      if (backing.kind === "local" && backing.substituteImage !== undefined) add("substitute_image", `${where}/${backing.substituteImage.digest}/${backing.substituteImage.approvalRef}`);
      if (backing.kind === "fake" && backing.unmatched === "schema_synth") add("schema_synth", where);
      if (backing.kind === "none") for (const selector of backing.excludedTests ?? []) add("none_excluded_tests", `${where}/${selector}`);
    }
  }
  return found;
}

/**
 * The less-safe fields this change turns on, against the dependencies before it (none: the first proposal, where every less-safe use is a change). A use already there and unchanged is not a change;
 * a raised run cap is. Pure and deterministic, so the card and the server agree.
 */
export function testEnvDependencyLessSafeChanges(previous: readonly TestEnvDependency[] | undefined, next: readonly TestEnvDependency[], caps?: { previous?: TestEnvRunCaps; next?: TestEnvRunCaps }, verifiedNext?: ReadonlySet<string>): TestEnvDependencyLessSafeField[] {
  const before = lessSafeSignatures(previous ?? []);
  const after = lessSafeSignatures(next, verifiedNext);
  const changed = TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS.filter((field) => field !== "run_cap_raised" && [...(after.get(field) ?? [])].some((signature) => !(before.get(field)?.has(signature) ?? false)));
  const raised = caps?.next !== undefined && caps.next.maxStarted > (caps.previous ?? TEST_ENV_DEFAULT_RUN_CAPS).maxStarted;
  const list: TestEnvDependencyLessSafeField[] = [...changed];
  if (raised) list.push("run_cap_raised");
  return list.sort((a, b) => TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS.indexOf(a) - TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS.indexOf(b));
}

/** The risk the dependencies add to the `approve_test_env` card: high for any test account, project image, company-approved substitute image or excluded tests; medium otherwise. No model output sets it. */
export function testEnvDependencyApprovalRisk(dependencies: readonly TestEnvDependency[], verified?: ReadonlySet<string>): DecisionRisk {
  const found = lessSafeSignatures(dependencies, verified);
  return (["test_account", "project_image", "substitute_image", "none_excluded_tests", "dependency_seed"] as const).some((field) => (found.get(field)?.size ?? 0) > 0) ? "high" : "medium";
}

// ---- reading today's `TestEnvService` (2.3)

/** What a pre-prod service pointed at. It moves into a test account, which a person creates and a second person approves; the converted dependency names the account it expects. */
export interface LegacyPreprodTarget {
  url?: string | undefined;
  endpointArn?: string | undefined;
  roleArn?: string | undefined;
  region: string;
}
export type LegacyServiceConversion =
  | { ok: true; dependency: TestEnvDependency; movedPreprod?: LegacyPreprodTarget & { accountId: string } }
  | { ok: false; reason: "not_an_aws_host" | "invalid" };

/** A dependency id made from a name: lower case, runs of other characters as one hyphen, at most 40 characters; a name with nothing usable gets `dep-` and eight characters of its hash. */
export const testEnvDependencyIdFromName = (name: string): string => {
  let text = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (text !== "" && !/^[a-z]/u.test(text)) text = `d-${text}`;
  text = text.slice(0, 40).replace(/-+$/gu, "");
  return text === "" ? `dep-${sha256Hex(name).slice(0, 8)}` : text;
};

const AWS_REGION_LABEL = /^[a-z]{2}(?:-[a-z]+)+-\d$/u;
const AWS_SERVICE_LABEL = /^[a-z0-9-]+$/u;
/** The service an AWS endpoint host names: `dynamodb.<region>.amazonaws.com` and `sts.amazonaws.com` are `dynamodb` and `sts`; `runtime.sagemaker.<region>...` is `sagemaker-runtime`. Anything else (dual-stack, FIPS, a made-up name) is undefined. */
export function awsServiceOfHost(host: string): string | undefined {
  if (!host.endsWith(".amazonaws.com")) return undefined;
  const labels = host.slice(0, -".amazonaws.com".length).split(".");
  if (labels.length > 1 && AWS_REGION_LABEL.test(labels[labels.length - 1] ?? "")) labels.pop();
  if (labels.length === 2 && labels[0] === "runtime" && labels[1] === "sagemaker") return "sagemaker-runtime";
  const [service] = labels;
  return labels.length === 1 && service !== undefined && AWS_SERVICE_LABEL.test(service) && !AWS_REGION_LABEL.test(service) ? service : undefined;
}

/**
 * One v1 service as a dependency. A pre-prod service has the test-account backing and an account id made from its name; its target is returned in `movedPreprod` for whoever creates that account. `auto`
 * becomes a test account with a fake fallback; a mock becomes a fake. Anything that cannot be read as a valid dependency is refused, never guessed.
 */
export function testEnvServiceToDependency(service: TestEnvService, taken: ReadonlySet<string> = new Set()): LegacyServiceConversion {
  let id = testEnvDependencyIdFromName(service.name);
  for (let n = 2; taken.has(id); n += 1) id = `${testEnvDependencyIdFromName(service.name).slice(0, 36)}-${String(n)}`;
  let kind: TestEnvDependencyKind;
  let family: string;
  let config: { endpointName: string } | undefined;
  if (service.kind === "sagemaker_runtime") {
    kind = "model_endpoint";
    family = "aws:sagemaker-runtime";
    if (service.match.endpointName === undefined) return { ok: false, reason: "invalid" };
    config = { endpointName: service.match.endpointName };
  } else if (service.kind === "http") {
    kind = "http_api";
    family = `http:${service.match.host ?? ""}`;
  } else {
    kind = "cloud_api";
    const awsService = awsServiceOfHost(service.match.host ?? "");
    if (awsService === undefined) return { ok: false, reason: "not_an_aws_host" };
    family = `aws:${awsService}`;
  }
  const fake = service.mock === undefined ? undefined : ({ kind: "fake", fixtureSetRef: service.mock.fixtureSetRef, unmatched: service.mock.unmatched } as const);
  const accountId = `legacy-${id}`.slice(0, 64).replace(/-+$/gu, "");
  const account = { kind: "test_account", accountId } as const;
  const backing = service.mode === "mock" ? fake : account;
  if (backing === undefined) return { ok: false, reason: "invalid" };
  const candidate = {
    id,
    name: service.name,
    kind,
    family,
    found: ["person"],
    usedBy: ["integration"],
    backing,
    ...(service.mode === "auto" && fake !== undefined ? { fallback: fake } : {}),
    ...(config === undefined ? {} : { config }),
    connect: { env: [], hostAliases: [] },
    seeds: [],
    reset: "fresh_per_round",
  };
  const parsed = TestEnvDependencySchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const moved = service.preprod === undefined ? undefined : { ...(service.preprod.url === undefined ? {} : { url: service.preprod.url }), ...(service.preprod.endpointArn === undefined ? {} : { endpointArn: service.preprod.endpointArn }), ...(service.preprod.roleArn === undefined ? {} : { roleArn: service.preprod.roleArn }), region: service.preprod.region, accountId };
  return { ok: true, dependency: parsed.data, ...(moved === undefined ? {} : { movedPreprod: moved }) };
}

export type LegacyServicesConversion =
  | { ok: true; dependencies: TestEnvDependency[]; movedPreprod: Array<LegacyPreprodTarget & { accountId: string }> }
  | { ok: false; reason: "not_an_aws_host" | "invalid"; serviceName: string };

/** The whole `services` list of an approved v1 environment as dependencies, in order. The first service that cannot be read stops it (the name is returned; its text is not). */
export function testEnvServicesToDependencies(services: readonly TestEnvService[]): LegacyServicesConversion {
  const taken = new Set<string>();
  const dependencies: TestEnvDependency[] = [];
  const movedPreprod: Array<LegacyPreprodTarget & { accountId: string }> = [];
  for (const service of services) {
    const converted = testEnvServiceToDependency(service, taken);
    if (!converted.ok) return { ok: false, reason: converted.reason, serviceName: service.name };
    taken.add(converted.dependency.id);
    dependencies.push(converted.dependency);
    if (converted.movedPreprod !== undefined) movedPreprod.push(converted.movedPreprod);
  }
  if (!TestEnvDependenciesSchema.safeParse(dependencies).success) return { ok: false, reason: "invalid", serviceName: "" };
  return { ok: true, dependencies, movedPreprod };
}

/**
 * The dependencies of an environment, from whichever shape it was stored in: its `dependencies` when it has them, otherwise its v1 `services` converted. An environment with both is refused (it would
 * have two answers), and so is a v1 service that cannot be read.
 */
export function readTestEnvDependencies(environment: { services: readonly TestEnvService[]; dependencies?: readonly TestEnvDependency[] | undefined }): LegacyServicesConversion | { ok: false; reason: "both_shapes"; serviceName: "" } {
  if (environment.dependencies !== undefined) {
    if (environment.services.length > 0) return { ok: false, reason: "both_shapes", serviceName: "" };
    const parsed = TestEnvDependenciesSchema.safeParse(environment.dependencies);
    return parsed.success ? { ok: true, dependencies: parsed.data, movedPreprod: [] } : { ok: false, reason: "invalid", serviceName: "" };
  }
  return testEnvServicesToDependencies(environment.services);
}
