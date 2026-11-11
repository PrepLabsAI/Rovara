// The `image-registry` plug-in point (a new interface; both owners approve).
//
// Where a project's saved environment image lives. The broker never talks to a registry itself: it asks this port for four things and
// keeps the rules that make an image trustworthy (which approved environment the image is for, that a Prove run passed, that the job
// that pushes is the job that was queued) in Rovara's core (`core/test-env/saved-env*.ts`).
//
//   - `inspect`: is the repository the one Rovara makes (nobody else's, with the settings Rovara needs)? A repository somebody else
//     created first, with other settings, answers `unusable` and is never pushed to or pulled from. `absent` is fine for a push: the
//     first push makes it.
//   - `login`: a short-lived login for ONE repository, to push or to pull. The worker never sees the registry's own credentials, only
//     this login (`SavedEnvRegistryAuth`), which works for that one repository and nothing else. An adapter that cannot bound a login to
//     one repository must not hand one out.
//   - `list` / `deleteImages` / `deleteRepository`: the broker's own housekeeping (keep the newest N images, the age ceiling, a deleted
//     project). Deleting what is not there is not an error.
//   - `startScan` (optional): a vulnerability scan of one pushed image, where the registry has one.
//
// A repository name is built by `savedEnvRepositoryName` (a hash of the company and the project, so no name is in a registry listing);
// the adapter takes it as given and refuses a name that is not that shape (`isSavedEnvRepositoryName`), so no wildcard or extra segment
// reaches a registry call. An adapter takes the company from each call, as every shared port does. Cloud's adapter is the cloud registry
// (a login scoped to one repository); Code's is a registry container on the owner's own Docker.
//
// Errors are `ImageRegistryError` with a fixed sentence: never a command's output, an address with a credential, or a registry's own
// message (a cloud error can carry a resource name or a request id).
import type { SavedEnvRegistryAuth } from "../saved-env-image.js";

/** What one adapter can do. The core asks before it queues a build or names an image to a worker, so a worker is never sent what it cannot do. */
export interface ImageRegistryCapabilities {
  /** A worker can push an image it built to this registry with its own container tooling (the worker holds the login, nothing else). */
  workerPush: boolean;
  /** A worker can pull an image from this registry by digest. */
  workerPull: boolean;
  /** `startScan` does something. */
  scan: boolean;
}

/** What `list` says of one image the registry holds. */
export interface RegistryImage {
  /** `sha256:<64 hex>`. */
  digest: string;
  tags: string[];
  /** When the image was pushed (an ISO instant). */
  pushedAt: string;
}

/** `matches`: the repository is the one Rovara makes. `absent`: there is none (a first push makes it). `unusable`: it exists with other settings, so nothing is pushed or pulled. */
export type RepositoryState = "matches" | "absent" | "unusable";

export interface RegistryLogin {
  auth: SavedEnvRegistryAuth;
  /** When the login stops working (ms since the epoch); never later than `auth.expiresAt`. */
  expiresAtMs: number;
}

export interface RepositoryCall {
  companyId: string;
  /** A name `savedEnvRepositoryName` made. */
  repository: string;
}

export type ImageRegistryErrorCode =
  /** The registry could not be reached or could not do it now. Retry later. */
  | "unavailable"
  /** The call is not one this adapter does (an unknown shape of repository name, a login it cannot bound to one repository). Never retried. */
  | "refused";

export class ImageRegistryError extends Error {
  constructor(readonly code: ImageRegistryErrorCode, message: string) {
    super(message);
    this.name = "ImageRegistryError";
  }
  get retryable(): boolean {
    return this.code === "unavailable";
  }
}

export interface ImageRegistry {
  readonly capabilities: ImageRegistryCapabilities;
  inspect(call: RepositoryCall): Promise<RepositoryState>;
  /** A login that lives at most `maxSeconds`. Throws `ImageRegistryError`. */
  login(call: RepositoryCall & { access: "push" | "pull"; maxSeconds: number }): Promise<RegistryLogin>;
  /** The images of the repository, or `absent`. */
  list(call: RepositoryCall): Promise<RegistryImage[] | "absent">;
  /** Deletes these images (by digest). Digests the registry does not hold are ignored. */
  deleteImages(call: RepositoryCall & { digests: readonly string[] }): Promise<void>;
  /** Deletes the repository with its images. `absent`: it did not exist, which counts as done. */
  deleteRepository(call: RepositoryCall): Promise<"deleted" | "absent">;
  startScan?(call: RepositoryCall & { digest: string }): Promise<void>;
  /** Lets go of what the adapter holds (a connection, a timer) so the process can exit. */
  close?(): Promise<void> | void;
}
