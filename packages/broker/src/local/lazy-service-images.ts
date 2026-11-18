// Test services on a laptop, LAZY pulls (DEC 254z-amend3): `rovara up` pulls no service image. The first step that needs one (a coding or checks run whose plan names a dependency) has its images pulled on the host, by
// digest, before the job is handed to the worker.
//
// Rules:
//   - Only images of the owner's list in effect (`LocalTestServices.ownerImages`) are ever pulled, by their pinned reference (`registry/repository@sha256:<digest>`), so the daemon holds the bytes to the digest. A plan
//     names a dependency by repository and digest; one with no matching entry is not this module's to pull (the worker refuses it, as before).
//   - A pull runs in the background, at most once per reference at a time, with the same ten-minute limit as an approval's pull. While one runs, `prepare` answers `pulling` and the caller tells the dispatcher to come back
//     (a `not_ready` machine, which the dispatcher retries within its own attempt budget). Nothing waits on Docker inside a dispatch.
//   - A pull that FAILS does not hold the step: `prepare` answers `ready` and the worker's own check (`requireLocalImages`) refuses the dependency in its fixed words. The failure is remembered for five minutes, so a
//     daemon that is down is not asked again on every try; after that a later step tries again.
//   - At most MAX_IMAGES_PER_STEP references are looked at for one step (a plan has few dependencies; a larger one is not looked at past the cap).
//   - Logs name only fixed events and the family of the image, never a reference, a digest or Docker's output.
import { ownerImageKey, ownerImageReferences, type OwnerListEntry } from "@agentx/contracts";
import type { DockerRunner } from "./docker-runner.js";

const PULL_TIMEOUT_MS = 10 * 60_000;
const QUICK_MS = 60_000;
const FAILED_FOR_MS = 5 * 60_000;
export const MAX_IMAGES_PER_STEP = 8;

export type LazyPullAnswer = "ready" | "pulling";

export interface LazyServiceImages {
  /** The owner-list references a job needs that are not on this computer yet: starts their pulls and answers `pulling`, or `ready` when there is nothing to wait for (all here, none needed, or a pull failed). */
  prepare(invocation: unknown): Promise<LazyPullAnswer>;
}

/** The pinned references of the owner's list that a job's plan names (repository and digest), in plan order, without repeats, at most MAX_IMAGES_PER_STEP. Anything that is not a plan's dependency is ignored. */
export function ownerImagesNeededBy(invocation: unknown, ownerImages: readonly OwnerListEntry[]): string[] {
  const dependencies = dependenciesOf(invocation);
  if (dependencies.length === 0) return [];
  // The same key the worker turns a plan's repository and digest back into (`ownerImageReferences`), so this pulls exactly what the worker will look for.
  const byKey = ownerImageReferences(ownerImages);
  const needed: string[] = [];
  for (const dependency of dependencies) {
    if (needed.length >= MAX_IMAGES_PER_STEP) break;
    const reference = byKey.get(ownerImageKey(dependency.repository, dependency.digest));
    if (reference !== undefined && !needed.includes(reference)) needed.push(reference);
  }
  return needed;
}

/** The plan's dependencies that name an image by repository and digest. Read defensively: the job is the core's, but nothing here trusts its shape. */
function dependenciesOf(invocation: unknown): Array<{ repository: string; digest: string }> {
  if (typeof invocation !== "object" || invocation === null) return [];
  const payload = (invocation as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return [];
  const plan = (payload as { testEnvironment?: unknown }).testEnvironment;
  if (typeof plan !== "object" || plan === null) return [];
  const list = (plan as { dependencies?: unknown }).dependencies;
  if (!Array.isArray(list)) return [];
  const found: Array<{ repository: string; digest: string }> = [];
  for (const item of list.slice(0, 64)) {
    if (typeof item !== "object" || item === null) continue;
    const { repository, digest } = item as { repository?: unknown; digest?: unknown };
    if (typeof repository === "string" && typeof digest === "string" && /^svc\/[a-z0-9][a-z0-9._-]{0,62}$/u.test(repository) && /^[a-f0-9]{64}$/u.test(digest)) found.push({ repository, digest });
  }
  return found;
}

export function createLazyServiceImages(input: {
  docker: DockerRunner; ownerImages: readonly OwnerListEntry[]; now?: () => number; log?: (entry: Record<string, unknown>) => void;
}): LazyServiceImages {
  const now = input.now ?? Date.now;
  const log = input.log ?? (() => undefined);
  const familyOf = new Map(input.ownerImages.map((entry) => [entry.reference, entry.family]));
  const pulling = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  const present = async (reference: string): Promise<boolean> => {
    const inspected = await input.docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: QUICK_MS }).catch(() => undefined);
    return inspected !== undefined && inspected.exitCode === 0;
  };
  const startPull = (reference: string): void => {
    log({ component: "test-services", event: "test_services.image_pull_started", family: familyOf.get(reference) ?? "unknown" });
    const run = input.docker.run(["pull", "--quiet", reference], { timeoutMs: PULL_TIMEOUT_MS })
      .then((result) => result.exitCode === 0, () => false)
      .then((ok) => {
        if (ok) failedAt.delete(reference);
        else failedAt.set(reference, now());
        log({ component: "test-services", event: ok ? "test_services.image_pulled" : "test_services.image_pull_failed", family: familyOf.get(reference) ?? "unknown" });
      })
      .finally(() => { pulling.delete(reference); });
    pulling.set(reference, run);
  };
  return {
    async prepare(invocation) {
      const needed = ownerImagesNeededBy(invocation, input.ownerImages);
      let waiting = false;
      // A reference being pulled waits; one that failed recently does not hold the step (the worker refuses the dependency in its own words); the rest are looked for at once, in parallel.
      const toCheck = needed.filter((reference) => {
        if (pulling.has(reference)) { waiting = true; return false; }
        const failed = failedAt.get(reference);
        return failed === undefined || now() - failed >= FAILED_FOR_MS;
      });
      const here = await Promise.all(toCheck.map((reference) => present(reference)));
      toCheck.forEach((reference, index) => {
        // Another step may have started this pull while we looked: never start it twice.
        if (pulling.has(reference)) { waiting = true; return; }
        if (here[index] === true) { failedAt.delete(reference); return; }
        startPull(reference);
        waiting = true;
      });
      return waiting ? "pulling" : "ready";
    },
  };
}
