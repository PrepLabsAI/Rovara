// Test services on Code's AWS deployment (DEC 254zm): the install's OWN copies of the starter images, one ECR repository per starter image, in the install's own account and region.
//
// Why copies: a hosted worker pulls nothing from Docker Hub (no outside registry at boot, no Docker Hub secret, no rate limit). The controller copies each starter image ONCE, BY DIGEST, into its repository
// (scripts/test-services-mirror.ts), so the copy's index digest IS the starter's digest (a copy by digest keeps the index manifest byte for byte). The digest stays the identity everywhere: a tag on a copy is a
// label for people, never what is pulled or trusted.
//
// One source: the repositories, their names and the references a worker runs are all made HERE from the starter list (owner-starter-images.ts, a guard file, unchanged). The infrastructure (the five repositories and
// the worker role's read grant), the worker's boot stage (through the worker image's own copy of this file: test-services-mirror-cli.ts) and the copy script all read these functions, so they cannot disagree.
//
// The broker's catalog keys an image by its catalog repository and digest (`svc/postgres@sha256:<digest>`, ownerImageReferences), never by where it is pulled from, so the broker's catalog (from the Docker Hub
// references) and a hosted worker's (from these mirrored references) are the same catalog: the same ids, the same digests.
import { ENVIRONMENT_NAME_PATTERN } from "./environments.js";
import { OwnerListEntrySchema, parseImageReference, type OwnerListEntry } from "./owner-image-list.js";
import { gcpPackGroupsOf, gcpPackGroupOf, gcpPackMirrorRepositoryName } from "./gcp-pack-images.js";
import { OWNER_GCP_PACK_IMAGES, OWNER_STARTER_IMAGES, ownerGcpPackMirrorable, type OwnerGcpPackImage, type OwnerStarterImage } from "./owner-starter-images.js";

/** An ECR registry host of one account and region: `<12 digits>.dkr.ecr.<region>.amazonaws.com`. */
export const ECR_REGISTRY_PATTERN = /^[0-9]{12}\.dkr\.ecr\.[a-z]{2}(?:-[a-z]+)+-[0-9]\.amazonaws\.com$/u;

/** One repository of the mirror: the starter it holds and the ECR repository name. */
export interface TestServiceMirrorRepository {
  /** The starter image (its pinned Docker Hub reference and digest). */
  readonly starter: OwnerStarterImage;
  /**
   * The ECR repository name, `agentx-<env>--test-services/<image>-<major>/<image>`: the last part is the image's own name, so the family is read from it exactly as from the Docker Hub name. The first part is NOT
   * `agentx-<env>/`: that is the environment's ECR pull-through prefix (public.ecr.aws), where the worker role may import and create repositories; the copies stay outside it. The double hyphen is one no environment name holds (ENVIRONMENT_NAME_PATTERN), so no other environment's pull-through prefix (`agentx-prod-test-services/` for an environment named prod-test-services) can match either.
   */
  readonly repositoryName: string;
  /** The starter's 64 hex digest (the copy's digest). */
  readonly digest: string;
  /** The tag the copy carries, `<major>-<first 12 of the digest>`: unique per digest, so an immutable tag never has to move. A label only. */
  readonly tag: string;
}

/** The repositories of an environment's mirror, one per starter image, in the starter list's order. Throws on a name that is not an environment name. */
export function testServiceMirrorRepositories(env: string): TestServiceMirrorRepository[] {
  if (typeof env !== "string" || !ENVIRONMENT_NAME_PATTERN.test(env)) throw new Error("the test service mirror needs a named environment");
  return OWNER_STARTER_IMAGES.map((starter) => {
    const parsed = parseImageReference(starter.reference);
    if (parsed?.digest === undefined) throw new Error("a starter image is not pinned by digest");
    const image = parsed.repository.split("/").at(-1)!;
    return { starter, repositoryName: `agentx-${env}--test-services/${image}-${starter.version}/${image}`, digest: parsed.digest, tag: `${starter.version}-${parsed.digest.slice(0, 12)}` };
  });
}

/**
 * The owner list a hosted worker runs from: each starter, named by the install's own copy (`<registry>/<repository>@sha256:<the starter's digest>`), with the starter's family and version. Every entry passes the owner-list
 * schema (pinned by digest, no tag, the family the image's own). Throws on a registry that is not an ECR registry or an environment that is not a name.
 */
export function mirroredStarterEntries(registry: string, env: string): OwnerListEntry[] {
  if (typeof registry !== "string" || !ECR_REGISTRY_PATTERN.test(registry)) throw new Error("the test service mirror is an ECR registry of this account");
  return testServiceMirrorRepositories(env).map((repository) => OwnerListEntrySchema.parse({ reference: `${registry}/${repository.repositoryName}@sha256:${repository.digest}`, family: repository.starter.family, version: repository.starter.version }));
}

// ---- the GCP pack's copies (lane L4-E8I, owner decision 2026-11-18)
//
// Three more repositories in the same family of names, for the pack's MIRRORED images only (Spanner, fake-gcs-server, the goccy BigQuery emulator: `ownerGcpPackMirrorable`). Google's SDK image (Pub/Sub, Firestore, Datastore,
// Bigtable) is never in this list: a worker pulls it from Google's registry by digest. They are separate from `testServiceMirrorRepositories` on purpose: the five starter repositories, the boot stage's `refs` and the copy script
// stay exactly what they were, and a pack copy exists only where the infrastructure and the setting say so.

/** One repository of the pack's mirror: the image it holds and the ECR repository name. */
export interface GcpPackMirrorRepository {
  readonly image: OwnerGcpPackImage;
  /** `agentx-<env>--test-services/<family>-<version>/<family>`, outside the environment's pull-through prefix (`agentx-<env>/`) like the starter copies. */
  readonly repositoryName: string;
  /** The image's 64 hex digest (the copy's digest: a copy by digest keeps the index manifest byte for byte). */
  readonly digest: string;
  /** `<version>-<first 12 of the digest>`: unique per digest, so an immutable tag never has to move. A label only. */
  readonly tag: string;
}

/** The pack's mirror repositories of an environment, in the pack list's order. Throws on a name that is not an environment name. */
export function gcpPackMirrorRepositories(env: string): GcpPackMirrorRepository[] {
  return ownerGcpPackMirrorable().map((image) => {
    const parsed = parseImageReference(image.reference);
    if (parsed?.digest === undefined) throw new Error("a pack image is not pinned by digest");
    return { image, repositoryName: gcpPackMirrorRepositoryName(env, image.family, image.version), digest: parsed.digest, tag: `${image.version}-${parsed.digest.slice(0, 12)}` };
  });
}

/**
 * The owner-list entries a hosted worker runs for the pack, for the groups `groups` (a stack parameter value or the laptop's list): the MIRRORED images named by the install's own ECR copy (`<registry>/<repository>@sha256:<digest>`),
 * the PULLED images by their source reference on Google's registry (the same digest, never copied). Every entry passes the owner-list schema. Nothing of a group that is not named. Throws on a registry that is not an ECR registry.
 */
export function gcpPackWorkerEntries(registry: string, env: string, groups: string | undefined): OwnerListEntry[] {
  if (typeof registry !== "string" || !ECR_REGISTRY_PATTERN.test(registry)) throw new Error("the test service mirror is an ECR registry of this account");
  const on = gcpPackGroupsOf(groups);
  const copies = new Map(gcpPackMirrorRepositories(env).map((repository) => [repository.image.family, repository]));
  return OWNER_GCP_PACK_IMAGES.filter((image) => on.has(gcpPackGroupOf(image.family))).map((image) => {
    const copy = copies.get(image.family);
    return OwnerListEntrySchema.parse({ reference: copy === undefined ? image.reference : `${registry}/${copy.repositoryName}@sha256:${copy.digest}`, family: image.family, version: image.version });
  });
}
