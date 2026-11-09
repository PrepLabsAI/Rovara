// Setup and test health SH3 (design setup-test-health.md, section 5): the saved environment of a project and the environment key that says when it is out of date.
//
// A saved environment is an image built from a proven setup. Its manifest names what it was built from; the ENVIRONMENT KEY is the hash of the inputs whose change makes the image wrong:
// the contents of the key files (lockfiles, build files, toolchain files, dev container files), the test environment's revision, the SET of secret names the project uses, and the base image digest.
//
// Pure: nothing here reads a file, a clock or a network. The caller hands in the hash of each key file. Nothing here imports a Node module, so the browser entry may include it later.
// The key is a one-way hash: it carries no file path, repository id or secret name in the clear, and a secret name is a NAME only, never a value.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { RelativeWorkspacePathSchema } from "./project.js";
import { sha256Hex } from "./web-hash.js";

export const SAVED_ENV_KEY_VERSION = 1;
/** The most key files one key covers; a project with more is refused, never silently cut (a cut key would miss the files past the cut). */
export const SAVED_ENV_MAX_KEY_FILES = 500;
export const SAVED_ENV_MAX_SECRET_NAMES = 200;
export const SAVED_ENV_MAX_COMMITS = 16;
/** A saved image is rebuilt when it is older than this, whatever the key says. */
export const SAVED_ENV_MAX_AGE_DAYS = 7;
/** A repository idle this many days is saved as a clone only (`savedEnv.lightAfterIdleDays`). */
export const SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT = 7;
/** Images kept per project: the company setting `savedEnv.keep` (default 3, 1 to 10). */
export const SAVED_ENV_KEEP_DEFAULT = 3;
export const SAVED_ENV_KEEP_MIN = 1;
export const SAVED_ENV_KEEP_MAX = 10;

const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u, "a sha256 in lowercase hex");
/** An image is named by its digest, never by a tag: a tag can be moved. */
export const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u, "an image digest (sha256:<64 hex>)");
const RepositoryId = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}\s]+$/u, "an id has no whitespace or control characters");
/** A secret NAME as a project's secrets list it (an environment variable name); never a value. */
export const SavedEnvSecretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u, "a secret name");

export const EnvKeyFileSchema = z.object({
  /** The project's own id for the repository (the same id the test environment uses). */
  repositoryId: RepositoryId,
  /** The file's path inside that repository. */
  path: RelativeWorkspacePathSchema,
  /** sha256 of the file's bytes. */
  sha256: Sha256Hex,
}).strict();
export type EnvKeyFile = z.infer<typeof EnvKeyFileSchema>;

export const EnvironmentKeyInputSchema = z.object({
  keyFiles: z.array(EnvKeyFileSchema).max(SAVED_ENV_MAX_KEY_FILES),
  testEnvRevision: z.number().int().min(1),
  secretNames: z.array(SavedEnvSecretNameSchema).max(SAVED_ENV_MAX_SECRET_NAMES),
  baseImageDigest: ImageDigestSchema,
}).strict();
export type EnvironmentKeyInput = z.infer<typeof EnvironmentKeyInputSchema>;

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The environment key: sha256 of the canonical form of the inputs, with the files in (repository, path) order and the secret names as a sorted set, so the order the caller listed them in never matters.
 * Throws on a malformed input, and on two entries for one file: a key that quietly picked one would hide a change in the other.
 */
export function computeEnvironmentKey(input: EnvironmentKeyInput): string {
  const parsed = EnvironmentKeyInputSchema.parse(input);
  const files = [...parsed.keyFiles].sort((left, right) => compareText(left.repositoryId, right.repositoryId) || compareText(left.path, right.path));
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1] as EnvKeyFile;
    const current = files[index] as EnvKeyFile;
    if (previous.repositoryId === current.repositoryId && previous.path === current.path) throw new Error("a key file is listed twice");
  }
  const secretNames = [...new Set(parsed.secretNames)].sort(compareText);
  // JSON keeps every field apart from its neighbours, so ("a", "b/c") and ("a/b", "c") cannot collide the way a joined string could.
  return sha256Hex(canonicalJson({
    kind: "rovara.saved-env.key",
    version: SAVED_ENV_KEY_VERSION,
    files: files.map((file) => [file.repositoryId, file.path, file.sha256]),
    testEnvRevision: parsed.testEnvRevision,
    secretNames,
    baseImageDigest: parsed.baseImageDigest,
  }));
}

/** What the image was built from (design 5.1). No secrets, no running programs. */
export const SavedEnvManifestSchema = z.object({
  schemaVersion: z.literal(1),
  environmentKey: Sha256Hex,
  /** The test environment revision the setup was proved at; a task pinned to another revision does not use this image. */
  testEnvRevision: z.number().int().min(1),
  commits: z.array(z.object({ repositoryId: RepositoryId, sha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict()).min(1).max(SAVED_ENV_MAX_COMMITS)
    // One commit per repository: two entries for one id could hide a different commit from a comparison that looks the id up.
    .refine((commits) => new Set(commits.map((entry) => entry.repositoryId)).size === commits.length, "a repository is listed twice"),
  /** The digest of the Prove report that allowed the build. */
  proveReportDigest: Sha256Hex,
  imageDigest: ImageDigestSchema,
  builtAt: z.string().datetime(),
}).strict();
export type SavedEnvManifest = z.infer<typeof SavedEnvManifestSchema>;
