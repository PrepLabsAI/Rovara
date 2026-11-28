// #1612: doctor's check of the install's own company: that it exists, and (a preview that reads only) that nothing is left in the built-in company to move into it.
import { installCompanyPending, runInstallCompanyStep } from "../company/install-company-step.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

const FIX = "run agentx upgrade (or agentx init again), which makes the install's company and moves the rest into it";

export async function companyChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const client = context.services.installCompanyClient;
  if (client === undefined) return [];
  const controlPlane = await context.services.stacks.describe(context.settings.stacks["control-plane"]);
  if (controlPlane?.outputs.DeveloperSignInTableName === undefined) return [check("sign-in", "company", "warn", "this control plane does not name its sign-in table yet, so the install's company is not checked", FIX)];
  const result = await runInstallCompanyStep({ documentClient: client, installations: async () => [], now: context.services.now, write: () => undefined },
    { env: context.env, outputs: controlPlane.outputs, parameters: controlPlane.parameters, apply: false });
  if (result.status === "skipped") return [check("sign-in", "company", "fail", "this install has no company of its own, so engine commands fail and model costs cannot be charged", FIX)];
  if (result.move.failed || result.connections.failed) return [check("sign-in", "company", "warn", `company ${result.companyId}: what is left to move could not be read`, "run agentx doctor again")];
  const pending = installCompanyPending(result);
  return pending === 0
    ? [check("sign-in", "company", "ok", `company ${result.companyId}; nothing left in the built-in company`)]
    : [check("sign-in", "company", "fail", `company ${result.companyId}; ${pending} records are still in the built-in company`, FIX)];
}
