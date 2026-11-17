// DEC 254zb (TE-C5 part C): what a machine start is estimated to cost, so the spend seam (Cloud's budgets) can charge a bigger size more.
// Its own switch, ROVARA_MACHINE_SIZE_COST (exactly "1", and sized launches on): a deployed install's admission HOLDS an estimate on the company's day cap
// (core-host/hosted-modules.ts), so turning this on makes machine time count against spending limits, an owner decision (plan Q5). Off: no estimate, and the
// admission request is exactly today's. On: one hour of the size the worker will launch as
// (the project's chosen row, or the default row when there is none or the install cannot run it), at the cautious list price of contracts/machine-size-price.ts.
// A region without a price, or a store that cannot be read, gives the default row's estimate or none; never $0.
import { MACHINE_DEFAULT_ROW_ID, machineCost, machineLaunchOf, type Cost, type DocumentStore, type OrgId } from "@agentx/contracts";
import { machineSizeRunEnabled, machineSizeX86Enabled, readMachineChoice } from "./machine-size.js";
import { optIn } from "./switch.js";

export const MACHINE_SIZE_COST_VARIABLE = "ROVARA_MACHINE_SIZE_COST";
export const machineSizeCostEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => optIn(env, MACHINE_SIZE_COST_VARIABLE) && machineSizeRunEnabled(env);

/** A machine start holds this much of the allowance up front; the seam settles the real time when the machine stops. */
export const MACHINE_START_ESTIMATE_MINUTES = 60;

export async function machineStartEstimate(input: { store: DocumentStore; companyId: OrgId; projectName: string | undefined; env?: NodeJS.ProcessEnv; now: () => number }): Promise<{ estimate?: { cost: Cost } }> {
  const env = input.env ?? process.env;
  if (!machineSizeCostEnabled(env)) return {};
  let rowId: string = MACHINE_DEFAULT_ROW_ID;
  if (input.projectName !== undefined && input.projectName !== "") {
    const chosen = await readMachineChoice({ store: input.store, now: input.now, env }, input.companyId, input.projectName).catch(() => undefined);
    if (chosen !== undefined && machineLaunchOf(chosen, { x86: machineSizeX86Enabled(env) }).ok) rowId = chosen;
  }
  const cost = machineCost(rowId, env["AWS_REGION"], MACHINE_START_ESTIMATE_MINUTES);
  return cost === undefined ? {} : { estimate: { cost } };
}
