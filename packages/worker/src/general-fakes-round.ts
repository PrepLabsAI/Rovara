// General fakes, slice 1 (owner decision 234 item 1; plan lanes TE-G1, TE-G2, TE-G6; plan briefs/general-fakes-plan.md): one CHECKS round with Rovara-made fakes beside it. `withGeneralFakesRound(plan, runners)`
// wraps the round's `CheckRunners` the way `withModelHelperRound` does: without a plan it returns the SAME object (nothing changes); with one, the first project command of a round builds a fake per configured
// service from the customer's OpenAPI description (openapi-fake.ts, through the contract finder of PR 589), starts ONE loopback HTTP server in the worker process (127.0.0.1, an ephemeral port), and every
// project command of the round gets each service's base-URL variable set to `http://127.0.0.1:<port>/s/<n>`. `endRound` reports per check how many calls a fake answered, and stops the server.
//
// Honesty rules, each with a test (tests/unit/worker-general-fakes-round.test.ts):
//   - EVERY call the server answered (a fake answer, or its fixed "cannot answer" 501) makes that check fake-answered: the broker maps it to a `made_by_rovara` dependency and it NEVER counts as change proof.
//   - A call no check can be blamed for (during setup, between commands, from a check with an unreadable id) makes the round's facts `unknown`, which marks every check of the round fake-answered.
//   - A check whose command FAILED after a call its fake could not answer is "Not run" with a fixed reason (contracts general-fakes.ts), never "failed": the failure says nothing about the change.
//   - Reasons and lines are fixed words: no path, variable, host, query or body.
//   - Local shell only (slice 1). In a task sandbox or dev container run-task makes no plan, and says so.
// Known limit (the same as the model helper's): a background process left by an earlier command that calls the fake during a later command is counted for the later check (it is still fake-answered).
import type { Dir } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import type { Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { parse } from "yaml";
import {
  GENERAL_FAKE_NOT_RUN_SENTENCES, GENERAL_FAKE_REASONS, GeneralFakesPayloadSchema, buildOpenApiFake, generalFakesRoundLine,
  type GeneralFakeReason, type GeneralFakeService, type GeneralFakeServiceFake, type GeneralFakesPayload,
} from "@agentx/contracts";
import { createGeneralFakesServer } from "./general-fakes-server.js";
import { CheckNotRunError, type CheckRunners } from "./verification/checks.js";

export const GENERAL_FAKES_DISCOVERY_LIMITS = { entries: 2_000, depth: 8, candidates: 16, specBytes: 2 * 1024 * 1024 } as const;
const SPEC_NAME = /^(?:openapi|swagger)\.(?:ya?ml|json)$|\.openapi\.(?:ya?ml|json)$/iu;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "vendor", "dist", "build", "target", "coverage", "__pycache__", "venv"]);
const CHECK_ID = /^(?:readiness|agent):(0|[1-9]\d{0,5})$/u;

export interface GeneralFakeFacts {
  /** True when some call could not be blamed on one check: every check of the round is then fake-answered. */
  readonly unknown: boolean;
  /** Checks a fake answered at least once, in the order they ran. */
  readonly checks: readonly { readonly checkId: string; readonly served: number }[];
}
export interface GeneralFakesRoundResult {
  readonly facts: GeneralFakeFacts;
  /** Fixed words for the round's evidence: the "Made by Rovara" line when any call was answered. */
  readonly lines: readonly string[];
}
/** What a hosted helper answered since the last read, in counts (slice 2b). `foreign` (another address) and `unrouted` (a path no service answers) can be blamed on no check; `refused` was refused for its size. */
export interface HostedFakeCalls {
  readonly served: number;
  readonly cannotAnswer: Readonly<Record<Exclude<GeneralFakeReason, "start_failed">, number>>;
  readonly foreign: number;
  readonly unrouted: number;
  readonly refused: number;
}
/** A hosted helper that is up for one round (general-fakes-hosted.ts). */
export interface StartedHostedFakes {
  /** The round's project commands get these variables (one base URL per service). */
  readonly environment: Readonly<Record<string, string>>;
  /** The calls since the last read, or undefined when the helper's record cannot be read, is not trusted or is saturated: never "no calls". */
  drain(): Promise<HostedFakeCalls | undefined>;
  /** Stops the helper and takes its network down (idempotent, never throws). */
  stop(): Promise<void>;
}
/** Starts a helper for ONE round with the fakes built from the customer's descriptions. A rejection makes the round's commands "Not run: Rovara could not start its fakes for this round." */
export interface HostedFakesLauncher {
  start(input: { readonly fakes: readonly GeneralFakeServiceFake[]; readonly variables: readonly string[] }): Promise<StartedHostedFakes>;
}
export interface GeneralFakesRoundPlan {
  readonly services: readonly GeneralFakeService[];
  readonly rootPath: string;
  readonly repositoryPaths: readonly string[];
  /** Slice 2b: when set, the fakes run in the hosted fake-helper container (a task sandbox) instead of the worker's loopback server. */
  readonly hosted?: HostedFakesLauncher;
  /** REQUIRED: the round's facts. Whoever supplies it must keep fake-answered checks out of the change proof (run-task puts them in the test proof). */
  onResult(result: GeneralFakesRoundResult): void;
}

/** The plan for a CHECKS round, or undefined: no payload, a payload that does not read, or not the local shell (slice 1). */
export function generalFakesPlanFor(payload: GeneralFakesPayload | undefined, options: { localShell: boolean; rootPath: string; repositoryPaths: readonly string[]; onResult: (result: GeneralFakesRoundResult) => void; hosted?: HostedFakesLauncher }): GeneralFakesRoundPlan | undefined {
  // Slice 2b: a task sandbox gets a plan only with a hosted launcher; the local shell never does (its fakes are the loopback server's).
  if (payload === undefined || (options.localShell ? options.hosted !== undefined : options.hosted === undefined)) return undefined;
  const parsed = GeneralFakesPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  return { services: parsed.data.services, rootPath: options.rootPath, repositoryPaths: [...options.repositoryPaths], onResult: options.onResult, ...(options.hosted === undefined ? {} : { hosted: options.hosted }) };
}

/** Both sets of facts as one: unknown if either is, served counts added per check. Undefined only when both are. */
export function mergeGeneralFakeFacts(a: GeneralFakeFacts | undefined, b: GeneralFakeFacts | undefined): GeneralFakeFacts | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  const served = new Map<string, number>();
  for (const entry of [...a.checks, ...b.checks]) served.set(entry.checkId, (served.get(entry.checkId) ?? 0) + entry.served);
  return { unknown: a.unknown || b.unknown, checks: [...served].map(([checkId, count]) => ({ checkId, served: count })) };
}

/**
 * Each invocation owns its collector. Every round's facts accumulate until `take()`: take the candidate round's right after it, then take again after the original-code rounds, whose facts count too
 * (a fake answer on the old code can make a new test fail there, which must never read as proof).
 */
export function generalFakesFactsCollector(): { wrap(plan: GeneralFakesRoundPlan | undefined): GeneralFakesRoundPlan | undefined; take(): GeneralFakeFacts | undefined } {
  let latest: GeneralFakeFacts | undefined;
  return {
    wrap(plan) {
      if (plan === undefined) return plan;
      return { ...plan, onResult(result) { latest = mergeGeneralFakeFacts(latest, result.facts); plan.onResult(result); } };
    },
    take() { const facts = latest; latest = undefined; return facts; },
  };
}

// ---- building the fakes

type ServiceFake = GeneralFakeServiceFake;
const notBuilt = (reason: GeneralFakeReason): ServiceFake => ({ status: "not_built", reason });
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

async function readBounded(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > GENERAL_FAKES_DISCOVERY_LIMITS.specBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
/** The fake for one file under the workspace, or why not. A file outside the workspace (through a link too), missing, too big or not an OpenAPI 3 description is unreadable. */
async function fakeOfFile(root: string, path: string): Promise<ServiceFake> {
  try {
    const real = await realpath(path);
    if (!inside(root, real)) return notBuilt("spec_unreadable");
    const text = await readBounded(real);
    if (text === undefined) return notBuilt("spec_unreadable");
    const fake = buildOpenApiFake(parse(text, { maxAliasCount: 50, prettyErrors: false }) as unknown, path.slice(root.length + 1));
    return fake.status === "built" ? { status: "built", fake } : notBuilt("spec_unreadable");
  } catch {
    return notBuilt("spec_unreadable");
  }
}
/** The one OpenAPI 3 description in the repositories. Links are not followed. A walk that hits its limits never picks a file. */
async function discover(root: string, repositoryPaths: readonly string[]): Promise<ServiceFake> {
  const found: string[] = [];
  let entries = 0;
  let truncated = false;
  const queue: { dir: string; depth: number }[] = [];
  for (const repository of repositoryPaths) {
    try {
      const real = await realpath(repository);
      if (inside(root, real)) queue.push({ dir: real, depth: 0 });
    } catch { /* a repository that is not there has no description */ }
  }
  while (queue.length > 0 && !truncated) {
    const { dir, depth } = queue.shift()!;
    // Streamed: a folder with a huge listing costs only up to the entry limit.
    let listing: Dir;
    try { listing = await opendir(dir, { bufferSize: 64 }); } catch { continue; }
    try {
    for await (const entry of listing) {
      if (++entries > GENERAL_FAKES_DISCOVERY_LIMITS.entries) { truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (depth + 1 > GENERAL_FAKES_DISCOVERY_LIMITS.depth) { truncated = true; break; }
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile() && SPEC_NAME.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
    } catch { truncated = true; /* a folder that fails part way could hide a second description: never pick one then */ } finally { await listing.close().catch(() => undefined); }
  }
  if (truncated || found.length > GENERAL_FAKES_DISCOVERY_LIMITS.candidates) return notBuilt("spec_ambiguous");
  const fakes = await Promise.all(found.map((path) => fakeOfFile(root, path)));
  const built = fakes.filter((fake) => fake.status === "built");
  if (built.length > 1) return notBuilt("spec_ambiguous");
  if (built.length === 1) return built[0]!;
  return notBuilt(found.length > 0 ? "spec_unreadable" : "no_spec");
}
async function buildFakes(plan: GeneralFakesRoundPlan): Promise<ServiceFake[]> {
  const root = await realpath(plan.rootPath);
  let discovered: Promise<ServiceFake> | undefined;
  return Promise.all(plan.services.map(async (service) => {
    if (service.spec !== undefined) return fakeOfFile(root, resolve(root, service.spec));
    // Read the repositories once for every service that names no file.
    discovered ??= discover(root, plan.repositoryPaths);
    return discovered;
  }));
}

// ---- the server

type CallOutcome = "served" | GeneralFakeReason;
interface StartedFakes {
  readonly environment: Readonly<Record<string, string>>;
  /** Hosted only: the calls since the last read (the helper's own record); the local server reports each call as it happens instead. */
  drain?(): Promise<HostedFakeCalls | undefined>;
  stop(): Promise<void>;
}

async function startFakes(plan: GeneralFakesRoundPlan, onCall: (outcome: CallOutcome | "unattributed") => void): Promise<StartedFakes> {
  const fakes = await buildFakes(plan);
  const server: Server = createGeneralFakesServer({
    fakes,
    // Slice 1's words: a fake that was not built, and a request refused for its size, are counted as before.
    onCall: (outcome) => onCall(outcome === "refused" ? "operation_unsupported" : outcome === "foreign" ? "unattributed" : outcome),
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    throw new Error("the fakes are not on the loopback address");
  }
  const base = `http://127.0.0.1:${String(address.port)}`;
  const environment = Object.fromEntries(plan.services.map((service, index) => [service.variable, `${base}/s/${String(index)}`]));
  let stopped: Promise<void> | undefined;
  return {
    environment,
    stop: () => (stopped ??= new Promise<void>((resolveStop) => { server.closeAllConnections(); server.close(() => resolveStop()); })),
  };
}

/** The hosted helper for one round: the fakes are built here (the worker reads the customer's descriptions) and handed to the launcher as a set; the sandbox's variables point at the helper. */
async function startHosted(plan: GeneralFakesRoundPlan, launcher: HostedFakesLauncher): Promise<StartedFakes> {
  const fakes = await buildFakes(plan);
  const started = await launcher.start({ fakes, variables: plan.services.map((service) => service.variable) });
  return { environment: started.environment, drain: () => started.drain(), stop: () => started.stop() };
}

// ---- the hook

const PRIORITY: readonly GeneralFakeReason[] = GENERAL_FAKE_REASONS.filter((reason) => reason !== "start_failed");

/** `runners` for a round with Rovara-made fakes, or the same object for one without. */
export function withGeneralFakesRound(plan: GeneralFakesRoundPlan | undefined, runners: CheckRunners): CheckRunners {
  if (plan === undefined) return runners;
  if (typeof (plan as { onResult?: unknown }).onResult !== "function") throw new TypeError("a general fakes plan needs an onResult consumer that keeps fake-answered checks out of the change proof");
  let started: Promise<StartedFakes> | undefined;
  let currentId: string | undefined;
  let inSetup = false;
  let running = false;
  let unknown = false;
  let total = 0;
  let calls: CallOutcome[] = [];
  let hostedReasons: GeneralFakeReason[] = [];
  // Bumped when a round ends: a command still running when its round was aborted must not write into the next round's facts.
  let generation = 0;
  let perCheck = new Map<string, number>();
  let seen = new Set<string>();
  // The checks this round's fakes answered, kept from `endRound` until `markEntries` (runChecks calls it right after) takes them.
  let answered: ReadonlySet<string> = new Set();
  const onCall = (outcome: CallOutcome | "unattributed"): void => {
    total += 1;
    if (outcome === "unattributed" || !running) { unknown = true; return; }
    calls.push(outcome);
  };
  const ensure = (): Promise<StartedFakes> => {
    started ??= (plan.hosted === undefined ? startFakes(plan, onCall) : startHosted(plan, plan.hosted)).catch((): never => { throw new CheckNotRunError(GENERAL_FAKE_NOT_RUN_SENTENCES.start_failed); });
    return started;
  };
  // Hosted: what the helper answered since the last read, folded into the same facts the local server reports call by call. A record that cannot be read marks every check of the round (fail closed).
  const absorb = (read: HostedFakeCalls | undefined, id: string | undefined): void => {
    if (read === undefined) { unknown = true; return; }
    const reasons = PRIORITY.filter((reason) => (read.cannotAnswer as Record<string, number>)[reason]! > 0);
    const count = read.served + read.refused + read.foreign + read.unrouted + Object.values(read.cannotAnswer).reduce((sum, value) => sum + value, 0);
    total += count;
    // A connection from another address, a request no service answers, or a call when no check is running, belongs to no check.
    if (read.foreign > 0 || read.unrouted > 0) unknown = true;
    if (count === 0) return;
    if (id === undefined) { unknown = true; return; }
    perCheck.set(id, (perCheck.get(id) ?? 0) + count);
    hostedReasons = [...hostedReasons, ...reasons, ...(read.refused > 0 ? ["operation_unsupported" as const] : [])];
  };
  const wrapped: CheckRunners = {
    ...runners,
    ...(runners.scopeRound === undefined ? {} : { scopeRound: (checkPlan, signal, run, remainingMs) => runners.scopeRound!(checkPlan, signal, (scoped) => run(withGeneralFakesRound(plan, scoped)), remainingMs) }),
    async scopeSetup(run) {
      const wasSetup = inSetup;
      inSetup = true;
      currentId = undefined;
      try { await (runners.scopeSetup === undefined ? run() : runners.scopeSetup(run)); }
      finally { inSetup = wasSetup; currentId = undefined; }
    },
    beginCheck(checkId) {
      currentId = typeof checkId === "string" && CHECK_ID.test(checkId) ? checkId : undefined;
      if (currentId === undefined) unknown = true;
      else seen.add(currentId);
      runners.beginCheck?.(checkId);
    },
    async runProjectCommand(command, signal) {
      const fakes = await ensure();
      const id = inSetup ? undefined : currentId;
      const roundGeneration = generation;
      calls = [];
      hostedReasons = [];
      running = true;
      let result: Awaited<ReturnType<CheckRunners["runProjectCommand"]>>;
      try {
        // The fakes' variables win over the project's own values for this round.
        result = await runners.runProjectCommand({ ...command, env: { ...(command.env ?? {}), ...fakes.environment } }, signal);
      } finally {
        running = false;
        if (fakes.drain !== undefined) { const read = await fakes.drain().catch(() => undefined); if (roundGeneration === generation) absorb(read, id); }
        else if (calls.length > 0) {
          if (id === undefined) unknown = true;
          else perCheck.set(id, (perCheck.get(id) ?? 0) + calls.length);
        }
      }
      const reason = PRIORITY.find((candidate) => (fakes.drain === undefined ? calls : hostedReasons).includes(candidate));
      if (id !== undefined && reason !== undefined && (result.exitCode !== 0 || result.timedOut)) throw new CheckNotRunError(GENERAL_FAKE_NOT_RUN_SENTENCES[reason]);
      return result;
    },
    markEntries(entries) {
      const ids = answered;
      answered = new Set();
      const marked = runners.markEntries === undefined ? [...entries] : runners.markEntries(entries);
      if (ids.size === 0) return marked;
      // Only a check that ran to a result is labelled: a check that did not run (Not run, stopped, unknown) shows nothing that could be taken for a pass.
      return marked.map((entry) => (ids.has(entry.id) && (entry.after === "passed" || entry.after === "failed" || entry.after === "timed_out") ? { ...entry, madeByRovara: true as const } : entry));
    },
    async endRound() {
      const current = started;
      answered = new Set();
      try {
        if (current !== undefined) {
          const fakes = await current.catch(() => undefined);
          // Hosted: the helper is read once more while it is still up. Calls after the last command belong to no check.
          if (fakes?.drain !== undefined) absorb(await fakes.drain().catch(() => undefined), undefined);
          await fakes?.stop().catch(() => undefined);
          const ids = unknown ? [...new Set([...seen, ...perCheck.keys()])] : [...perCheck.keys()];
          const facts: GeneralFakeFacts = { unknown, checks: ids.map((checkId) => ({ checkId, served: Math.max(1, perCheck.get(checkId) ?? 0) })) };
          answered = new Set(ids);
          try { plan.onResult({ facts, lines: total > 0 ? [generalFakesRoundLine(total)] : [] }); } catch { /* a sink that throws must not keep the round open */ }
        }
      } finally {
        generation += 1;
        started = undefined; currentId = undefined; inSetup = false; running = false; unknown = false; total = 0;
        calls = []; hostedReasons = []; perCheck = new Map(); seen = new Set();
        await runners.endRound?.();
      }
    },
  };
  return wrapped;
}

