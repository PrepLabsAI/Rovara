// Test services turning what the detectors found (CANDIDATES, in a setup draft) into PROPOSED dependencies.
//
// The worker's draft is untrusted, so the BROKER decides here: each candidate goes through `chooseBacking` (the deterministic chooser, place "task_check" and again "working"), and only a candidate that gets REAL software
// from the signed catalog , or Rovara local AWS for S3, SQS and DynamoDB , becomes a dependency of the proposal. Everything in a proposed dependency is made from the catalog entry the chooser picked, the candidate's family and kind, and the
// files and lines the detector cited; no text from the repository is copied (a name is a fixed word for a known family, a variable name comes from the catalog's own templates). What cannot be backed yet is counted in one
// fixed note, never described. A person still approves the proposal on a card; nothing here approves anything.
import { RelativeWorkspacePathSchema, TestEnvDependenciesSchema, TestEnvDependencySchema, type TestEnvDependency, type TestEnvDependencyCandidate, type VerifiedCatalog } from "@agentx/contracts";
import { chooseBacking, effectiveAllowedBackings } from "./backing-choice.js";
import { EMULATED_TASK_SERVICES } from "./dependency-plan.js";

export const DEPENDENCIES_NOT_PROPOSED_NOTE = "Some dependencies were found that Rovara cannot start yet. They are not part of the proposal.";
export const DEPENDENCIES_NO_CATALOG_NOTE = "Dependencies were found, but Rovara's image list could not be read, so none are proposed.";
export const DEPENDENCIES_LEFT_OUT_NOTE = "The dependencies found could not be proposed together, so none are proposed.";

/** What people see for the families Rovara knows; any other family shows its id (which passed the family pattern). */
const FAMILY_NAMES: Readonly<Record<string, string>> = {
  "aws:s3": "S3", "aws:sqs": "SQS", "aws:dynamodb": "DynamoDB", postgres: "Postgres", mysql: "MySQL", mariadb: "MariaDB", mongodb: "MongoDB", redis: "Redis", memcached: "Memcached", rabbitmq: "RabbitMQ", kafka: "Kafka", elasticsearch: "Elasticsearch", opensearch: "OpenSearch", smtp: "Mail catcher",
};

const idOfFamily = (family: string): string | undefined => {
  const id = family.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "");
  return /^[a-z][a-z0-9-]{0,39}$/u.test(id) ? id : undefined;
};

/**
 * The region Rovara local AWS tells the code when the detectors found none (they read names, never a value). A maintainer can change it on the card; the emulator keeps no real data in any region.
 */
export const EMULATED_DEFAULT_REGION = "us-east-1";

export interface DependencyProposalContext {
  /** The signed catalog (`serviceCatalogSourceOf`); undefined when it could not be read. */
  catalog: VerifiedCatalog | undefined;
  edition: "public" | "enterprise";
  projectId: string;
  prodDeny: { accountIds: string[]; hosts: string[]; arnPrefixes: string[] };
}

export interface DependencyProposal { dependencies: TestEnvDependency[]; notes: string[] }

/** The proposed dependencies for a draft's candidates, and the fixed notes for what was left out. Never throws; a candidate that does not make a valid dependency is left out and counted. */
export function proposeDependencies(candidates: readonly TestEnvDependencyCandidate[], context: DependencyProposalContext): DependencyProposal {
  if (candidates.length === 0) return { dependencies: [], notes: [] };
  const catalog = context.catalog;
  if (catalog === undefined) return { dependencies: [], notes: [DEPENDENCIES_NO_CATALOG_NOTE] };
  const proposed: TestEnvDependency[] = [];
  let leftOut = 0;
  for (const candidate of candidates) {
    try {
      const one = proposeOne(candidate, catalog, context);
      if (one === undefined) leftOut += 1;
      else proposed.push(one);
    } catch {
      leftOut += 1;
    }
  }
  // The emulated dependencies share one helper (Rovara local AWS) and one name for it: only the first carries the alias, because the contract lets a name be used once.
  let emulatedSeen = false;
  const shared = proposed.map((dependency) => {
    if (dependency.backing.kind !== "emulated") return dependency;
    const first = !emulatedSeen;
    emulatedSeen = true;
    return first ? dependency : { ...dependency, connect: { env: [], hostAliases: [] } };
  });
  proposed.splice(0, proposed.length, ...shared);
  // The list as a whole must be one the contract accepts (unique ids, aliases and variables; at most 12 started). If it is not, nothing is proposed: a partial list would pick winners by position.
  if (proposed.length > 0 && !TestEnvDependenciesSchema.safeParse(proposed).success) return { dependencies: [], notes: [DEPENDENCIES_LEFT_OUT_NOTE] };
  return { dependencies: proposed, notes: leftOut > 0 ? [DEPENDENCIES_NOT_PROPOSED_NOTE] : [] };
}

function proposeOne(candidate: TestEnvDependencyCandidate, catalog: VerifiedCatalog, context: DependencyProposalContext): TestEnvDependency | undefined {
  const id = idOfFamily(candidate.family);
  if (id === undefined) return undefined;
  // Tests that fake it themselves, and anything the chooser would back with something else, are not proposed: only real software from the catalog, and Rovara local AWS for S3, SQS and DynamoDB.
  if (candidate.hints.fakedByTests === true) return undefined;
  if (candidate.family.startsWith("aws:") && !EMULATED_TASK_SERVICES.includes(candidate.family.slice(4))) return undefined;
  let catalogId: string | undefined;
  let backingKind: "local" | "emulated" | undefined;
  for (const place of ["task_check", "working"] as const) {
    const chosen = chooseBacking({
      dependency: { family: candidate.family, kind: candidate.kind, major: candidate.hints.version, fakedByTests: false },
      place, edition: context.edition, allowed: effectiveAllowedBackings(undefined), catalog, projectId: context.projectId, projectImages: [], accounts: [], prodDeny: context.prodDeny, fixtures: [], canMakeFake: false, now: 0,
    });
    if ((chosen.backing.kind !== "local" && chosen.backing.kind !== "emulated") || (catalogId !== undefined && (catalogId !== chosen.backing.catalogId || backingKind !== chosen.backing.kind))) return undefined;
    catalogId = chosen.backing.catalogId;
    backingKind = chosen.backing.kind;
  }
  const entry = catalog.entries.find((item) => item.id === catalogId);
  if (entry === undefined || catalogId === undefined) return undefined;
  const found = candidate.evidence.slice(0, 8).map((item) => ({ path: item.path, line: item.line }));
  const base = { id, name: FAMILY_NAMES[candidate.family] ?? candidate.family, kind: candidate.kind, family: candidate.family, found, usedBy: ["integration"], seeds: [], reset: "fresh_per_round" };
  // Rovara local AWS: the region variables are Rovara's to set (the contract reserves `AWS_REGION`), so only the helper's name is carried here, by the first emulated dependency (see `proposeDependencies`).
  const connect = { env: backingKind === "emulated" ? [] : Object.entries(entry.connect.templates).map(([name, template]) => ({ name, template })), hostAliases: [...entry.connect.defaultAliases] };
  if (backingKind === "emulated") {
    const resources = iacResourcesOf(candidate);
    const parsed = TestEnvDependencySchema.safeParse({ ...base, backing: { kind: "emulated", catalogId, awsServices: [candidate.family.slice(4)], region: EMULATED_DEFAULT_REGION, ...(resources === undefined ? {} : { resources }) }, connect });
    return parsed.success ? parsed.data : undefined;
  }
  const config = entry.family === "postgres" && candidate.hints.initFiles !== undefined && candidate.hints.initFiles.length > 0 ? { initFiles: candidate.hints.initFiles.slice(0, 4) } : {};
  const parsed = TestEnvDependencySchema.safeParse({ ...base, backing: { kind: "local", catalogId, config }, connect });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Where the project declares the AWS resources the tests expect (D7 saw them in one template or one Terraform file), so the card can say where the tables and buckets come from. Only when the detector's evidence is in one
 * file whose name shows the tool; two files, or a file whose tool cannot be told, leave it out (the dependency is then still proposed, without the pointer).
 */
function iacResourcesOf(candidate: TestEnvDependencyCandidate): { provider: "cloudformation" | "terraform" | "cdk"; path: string } | undefined {
  if (candidate.hints.seenBy?.includes("iac") !== true) return undefined;
  const paths = [...new Set(candidate.evidence.map((item) => item.path))];
  const path = paths[0];
  if (paths.length !== 1 || path === undefined || !RelativeWorkspacePathSchema.safeParse(path).success) return undefined;
  const provider = /\.tf$/u.test(path) ? "terraform" : /\.(?:ya?ml|json|template)$/u.test(path) ? "cloudformation" : /\.(?:ts|js|py)$/u.test(path) ? "cdk" : undefined;
  return provider === undefined ? undefined : { provider, path };
}
