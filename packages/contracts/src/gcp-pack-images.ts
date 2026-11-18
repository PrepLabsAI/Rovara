// Test services, the GCP pack (lane L4-E8, spike L4-E8S, owner decision 2026-11-18): the Google Cloud services a project's tests and evals can be pointed at emulators of. Pure data and small checks; nothing here reads a
// file, the environment or the network.
//
// What the pack is, family by family (the family id is the dependency's: `pubsub`, `firestore`, ...):
//   - Spanner (Apache-2.0), the community Cloud Storage emulator fake-gcs-server (BSD-2-Clause) and the BigQuery emulator of goccy (MIT, beta) MAY be mirrored into Rovara's own registry: `distribution: "mirrored"`.
//   - Google's SDK `emulators` image (Pub/Sub, Firestore, Datastore mode, Bigtable) is "Google owned" with no redistribution licence of its own. It is NEVER mirrored: a worker pulls it directly from Google's registry,
//     pinned by digest: `distribution: "pulled_from_source"`. (Owner decision, 2026-11-18.)
//   - BigQuery sits behind the R8 dry-run gate (a partial SQL translation): `gate: "r8_dry_run"`, and its own switch token.
// The pack is OFF by default. `ROVARA_TEST_SERVICES_GCP_PACK` is a comma list of the groups that are on: `mirrored`, `pulled`, `bigquery` (`gcpPackGroupsOf`). Nothing in a group that is not named is ever listed, planned or pulled.
//
// The images and their digests are in owner-starter-images.ts (a guard file, `OWNER_GCP_PACK_IMAGES`); this file says which repository each family is allowed to come from, where each emulator listens, and how a project's
// Google client libraries are pointed at it (the variable each reads, with the run's own placeholders). A project id is made up (`GCP_FAKE_PROJECT_ID`) and no credential is ever set.
import { ENVIRONMENT_NAME_PATTERN } from "./environments.js";
import type { TestEnvDependencyKind } from "./test-env-dependency.js";

export const GCP_PACK_FAMILIES = ["pubsub", "firestore", "datastore", "bigtable", "spanner", "gcs", "bigquery"] as const;
export type GcpPackFamily = (typeof GCP_PACK_FAMILIES)[number];

export const isGcpPackFamily = (family: unknown): family is GcpPackFamily => typeof family === "string" && (GCP_PACK_FAMILIES as readonly string[]).includes(family);

/** The project id the emulators and the code are told. Made up: no emulator checks it, and it is the same in every run, so it can never name a real project. */
export const GCP_FAKE_PROJECT_ID = "rovara-test-project";

/** The stack or laptop setting that switches the pack on, group by group. Unset, empty or anything else: nothing of the pack is on. */
export const GCP_PACK_SETTING_VARIABLE = "ROVARA_TEST_SERVICES_GCP_PACK";
export const GCP_PACK_GROUPS = ["mirrored", "pulled", "bigquery"] as const;
export type GcpPackGroup = (typeof GCP_PACK_GROUPS)[number];

/**
 * The groups a setting value switches on: a list of exactly `mirrored`, `pulled` and `bigquery` (case and spaces ignored), separated by a comma (the laptop) or a colon (a stack parameter: a packed broker setting cannot hold a
 * comma); every other word is dropped (so `off` is none). Fail closed: undefined or empty is none.
 */
export function gcpPackGroupsOf(value: string | undefined): ReadonlySet<GcpPackGroup> {
  const on = new Set<GcpPackGroup>();
  for (const word of (value ?? "").split(/[,:]/u)) {
    const group = word.trim().toLowerCase();
    if ((GCP_PACK_GROUPS as readonly string[]).includes(group)) on.add(group as GcpPackGroup);
  }
  return on;
}

/** How the image reaches a machine that runs it: `mirrored` (the licence allows Rovara's own registry copy) or `pulled_from_source` (never copied; pulled by digest from the publisher's registry). */
export const GCP_PACK_DISTRIBUTIONS = ["mirrored", "pulled_from_source"] as const;
export type GcpPackDistribution = (typeof GCP_PACK_DISTRIBUTIONS)[number];

export interface GcpPackFamilyInfo {
  /** The ONLY registry and repository this family's image may come from. */
  readonly registry: string;
  readonly repository: string;
  readonly distribution: GcpPackDistribution;
  /** Present on the entries that sit behind a gate that is not the licence. */
  readonly gate?: "r8_dry_run";
  readonly kind: TestEnvDependencyKind;
  /** The name the code reaches the emulator by on the run's network. */
  readonly alias: string;
  /** The port the emulator listens on (the first is the one the connection variables name). */
  readonly ports: readonly number[];
  /** What the image's licence file says, as an SPDX id or a `LicenseRef-` name. */
  readonly licence: string;
  /** The environment variables the Google client libraries read, with the run's placeholders (`{host}`, `{port}`, `{endpoint}`). */
  readonly env: Readonly<Record<string, string>>;
  /** What a person reads. */
  readonly name: string;
}

const SDK = { registry: "gcr.io", repository: "google.com/cloudsdktool/google-cloud-cli" } as const;

export const GCP_PACK: Readonly<Record<GcpPackFamily, GcpPackFamilyInfo>> = {
  pubsub: { ...SDK, distribution: "pulled_from_source", kind: "queue", alias: "pubsub", ports: [8085], licence: "LicenseRef-Google-owned", env: { PUBSUB_EMULATOR_HOST: "{host}:{port}" }, name: "Pub/Sub" },
  firestore: { ...SDK, distribution: "pulled_from_source", kind: "database", alias: "firestore", ports: [8080], licence: "LicenseRef-Google-owned", env: { FIRESTORE_EMULATOR_HOST: "{host}:{port}" }, name: "Firestore" },
  datastore: { ...SDK, distribution: "pulled_from_source", kind: "database", alias: "datastore", ports: [8080], licence: "LicenseRef-Google-owned", env: { DATASTORE_EMULATOR_HOST: "{host}:{port}" }, name: "Datastore" },
  bigtable: { ...SDK, distribution: "pulled_from_source", kind: "database", alias: "bigtable", ports: [8086], licence: "LicenseRef-Google-owned", env: { BIGTABLE_EMULATOR_HOST: "{host}:{port}" }, name: "Bigtable" },
  spanner: { registry: "gcr.io", repository: "cloud-spanner-emulator/emulator", distribution: "mirrored", kind: "database", alias: "spanner", ports: [9010], licence: "Apache-2.0", env: { SPANNER_EMULATOR_HOST: "{host}:{port}" }, name: "Spanner" },
  // The Cloud Storage client wants the scheme in this variable, so it is the whole endpoint (`http://<alias>:4443`).
  gcs: { registry: "docker.io", repository: "fsouza/fake-gcs-server", distribution: "mirrored", kind: "object_store", alias: "gcs", ports: [4443], licence: "BSD-2-Clause", env: { STORAGE_EMULATOR_HOST: "{endpoint}" }, name: "Cloud Storage" },
  // No standard Google variable points the Python client at it: BIGQUERY_EMULATOR_HOST is the Node client's, BIGQUERY_API_ENDPOINT the plain endpoint for a client option in the project's own setup.
  bigquery: { registry: "ghcr.io", repository: "goccy/bigquery-emulator", distribution: "mirrored", gate: "r8_dry_run", kind: "database", alias: "bigquery", ports: [9050, 9060], licence: "MIT", env: { BIGQUERY_EMULATOR_HOST: "{host}:{port}", BIGQUERY_API_ENDPOINT: "{endpoint}" }, name: "BigQuery" },
};

/** The group a family is switched on with. */
export const gcpPackGroupOf = (family: GcpPackFamily): GcpPackGroup => (GCP_PACK[family].gate !== undefined ? "bigquery" : GCP_PACK[family].distribution === "mirrored" ? "mirrored" : "pulled");

/** Whether an image reference's registry and repository are the one this pack family may use (no other image, whatever its last name). */
export const gcpPackSourceMatches = (family: GcpPackFamily, registry: string, repository: string): boolean => GCP_PACK[family].registry === registry && GCP_PACK[family].repository === repository;

/**
 * Variable names no Google client reads as a credential and that this pack must therefore never set: the pack points clients at emulators that need none. Used by the environment builder's check and by the tests.
 */
export const GCP_CREDENTIAL_VARIABLES: readonly string[] = [
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_KEYFILE_JSON", "GCLOUD_KEYFILE_JSON", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
];

// ---- the install's stack setting (lane L4-E8I, owner decision 2026-11-18)
//
// The stack parameter `TestServicesGcpPack` (named environments only, default `off`) carries the same list the laptop's variable does, written with colons: one of GCP_PACK_PARAMETER_VALUES, every non-empty combination of the
// three groups in this order. It is packed into the broker's and the dispatcher's settings (`gp`) and read as ROVARA_TEST_SERVICES_GCP_PACK; the session steps pass it into a worker's boot configuration. Anything else reads as none.
export const GCP_PACK_PARAMETER = "TestServicesGcpPack";
export const GCP_PACK_PARAMETER_DEFAULT = "off";
export const GCP_PACK_PARAMETER_VALUES: readonly string[] = [
  GCP_PACK_PARAMETER_DEFAULT,
  ...[1, 2, 3, 4, 5, 6, 7].map((mask) => GCP_PACK_GROUPS.filter((_, index) => (mask & (1 << index)) !== 0).join(":")),
];

/**
 * The only hosts a worker host may pull the pack's source-pulled image from (the DNS firewall's allow entries, and nothing else: HTTPS only, from the worker host's own Docker, never from the sealed box). Measured 2026-11-18, anonymous
 * and read only: the manifest, the token and the blob redirect of the pinned SDK image are all on gcr.io (the blob's redirect is a path on gcr.io itself), so no storage host is needed. `us-docker.pkg.dev` is the registry gcr.io
 * repositories move to; the owner allowed both.
 */
export const GCP_PACK_PULL_REGISTRY_HOSTS: readonly string[] = ["gcr.io", "us-docker.pkg.dev"];

/** Whether a parameter or setting value switches on the group whose images are pulled from Google's registry (the only group that needs egress). */
export const gcpPackPullsFromSource = (value: string | undefined): boolean => gcpPackGroupsOf(value).has("pulled");

/** The ECR repository of a mirrored pack image: `agentx-<env>--test-services/<family>-<version>/<family>` (the same family of names as the five starter copies, test-service-mirror.ts; the last part is the pack family's id). */
export function gcpPackMirrorRepositoryName(env: string, family: GcpPackFamily, version: string): string {
  if (typeof env !== "string" || !ENVIRONMENT_NAME_PATTERN.test(env)) throw new Error("the test service mirror needs a named environment");
  return `agentx-${env}--test-services/${family}-${version}/${family}`;
}

const ECR_REGISTRY = /^[0-9]{12}\.dkr\.ecr\.[a-z]{2}(?:-[a-z]+)+-[0-9]\.amazonaws\.com$/u;
const MIRROR_REPOSITORY = /^agentx-([a-z](?:[a-z0-9-]{0,18}[a-z0-9])?)--test-services\/([a-z]+)-(\d{1,3}(?:\.\d{1,3}){0,2})\/([a-z]+)$/u;

/**
 * Whether this registry and repository are the install's own ECR copy of a MIRRORED pack family at this version (what a hosted worker's owner list names): an ECR registry and exactly
 * `agentx-<env>--test-services/<family>-<version>/<family>`. Never true for a pulled-from-source family: its image is never copied.
 */
export function gcpPackMirrorMatches(family: GcpPackFamily, version: string, registry: string, repository: string): boolean {
  if (GCP_PACK[family].distribution !== "mirrored" || !ECR_REGISTRY.test(registry)) return false;
  const match = MIRROR_REPOSITORY.exec(repository);
  return match !== null && ENVIRONMENT_NAME_PATTERN.test(match[1]!) && match[2] === family && match[3] === version && match[4] === family && repository === gcpPackMirrorRepositoryName(match[1]!, family, version);
}
