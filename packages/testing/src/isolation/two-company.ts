// The two-company isolation kit.
//
// A port that serves more than one company must keep them apart: whatever is written, read, listed, delivered or looked up for company A is never visible to company B, even when
// both use the same raw ids (the same repository address, space, user, item or machine key). Every conformance suite where that applies calls this one helper, so "companies stay
// apart" is one rule checked one way, not a different test in each suite.
//
// How a suite uses it. The suite's world (or harness) builds an `IsolationSurface` for each thing a company can put in and get out of the adapter: a read, a list, an event or
// webhook delivery, a secret. A surface has two halves:
//
//   plant(me)             puts something of company `me` into the adapter through its port, under the SHARED raw ids. The thing it plants carries a marker (by default the company's
//                         canary string; an adapter that does not echo what it is given names the opaque ids it handed back instead).
//   observe(as, planted)  does what company `as` can do with the adapter now, and returns what it saw. It should also try the other company's ids with the call made as `as`
//                         (`attempt(...)` turns a refusal into plain data), because "the answer is not found, never the other company's data" is the rule.
//
// The kit plants for both companies first and observes afterwards, so a leak between surfaces shows too. It then asserts, for each company, that the observation holds that
// company's own marker (so a surface that observes nothing cannot pass by looking at nothing) and never the other company's.
//
// Failing closed: a `FailClosedProbe` runs an operation on a world whose company resolver throws, and again on one whose resolver answers `undefined`. The operation must be refused
// (or answer nothing); it must never fall back to a default company, and its error may carry no company's marker.
//
// A suite that already has a single-company world adds an optional `isolation` member to the world and appends `twoCompanyChecks()` to its checks; a world without `isolation`
// shows the check as skipped, never as passed. The kit asks nothing of the adapter beyond its own port.
import { expect } from "vitest";
import type { ContractCheck } from "../ports/plugin-contract-kit.js";

/** Two company ids of the shape Cloud uses (`org_` and 20 base-36 characters). The first is not the implicit company of a laptop install. */
export const COMPANY_A_ID = "org_aaaaaaaaaaaaaaaaaaaa";
export const COMPANY_B_ID = "org_bbbbbbbbbbbbbbbbbbbb";

/** Raw ids both companies use, so a call that is not scoped to its company would find the other company's thing. */
export const SHARED_RAW_IDS = {
  repositoryUrl: "https://git.example.test/acme/app",
  branch: "rovara/shared-work",
  trackerItem: "ENG-1",
  tenant: "T-SHARED",
  space: "C-SHARED",
  thread: "1700000000.000100",
  user: "U-SHARED",
  machineKey: "ws-shared",
  scheduleId: "night-shared",
  secretName: "shared-secret",
  documentName: "SHARED-NOTES",
  project: "shared-project",
} as const;

export interface IsolationCompany {
  readonly label: "A" | "B";
  readonly orgId: string;
  /** The `HostScope` of a call made for this company. */
  readonly scope: { readonly orgId: string };
  /** A string no other company's data holds. Plant it in something the company can read back. */
  readonly canary: string;
}

export const COMPANY_A: IsolationCompany = { label: "A", orgId: COMPANY_A_ID, scope: { orgId: COMPANY_A_ID }, canary: "rovara-canary-a-5d41f0c2" };
export const COMPANY_B: IsolationCompany = { label: "B", orgId: COMPANY_B_ID, scope: { orgId: COMPANY_B_ID }, canary: "rovara-canary-b-5d41f0c2" };
export const TWO_COMPANIES: readonly [IsolationCompany, IsolationCompany] = [COMPANY_A, COMPANY_B];

export const otherCompany = (company: IsolationCompany): IsolationCompany => (company.label === "A" ? COMPANY_B : COMPANY_A);

/** What the kinds of surface are, for the report when one fails. */
export type IsolationKind = "read" | "list" | "write" | "event" | "delivery" | "secret";

/** What `plant` gives back: the thing's handle (whatever `observe` needs to name it) and the markers that identify it in an observation. */
export interface Planted {
  readonly handle: unknown;
  /** Strings that appear in what the planting company sees and never in what the other company sees. Default: the company's canary. */
  readonly markers?: readonly string[];
}

/** The two companies' planted things, as `observe` is given them: the observing company's own, and the other company's. */
export interface PlantedPair {
  readonly own: unknown;
  readonly other: unknown;
  readonly byCompany: { readonly A: unknown; readonly B: unknown };
}

export interface IsolationSurface {
  readonly kind: IsolationKind;
  /** A short name for the report. */
  readonly name: string;
  plant(me: IsolationCompany): Promise<Planted | void>;
  observe(as: IsolationCompany, planted: PlantedPair): Promise<unknown>;
  /** False for a surface where the observing company may legitimately see nothing of its own (for example, a delivery the adapter refuses by design). Default: it must see its own marker. */
  readonly expectOwn?: boolean;
  /** Runs once after every company has observed, pass or fail: stops what `plant` started (a listening adapter). */
  teardown?(): Promise<void>;
}

export type ResolverFailure = "throws" | "undefined";

/**
 * One operation that must fail closed when the adapter cannot tell which company a call is for. `attempt` builds (or flips) the adapter's company resolver to fail in `mode`, runs the
 * operation for company A, and returns what it gave back. It must reject, or give back nothing; the kit checks that no company's marker comes out either way.
 */
export interface FailClosedProbe {
  readonly name: string;
  /** Puts company A's data (carrying its canary) in place first, so a fall back to a default company would have something to give out. */
  prepare(): Promise<void>;
  attempt(mode: ResolverFailure): Promise<unknown>;
}

export interface TwoCompanyIsolation {
  readonly surfaces: readonly IsolationSurface[];
  readonly failClosed?: readonly FailClosedProbe[];
}

/** An outcome as plain data: what a call gave, or the sentence it was refused with. Refusals are fine; what they say is checked like any answer. */
export type Attempt = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly refused: string };

/** Runs a call and turns a refusal into data, so an observation can hold "refused" next to what a call saw. */
export async function attempt(run: () => unknown): Promise<Attempt> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, refused: error instanceof Error ? `${error.name}: ${error.message}` : "refused" };
  }
}

function printable(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) => {
    if (typeof held === "bigint") return held.toString();
    if (held instanceof Map) return [...(held as Map<unknown, unknown>).entries()];
    if (held instanceof Set) return [...(held as Set<unknown>).values()];
    if (held instanceof Error) return `${held.name}: ${held.message}`;
    return held;
  }) ?? "undefined";
}

const markersOf = (company: IsolationCompany, planted: Planted | void): readonly string[] => (planted === undefined ? [company.canary] : planted.markers ?? [company.canary]);

/** True for what "nothing" looks like: undefined, null, false, an empty list or an empty object. */
export function isNothing(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * Plants for both companies on every surface, then observes as each one. Throws a vitest assertion error that names the surface, the observing company and the marker that leaked.
 */
export async function assertSurfacesIsolated(surfaces: readonly IsolationSurface[]): Promise<void> {
  expect(surfaces.length, "an isolation set with no surfaces proves nothing").toBeGreaterThan(0);
  try {
    await plantAndObserve(surfaces);
  } finally {
    for (const surface of surfaces) await surface.teardown?.();
  }
}

async function plantAndObserve(surfaces: readonly IsolationSurface[]): Promise<void> {
  const planted = new Map<IsolationSurface, { A: Planted | void; B: Planted | void }>();
  for (const surface of surfaces) {
    const a = await surface.plant(COMPANY_A);
    const b = await surface.plant(COMPANY_B);
    planted.set(surface, { A: a, B: b });
  }
  for (const surface of surfaces) {
    const both = planted.get(surface)!;
    for (const company of TWO_COMPANIES) {
      const other = otherCompany(company);
      const pair: PlantedPair = {
        own: both[company.label]?.handle, other: both[other.label]?.handle,
        byCompany: { A: both.A?.handle, B: both.B?.handle },
      };
      const seen = printable(await surface.observe(company, pair));
      const label = `${surface.kind} "${surface.name}" as company ${company.label}`;
      for (const marker of markersOf(other, both[other.label])) expect(seen.includes(marker), `${label}: saw company ${other.label}'s marker "${marker}"`).toBe(false);
      if (surface.expectOwn !== false) {
        const own = markersOf(company, both[company.label]);
        expect(own.some((marker) => seen.includes(marker)), `${label}: saw none of its own markers, so it observed nothing (${own.join(", ")})`).toBe(true);
      }
    }
  }
}

/** Runs every fail-closed probe in both modes: each must be refused or answer nothing, and nothing it says may hold a company's canary. */
export async function assertFailsClosed(probes: readonly FailClosedProbe[]): Promise<void> {
  for (const probe of probes) {
    for (const mode of ["throws", "undefined"] as const) {
      await probe.prepare();
      const outcome = await attempt(() => probe.attempt(mode));
      const label = `fail-closed "${probe.name}" when the company resolver ${mode === "throws" ? "throws" : "answers undefined"}`;
      const seen = printable(outcome);
      for (const company of TWO_COMPANIES) expect(seen.includes(company.canary), `${label}: gave out company ${company.label}'s marker`).toBe(false);
      if (outcome.ok) expect(isNothing(outcome.value), `${label}: succeeded with ${seen} instead of being refused`).toBe(true);
    }
  }
}

/** Both halves, for a harness that is not built from contract checks. */
export async function assertTwoCompanyIsolation(isolation: TwoCompanyIsolation): Promise<void> {
  await assertSurfacesIsolated(isolation.surfaces);
  await assertFailsClosed(isolation.failClosed ?? []);
}

/** The contract checks a suite appends to its own list: one per kind of surface the world supplies, so a failure names what leaked. */
export function twoCompanyChecks<W extends { readonly isolation?: TwoCompanyIsolation }>(): readonly ContractCheck<W>[] {
  return [
    {
      name: "keeps two companies that share raw ids apart: nothing written, read, listed or delivered for one is seen by the other",
      needs: (world) => world.isolation !== undefined,
      async run(world) {
        await assertSurfacesIsolated(world.isolation!.surfaces);
      },
    },
    {
      name: "fails closed when the company resolver throws or answers nothing",
      needs: (world) => (world.isolation?.failClosed?.length ?? 0) > 0,
      async run(world) {
        await assertFailsClosed(world.isolation!.failClosed!);
      },
    },
  ];
}
