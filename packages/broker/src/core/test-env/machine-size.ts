// TE-C5 part B: the machine size at project setup, stored only.
//
// A measured setup Prove (the worker's `setup-prove-result` post) says how much memory the suite needed and whether the code builds on ARM. This module keeps the FACTS of that report (never its text),
// shows the setup card a suggested size in fixed words, and stores the size the person chose as a project setting. It launches nothing: the card says so.
//
//   TESTENV#MACHINE#<digest>     the facts of a measured Prove for exactly that proposal digest (30 days); written only for a proposal that exists, so a worker cannot invent a digest;
//   TESTENV#MACHINE_CHOICE       the row the person chose (one of the listed rows), replaced by a later choice.
// Neither is the proof row (`TESTENV#PROVE#`): nothing a worker says here can approve an environment. Switch `ROVARA_MACHINE_SIZE` is on by default; exactly "0" turns it off, so nothing is read or written.
//
// NOT HERE (part C): who may call `recordMachineMeasurement`. It trusts that the caller already authenticated the worker's lease and the operation (as `handleNightlyResultCallback` does); the route, the job queue and
// the advertising of `task.testEnvProveMeasure.v1` are not built yet, so no production caller exists.
import {
  MACHINE_SIZE_ROWS, MachineFactsSchema, SetupProveResultBodySchema, agentXError, machineAdviceOf, machineCostWords, machineFactsOf, machineRowLabel, MACHINE_STORED_ONLY_LINE, projectPk, when,
  type DocumentKey, type MachineFacts, type OrgId,
} from "@agentx/contracts";
import { documentOf, expired, expiryOf, type TestEnvDeps } from "./deps.js";
import { testEnvProposalKey } from "./environment.js";
import { optIn, testEnvironmentEnabled } from "./switch.js";

/** ROVARA_MACHINE_SIZE: the measured machine size at setup (record, show, choose). On by default; exactly "0" turns it off. Does nothing without the test environment. */
export const MACHINE_SIZE_VARIABLE = "ROVARA_MACHINE_SIZE";
/** The size suggestion is on by default with test environments; an install may explicitly turn it off. */
export const machineSizeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[MACHINE_SIZE_VARIABLE] !== "0" && testEnvironmentEnabled(env);
/** DEC 254zb (part C): ROVARA_MACHINE_SIZE_RUN makes the chosen size change what launches (and what a machine start is estimated to cost). OFF unless exactly "1", and only with the choice on. */
export const MACHINE_SIZE_RUN_VARIABLE = "ROVARA_MACHINE_SIZE_RUN";
export const machineSizeRunEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, MACHINE_SIZE_RUN_VARIABLE) && machineSizeEnabled(env);
/** ROVARA_MACHINE_SIZE_X86: this install's worker image runs on x86. OFF unless exactly "1": until a release carries an amd64 image, an x86 choice launches the default size. */
export const MACHINE_SIZE_X86_VARIABLE = "ROVARA_MACHINE_SIZE_X86";
export const machineSizeX86Enabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, MACHINE_SIZE_X86_VARIABLE);

/** A measurement is kept this long: a proposal lives 7 days, an approved environment's card is read soon after. */
export const MACHINE_MEASURE_TTL_MS = 30 * 86_400_000;
const ENTITY_MEASURE = "TEST_ENV_MACHINE_MEASURE";
const ENTITY_CHOICE = "TEST_ENV_MACHINE_CHOICE";
const DIGEST = /^[a-f0-9]{64}$/u;
const ROW_IDS: readonly string[] = MACHINE_SIZE_ROWS.map(row => row.id);

export const testEnvMachineKey = (orgId: OrgId, project: string, digest: string): DocumentKey => ({ pk: projectPk(orgId, project), sk: `TESTENV#MACHINE#${digest}` });
export const testEnvMachineChoiceKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: projectPk(orgId, project), sk: "TESTENV#MACHINE_CHOICE" });

const switchedOff = () => agentXError("CALLBACK_FORBIDDEN", "machine sizing is not on");
type Row = Record<string, unknown>;
const readRow = async (deps: TestEnvDeps, key: DocumentKey): Promise<Row | undefined> => {
  const item = (await deps.store.get(key)) as Row | undefined;
  return item === undefined || expired(item, deps.now()) ? undefined : item;
};

/**
 * Keeps the facts of one measured setup Prove. The caller must have authenticated the worker's lease already. Throws CALLBACK_FORBIDDEN while the switch is off, CONFIG_INVALID for a body that is not the shape
 * (the message never repeats it), CHANGE_STALE for a digest with no proposal. A refused Prove, or a report that does not name its chip, records nothing and answers `not_measured`.
 */
export async function recordMachineMeasurement(deps: TestEnvDeps, input: { orgId: OrgId; project: string; body: unknown }): Promise<{ recorded: true } | { recorded: false; reason: "not_measured" }> {
  if (!machineSizeEnabled(deps.env ?? process.env)) throw switchedOff();
  const parsed = SetupProveResultBodySchema.safeParse(input.body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the setup Prove result could not be read");
  if (!parsed.data.result.ok) return { recorded: false, reason: "not_measured" };
  const facts = machineFactsOf(parsed.data.result.report);
  if (facts === undefined) return { recorded: false, reason: "not_measured" };
  const now = deps.now();
  const written = await deps.store.transact([
    { kind: "check", key: testEnvProposalKey(input.orgId, input.project, facts.proposalDigest), condition: when.present() },
    { kind: "put", item: documentOf({ ...testEnvMachineKey(input.orgId, input.project, facts.proposalDigest), entityType: ENTITY_MEASURE, orgId: input.orgId, project: input.project, digest: facts.proposalDigest, facts, recordedAt: new Date(now).toISOString(), ...expiryOf(now + MACHINE_MEASURE_TTL_MS) }) },
  ]);
  if (!written.applied) throw agentXError("CHANGE_STALE", "there is no such proposal to measure; propose the environment again");
  return { recorded: true };
}

/** The stored facts for a digest, read again through the contract; a row that does not read back as exactly what was stored is none. */
export async function readMachineFacts(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string): Promise<MachineFacts | undefined> {
  if (!machineSizeEnabled(deps.env ?? process.env) || !DIGEST.test(digest)) return undefined;
  const row = await readRow(deps, testEnvMachineKey(orgId, project, digest));
  if (row === undefined || row["entityType"] !== ENTITY_MEASURE || row["orgId"] !== orgId || row["project"] !== project || row["digest"] !== digest) return undefined;
  const facts = MachineFactsSchema.safeParse(row["facts"]);
  return facts.success && facts.data.proposalDigest === digest ? facts.data : undefined;
}

/** Stores the person's choice. The id must be one of the listed rows (anything else is refused without being repeated). It changes nothing that runs. */
export async function setMachineChoice(deps: TestEnvDeps, input: { orgId: OrgId; project: string; rowId: unknown }): Promise<{ rowId: string }> {
  if (!machineSizeEnabled(deps.env ?? process.env)) throw agentXError("NOT_AVAILABLE_HERE", "machine sizing is not on");
  const rowId = input.rowId;
  if (typeof rowId !== "string" || !ROW_IDS.includes(rowId)) throw agentXError("CONFIG_INVALID", "rowId: choose one of the listed machine sizes");
  await deps.store.put({ item: documentOf({ ...testEnvMachineChoiceKey(input.orgId, input.project), entityType: ENTITY_CHOICE, orgId: input.orgId, project: input.project, rowId, chosenAt: new Date(deps.now()).toISOString() }) });
  return { rowId };
}

/** The chosen row id, or undefined (none, a switch that is off, or a row that does not read back). */
export async function readMachineChoice(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<string | undefined> {
  if (!machineSizeEnabled(deps.env ?? process.env)) return undefined;
  const row = await readRow(deps, testEnvMachineChoiceKey(orgId, project));
  const rowId = row?.["rowId"];
  return row !== undefined && row["entityType"] === ENTITY_CHOICE && row["orgId"] === orgId && row["project"] === project && typeof rowId === "string" && ROW_IDS.includes(rowId) ? rowId : undefined;
}

export interface MachineCard {
  /** Fixed words, one line each: the headline, the reasons, the person's choice, and that nothing launches yet. */
  lines: string[];
  suggestedRowId?: string;
  chosenRowId?: string;
  measuredPeakMemoryMiB?: number;
  testTimeMs?: number;
  /** Each size's label and, in fixed words, what it would cost compared with the standard size. */
  choices: readonly { id: string; label: string; costNote?: string }[];
}

/** What the setup card shows for a proposal or approved digest. Undefined while the switch is off (the card is then exactly what it was). At most two stored rows are read. */
export async function machineCard(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string | undefined): Promise<MachineCard | undefined> {
  if (!machineSizeEnabled(deps.env ?? process.env)) return undefined;
  const facts = digest === undefined ? undefined : await readMachineFacts(deps, orgId, project, digest).catch(() => undefined);
  const chosen = await readMachineChoice(deps, orgId, project).catch(() => undefined);
  const advice = machineAdviceOf(facts);
  const chosenLabel = chosen === undefined ? undefined : machineRowLabel(chosen);
  return {
    lines: [advice.headline, `Why: ${advice.reasons.join("; ")}`, `Your choice: ${chosenLabel ?? "none yet"}`, MACHINE_STORED_ONLY_LINE],
    choices: MACHINE_SIZE_ROWS.map((row) => ({ id: row.id, label: machineRowLabel(row.id)!, ...(machineCostWords(row.id) === undefined ? {} : { costNote: machineCostWords(row.id)! }) })),
    ...(facts?.peakMemoryMiB === undefined ? {} : { measuredPeakMemoryMiB: facts.peakMemoryMiB }),
    ...(facts?.suiteMs === undefined ? {} : { testTimeMs: facts.suiteMs }),
    ...(advice.row === undefined ? {} : { suggestedRowId: advice.row.id }), ...(chosen === undefined ? {} : { chosenRowId: chosen }),
  };
}
