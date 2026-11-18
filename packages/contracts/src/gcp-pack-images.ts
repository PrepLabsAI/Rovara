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

/** The groups a setting value switches on: a comma list of exactly `mirrored`, `pulled` and `bigquery` (case and spaces ignored); every other word is dropped. Fail closed: undefined or empty is none. */
export function gcpPackGroupsOf(value: string | undefined): ReadonlySet<GcpPackGroup> {
  const on = new Set<GcpPackGroup>();
  for (const word of (value ?? "").split(",")) {
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
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_KEYFILE_JSON", "GCLOUD_KEYFILE_JSON", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
];
