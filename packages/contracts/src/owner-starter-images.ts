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
