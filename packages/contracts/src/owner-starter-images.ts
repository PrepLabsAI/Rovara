// Test services on a laptop: the STARTER LIST, the images that count as approved with no click.
//
// THIS FILE IS A GUARD FILE (scripts/port-guard.ts, `GUARD_FILES`): any change to the list goes through review by hand, and `npm run port:guard` flags a change to it. It needs no signing key because Rovara Code's own
// release is the trust anchor: the list is source, and a user trusts it exactly as far as they trust the release they installed. Everything not named here still needs the owner's one-time approval on the test environment page.
//
// Each entry is an official Docker Hub library image pinned to the digest of its multi-platform INDEX manifest (the one `docker pull <name>:<tag>` resolves on both arm64 and amd64; the linux/arm64 and linux/amd64
// manifests are in each index). The digests were read on 2026-11-11 with a read-only registry request: the token endpoint `auth.docker.io/token?service=registry.docker.io&scope=repository:library/<name>:pull`, then
// `GET https://registry-1.docker.io/v2/library/<name>/manifests/<tag>` with `Accept: application/vnd.oci.image.index.v1+json`. For every entry the SHA-256 of the manifest bytes was checked to equal the
// `Docker-Content-Digest` header, and the index was checked to list linux/arm64 and linux/amd64. To refresh an entry, repeat that request, replace the digest and the date, and have the change reviewed.
//
// A starter name with another digest is NOT a starter: it is a different image, so it is refused until the owner approves it, and an approval may not take a starter's place (the same family and major version).
import { OwnerListEntrySchema, type OwnerImageFamily, type OwnerListEntry } from "./owner-image-list.js";
import { GCP_PACK, GCP_PACK_SETTING_VARIABLE, gcpPackGroupOf, gcpPackGroupsOf, gcpPackSourceMatches, type GcpPackDistribution, type GcpPackFamily, type GcpPackGroup } from "./gcp-pack-images.js";

export interface OwnerStarterImage extends OwnerListEntry {
  /** What a person reads: `postgres:16`. */
  readonly requested: string;
  /** Where the digest came from (the registry, the tag and the day it was read). */
  readonly source: string;
}

const READ_ON = "2026-11-11";
const from = (name: string, tag: string): string => `index manifest of docker.io/library/${name}:${tag}, read from registry-1.docker.io on ${READ_ON}; lists linux/arm64 and linux/amd64`;

export const OWNER_STARTER_IMAGES: readonly OwnerStarterImage[] = [
  { requested: "postgres:16", family: "postgres", version: "16", reference: "docker.io/library/postgres@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657", source: from("postgres", "16") },
  { requested: "postgres:17", family: "postgres", version: "17", reference: "docker.io/library/postgres@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f", source: from("postgres", "17") },
  { requested: "mysql:8", family: "mysql", version: "8", reference: "docker.io/library/mysql@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902", source: from("mysql", "8") },
  { requested: "redis:7", family: "redis", version: "7", reference: "docker.io/library/redis@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90", source: from("redis", "7") },
  { requested: "mongo:7", family: "mongodb", version: "7", reference: "docker.io/library/mongo@sha256:8bb4442761a63a8dda452744082cdac9644b429807eb977b42324a63cef59ca4", source: from("mongo", "7") },
];

/** The starter list as list entries (what `normalizeOwnerList` and `ownerCatalogOf` take). Never empty; every entry is checked by the owner-list schema when it is used. */
export const ownerStarterEntries = (): OwnerListEntry[] => OWNER_STARTER_IMAGES.map((image) => ({ reference: image.reference, family: image.family, version: image.version }));

/** The starter image of a family and major version (`postgres`, `16`), or undefined. */
export function starterImageFor(family: OwnerImageFamily, version: string): OwnerStarterImage | undefined {
  const major = version.split(".")[0];
  return OWNER_STARTER_IMAGES.find((image) => image.family === family && image.version === major);
}

/** Whether this exact pinned reference (registry, repository and digest) is a starter image. */
export const isStarterReference = (reference: string): boolean => OWNER_STARTER_IMAGES.some((image) => image.reference === reference);

// A starter that does not pass the owner-list schema is a build error, not a runtime surprise.
for (const image of OWNER_STARTER_IMAGES) OwnerListEntrySchema.parse({ reference: image.reference, family: image.family, version: image.version });

// ---- the GCP pack (lane L4-E8; spike L4-E8S, 2026-11-18; owner decision 2026-11-18)
//
// NOT part of OWNER_STARTER_IMAGES: the pack is off by default (`ROVARA_TEST_SERVICES_GCP_PACK`, gcp-pack-images.ts), the install's registry mirror (test-service-mirror.ts) is made from the five images above and nothing here, and the
// laptop's pre-approved list and the hosted catalog stay what they were until the pack is switched on. Each entry is pinned to the digest of the multi-platform INDEX manifest, read on 2026-11-18 with `crane` (read-only, anonymous):
// the index lists linux/arm64 and linux/amd64 (per-architecture digests are in briefs/lead4/L4-E8S-GCP-EMULATORS.md). To refresh an entry, repeat that read, replace the digest and the date, and have the change reviewed.
//
// `distribution` says how the image reaches a machine that runs it, and it is a rule, not a label:
//   - `mirrored`: Spanner (Apache-2.0), fake-gcs-server (BSD-2-Clause), the goccy BigQuery emulator (MIT). Rovara's own registry MAY hold a straight registry-to-registry copy by digest (keep the image's licence files).
//   - `pulled_from_source`: Google's SDK `emulators` image. The Pub/Sub and Firestore jars are "Google owned" and carry no redistribution licence, so Rovara never copies the image: a worker pulls it, by digest, from Google's registry.
//     A pulled image needs the worker to reach that registry (an egress allow-list change, not made here); until then the group stays off.
// `OwnerGcpPackImage.reference` is the SOURCE reference in both cases (what a laptop's Docker pulls by digest); a mirror's copy has the same digest.

export interface OwnerGcpPackImage {
  /** What a person reads: `fsouza/fake-gcs-server:1.56.1`. */
  readonly requested: string;
  readonly family: GcpPackFamily;
  readonly version: string;
  /** The pinned SOURCE reference (`registry/repository@sha256:<index digest>`). */
  readonly reference: string;
  readonly distribution: GcpPackDistribution;
  /** Behind a gate that is not the licence (BigQuery: the R8 dry run). */
  readonly gate?: "r8_dry_run";
  /** Where the digest came from, the day it was read, and the licence reading that decides `distribution`. */
  readonly source: string;
}

const PACK_READ_ON = "2026-11-18";
const packSource = (name: string, tag: string, licence: string): string => `index manifest of ${name}:${tag}, read with crane (anonymous, read-only) on ${PACK_READ_ON}; lists linux/arm64 and linux/amd64. ${licence}`;
const SDK_DIGEST = "4568487af2c00a66e1d3e0f054be208c9c5b499a3999da50428b396e1341e9fd";
const SDK_SOURCE = packSource("gcr.io/google.com/cloudsdktool/google-cloud-cli", "594.0.0-emulators", "Google owned, no redistribution licence for the emulator jars: pulled from Google's registry, never mirrored (owner decision 2026-11-18).");
const SDK_REFERENCE = `gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:${SDK_DIGEST}`;

const sdkImage = (family: "pubsub" | "firestore" | "datastore" | "bigtable"): OwnerGcpPackImage => ({ requested: "google-cloud-cli:594.0.0-emulators", family, version: "594.0.0", reference: SDK_REFERENCE, distribution: GCP_PACK[family].distribution, source: SDK_SOURCE });

export const OWNER_GCP_PACK_IMAGES: readonly OwnerGcpPackImage[] = [
  sdkImage("pubsub"),
  sdkImage("firestore"),
  sdkImage("datastore"),
  sdkImage("bigtable"),
  { requested: "cloud-spanner-emulator/emulator:1.5.59", family: "spanner", version: "1.5.59", reference: "gcr.io/cloud-spanner-emulator/emulator@sha256:5f71fecd6330211789b75065ade9587d67b3a6b4678e7e5408e42c22f778c63e", distribution: "mirrored", source: packSource("gcr.io/cloud-spanner-emulator/emulator", "1.5.59", "Apache-2.0: a registry copy by digest is allowed.") },
  { requested: "fsouza/fake-gcs-server:1.56.1", family: "gcs", version: "1.56.1", reference: "docker.io/fsouza/fake-gcs-server@sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef", distribution: "mirrored", source: packSource("docker.io/fsouza/fake-gcs-server", "1.56.1", "BSD-2-Clause: a registry copy by digest is allowed.") },
  { requested: "goccy/bigquery-emulator:0.8.1", family: "bigquery", version: "0.8.1", reference: "ghcr.io/goccy/bigquery-emulator@sha256:f4e428d265a93dc5ce36c294e1c584c7c9b384117d47ab8ddbb63d8d50b7f393", distribution: "mirrored", gate: "r8_dry_run", source: packSource("ghcr.io/goccy/bigquery-emulator", "0.8.1", "MIT (beta, partial SQL): a registry copy by digest is allowed; offered only behind the R8 dry-run gate.") },
];

/** The pack's images of the groups that are on (`mirrored`, `pulled`, `bigquery`), in list order. Nothing of a group that is not named. */
export const ownerGcpPackImagesOf = (groups: ReadonlySet<GcpPackGroup>): OwnerGcpPackImage[] => OWNER_GCP_PACK_IMAGES.filter((image) => groups.has(gcpPackGroupOf(image.family)));

/** The pack's images the setting value switches on: the one place the setting is read. Unset or unreadable is none. */
export const ownerGcpPackImagesFor = (environment: Readonly<Record<string, string | undefined>>): OwnerGcpPackImage[] => ownerGcpPackImagesOf(gcpPackGroupsOf(environment[GCP_PACK_SETTING_VARIABLE]));

/** The pack's images as list entries (what `normalizeOwnerList` and `ownerCatalogOf` take). */
export const ownerGcpPackEntries = (images: readonly OwnerGcpPackImage[]): OwnerListEntry[] => images.map((image) => ({ reference: image.reference, family: image.family, version: image.version }));

/** The pack's images the install's registry mirror may copy: every `mirrored` one (the licence allows a copy; BigQuery still needs the R8 gate to be switched on before it is offered). The pulled image is never in this list. */
export const ownerGcpPackMirrorable = (): OwnerGcpPackImage[] => OWNER_GCP_PACK_IMAGES.filter((image) => image.distribution === "mirrored");

/** Whether this exact pinned reference is one the pack pulls straight from the publisher's registry (never mirrored). */
export const isPulledFromSourceReference = (reference: string): boolean => OWNER_GCP_PACK_IMAGES.some((image) => image.distribution === "pulled_from_source" && image.reference === reference);

// A pack entry that does not pass the owner-list schema, or whose marker or source disagrees with the pack's table, is a build error, not a runtime surprise.
for (const image of OWNER_GCP_PACK_IMAGES) {
  OwnerListEntrySchema.parse({ reference: image.reference, family: image.family, version: image.version });
  const info = GCP_PACK[image.family];
  const at = image.reference.indexOf("@sha256:");
  if (image.reference.slice(0, at) !== `${info.registry}/${info.repository}` || !gcpPackSourceMatches(image.family, info.registry, info.repository) || image.distribution !== info.distribution || image.gate !== info.gate) throw new Error("a GCP pack image disagrees with the pack's table");
}
