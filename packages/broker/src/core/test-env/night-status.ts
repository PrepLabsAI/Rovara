// What happened to a project's last night when no result was recorded: a per-night row, readable by the project's health page and Home. Two kinds, both in fixed words:
//   failed       the night started and did not finish: branch_moved, wall_clock, worker_refused, infra (contracts `NIGHT_FAILED_REASONS`). Written by the worker's report on the nightly action, and by the end of the
//                operation when it ends with no report (infra), whichever comes first: the first word stands. None of them is the project's fault, so none moves the project's health state.
//   unavailable  the night cannot run at all today: services_unsupported, registries_unsupported, branch_not_default. Written by the fire. Never "needs repair".
// A row is one item per night slot, kept 7 days. At most ONE retry the same UTC day, only after an `infra` failure (`sameDayRetryOf`).
import { INDEX_EXPIRY_ATTRIBUTE, NIGHT_FAILED_REASONS, NIGHT_UNAVAILABLE_REASONS, change, projectPk, queryAll, type DocumentKey, type NightFailedReason, type NightUnavailableReason, type OrgId, type TransactItem } from "@agentx/contracts";
import { documentOf, expiryOf, type TestEnvDeps } from "./deps.js";

export type NightRow =
  | { status: "failed"; reason: NightFailedReason; slotId: string; at: string }
  | { status: "unavailable"; reason: NightUnavailableReason; slotId: string; at: string };

const PREFIX = "TESTENV#NIGHT#SLOT#";
const TTL_MS = 7 * 24 * 3_600_000;
export const nightRowKey = (orgId: OrgId, project: string, slotId: string): DocumentKey => ({ pk: projectPk(orgId, project), sk: `${PREFIX}${slotId}` });

/** The words a person reads. Nothing here is "needs repair": a night that did not run says why in plain terms. */
export const NIGHT_WORDS: Readonly<Record<NightFailedReason | NightUnavailableReason, string>> = {
  branch_moved: "Last night did not run: the default branch moved while it was starting.",
  wall_clock: "Last night ran out of time before the tests finished.",
  worker_refused: "Last night did not run: the machine could not run this setup.",
  infra: "Last night did not run because of a problem on Rovara's side.",
  services_unsupported: "Nightly not available: this setup's services can't be started by nightly runs yet.",
  registries_unsupported: "Nightly not available: this project uses private package registries, which nightly runs can't use yet.",
  branch_not_default: "Nightly not available: the nightly branch is not the repository's default branch.",
};

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The step that records a failed night, for the transaction that ends the operation. An update that sets every attribute only if it is absent and has no condition: the first word stands (the worker's own
 * report wins over the `infra` the end writes), and it can never fail the transaction it rides in.
 */
export function nightFailedItem(input: { orgId: OrgId; project: string; slotId: string; reason: NightFailedReason; nowIso: string }): TransactItem {
  const expiry = Math.floor((Date.parse(input.nowIso) + TTL_MS) / 1000);
  return {
    kind: "update", key: nightRowKey(input.orgId, input.project, input.slotId),
    ops: [
      change.setIfAbsent("entityType", "TEST_ENV_NIGHT"), change.setIfAbsent("orgId", input.orgId), change.setIfAbsent("project", input.project), change.setIfAbsent("slotId", input.slotId),
      change.setIfAbsent("nightStatus", "failed"), change.setIfAbsent("nightReason", input.reason), change.setIfAbsent("nightAt", input.nowIso), change.setIfAbsent("nightDay", input.nowIso.slice(0, 10)),
      change.setIfAbsent(INDEX_EXPIRY_ATTRIBUTE, expiry),
    ],
  };
}

/** Records that the night cannot run today (the fire's). Best effort for the caller: it is a note, and a failure to write it changes nothing else. */
export async function recordNightUnavailable(deps: TestEnvDeps, input: { orgId: OrgId; project: string; slotId: string; reason: NightUnavailableReason }): Promise<void> {
  const now = deps.now();
  await deps.store.put({
    item: documentOf({ ...nightRowKey(input.orgId, input.project, input.slotId), entityType: "TEST_ENV_NIGHT", orgId: input.orgId, project: input.project, slotId: input.slotId, nightStatus: "unavailable", nightReason: input.reason, nightAt: new Date(now).toISOString(), nightDay: dayOf(now), ...expiryOf(now + TTL_MS) }),
  });
}

/** The project's nights that left a row (newest last), without those a newer recorded baseline has answered: once a night is recorded, an earlier night that failed or could not run says nothing more. A row that does not read back is left out, never read as a different word. */
export async function readNightRows(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<Array<NightRow & { day: string }>> {
  const rows = await readAllNightRows(deps, orgId, project);
  const latest = (await deps.store.get({ pk: projectPk(orgId, project), sk: "TESTENV#BASELINE#LATEST" })) as { baseline?: { recordedAt?: unknown } } | undefined;
  const recordedAt = typeof latest?.baseline?.recordedAt === "string" ? Date.parse(latest.baseline.recordedAt) : Number.NaN;
  return Number.isFinite(recordedAt) ? rows.filter((row) => Date.parse(row.at) > recordedAt) : rows;
}

async function readAllNightRows(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<Array<NightRow & { day: string }>> {
  const items = await queryAll(deps.store, { pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: PREFIX } });
  const rows: Array<NightRow & { day: string }> = [];
  for (const item of items) {
    const { nightStatus: status, nightReason: reason, slotId, nightAt: at, nightDay: day } = item;
    if (typeof slotId !== "string" || typeof at !== "string" || typeof day !== "string") continue;
    if (status === "failed" && (NIGHT_FAILED_REASONS as readonly unknown[]).includes(reason)) rows.push({ status, reason: reason as NightFailedReason, slotId, at, day });
    else if (status === "unavailable" && (NIGHT_UNAVAILABLE_REASONS as readonly unknown[]).includes(reason)) rows.push({ status, reason: reason as NightUnavailableReason, slotId, at, day });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/** The latest night that left a row, with the words to show; undefined when none did. */
export async function readLatestNight(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<(NightRow & { words: string }) | undefined> {
  const latest = (await readNightRows(deps, orgId, project)).at(-1);
  return latest === undefined ? undefined : { status: latest.status, reason: latest.reason, slotId: latest.slotId, at: latest.at, words: NIGHT_WORDS[latest.reason] } as NightRow & { words: string };
}

/**
 * The failed slot a second run may replace today, or undefined. At most ONE same-day retry, and only after an infrastructure-class failure (`infra`): the newest night of today left a failed `infra` row, and today
 * has had only that one failed night. A night that failed any other way, or a second failure, is not retried: the day's cost stays bounded.
 */
export async function sameDayRetryOf(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<string | undefined> {
  const today = dayOf(deps.now());
  const todays = (await readNightRows(deps, orgId, project)).filter((row) => row.day === today && row.status === "failed");
  const last = todays.at(-1);
  return todays.length === 1 && last?.reason === "infra" ? last.slotId : undefined;
}
