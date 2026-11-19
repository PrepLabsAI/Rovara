// The two-company isolation sets for the fakes: a code host, a tracker and a check runner, each made of one fake per company (same raw ids, nothing else shared) behind a company router.
// A real adapter that serves many companies builds the same `TwoCompanyIsolation` over its own fixtures and appends the same checks (`twoCompanyChecks`).
import { FakeCheckRunner, FakeCodeHost, FakeHostModel, FakeTracker, fakeSignedDelivery, fakeTrackerDelivery } from "@agentx/broker/fakes";
import type { CheckRunner, CodeHost, HostScope, Tracker } from "@agentx/contracts";
import { routeByCompany, type CompanyResolver } from "./company-router.js";
import {
  COMPANY_A, SHARED_RAW_IDS, TWO_COMPANIES, attempt, type FailClosedProbe, type IsolationCompany, type IsolationSurface, type ResolverFailure, type TwoCompanyIsolation,
} from "./two-company.js";

const REPOSITORY = { url: SHARED_RAW_IDS.repositoryUrl };
const FILE = "NOTES.md";
const NOTE_REVISION = "c".repeat(40);
/** The same commit on every company's repository: the same content in the same order gives the same revision, so the raw id is shared. */
const SHARED_COMMIT = { "x.txt": "x\n" };

/** A resolver that fails the way a broken company lookup does. */
export const failingResolver = (mode: ResolverFailure): CompanyResolver => (mode === "throws"
  ? () => { throw new Error("the company lookup is down"); }
  : () => undefined);

/** Each company's webhook secret differs, so a delivery signed for one company never verifies for the other. */
const secretOf = (company: IsolationCompany): string => `fake-secret-${company.label}-not-a-real-secret`;
const modelOf = (): FakeHostModel => new FakeHostModel({ url: SHARED_RAW_IDS.repositoryUrl, id: "4242", fullName: "acme/app" });
const byCompany = <T>(make: (company: IsolationCompany) => T): ReadonlyMap<string, T> => new Map(TWO_COMPANIES.map((company) => [company.orgId, make(company)]));

// ---- code host

export interface FakeCodeHostCompanies {
  readonly router: CodeHost;
  readonly hosts: ReadonlyMap<string, FakeCodeHost>;
  readonly isolation: TwoCompanyIsolation;
}

/** `build` is for tests that break the router on purpose: it makes the adapter the surfaces run against from the per-company fakes. */
export function fakeCodeHostCompanies(build: (hosts: ReadonlyMap<string, FakeCodeHost>, resolve?: CompanyResolver) => CodeHost = (hosts, resolve) => routeByCompany(hosts, resolve === undefined ? {} : { resolve })): FakeCodeHostCompanies {
  const hosts = byCompany((company) => new FakeCodeHost(modelOf(), secretOf(company)));
  const router = build(hosts);
  const modelFor = (company: IsolationCompany): FakeHostModel => hosts.get(company.orgId)!.model;
  const reads: IsolationSurface = {
    kind: "read", name: "code host: a file, a branch head and a change request under shared ids",
    async plant(me) {
      const revision = modelFor(me).commit(SHARED_RAW_IDS.branch, { [FILE]: `notes ${me.canary}\n` });
      const { ref } = await router.reconcileChangeRequest({ repository: REPOSITORY, sourceBranch: SHARED_RAW_IDS.branch, targetBranch: "main", title: `Change ${me.canary}` }, me.scope);
      return { handle: { revision, id: ref.id } };
    },
    async observe(as, planted) {
      const own = planted.own as { revision: string; id: string }, other = planted.other as { revision: string; id: string };
      const head = await router.branchHead(REPOSITORY, SHARED_RAW_IDS.branch, as.scope);
      const ref = { repository: REPOSITORY, id: own.id, url: `https://host.example.test/changes/${own.id}` };
      return {
        head,
        file: await router.fileAtRevision(REPOSITORY, FILE, head, as.scope),
        change: await router.getChangeRequest(ref, as.scope),
        // The other company's revision, asked for as this company: not found, never the other company's file.
        theirs: await attempt(() => router.fileAtRevision(REPOSITORY, FILE, other.revision, as.scope)),
      };
    },
  };
  const delivery: IsolationSurface = {
    kind: "delivery", name: "code host: a webhook delivery signed for one company, shown to the other",
    async plant(me) {
      return { handle: fakeSignedDelivery({ delivery: `d-${me.canary}`, event: "push", branch: SHARED_RAW_IDS.branch, revision: NOTE_REVISION }, secretOf(me)) };
    },
    async observe(as, planted) {
      return {
        own: await router.events.normalise!(planted.own as never, as.scope),
        // A delivery signed for the other company, presented in this company's scope: refused, and nothing of it comes back.
        theirs: await attempt(() => router.events.normalise!(planted.other as never, as.scope)),
      };
    },
  };
  const probe: FailClosedProbe = {
    name: "code host: a read",
    async prepare() { modelFor(COMPANY_A).commit(SHARED_RAW_IDS.branch, { [FILE]: `notes ${COMPANY_A.canary}\n` }); },
    async attempt(mode) {
      const broken = build(hosts, failingResolver(mode));
      return broken.fileAtRevision(REPOSITORY, FILE, modelFor(COMPANY_A).headOf(SHARED_RAW_IDS.branch), COMPANY_A.scope);
    },
  };
  const deliveryProbe: FailClosedProbe = {
    name: "code host: a webhook delivery",
    async prepare() { /* nothing to put in place: a delivery carries its own canary */ },
    async attempt(mode) {
      const broken = build(hosts, failingResolver(mode));
      return broken.events.normalise!(fakeSignedDelivery({ delivery: `d-${COMPANY_A.canary}`, event: "push", branch: SHARED_RAW_IDS.branch, revision: NOTE_REVISION }, secretOf(COMPANY_A)), COMPANY_A.scope);
    },
  };
  return { router, hosts, isolation: { surfaces: [reads, delivery], failClosed: [probe, deliveryProbe] } };
}

// ---- tracker

export interface FakeTrackerCompanies {
  readonly router: Tracker;
  readonly trackers: ReadonlyMap<string, FakeTracker>;
  readonly isolation: TwoCompanyIsolation;
}

export function fakeTrackerCompanies(build: (trackers: ReadonlyMap<string, FakeTracker>, resolve?: CompanyResolver) => Tracker = (trackers, resolve) => routeByCompany(trackers, resolve === undefined ? {} : { resolve })): FakeTrackerCompanies {
  const trackers = byCompany((company) => new FakeTracker({ secret: secretOf(company) }));
  const router = build(trackers);
  const item = { tracker: "fake-tracker", id: SHARED_RAW_IDS.trackerItem };
  const reads: IsolationSurface = {
    kind: "read", name: "tracker: an item under a shared id",
    async plant(me) { trackers.get(me.orgId)!.addItem(SHARED_RAW_IDS.trackerItem, { title: `Item ${me.canary}`, body: `body ${me.canary}` }); },
    async observe(as) { return router.readItem(item, as.scope); },
  };
  const writes: IsolationSurface = {
    kind: "write", name: "tracker: a comment written for one company lands only in that company's tracker",
    async plant(me) { await router.comment!(item, `comment ${me.canary}`, me.scope, { key: "shared-comment-key" }); },
    // What each company's own tracker holds: the comment under the same key is two comments, one per company.
    async observe(as) { return trackers.get(as.orgId)!.writes; },
  };
  const delivery: IsolationSurface = {
    kind: "delivery", name: "tracker: a webhook delivery signed for one company, shown to the other",
    async plant(me) { return { handle: fakeTrackerDelivery({ delivery: `t-${me.canary}`, event: "assigned", item: SHARED_RAW_IDS.trackerItem }, secretOf(me)) }; },
    async observe(as, planted) {
      return {
        own: await router.events!.normalise!(planted.own as never, as.scope),
        theirs: await attempt(() => router.events!.normalise!(planted.other as never, as.scope)),
      };
    },
  };
  const probe: FailClosedProbe = {
    name: "tracker: a read",
    async prepare() { trackers.get(COMPANY_A.orgId)!.addItem(SHARED_RAW_IDS.trackerItem, { title: `Item ${COMPANY_A.canary}` }); },
    async attempt(mode) { return build(trackers, failingResolver(mode)).readItem(item, COMPANY_A.scope); },
  };
  return { router, trackers, isolation: { surfaces: [reads, writes, delivery], failClosed: [probe] } };
}

// ---- check runner

export interface FakeCheckRunnerCompanies {
  readonly router: CheckRunner;
  readonly runners: ReadonlyMap<string, FakeCheckRunner>;
  readonly isolation: TwoCompanyIsolation;
}

export function fakeCheckRunnerCompanies(build: (runners: ReadonlyMap<string, FakeCheckRunner>, resolve?: CompanyResolver) => CheckRunner = (runners, resolve) => routeByCompany(runners, resolve === undefined ? {} : { resolve })): FakeCheckRunnerCompanies {
  const sharedModel = (): FakeHostModel => { const model = modelOf(); model.commit("rovara/shared-runs", SHARED_COMMIT); return model; };
  const REVISION = sharedModel().headOf("rovara/shared-runs");
  const runners = byCompany(() => new FakeCheckRunner(sharedModel()));
  const router = build(runners);
  const request = { repository: REPOSITORY, revision: REVISION, gate: "unit", project: SHARED_RAW_IDS.project, timeoutMinutes: 10, idempotencyKey: "shared-key" } as const;
  const targetOf = (runId: string) => ({ kind: "run" as const, repository: REPOSITORY, revision: REVISION, run: { runner: "fake-checks", id: runId }, gate: "unit", project: SHARED_RAW_IDS.project });
  const runs: IsolationSurface = {
    kind: "read", name: "check runner: a run and its log under a shared repository, revision and idempotency key",
    async plant(me) {
      const { run } = await router.start!(request, me.scope);
      // The run must exist in this company's own runner: a router that started it in another company's runner has already leaked.
      if (runners.get(me.orgId)!.model.findRun(run.id) === undefined) throw new Error(`company ${me.label}'s run was started in another company's runner`);
      runners.get(me.orgId)!.finish(run.id, "success", `log ${me.canary}`);
      return { handle: { runId: run.id } };
    },
    async observe(as, planted) {
      const { runId } = planted.own as { runId: string };
      const target = targetOf(runId);
      const checks = await router.listChecks(target, as.scope);
      const log = checks[0] === undefined ? undefined : await router.logTail(target, checks[0], as.scope);
      return { checks, log };
    },
  };
  const probe: FailClosedProbe = {
    name: "check runner: a log read",
    async prepare() {
      const runner = runners.get(COMPANY_A.orgId)!;
      const { run } = await runner.start(request, COMPANY_A.scope);
      runner.finish(run.id, "success", `log ${COMPANY_A.canary}`);
    },
    async attempt(mode) {
      const broken = build(runners, failingResolver(mode));
      const scope: HostScope = COMPANY_A.scope;
      const runner = runners.get(COMPANY_A.orgId)!;
      const { run } = await runner.start(request, scope);
      const [check] = await runner.listChecks(targetOf(run.id), scope);
      return broken.logTail(targetOf(run.id), check!, scope);
    },
  };
  return { router, runners, isolation: { surfaces: [runs], failClosed: [probe] } };
}
