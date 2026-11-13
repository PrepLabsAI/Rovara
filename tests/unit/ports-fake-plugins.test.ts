// P2: the fakes pass the contract suites, and a deliberately broken fake fails the check that guards the behaviour it breaks. The second half is what
// shows a suite can fail at all: a contract that no broken adapter can fail proves nothing.
import { describe, expect, it } from "vitest";
import { FakeCheckRunner, FakeCodeHost, FakeTracker, fakeSignedDelivery, type FakeRawEvent } from "@rovara-code/core/fakes";
import type { CodeHostEvents, GitCredential, RepositoryRef } from "../../packages/contracts/src/index.js";
import { checkRunnerChecks } from "../support/ports/check-runner-conformance.js";
import { codeHostChecks } from "../support/ports/code-host-conformance.js";
import { runContract } from "../support/ports/plugin-contract-kit.js";
import { checkRunnerWorldFor, codeHostWorldFor, fakeCheckRunnerWorld, fakeCodeHostWorld, fakeTrackerWorld, newModel, trackerWorldFor } from "../support/ports/plugin-fake-worlds.js";
import { trackerChecks } from "../support/ports/tracker-conformance.js";

runContract("FakeCodeHost passes the CodeHost contract", codeHostChecks, fakeCodeHostWorld);
runContract("FakeCheckRunner passes the CheckRunner contract", checkRunnerChecks, fakeCheckRunnerWorld);
runContract("FakeTracker passes the Tracker contract", trackerChecks, fakeTrackerWorld);

async function fails<W>(checks: ReadonlyArray<{ name: string; run: (world: W) => Promise<void>; needs?: (world: W) => boolean }>, name: string, world: W): Promise<boolean> {
  const check = checks.find((entry) => entry.name === name);
  if (check === undefined) throw new Error(`no check named ${name}`);
  expect(check.needs === undefined || check.needs(world)).toBe(true);
  try {
    await check.run(world);
  } catch {
    return true;
  }
  return false;
}

class NonIdempotent extends FakeCodeHost {
  override reconcileChangeRequest(input: Parameters<FakeCodeHost["reconcileChangeRequest"]>[0], scope: Parameters<FakeCodeHost["reconcileChangeRequest"]>[1]) {
    // Always opens a new change request, even for the same branches.
    const cr = this.model.reconcile({ ...input, sourceBranch: input.sourceBranch } as Parameters<typeof this.model.reconcile>[0]);
    if (cr.reconciled) {
      this.model.changeRequests.push({ ...cr.cr, id: String(this.model.changeRequests.length + 1) });
      return Promise.resolve({ ref: this.ref(String(this.model.changeRequests.length)), reconciled: false });
    }
    return super.reconcileChangeRequest(input, scope);
  }
}
class MergesStaleHead extends FakeCodeHost {
  override merge(ref: Parameters<FakeCodeHost["merge"]>[0], input: Parameters<FakeCodeHost["merge"]>[1], scope: Parameters<FakeCodeHost["merge"]>[2]) {
    return super.merge(ref, { ...input, revision: this.model.headRevisionOf(this.cr(ref)) }, scope);
  }
}
class ReadsMissingChecksAsPassing extends FakeCodeHost {
  override async changeRequestStatus(...args: Parameters<FakeCodeHost["changeRequestStatus"]>) {
    return { ...(await super.changeRequestStatus(...args)), mergeableState: "clean" as const };
  }
}
class IdentifiesAnyRepository extends FakeCodeHost {
  override repositoryIdentity(_repository: RepositoryRef, scope: Parameters<FakeCodeHost["repositoryIdentity"]>[1]) {
    return super.repositoryIdentity({ url: this.model.url }, scope);
  }
}
class ReturnsEmptyForMissingFile extends FakeCodeHost {
  override async fileAtRevision(...args: Parameters<FakeCodeHost["fileAtRevision"]>) {
    return (await super.fileAtRevision(...args)) ?? "";
  }
}
class IgnoresScope extends FakeCodeHost {
  protected override checkScope(): void { /* no check */ }
}
class RepliesWithAnything extends FakeCodeHost {
  override reply(ref: Parameters<FakeCodeHost["reply"]>[0], commentId: string, _body: string, scope: Parameters<FakeCodeHost["reply"]>[3]) {
    return super.reply(ref, commentId, "ok", scope).then(() => {
      // The text was never checked: a mention or a very long one goes out as it came.
      return "replied" as const;
    });
  }
}
class TrustsForgedDelivery extends FakeCodeHost {
  constructor(model: ConstructorParameters<typeof FakeCodeHost>[0]) {
    super(model);
    const honest = this.events;
    (this as { events: CodeHostEvents }).events = {
      mode: "webhook",
      // Checks the signature as the honest host does, then, when it fails, trusts the body anyway.
      normalise: async (delivery, scope) => {
        try {
          return await honest.normalise!(delivery, scope);
        } catch {
          return honest.normalise!(fakeSignedDelivery(JSON.parse(delivery.rawBody) as FakeRawEvent), scope);
        }
      },
    };
  }
}
class BaseHeadOnlyForRovarasBranches extends FakeCodeHost {
  override baseBranchHead(...args: Parameters<FakeCodeHost["baseBranchHead"]>) {
    // GitHub's old `branchHead` rule: only Rovara's own working branches have a head.
    if (!/^agentx\//.test(args[1])) return Promise.reject(new Error("branch name is invalid"));
    return super.baseBranchHead(...args);
  }
}
class CutsAFileAtTheCap extends FakeCodeHost {
  override async fileAtRevision(...args: Parameters<FakeCodeHost["fileAtRevision"]>) {
    const [repository, path, revision, scope, options] = args;
    const content = await super.fileAtRevision(repository, path, revision, scope);
    return options?.maxBytes === undefined ? content : content?.slice(0, options.maxBytes);
  }
}
class NoParents extends FakeCodeHost {
  override commitParents() { return Promise.resolve([]); }
}
class ObservesWithoutTime extends FakeCodeHost {
  override async mergeObservation(...args: Parameters<NonNullable<FakeCodeHost["mergeObservation"]>>) {
    const observed = await super.mergeObservation(...args);
    delete observed.mergedAt;
    return observed;
  }
}
class ObservesWithoutSpendingTheAllowance extends FakeCodeHost {
  override mergeObservation(ref: Parameters<NonNullable<FakeCodeHost["mergeObservation"]>>[0], scope: Parameters<NonNullable<FakeCodeHost["mergeObservation"]>>[1]) {
    return super.mergeObservation(ref, scope, { signal: new AbortController().signal, beforeRequest: () => undefined });
  }
}
class RateLimitAsPlainFailure extends FakeCodeHost {
  protected override spend(): void {
    if (this.model.rateLimitedUntil !== undefined) throw new Error("rate limited");
  }
}
class DeliversUnadvertisedCredentialKind extends FakeCodeHost {
  override issueGitCredential(...args: Parameters<FakeCodeHost["issueGitCredential"]>): Promise<GitCredential> {
    // Deliberately not a valid ssh-key credential (no address, no host keys): the check must catch a kind the host never advertised.
    return super.issueGitCredential(...args).then((credential) => ({ kind: "ssh-key", privateKey: "k", expiresAt: credential.expiresAt }) as unknown as GitCredential);
  }
}

describe("a broken CodeHost fails the check that guards its behaviour", () => {
  const mutants: Array<[string, (model: ReturnType<typeof newModel>) => FakeCodeHost, string]> = [
    ["opens a second change request for the same branches", (m) => new NonIdempotent(m), "opens a change request once: asking again answers the same one, marked as found again"],
    ["merges at a head the caller did not check", (m) => new MergesStaleHead(m), "merges only at the head the caller checked, only when open and mergeable, and is then 'already merged'"],
    ["reads a missing required check as passing", (m) => new ReadsMissingChecksAsPassing(m), "never reads a missing required check as passing"],
    ["identifies a repository nobody registered", (m) => new IdentifiesAnyRepository(m), "identifies a registered repository, and never an unregistered one"],
    ["answers an empty string for a missing file", (m) => new ReturnsEmptyForMissingFile(m), "reads a file at a revision, and the file as it was at an older one"],
    ["accepts a call with no scope", (m) => new IgnoresScope(m), "refuses a call with no valid scope, before touching the host"],
    ["posts any reply text", (m) => new RepliesWithAnything(m), "replies only with fixed text, and says 'gone' for a comment that is not in a thread"],
    ["trusts a forged delivery", (m) => new TrustsForgedDelivery(m), "maps a signed delivery to neutral events, and never returns events from one that does not verify"],
    ["reads the head of Rovara's own branches only", (m) => new BaseHeadOnlyForRovarasBranches(m), "reads the head of an ordinary branch and the parents of a revision"],
    ["cuts a file at the cap instead of refusing it", (m) => new CutsAFileAtTheCap(m), "refuses a file over the caller's size cap, never cutting it, and reads one within it"],
    ["says no revision has a parent", (m) => new NoParents(m), "reads the head of an ordinary branch and the parents of a revision"],
    ["observes a merge without its time", (m) => new ObservesWithoutTime(m), "observes a merge: what it merged as and when, within the read allowance"],
    ["observes a merge without spending the allowance", (m) => new ObservesWithoutSpendingTheAllowance(m), "observes a merge: what it merged as and when, within the read allowance"],
    ["reports its rate limit as a plain failure", (m) => new RateLimitAsPlainFailure(m), "signals its rate limit as the neutral error, with the time to try again"],
    ["hands out a credential kind it does not advertise", (m) => new DeliversUnadvertisedCredentialKind(m), "hands out a short-lived git credential of an advertised kind for clone and push"],
  ];
  it.each(mutants)("%s", async (_label, make, checkName) => {
    expect(await fails(codeHostChecks, checkName, codeHostWorldFor(make(newModel())))).toBe(true);
  });

  it("each mutant leaves the other suites' checks to the honest fake (the honest fake still passes the guarded check)", async () => {
    for (const [, , checkName] of mutants) expect(await fails(codeHostChecks, checkName, fakeCodeHostWorld())).toBe(false);
  });
});

describe("a broken CheckRunner fails the check that guards its behaviour", () => {
  class StartsTwice extends FakeCheckRunner {
    override start(request: Parameters<FakeCheckRunner["start"]>[0], scope: Parameters<FakeCheckRunner["start"]>[1]) {
      return super.start({ ...request, idempotencyKey: `${request.idempotencyKey}-${String(Math.random())}` }, scope);
    }
  }
  class ListsEverythingForAnyRepository extends FakeCheckRunner {
    protected override revisionOf(target: Parameters<FakeCheckRunner["listChecks"]>[0]): string {
      return target.kind === "revision" ? target.revision : super.revisionOf(target);
    }
  }
  class UnboundedLog extends FakeCheckRunner {
    override logTail(...args: Parameters<FakeCheckRunner["logTail"]>) {
      const [, check] = args;
      return Promise.resolve(check.runId === undefined ? undefined : this.model.logOf(check.runId) ?? "");
    }
  }
  class FinishedWithoutConclusion extends FakeCheckRunner {
    override async listChecks(...args: Parameters<FakeCheckRunner["listChecks"]>) {
      return (await super.listChecks(...args)).map((check) => ({ ...check, conclusion: undefined }));
    }
  }
  class IgnoresBudget extends FakeCheckRunner {
    override listChecks(target: Parameters<FakeCheckRunner["listChecks"]>[0], scope: Parameters<FakeCheckRunner["listChecks"]>[1]) {
      return super.listChecks(target, scope);
    }
  }
  const mutants: Array<[string, (model: ReturnType<typeof newModel>) => FakeCheckRunner, string]> = [
    ["starts a new run on every retry", (m) => new StartsTwice(m), "starts a run once per idempotency key, and reads it again until it finishes"],
    ["lists checks of a repository nobody registered", (m) => new ListsEverythingForAnyRepository(m), "refuses a target that names a repository nobody registered"],
    ["returns a whole log, however long", (m) => new UnboundedLog(m), "reads the tail of a log, bounded, and undefined when the log is gone"],
    ["reports a finished check with no conclusion", (m) => new FinishedWithoutConclusion(m), "lists the checks on a revision, with a conclusion on every finished one"],
    ["ignores the read budget", (m) => new IgnoresBudget(m), "stops a listing when its read budget is spent"],
  ];
  it.each(mutants)("%s", async (_label, make, checkName) => {
    expect(await fails(checkRunnerChecks, checkName, checkRunnerWorldFor(make(newModel())))).toBe(true);
  });
});

describe("a broken Tracker fails the check that guards its behaviour", () => {
  class AnyStatus extends FakeTracker {
    override setStatus(ref: Parameters<FakeTracker["setStatus"]>[0], _status: Parameters<FakeTracker["setStatus"]>[1], scope: Parameters<FakeTracker["setStatus"]>[2]) {
      return super.setStatus(ref, "in_review", scope).then(() => { this.items.set(ref.id, { ...this.items.get(ref.id)!, status: "done" }); });
    }
  }
  class RewritesText extends FakeTracker {
    override async readItem(...args: Parameters<FakeTracker["readItem"]>) {
      const item = await super.readItem(...args);
      return { ...item, body: item.body.replace(/<[^>]*>/g, "") };
    }
  }
  class AnyTracker extends FakeTracker {
    protected override item(ref: Parameters<FakeTracker["readItem"]>[0]) {
      return super.item({ ...ref, tracker: this.kind });
    }
  }
  class EmptyComments extends FakeTracker {
    override comment(ref: Parameters<FakeTracker["comment"]>[0], _body: string, scope: Parameters<FakeTracker["comment"]>[2]) {
      return super.comment(ref, " ", scope);
    }
  }
  const mutants: Array<[string, () => FakeTracker, string]> = [
    ["moves an item to a status it was not allowed", () => new AnyStatus({ allowedStatuses: ["open", "in_review"] }), "moves an item to an allowed status, and never to one the admin did not allow"],
    ["rewrites an item's text", () => new RewritesText(), "reads an item fresh, as data, with its text unchanged"],
    ["reads an item of another tracker", () => new AnyTracker(), "refuses an item that does not exist and an item of another tracker"],
    ["writes the wrong comment", () => new EmptyComments(), "writes a comment, and refuses an empty one"],
  ];
  it.each(mutants)("%s", async (_label, make, checkName) => {
    expect(await fails(trackerChecks, checkName, trackerWorldFor(make()))).toBe(true);
  });
});

describe("the fake model", () => {
  it("is deterministic: the same steps give the same ids", () => {
    const a = newModel(), b = newModel();
    expect(a.commit("x", { "f.txt": "1" })).toBe(b.commit("x", { "f.txt": "1" }));
  });
  it("moves its clock forward and never reads the real one", () => {
    const model = newModel();
    expect(Date.parse(model.now())).toBeLessThan(Date.parse(model.now()));
  });
  it("gives a revision a tree that depends on content only", () => {
    const model = newModel();
    const one = model.commit("x", { "f.txt": "1" });
    const two = model.commit("y", { "f.txt": "1" });
    expect(model.revision(one).tree).toBe(model.revision(two).tree);
    expect(one).not.toBe(two);
  });
});
