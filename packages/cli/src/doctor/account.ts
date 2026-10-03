// FR-050's model access, alert subscription and budget; the region's capacity (the vCPU quota and
// free Elastic IPs init checks, item 5); and spec 025 FR-046's sign-in checks, unchanged.
import { environmentStackName } from "@agentx/contracts";
import { modelCheckProblem, NAT_ELASTIC_IPS, type ModelRole } from "../init/prerequisites.js";
import { plainMessage } from "../output.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

export async function modelChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, services } = context;
  const results = new Map<string, { ok: boolean; detail: string }>();
  const checks: DoctorCheck[] = [];
  for (const role of ["orchestrator", "classifier", "worker"] as const satisfies readonly ModelRole[]) {
    const modelId = settings.models[role];
    const provider = settings.models.providers?.[role] ?? "amazon-bedrock";
    const key = `${provider}/${modelId}`;
    let result = results.get(key);
    if (result === undefined) {
      try {
        if (provider === "openrouter") {
          if (services.checks.openRouter === undefined) throw new Error("this agentx cannot check OpenRouter models");
          await services.checks.openRouter(modelId, settings.models.openRouter ?? {});
        } else if (provider === "anthropic" || provider === "openai") {
          if (services.checks.directProvider === undefined) throw new Error(`this agentx cannot check ${provider} models`);
          await services.checks.directProvider(provider, modelId, settings.models[provider] ?? {});
        } else {
          await services.checks.converse(modelId);
        }
        result = { ok: true, detail: `${modelId} answers a one-token test call` };
      } catch (error) {
        const wording = { changeModel: `agentx --env ${env} config set models.${role} <model id>`, rerun: "run agentx doctor again", region: "check this computer's network access to AWS (an environment cannot move regions), then run agentx doctor again" };
        result = { ok: false, detail: modelCheckProblem({ modelId, role, region: settings.region, error, wording }) };
      }
      results.set(key, result);
    }
    checks.push(result.ok ? check("models", role, "ok", result.detail) : check("models", role, "fail", result.detail, `choose another model with agentx --env ${env} config set models.${role} <model id>`));
  }
  return checks;
}

export async function alertChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, answers, services } = context;
  const controlPlaneName = settings.stacks["control-plane"] ?? environmentStackName(env, "control-plane");
  const controlPlane = await services.stacks.describe(controlPlaneName);
  const set = `agentx --env ${env} config set alerts.address <email>`;
  const checks: DoctorCheck[] = [];
  const topicArn = controlPlane?.outputs.OperatorAlertsTopicArn;
  if (topicArn === undefined || topicArn === "") {
    checks.push(check("alerts", "subscription", "fail", "the control-plane stack reports no alert topic", `agentx --env ${env} upgrade`));
  } else {
    const subscriptions = await services.alerts.subscriptions(topicArn);
    const confirmed = subscriptions.filter((entry) => entry.arn.startsWith("arn:"));
    const addressSet = settings.alertAddress !== undefined || (answers !== undefined && answers.alert.kind !== "none");
    if (subscriptions.length === 0) {
      checks.push(addressSet
        ? check("alerts", "subscription", "fail", `nobody is subscribed to agentx-${env}-alerts, so alarms go nowhere`, set)
        : check("alerts", "subscription", "warn", "no alert address is set, so alarms go nowhere", set));
    } else if (confirmed.length === 0) {
      checks.push(check("alerts", "subscription", "warn", "the subscription is not confirmed yet", `confirm it (the AWS Notifications email, or your webhook's SubscribeURL), then run agentx --env ${env} alerts test`));
    } else {
      const protocols = [...new Set(confirmed.map((entry) => entry.protocol))].join(", ");
      checks.push(check("alerts", "subscription", "ok", `${confirmed.length} confirmed ${confirmed.length === 1 ? "subscription" : "subscriptions"} (${protocols})`));
    }
  }
  if (controlPlane === undefined) {
    checks.push(check("alerts", "budget", "skip", `${controlPlaneName} does not exist, so its budget setting cannot be read (the stacks check says what to do)`));
    return checks;
  }
  const monthly = controlPlane.parameters.BudgetMonthlyUsd ?? "0";
  const scope = controlPlane.parameters.BudgetScope ?? "tag";
  if (monthly === "0") {
    checks.push(check("alerts", "budget", "ok", "no budget (budget.monthlyUsd is 0)"));
  } else {
    const limit = await services.alerts.budget(settings.account, `agentx-${env}-monthly`);
    // CloudFormation neither recreates a budget deleted outside it nor reverts an edited amount, so a
    // no-change upgrade leaves both as they are. The budget exists only while BudgetMonthlyUsd is not
    // 0 (the HasBudget condition): setting 0 removes it, and setting the amount again creates it.
    const recreate = `agentx --env ${env} config set budget.monthlyUsd 0, then agentx --env ${env} config set budget.monthlyUsd ${monthly}: the first removes the budget from the control-plane stack, the second creates it again (an upgrade with no change leaves it as it is)`;
    if (limit === undefined) checks.push(check("alerts", "budget", "fail", `the budget agentx-${env}-monthly is missing`, recreate));
    else if (limit !== Number(monthly)) checks.push(check("alerts", "budget", "warn", `the budget is $${limit} a month, but budget.monthlyUsd is ${monthly}`, `set agentx-${env}-monthly back to $${monthly} in the AWS Budgets console, or run ${recreate}`));
    else checks.push(check("alerts", "budget", "ok", `$${monthly} a month, ${scope === "tag" ? "costs tagged agentx:env (the tag must be active in Billing, Cost allocation tags)" : "the whole account"}`));
  }
  return checks;
}

export async function capacityChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { settings, services } = context;
  const region = settings.region;
  const checks: DoctorCheck[] = [];
  try {
    const quota = await services.checks.ec2Quota();
    checks.push(quota >= 1
      ? check("capacity", "EC2 vCPUs", "ok", `the Standard on-demand vCPU quota is ${quota} in ${region}`)
      : check("capacity", "EC2 vCPUs", "fail", `the Standard on-demand vCPU quota is ${quota} in ${region}, so no worker can start`, `request an increase of L-1216C47A in Service Quotas for ${region}`));
  } catch (error) {
    checks.push(check("capacity", "EC2 vCPUs", "warn", `could not read the vCPU quota: ${plainMessage(error)}`));
  }
  try {
    const { quota, allocated } = await services.checks.elasticIps();
    const free = Math.max(0, quota - allocated);
    checks.push(free >= NAT_ELASTIC_IPS
      ? check("capacity", "Elastic IPs", "ok", `${free} of ${quota} EC2-VPC Elastic IPs free in ${region}`)
      : check("capacity", "Elastic IPs", "warn", `${free} of ${quota} EC2-VPC Elastic IPs free in ${region}: this environment keeps working, but another environment in this region would not fit (it needs ${NAT_ELASTIC_IPS})`,
        `release addresses you no longer use, or request more: aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-0263D0A3 --desired-value ${allocated + NAT_ELASTIC_IPS} --region ${region}`));
  } catch (error) {
    checks.push(check("capacity", "Elastic IPs", "warn", `could not count Elastic IPs: ${plainMessage(error)}`));
  }
  return checks;
}

export async function signInChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const found = await context.services.signIn(context.settings);
  return found.map((entry) => check("sign-in", entry.name, entry.warn === true ? "warn" : entry.ok ? "ok" : "fail", entry.detail));
}
