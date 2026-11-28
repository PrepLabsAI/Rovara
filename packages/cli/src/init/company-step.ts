// #1612: init's company step. After the first project and the connectors, the install gets its own company (named after the Slack workspace, its first owner the admin init made)
// and the records init just made move into it, so a fresh install ends with one real company the core accepts. Re-run, it finds the same company and writes nothing new.
import { environmentStackName } from "@agentx/contracts";
import { installCompanyLines, runInstallCompanyStep } from "../company/install-company-step.js";
import type { InitContext } from "./context.js";
import { requireSettings } from "./finish-steps.js";
import { githubAppJwt, githubAppSecretName, parseAppSecret } from "./github-app.js";
import type { InitStep } from "./steps.js";
import { STEP_PLAN } from "./ui/journey.js";

export function companyStep(): InitStep<InitContext> {
  return {
    id: "company",
    title: STEP_PLAN.company.title,
    async run(context, progress) {
      const settings = await requireSettings(context);
      const client = context.setup.installCompanyClient?.(settings.region);
      if (client === undefined) return { status: "done", note: "skipped: no AWS client for the company step" };
      const outputs = await context.setup.stackOutputs(environmentStackName(context.env, "control-plane")) ?? {};
      const recorded = progress.current();
      const owner = recorded.admin?.username;
      const result = await runInstallCompanyStep({ documentClient: client, installations: async () => await installations(context), now: context.now, write: context.write }, {
        env: context.env, outputs, parameters: recorded.slack === undefined ? {} : { SlackTeamId: recorded.slack.teamId },
        ...(owner !== undefined && owner.includes("@") ? { ownerEmail: owner } : {}),
        ...(recorded.slack?.teamName === undefined ? {} : { slackTeamName: recorded.slack.teamName }),
        apply: true,
      });
      for (const line of installCompanyLines(result)) context.write(line);
      if (result.status === "done" && (result.move.failed || result.connections.failed)) throw new Error("the company step did not finish; run agentx init again");
      return { status: "done", note: result.status === "done" ? `company ${result.companyId}` : result.reason };
    },
  };
}

/** The GitHub App's installations, read with the App's own key; none before the App exists. */
async function installations(context: InitContext): Promise<Array<{ installationId: number; accountLogin: string }>> {
  const secretName = githubAppSecretName(context.env);
  const raw = await context.secrets.get(secretName);
  if (raw === undefined) return [];
  const app = parseAppSecret(raw, secretName);
  const listed = await context.setup.github.listInstallations(githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: Math.floor(context.now() / 1000) }));
  return listed.map((installation) => ({ installationId: installation.id, accountLogin: installation.account.login }));
}
