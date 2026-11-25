// L4-EVS (DEC 254zzz20 D3): the environment the sealed eval runs in. See contracts `eval-environment.ts` for what the broker may deliver. This file is the worker's two halves:
//
//   SAVED. `useSavedEnvironment` pulls the project's saved image by digest (the preparation's own pull and checks, `extractSavedEnvSeed`: digest only, labels, manifest, link and special-file checks;
//   nothing in the image is ever run) and copies ONLY its dependency folders (`node_modules`, `.venv`, ... : `SAVED_ENV_UNTRACKED_FOLDER_NAMES`) next to the commit's own files in the eval checkout.
//   A tracked file of the image is never copied (the commit's code is the code under test), and a dependency folder is never put over a path the commit already has. Links are copied as links, never followed.
//   Any failure answers false (the caller then runs the project's install steps if the plan has them, else the bare image): a bad image never stops an eval, and it never makes one read wrongly.
//
//   INSTALL. `evalInstallRunArgs` (in eval-bridged-exec.ts, beside the sealed sandbox's own arguments) is the `docker run` of ONE approved install step. It differs from the sealed run in exactly the ways that matter:
//     - the network is the machine's shared sandbox network, whose reach is the allowed-websites firewall (package registries and the project's own allowed domains; the same reach the project's own setup
//       and test runs have), and the sealed run's round network is NOT used;
//     - there is NO model route: every model host is pointed at a dropped address, no helper is started, no bridge folder, no token and no env file exist yet;
//     - the same walls as every eval box: non-root, every capability dropped, no-new-privileges, read-only root, memory, cpu and process limits, ONE mount (the checkout) and a tmpfs.
//   It runs BEFORE the sealed run starts and is gone before the round network exists. Then the box is sealed: no network except the model helper.
import { lstat, readdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EvalEnvironment } from "@agentx/contracts";
import { SAVED_ENV_NEVER_SHIPPED_UNTRACKED, SAVED_ENV_UNTRACKED_FOLDER_NAMES } from "../saved-env/build.js";
import { extractSavedEnvSeed, type SavedEnvUseOptions } from "../saved-env/use.js";
import type { DockerCli } from "../docker-cli.js";

/** The most entries one overlay walks, and the deepest folder it enters: a hostile or runaway image cannot make the worker walk forever. */
export const EVAL_OVERLAY_ENTRIES_MAX = 400_000;
const OVERLAY_DEPTH_MAX = 24;
const DEPENDENCY_FOLDERS: ReadonlySet<string> = new Set(SAVED_ENV_UNTRACKED_FOLDER_NAMES);

/** Where a `--user` install puts its files: inside the checkout, so the sealed run (which sets the same variable) finds them. */
export const EVAL_PYTHON_USER_BASE = "/workspace/.rovara-python";

/**
 * Copies the dependency folders of `seedRepository` (the repository's folder in an extracted seed) into `checkout`, at the same relative paths. A folder is taken whole, by name, at any depth (not inside another
 * dependency folder); a path the checkout already holds is left alone. Refuses (throws) when the walk is over its bounds. Never follows a link, never copies a `.git`.
 */
export async function overlayDependencyFolders(seedRepository: string, checkout: string, created: string[] = [], copy: typeof cp = cp): Promise<{ folders: number }> {
  let entries = 0;
  let folders = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > OVERLAY_DEPTH_MAX) throw new Error("the seed is nested too deep");
    for (const entry of await readdir(join(seedRepository, relative), { withFileTypes: true })) {
      if (++entries > EVAL_OVERLAY_ENTRIES_MAX) throw new Error("the seed is too large to read");
      if (entry.name === ".git") continue;
      const here = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (DEPENDENCY_FOLDERS.has(entry.name)) {
        const destination = join(checkout, here);
        // The commit's own path wins: a tracked folder of that name stays what the commit says. A missing one is made.
        if (await lstat(destination).then(() => true, () => false)) continue;
        // Recorded BEFORE the copy: a copy that fails part way leaves a part folder, and that one is removed too.
        created.push(destination);
        await copy(join(seedRepository, here), destination, {
          recursive: true, verbatimSymlinks: true, dereference: false, force: false, errorOnExist: true,
          filter: (source) => !SAVED_ENV_NEVER_SHIPPED_UNTRACKED.has(source.slice(source.lastIndexOf("/") + 1)),
        });
        folders += 1;
        continue;
      }
      await walk(here, depth + 1);
    }
  };
  await walk("", 0);
  return { folders };
}

export interface UseSavedEnvironmentInput {
  readonly environment: Extract<EvalEnvironment, { kind: "saved" }>;
  readonly checkout: string;
  readonly docker: DockerCli;
  readonly now?: (() => number) | undefined;
  /** Test seam: the preparation's pull and extract. Default `extractSavedEnvSeed`. */
  readonly extract?: typeof extractSavedEnvSeed;
  /** Test seam: the folder copy. Default `fs.cp`. */
  readonly copy?: typeof cp;
}

/** True when the saved image's dependency folders are in `checkout`. False for anything else (nothing is left half done that a run could trip on: a failed copy is removed here). Never throws, never echoes. */
export async function useSavedEnvironment(input: UseSavedEnvironmentInput): Promise<boolean> {
  const env = input.environment;
  const options: SavedEnvUseOptions = {
    ref: { repository: env.repository, digest: env.digest, testEnvRevision: env.testEnvRevision, environmentKey: env.environmentKey, taskTestEnvRevision: env.testEnvRevision },
    // Held in memory for this one pull; the preparation's code writes it to a throwaway docker config and removes it.
    login: async () => env.login,
    docker: input.docker,
    ...(input.now === undefined ? {} : { now: input.now }),
  };
  const created: string[] = [];
  let extracted: Awaited<ReturnType<typeof extractSavedEnvSeed>> | undefined;
  try {
    extracted = await (input.extract ?? extractSavedEnvSeed)(options);
    const seedRepository = join(extracted.seed, env.directory);
    const info = await lstat(seedRepository);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const { folders } = await overlayDependencyFolders(seedRepository, input.checkout, created, input.copy);
    return folders > 0;
  } catch {
    // A half-copied folder must not stay (the install fallback, or the bare image, runs over this checkout): what this call made is removed.
    await Promise.all(created.map(path => rm(path, { recursive: true, force: true }).catch(() => undefined)));
    return false;
  } finally {
    await extracted?.remove().catch(() => undefined);
  }
}
