// Saved project images (SV wiring): the rebuild job on the wire. A rebuild runs as a PREPARATION on a fresh workspace the broker makes (read only, pinned to the commits the job was queued for), and the worker builds
// the image from that clone after the preparation: the job is a field of the prepare payload (`savedEnvBuild`), not a new operation kind, so the preparation's grant, fence, outbox and dispatch are the ones every
// preparation has.
//
// The LEASE TOKEN is not in the stored invocation (an invocation is kept in the outbox, the stream, the queue and the dead-letter queue): the dispatcher adds it once, when it delivers (`leaseForDispatch`), and the
// worker sends it back with the job's id on each of the two lease routes. Those routes answer to the lease alone (and the preparation's own grant), never to a task or to a person.
import { z } from "zod";
import { ImageDigestSchema, SavedEnvSecretNameSchema } from "./saved-env.js";
import { isSavedEnvRepositoryName } from "./saved-env-image.js";
import { TestEnvironmentBodySchema } from "./test-environment.js";

/** The worker feature (listed on /ping) that takes the prepare payload's `savedEnvBuild`. A worker without it is never sent the job (the build is not something to skip). */
export const PREPARE_SAVED_ENV_BUILD_FEATURE = "prepare.savedEnvBuild.v1" as const;

/** The paths (under a workspace's operation) of the two lease routes, and of the fallback report of a preparation that started from a saved image. */
export const SAVED_ENV_PUSH_LOGIN_PATH = "saved-env-push-login" as const;
export const SAVED_ENV_RESULT_PATH = "saved-env-result" as const;
export const SAVED_ENV_FALLBACK_PATH = "saved-env-fallback" as const;

export const SAVED_ENV_REBUILD_REASONS = ["no_image", "key_changed", "max_age", "stale", "reset"] as const;
const Commit = z.string().regex(/^[a-f0-9]{40}$/u);

/** What the build needs beyond the preparation: the approved environment (the body whose digest is `approved.digest`), the commits (these are also the preparation's pins), and the key's inputs. NAMES of secrets only. */
export const PrepareSavedEnvBuildSchema = z.object({
  jobId: z.string().min(1).max(64),
  /** Added by the dispatcher at delivery; absent in the stored invocation. A worker refuses a build without it. */
  leaseToken: z.string().min(16).max(200).optional(),
  reason: z.enum(SAVED_ENV_REBUILD_REASONS),
  approved: z.object({ revision: z.number().int().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  /** The registry repository the broker derived for this org and project; the push login must be for exactly this one. */
  repository: z.string().refine(isSavedEnvRepositoryName, "a saved environment repository name"),
  environment: TestEnvironmentBodySchema,
  /** The commit of each repository (by repository name) the build is for. */
  commits: z.record(z.string().min(1).max(200), Commit).refine((commits) => Object.keys(commits).length >= 1 && Object.keys(commits).length <= 16, "one to sixteen repositories"),
  /** The environment key the broker worked out for `commits` (the code host's tree listing, the secret names and the base image): the worker works its own out from the clone and stops on a difference. */
  expectedKey: z.string().regex(/^[a-f0-9]{64}$/u),
  /** `Detection.fullSuiteOn` values for the environment key. */
  detectorGlobs: z.array(z.string().min(1).max(256)).max(200).default([]),
  secretNames: z.array(SavedEnvSecretNameSchema).max(200).default([]),
  /** The base image digest the environment key holds. */
  baseImageDigest: ImageDigestSchema,
}).strict();
export type PrepareSavedEnvBuild = z.infer<typeof PrepareSavedEnvBuildSchema>;

/** The body of the push login request and of the result: the job's id and the lease token, nothing else for the login. */
export const SavedEnvLeaseBodySchema = z.object({ jobId: z.string().min(1).max(64), leaseToken: z.string().min(16).max(200) }).strict();
export const SavedEnvResultBodySchema = SavedEnvLeaseBodySchema.extend({ result: z.unknown() }).strict();
/** The body of a preparation's fallback report: the step it fell back at. The image is the one the broker recorded with the operation. */
export const SavedEnvFallbackBodySchema = z.object({ step: z.string().min(1).max(40) }).strict();
