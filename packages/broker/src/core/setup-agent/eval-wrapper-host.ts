// The few code-host helpers the eval wrapper needs (DEC 254zzz43 / 254zzz14: the lessons file code is deleted, so the part this module needs lives HERE and nothing here depends on the lessons folder).
// A repository as the wrapper code sees it is a `CodeHost` (the neutral port), a repository reference and a scope.
//
// STRUCTURE, NOT DISCIPLINE: a guarded target wraps its host so that no call but `repositoryIdentity` reaches the host until the repository that answers at the address has been checked to BE the one the place pins. Every
// exported function that takes a `EvalWrapperTarget` guards it first, so a path added later cannot skip the check.
import { EVAL_WRAPPER_BRANCH_PATTERN, type ChangeRequestDetails, type CodeHost, type HostScope, type RepositoryIdentity, type RepositoryRef } from "@agentx/contracts";

/** One repository of a project, with the code host that serves it and the scope to call it in. Provider-neutral: the host is the `CodeHost` port. */
export interface EvalWrapperTarget { name: string; place: string; repository: RepositoryRef; scope: HostScope; host: CodeHost }

/** The head of a branch, or undefined when the host cannot say (a branch that is gone and a host that is down look the same, and neither is "Rovara's own"). */
export const headOf = (target: EvalWrapperTarget, branch: string): Promise<string | undefined> => {
  assertGuarded(target);
  return target.host.baseBranchHead(target.repository, branch, target.scope).then((head) => head, () => undefined);
};

/** The repository id a place pins (`github:repo/123` pins `123`), or undefined for a place of any other shape. */
export const repositoryIdOfPlace = (place: string): string | undefined => /^[a-z][a-z0-9-]*:repo\/([^/\s]+)$/u.exec(place)?.[1];

type Verified = { ok: true; identity: RepositoryIdentity & { defaultBranch: string } } | { ok: false };

async function verifyRaw(target: EvalWrapperTarget): Promise<Verified> {
  let identity: RepositoryIdentity | undefined;
  try { identity = await target.host.repositoryIdentity(target.repository, target.scope); } catch { return { ok: false }; }
  const pinned = repositoryIdOfPlace(target.place);
  if (identity === undefined || identity.defaultBranch === undefined || pinned === undefined || String(identity.id) !== pinned) return { ok: false };
  return { ok: true, identity: { ...identity, defaultBranch: identity.defaultBranch } };
}

/** The verdicts of guarded hosts, by the guarded host: one identity read per guarded target. */
const verdicts = new WeakMap<object, () => Promise<Verified>>();
/** The one place a guarded host was checked for: a guarded host is never used for another. */
const bound = new WeakMap<object, string>();

/** The host refused to act because the repository at its address is not the one the place pins. */
export class RepositoryMismatch extends Error {
  constructor() { super("the repository at this address is not the one this place pins"); this.name = "RepositoryMismatch"; }
}

/** Throws unless the target's host is a guarded one that was checked for THIS target's place. The shared helpers call it first: they are handed a guarded target, never a raw one. */
export function assertGuarded(target: Pick<EvalWrapperTarget, "host" | "place">): void {
  if (!verdicts.has(target.host) || bound.get(target.host) !== target.place) throw new RepositoryMismatch();
}

/**
 * THE FIRST CHECK before any host action on a repository (a read of its file, a branch, a pull request, a delete): the repository that answers at the target's address must BE the one the place pins. Every host call is
 * addressed by owner and name, and an address can come to hold another repository (the old one deleted or renamed, a new one given the name), so the id in the place is compared with the id the host reports. A mismatch, a
 * repository the host will not describe, or a place that pins no id is "not reachable": nothing is read from it and nothing is written to it. A guarded target answers from the one read it made.
 */
export function verifyRepository(target: EvalWrapperTarget): Promise<Verified> {
  const guarded = verdicts.get(target.host);
  if (guarded === undefined) return verifyRaw(target);
  if (bound.get(target.host) !== target.place) throw new RepositoryMismatch();
  return guarded();
}

/** The target with its host wrapped so that no call but `repositoryIdentity` reaches the host until the repository's id has been checked against the place's (once per guarded target). Capability checks see the host's own methods. */
export function guardTarget(target: EvalWrapperTarget): EvalWrapperTarget {
  if (verdicts.has(target.host)) {
    // A guarded target is bound to ONE place: pointing it at another is refused, not answered from the first verdict.
    if (bound.get(target.host) !== target.place) throw new RepositoryMismatch();
    return target;
  }
  const raw = target.host;
  let verdict: Promise<Verified> | undefined;
  const check = (): Promise<Verified> => (verdict ??= verifyRaw({ ...target, host: raw }));
  const host = new Proxy(raw, {
    get(inner, property) {
      const value: unknown = Reflect.get(inner, property, inner);
      if (typeof value !== "function" || property === "repositoryIdentity") return value;
      return async (...args: unknown[]): Promise<unknown> => {
        if (!(await check()).ok) throw new RepositoryMismatch();
        return (value as (...a: unknown[]) => unknown).apply(inner, args);
      };
    },
  });
  verdicts.set(host, check);
  bound.set(host, target.place);
  return { ...target, host };
}

/** The host says there is no such pull request (GitHub: HTTP 404 on the lookup). A failure of any other kind is not "gone". */
export const isGone = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "NOT_FOUND" || /\bHTTP 404\b/u.test(error instanceof Error ? error.message : "");

/** A pull request that could not be read, or whose maker could not be confirmed: nothing is done to it, and it is tried again at the next read. */
export class Unconfirmed extends Error {
  constructor() { super("the pull request could not be read or confirmed as Rovara's"); this.name = "Unconfirmed"; }
}

/**
 * READ AND CONFIRM BEFORE ANY DESTRUCTIVE CALL on a pull request. What the host says about change request `number`:
 *   - `gone`: a confirmed 404 (the only read failure that means anything);
 *   - `read` with `ours` true: Rovara made it (the host account is Rovara's own, its source branch is the row's branch, and it is against the repository the place pins);
 *   - `read` with `ours` false: it is someone else's (never touched);
 *   - `read` with `ours` undefined: the host did not say who made it or what it is against (never taken as a yes).
 * Any other failure to read THROWS `Unconfirmed`: no action, tried again next time.
 */
export async function readOwnPr(target: EvalWrapperTarget, number: string, branch: string, recordedHead?: string): Promise<{ kind: "gone" } | { kind: "read"; details: ChangeRequestDetails; ours: boolean | undefined }> {
  assertGuarded(target);
  let details: ChangeRequestDetails;
  try { details = await target.host.getChangeRequest({ repository: target.repository, id: number, url: "" }, target.scope); } catch (error) {
    if (isGone(error)) return { kind: "gone" };
    throw new Unconfirmed();
  }
  const pinned = repositoryIdOfPlace(target.place);
  if (details.sourceBranch !== branch || details.authoredByRovara === false || (pinned !== undefined && details.baseRepositoryId !== undefined && details.baseRepositoryId !== pinned)) return { kind: "read", details, ours: false };
  // A host that cannot say who made a pull request (a laptop signed in with the owner's own token: the account is the owner's too) is proved another way: the branch is one of Rovara's own random wrapper names, it is
  // still the branch the row names, and the pull request's head is exactly the commit Rovara left it at. A pull request someone pushed to since has another head and is never taken as Rovara's.
  if (details.authoredByRovara === undefined && recordedHead !== undefined && EVAL_WRAPPER_BRANCH_PATTERN.test(branch) && details.headRevision === recordedHead) return { kind: "read", details, ours: true };
  if (details.authoredByRovara !== true || details.baseRepositoryId === undefined || pinned === undefined) return { kind: "read", details, ours: undefined };
  return { kind: "read", details, ours: true };
}
