// L4-EINT: PLANS the stand-in round of one eval check (the production path; the operator's switch AGENTX_EVAL_STAND_INS, default off). Inputs: the descriptor the broker delivered (the free dry run's outside hosts, the stand-in
// writer's sample set) and the repository at its BASE commit. Output: ONE `EvalStandInRound` (both sides, every re-ask and the second look share its answer book and certificate authority) and the digests that make the
// stand-in set's VERSION (E4).
//
// THE BASE COMMIT ONLY. Recordings and OpenAPI descriptions are read from a Rovara-made checkout of the BASE commit, never from the change: a change cannot edit the answers it will be measured against, and both sides get the same
// stand-in. Everything read is data (parsed, never run), within `EVAL_STAND_IN_READ_LIMITS`, never through a link.
//
// NEVER STOPS THE EVAL. A plan that cannot be made (no checkout, no host and no recording, an id that is not a UUID) is "no stand-in round": the eval runs exactly as it would without the switch.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, opendir, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { open } from "node:fs/promises";
import { parse } from "yaml";
import { STAND_IN_ROW_GENERATOR_VERSION, STAND_IN_SET_LIMITS, evalTelemetryEntryOf, isEvalStandInPlanHost, standInPoolRoutes, standInSetDigest, standInSetVersion, type EvalStandInDescriptor, type EvalStandInPlan, type StandInWriterSet, type TaskDependencyPlan } from "@agentx/contracts";
import { createProcessCandidateGit } from "./e2e-candidate-source.js";
import { EVAL_STAND_IN_READ_LIMITS, EvalStandInRound, buildEvalStandInPlan, readRepositoryRecordings } from "./eval-standin-round.js";
import { openApiHostOf } from "./standin-readers.js";
import type { DockerCli } from "./swebench/containers.js";
import { readSeedFile, seedFileDigest } from "./service-seed-file.js";
import { EVAL_SERVICES_FAILURE_SENTENCE, type EvalServicesInput } from "./verification/eval-services.js";
import { postgresStandInDatabase, prepareStandInDatabase } from "./verification/eval-database-prep.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const OPENAPI_NAME = /^(?:openapi|swagger)[^/]*\.(?:ya?ml|json)$/iu;
const SKIP = new Set(["node_modules", ".git", "vendor", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache", "coverage"]);

/** The OpenAPI descriptions of a checkout, by the host each names (the first file for a host, in path order). Bounded, no links, parsed as data. Never throws. */
export async function findOpenApiDescriptions(checkoutRoot: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let visited = 0; let files = 0;
  try {
    const root = await realpath(checkoutRoot);
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > EVAL_STAND_IN_READ_LIMITS.depth) return;
      const entries: { name: string; dir: boolean; file: boolean }[] = [];
      for await (const entry of await opendir(directory)) {
        if (++visited > EVAL_STAND_IN_READ_LIMITS.visited) break;
        if (entry.isSymbolicLink()) continue;
        entries.push({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() });
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = join(directory, entry.name);
        if (entry.dir) { if (!SKIP.has(entry.name)) await walk(path, depth + 1); continue; }
        if (!entry.file || !OPENAPI_NAME.test(entry.name) || files >= EVAL_STAND_IN_READ_LIMITS.files) continue;
        files += 1;
        try {
          const real = await realpath(path);
          if (real !== root && !real.startsWith(`${root}${sep}`)) continue;
          const handle = await open(real, "r");
          let text: string;
          try { const info = await handle.stat(); if (!info.isFile() || info.size > EVAL_STAND_IN_READ_LIMITS.fileBytes) continue; text = (await handle.readFile()).toString("utf8"); } finally { await handle.close(); }
          const host = openApiHostOf(parse(text, { maxAliasCount: 50, prettyErrors: false }) as unknown);
          if (host !== undefined && !found.has(host)) found.set(host, relative(root, real));
        } catch { /* a file that does not read is skipped */ }
      }
    };
    await walk(root, 0);
  } catch { /* what was found stays */ }
  return found;
}

export interface PlannedEvalStandIns {
  readonly round: EvalStandInRound;
  /** What the version's `answerSets` hold (E4): the writer's set digest, the recordings, the plan and the round's book digest, each as a sha-256 hex. */
  readonly answerSetDigests: readonly string[];
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The round for a checkout of the base commit, or undefined (nothing to stand in for, or a workspace/operation id that is not what the stand-in's files need). Pure of Docker; never throws. */
export async function planEvalStandInsFromCheckout(input: { descriptor: EvalStandInDescriptor; checkoutRoot: string; workspaceId: string; operationId: string }): Promise<PlannedEvalStandIns | undefined> {
  try {
    if (!UUID.test(input.workspaceId) || !UUID.test(input.operationId)) return undefined;
    // Only the hosts the sandboxed dry run saw, never a telemetry host (the stand-in answers those itself), in a fixed order.
    const hosts = [...new Set(input.descriptor.hosts.map((host) => host.name.toLowerCase()).filter((host) => isEvalStandInPlanHost(host) && evalTelemetryEntryOf(host) === undefined))].sort();
    const specs = await findOpenApiDescriptions(input.checkoutRoot);
    const built = await buildEvalStandInPlan(input.checkoutRoot, hosts.map((host) => ({ host, ...(specs.has(host) ? { specPath: specs.get(host) } : {}) })));
    const set: StandInWriterSet | undefined = input.descriptor.writerSet;
    // The writer's sample answers join the host's operations (E7 into E6).
    const plan: EvalStandInPlan = built.map((entry) => { const pools = standInPoolRoutes(entry.host, entry.openapi, set); return pools.length === 0 ? entry : { ...entry, pools }; });
    const recordings = await readRepositoryRecordings(input.checkoutRoot, hosts.length === 1 ? hosts[0] : undefined);
    const recorded = recordings.recorded.filter((entry) => evalTelemetryEntryOf(entry.host.toLowerCase()) === undefined);
    if (plan.length === 0 && recorded.length === 0) return undefined;
    const round = new EvalStandInRound({ workspaceId: input.workspaceId, operationId: input.operationId, plan, recorded });
    const answerSetDigests = [
      ...(set === undefined ? [] : [standInSetDigest(set)]),
      sha(`rovara-eval-recorded/v1\n${JSON.stringify(recorded.map((entry) => [entry.method, entry.host, entry.path, entry.query, entry.status, sha(entry.body)]))}`),
      sha(`rovara-eval-plan/v1\n${JSON.stringify(plan.map((entry) => [entry.host, entry.openapi === undefined ? null : specs.get(entry.host) ?? null, (entry.pools ?? []).length]))}`),
      round.book.digest(),
    ];
    return { round, answerSetDigests };
  } catch { return undefined; }
}

/** The same, from the repository itself: the BASE commit is materialized by the worker (never the change's tree, never the working tree) into a folder of its own that is removed afterwards. */
export async function planEvalStandIns(input: {
  descriptor: EvalStandInDescriptor; repositoryDirectory: string; baseCommit: string; scratchDir: string; workspaceId: string; operationId: string; signal: AbortSignal;
  /** Test seam; default the worker's safe git path. */
  materialize?: ((root: string, sha: string, destination: string, signal: AbortSignal) => Promise<void>) | undefined;
}): Promise<PlannedEvalStandIns | undefined> {
  let folder: string | undefined;
  try {
    await mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
    folder = await mkdtemp(join(input.scratchDir, "standin-plan-"));
    const checkout = join(folder, "checkout");
    await mkdir(checkout, { mode: 0o755 });
    await (input.materialize ?? ((root, commit, destination, signal) => createProcessCandidateGit(folder!).materializeInto(root, commit, destination, signal)))(input.repositoryDirectory, input.baseCommit, checkout, input.signal);
    if (input.signal.aborted) return undefined;
    return await planEvalStandInsFromCheckout({ descriptor: input.descriptor, checkoutRoot: checkout, workspaceId: input.workspaceId, operationId: input.operationId });
  } catch { return undefined; } finally {
    if (folder !== undefined) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- the whole preparation of one eval check: the round, the seed files and the version

/**
 * The path of a seed inside ONE repository's checkout, from its workspace-relative path: the first `k` folders (k = 0 to 4) must be the last `k` folders of the repository's own directory on the worker, the rest is the path in the
 * checkout (never empty, never `..`). Undefined when the seed is not this repository's. Pure.
 */
export function seedPathInRepository(fixturePath: string, repositoryDirectory: string): string | undefined {
  const parts = fixturePath.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  const folders = repositoryDirectory.split("/").filter((part) => part !== "");
  for (let k = Math.min(4, parts.length - 1); k >= 0; k -= 1) {
    const prefix = parts.slice(0, k);
    if (k === 0 || (folders.length >= k && prefix.every((part, i) => folders[folders.length - k + i] === part))) return parts.slice(k).join("/");
  }
  return undefined;
}

export interface PreparedEvalStandIns {
  /** The outside-HTTP round (absent: no host and no recording, or no descriptor). */
  readonly round?: EvalStandInRound | undefined;
  /** The seed files of each local dependency (by the plan's id), read from the BASE commit once: both sides load the same bytes. */
  readonly seeds: ReadonlyMap<string, readonly Buffer[]>;
  /** E4: the stand-in set's version for the base-cache key, or undefined when nothing is stood in. */
  readonly version?: string | undefined;
}

/**
 * Prepares everything that needs the BASE commit, ONCE per eval check, from a checkout of it that Rovara makes and removes: the round (descriptor + recordings + descriptions), the seed FILES of the project's local
 * dependencies (`seeds[].fixturePath`, read with the same containment rules the Build step uses) and the version. Fail-soft in every part: nothing found is nothing stood in; a seed file that cannot be read gives the
 * dependency no seed (and no digest), so both sides stay identical. Never throws.
 */
export async function prepareEvalStandIns(input: {
  descriptor: EvalStandInDescriptor | undefined; dependencies: readonly TaskDependencyPlan[] | undefined;
  repositoryDirectory: string; baseCommit: string; scratchDir: string; workspaceId: string; operationId: string; signal: AbortSignal;
  materialize?: ((root: string, sha: string, destination: string, signal: AbortSignal) => Promise<void>) | undefined;
}): Promise<PreparedEvalStandIns> {
  const locals = (input.dependencies ?? []).filter((plan) => plan.backing === "local");
  let folder: string | undefined;
  try {
    await mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
    folder = await mkdtemp(join(input.scratchDir, "standin-prep-"));
    const checkout = join(folder, "checkout");
    await mkdir(checkout, { mode: 0o755 });
    await (input.materialize ?? ((root, commit, destination, signal) => createProcessCandidateGit(folder!).materializeInto(root, commit, destination, signal)))(input.repositoryDirectory, input.baseCommit, checkout, input.signal);
    if (input.signal.aborted) return { seeds: new Map() };
    const planned = input.descriptor === undefined ? undefined : await planEvalStandInsFromCheckout({ descriptor: input.descriptor, checkoutRoot: checkout, workspaceId: input.workspaceId, operationId: input.operationId });
    const seeds = new Map<string, Buffer[]>();
    const seedDigests: string[] = [];
    const images: string[] = [];
    for (const plan of locals) {
      if (typeof plan.digest === "string" && /^[A-Za-z0-9._:/@+-]{1,2000}$/u.test(plan.digest)) images.push(plan.digest);
      const files: Buffer[] = [];
      for (const seed of plan.seeds) {
        if (!("fixturePath" in seed)) continue;
        try {
          // A seed's path is WORKSPACE-relative (`<repository path>/<file>`); the checkout is this one repository. The seed belongs to this repository only when the path's folder prefix is the end of the repository's own directory
          // (so a file of another repository is never read from this tree); the rest is the path inside the checkout.
          const inside = seedPathInRepository(seed.fixturePath, input.repositoryDirectory);
          if (inside === undefined) continue;
          const bytes = await readSeedFile({ rootPath: checkout, repositoryPaths: [checkout], hiddenPaths: [], fixturePath: inside, family: plan.family });
          // An approved plan names the content its approval bound: a file that differs is not loaded.
          if (seed.sha256 !== undefined && seed.sha256 !== seedFileDigest(bytes)) continue;
          files.push(bytes); seedDigests.push(seedFileDigest(bytes));
        } catch { /* no seed for this entry, on both sides */ }
      }
      if (files.length > 0) seeds.set(plan.id, files);
    }
    const stoodIn = planned !== undefined || locals.length > 0;
    const version = !stoodIn ? undefined : (() => { try { return standInSetVersion({ images, seeds: seedDigests.slice(0, STAND_IN_SET_LIMITS.seeds), generatorVersion: STAND_IN_ROW_GENERATOR_VERSION, answerSets: planned?.answerSetDigests.slice(0, STAND_IN_SET_LIMITS.answerSets) ?? [] }); } catch { return undefined; } })();
    return { ...(planned === undefined ? {} : { round: planned.round }), seeds, ...(version === undefined ? {} : { version }) };
  } catch { return { seeds: new Map() }; } finally {
    if (folder !== undefined) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The seed step of ONE side's services (`EvalServicesInput.seed`, E3): for each started service whose family has a file loader (Postgres), the base commit's seed files in the plan's order, then generated rows for the tables
 * still empty (`prepareStandInDatabase`). The side's own database, built the same way on both sides. A failing seed ends the start with a fixed sentence (the starter retries once, then the eval is Not run). Project COMMANDS
 * (migrations, seed commands) are not run here (they need a box with the checkout on the round's network): the services start with the files and the generated rows only. Never reads a value, never throws anything but the fixed sentence.
 */
export function evalDatabaseSeed(input: { docker: Pick<DockerCli, "execBytes" | "run">; side: "old" | "new"; prepared: Pick<PreparedEvalStandIns, "seeds"> }): NonNullable<EvalServicesInput["seed"]> {
  return async (started, _net, signal) => {
    for (const target of started.targets) {
      if (target.family !== "postgres") continue;
      const files = input.prepared.seeds.get(target.id) ?? [];
      const database = postgresStandInDatabase({
        docker: input.docker, target: { container: target.container, family: target.family, user: target.user, database: target.database },
        // A project command is not run in the eval round's services: a step that is one would fail the side, so none is given (see above).
        runCommand: async () => { throw new Error("no commands"); },
      });
      try { await prepareStandInDatabase({ side: input.side, database, steps: files.map((bytes) => ({ kind: "file" as const, bytes })), signal }); } catch { throw new Error(EVAL_SERVICES_FAILURE_SENTENCE); }
    }
  };
}
