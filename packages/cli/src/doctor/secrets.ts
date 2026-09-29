// FR-050: that secrets exist and have the right shape. Values are read only to judge their shape;
// no message here is built from a value.
import { githubAppSecretName, parseAppSecret } from "../init/github-app.js";
import { checkAlertWebhook } from "../init/answers.js";
import { slackSecretName } from "../init/slack-app.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

interface SecretRule { name: string; shape(value: string): string | undefined; fix: string }

function slackShape(value: string): string | undefined {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(value) as Record<string, unknown>; } catch { return "is not JSON"; }
  if (typeof parsed.botToken !== "string" || !parsed.botToken.startsWith("xoxb-")) return "holds no bot token (xoxb-)";
  if (typeof parsed.signingSecret !== "string" || !/^[a-f0-9]{32}$/.test(parsed.signingSecret)) return "holds no Slack signing secret";
  return undefined;
}

export async function secretChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, answers, services } = context;
  const put = (name: string, shape: string) => `aws secretsmanager put-secret-value --secret-id ${name} --secret-string file://${shape} --region ${settings.region}`;
  const rules: SecretRule[] = [
    {
      name: `agentx/${env}/callback-signing-key`,
      shape: (value) => (value.length >= 32 ? undefined : "is shorter than the 32 characters the control plane needs"),
      fix: `run agentx --env ${env} upgrade: it makes a new key and redeploys the control plane with it`,
    },
    {
      name: slackSecretName(env),
      shape: slackShape,
      fix: `store the Slack app's Bot User OAuth Token and Signing Secret again: ${put(slackSecretName(env), "slack.json")}, where slack.json is {"botToken":"xoxb-...","signingSecret":"..."} plus clientId and clientSecret if developers sign in with Slack`,
    },
    {
      name: githubAppSecretName(env),
      shape: (value) => { try { parseAppSecret(value, githubAppSecretName(env)); return undefined; } catch { return "is not an AgentX GitHub App secret"; } },
      fix: `generate a new private key on the GitHub App's settings page, then ${put(githubAppSecretName(env), "github-app.json")} with {"appId":"...","slug":"...","account":"...","privateKey":"-----BEGIN RSA PRIVATE KEY-----..."}`,
    },
  ];
  if (answers?.alert.kind === "webhook") {
    rules.push({
      name: answers.alert.secretName,
      shape: (value) => { try { checkAlertWebhook(value.trim()); return undefined; } catch { return "is not an https:// address"; } },
      fix: `agentx --env ${env} config set alerts.address --value-file <file holding the PagerDuty or Opsgenie address>`,
    });
  }
  if (settings.models.openRouter?.secretArn.includes(`:secret:agentx/${env}/openrouter`) === true) {
    rules.push({ name: `agentx/${env}/openrouter`, shape: (value) => (value.trim() === "" ? "is empty" : undefined), fix: `store the OpenRouter key again: ${put(`agentx/${env}/openrouter`, "openrouter-key.txt")}` });
  }
  const checks: DoctorCheck[] = [];
  for (const rule of rules) {
    const value = await services.secrets.get(rule.name);
    if (value === undefined) { checks.push(check("secrets", rule.name, "fail", "does not exist", rule.fix)); continue; }
    const problem = rule.shape(value);
    checks.push(problem === undefined ? check("secrets", rule.name, "ok", "exists and has the right shape") : check("secrets", rule.name, "fail", problem, rule.fix));
  }
  return checks;
}
