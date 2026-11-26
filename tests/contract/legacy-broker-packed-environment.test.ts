import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { hydrateBrokerEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { loadBrokerNamesParameter } from "../../packages/broker/src/aws/broker-names-parameter.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// #1149: production's (the legacy template's) broker packs its environment as a named environment does, with NO change to what the broker runs with. This synthesizes the legacy
// control plane, fills every CloudFormation value in with a stand-in physical name, runs the broker's own boot (the names parameter read, then hydrateBrokerEnvironment) and pins
// the result: exactly the 45 variables production's broker had before #1149 (as live on 2026-11-19), each rebuilt to the value the old template gave it, plus the packing's own six,
// plus (#1148) what the core engine brought, its switch off.

/** The variables production's broker had before #1149 (AgentXControlPlane, 2026-11-19), every one of them passed whole. */
const BEFORE = [
  "ADMIN_CLAIM", "ADMIN_VALUES", "AGENTX_ALARM_PREFIX", "AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID", "AGENTX_ENV", "AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID", "AGENTX_TASK_PEOPLE_CHANGES_ENABLED",
  "AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED", "AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED", "AGENTX_WORKFLOW_DEPENDENCIES_ENABLED", "ARTIFACT_BUCKET_NAME", "CALLBACK_SIGNING_KEY_SECRET_ID",
  "CHANNEL_ADAPTERS", "CHANNEL_ADAPTER_SECRET_PREFIX", "CHATGPT_CONNECTION_KEY_ARN", "COMPANY_SECRETS_ROLE_ARN", "COMPANY_SIGNIN", "DELETER_ARN", "DEVELOPER_GITHUB_SINCE",
  "DEVELOPER_IDENTITY_FUNCTION_ARN", "DEVELOPER_OIDC_ISSUER", "DEVELOPER_OIDC_SINCE", "DEVELOPER_SIGNIN_GITHUB", "DEVELOPER_SIGNIN_SLACK", "DEVELOPER_SIGNIN_SLACK_SINCE",
  "DEVELOPER_SIGNIN_TABLE_NAME", "DEVELOPER_TOKEN_ISSUER", "EC2_WORKER_LAUNCH_TEMPLATE_ID", "EC2_WORKER_SUBNETS", "GITHUB_APP_CREDENTIAL_REF", "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_SECRET_ARN", "HEALTH_DEAD_LETTER_QUEUES", "MCP_CONFIRM_ELICITATION", "OIDC_ISSUER", "PROVISIONER_ARN", "SLACK_MEMBER_WORKSPACE_LIMIT",
  "SLACK_ORCHESTRATOR_ROLE_ARN", "SLACK_ORGANIZATION_WORKSPACE_LIMIT", "SLACK_REQUEST_QUEUE_URL", "SLACK_TEAM_ID", "SLACK_THREADS_TABLE_NAME", "STATE_TABLE_NAME",
  "TURN_RECORDS_TABLE_NAME",
];
/** F1 L1a-1 deleted the two invitation switches (the parameters and their packed settings tu and tv): the broker no longer has these two of the 45. Nothing read either variable. */
const RETIRED = ["AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED", "AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED"];
/** What packing adds, and nothing else: the account (ARNs and URLs are built from it), the names parameter's pointer and revision (and the names read from it), the settings, and the layout. */
const PACKING = ["AGENTX_ACCOUNT_ID", "AGENTX_INSTALL_LAYOUT", "AGENTX_NAMES", "AGENTX_NAMES_PARAMETER", "AGENTX_NAMES_REVISION", "AGENTX_SETTINGS"];
/** CODE-PUBLIC-URL: the public address the broker derives its issuer from (packed `pu`); empty while the install has none. */
const PUBLIC_API = ["ROVARA_PUBLIC_API_URL"];
/** #1171: Slack company mode's switch (packed `cw`), "disabled" while off. */
const SLACK_COMPANY = ["SLACK_COMPANY_WORKSPACES"];
/** #1148: what the core engine brought to the legacy install, on purpose: its switches and model settings, its queues and attention email (derived), the keys and the saved environments' roles. */
const CORE = [
  "ATTENTION_EMAIL_FUNCTION_NAME", "COMPANY_READS", "CORE_DISPATCH_DEAD_LETTER_URL", "CORE_DISPATCH_QUEUE_URL", "CORE_LESSONS_REFLECT_DEAD_LETTER_URL", "CORE_LESSONS_REFLECT_QUEUE_URL",
  "POLICY_HOOK_KEY_ARN", "ROVARA_ATTENTION_EMAIL", "ROVARA_CORE_AGENT_MODEL", "ROVARA_CORE_AGENT_MODEL_CHOICE", "ROVARA_CORE_ANSWERS_MODEL",
  "ROVARA_CORE_COMPANY_DAY_CAP_USD", "ROVARA_CORE_LEARNING_MODEL", "ROVARA_CORE_LESSONS", "ROVARA_CORE_MODEL_GATEWAY_URL", "ROVARA_CORE_OUTBOX_STREAM_RELAY", "ROVARA_CORE_SYSTEM_RUNS",
  "ROVARA_CORE_TASK_CAP_USD", "ROVARA_POLICY_HOOK", "ROVARA_SAVED_ENVIRONMENTS", "ROVARA_SAVED_ENV_MANAGE_ROLE_ARN", "ROVARA_SAVED_ENV_PULL_ROLE_ARN", "ROVARA_SAVED_ENV_PUSH_ROLE_ARN",
  "ROVARA_SAVED_ENV_REPO_PREFIX", "ROVARA_TEST_SERVICES", "ROVARA_TEST_SERVICES_HOSTED_IMAGES", "TASK_TOKEN_KEY_ARN",
];

/** Webhook lane W3: the dedicated GitHub webhook secret's NAME, derived by the broker (nothing in its 4 KB variables); production's slot is agentx/production/github-webhook-secret. */
const WEBHOOK = ["GITHUB_WEBHOOK_SECRET_ID"];

// AWS's documentation placeholder account and API id (the port guard refuses real ones; the shapes are what is pinned).
const REGION = "us-east-1", ACCOUNT = "123456789012";
type Json = Record<string, unknown>;
interface Template { Resources: Record<string, { Type: string; Properties: Json }>; Conditions?: Record<string, unknown>; Parameters?: Record<string, { Default?: unknown }> }

/** Fills a CloudFormation value in: a resource is `PHYS-<logical id>`, in the shape its Ref or attribute really has; a parameter its default, or `parameters`. */
function resolverOf(template: Template, parameters: Record<string, string>) {
  const pseudo: Record<string, string> = { "AWS::Region": REGION, "AWS::AccountId": ACCOUNT, "AWS::Partition": "aws", "AWS::URLSuffix": "amazonaws.com", "AWS::StackName": "AgentXControlPlane" };
  const typeOf = (id: string) => { const resource = template.Resources[id]; if (resource === undefined) throw new Error(`no resource ${id}`); return resource.Type; };
  const ref = (id: string): string => {
    const type = typeOf(id), phys = type === "AWS::ApiGatewayV2::Api" ? "example" : `PHYS-${id}`;
    if (type === "AWS::SQS::Queue") return `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${phys}`;
    if (type === "AWS::StepFunctions::StateMachine") return `arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:${phys}`;
    return phys;
  };
  const attribute = (id: string, name: string): string => {
    const type = typeOf(id), phys = `PHYS-${id}`;
    if (name === "QueueName" && type === "AWS::SQS::Queue") return phys;
    if (name === "Name" && type === "AWS::StepFunctions::StateMachine") return phys;
    if (name === "ApiEndpoint" && type === "AWS::ApiGatewayV2::Api") return `https://${phys}.execute-api.${REGION}.amazonaws.com`;
    if (name === "Arn") {
      const arns: Record<string, string> = {
        "AWS::Lambda::Function": `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${phys}`, "AWS::IAM::Role": `arn:aws:iam::${ACCOUNT}:role/${phys}`,
        "AWS::KMS::Key": `arn:aws:kms:${REGION}:${ACCOUNT}:key/${phys}`, "AWS::SQS::Queue": `arn:aws:sqs:${REGION}:${ACCOUNT}:${phys}`,
      };
      if (arns[type] !== undefined) return arns[type];
    }
    throw new Error(`no stand-in for ${id}.${name} (${type})`);
  };
  const condition = (node: unknown): boolean => {
    const [key, value] = Object.entries(node as Json)[0]! as [string, unknown[] | string];
    if (key === "Fn::Equals") return resolve((value as unknown[])[0]) === resolve((value as unknown[])[1]);
    if (key === "Fn::Not") return !condition((value as unknown[])[0]);
    if (key === "Fn::And") return (value as unknown[]).every(condition);
    if (key === "Fn::Or") return (value as unknown[]).some(condition);
    if (key === "Condition") return condition(template.Conditions![value as string]);
    throw new Error(`condition ${key}`);
  };
  const resolve = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    const [key, value] = Object.entries(node as Json)[0]!;
    if (key === "Ref") {
      const name = value as string;
      if (pseudo[name] !== undefined) return pseudo[name];
      const declared = template.Parameters?.[name];
      if (declared !== undefined) return parameters[name] ?? (typeof declared.Default === "string" || typeof declared.Default === "number" ? String(declared.Default) : `P-${name}`);
      return ref(name);
    }
    if (key === "Fn::GetAtt") return attribute((value as string[])[0]!, (value as string[])[1]!);
    if (key === "Fn::Join") return ((value as unknown[])[1] as unknown[]).map(resolve).join((value as unknown[])[0] as string);
    // CODE-PUBLIC-URL: the packed public host is Select(1, Split("://", PublicApiUrl)).
    if (key === "Fn::Select") { const [index, list] = value as [number, { "Fn::Split": [string, unknown] }]; return resolve(list["Fn::Split"][1]).split(list["Fn::Split"][0])[Number(index)]!; }
    if (key === "Fn::If") { const [name, yes, no] = value as [string, unknown, unknown]; return resolve(condition(template.Conditions![name]) ? yes : no); }
    throw new Error(`no stand-in for ${key}`);
  };
  return resolve;
}

/** The broker as it boots: its environment filled in, the names parameter read (the only read), then hydrated. */
async function bootedBroker(template: Template, parameters: Record<string, string>): Promise<{ env: Record<string, string | undefined>; reads: string[]; parameterName: string }> {
  const resolve = resolverOf(template, parameters);
  const [, broker] = Object.entries(template.Resources).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith("Broker"))!;
  const [, names] = Object.entries(template.Resources).find(([id, resource]) => resource.Type === "AWS::SSM::Parameter" && id.startsWith("BrokerNamesParameter"))!;
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries((broker.Properties.Environment as { Variables: Json }).Variables).map(([key, value]) => [key, resolve(value)]));
  env.AWS_REGION = REGION;
  const reads: string[] = [];
  await loadBrokerNamesParameter(env, async (name) => { reads.push(name); return { type: "String", value: resolve(names.Properties.Value) }; });
  hydrateBrokerEnvironment(env);
  delete env.AWS_REGION;
  return { env, reads, parameterName: names.Properties.Name as string };
}

describe("production's broker, packed (#1149)", () => {
  let template: Template;
  beforeAll(() => { template = buildAgentXApp().synth().getStackByName("AgentXControlPlane").template as Template; }, 300_000);

  for (const companySignIn of ["disabled", "enabled"]) {
    it(`boots with exactly the variables it had before, plus the packing's own (company sign-in ${companySignIn})`, async () => {
      const { env, reads, parameterName } = await bootedBroker(template, { CompanySignIn: companySignIn, CompanySelfServe: companySignIn });
      expect(parameterName).toBe("/agentx/production/broker-names");
      expect(reads).toEqual(["/agentx/production/broker-names"]);
      expect(Object.keys(env).sort()).toEqual([...BEFORE.filter((name) => !RETIRED.includes(name)), ...PACKING, ...CORE, ...SLACK_COMPANY, ...WEBHOOK, ...PUBLIC_API].sort());
      expect(env.SLACK_COMPANY_WORKSPACES).toBe("disabled");
      expect(env.AGENTX_INSTALL_LAYOUT).toBe("legacy");
      expect(env.GITHUB_WEBHOOK_SECRET_ID).toBe("agentx/production/github-webhook-secret");
      expect(env.AGENTX_ENV).toBe("production");
      expect(env.COMPANY_SIGNIN).toBe(companySignIn);
      // What a named environment would derive differently stays production's own: the alarm prefix is passed whole, and the roles keep their ARNs (no /agentx/production/ path).
      expect(env.AGENTX_ALARM_PREFIX).toBe("AgentX");
      expect(env.SLACK_ORCHESTRATOR_ROLE_ARN).toMatch(/^arn:aws:iam::123456789012:role\/PHYS-SlackOrchestratorTaskRole/u);
      expect(env.COMPANY_SECRETS_ROLE_ARN).toMatch(/^arn:aws:iam::123456789012:role\/PHYS-CompanySecretsRole/u);
      // Rebuilt from the packed names, to the values the whole variables held.
      expect(env.STATE_TABLE_NAME).toMatch(/^PHYS-State/u);
      expect(env.SLACK_REQUEST_QUEUE_URL).toMatch(/^https:\/\/sqs\.us-east-1\.amazonaws\.com\/123456789012\/PHYS-SlackRequestQueue/u);
      // CODE-PUBLIC-URL: with PublicApiUrl empty (the default) the issuer is exactly the API's own host, as before, and there is no public origin.
      expect(env.DEVELOPER_TOKEN_ISSUER).toBe("https://example.execute-api.us-east-1.amazonaws.com/v1/auth");
      expect(env.ROVARA_PUBLIC_API_URL).toBe("");
      expect(env.DELETER_ARN).toMatch(/^arn:aws:states:us-east-1:123456789012:stateMachine:PHYS-SessionsDeleter/u);
      expect(Object.keys(JSON.parse(env.HEALTH_DEAD_LETTER_QUEUES!) as Json)).toEqual(["dispatch", "slack-requests", "developer-notices", "developer-notice-stream", "channel-events"]);
      // The three derivations identical to production's own values.
      expect(env.CHANNEL_ADAPTER_SECRET_PREFIX).toBe("agentx/production/");
      expect(env.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe("agentx-production-project-setup-runtime-v1");
      expect(env.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID).toBe("agentx-production-e2e-mock-runtime-v1");
    }, 120_000);
  }

  it("CODE-PUBLIC-URL: with PublicApiUrl set, the broker's issuer is the public address and nothing else about it changes", async () => {
    const unset = (await bootedBroker(template, {})).env;
    const { env } = await bootedBroker(template, { PublicApiUrl: "https://api.example.dev" });
    expect(env.ROVARA_PUBLIC_API_URL).toBe("https://api.example.dev");
    expect(env.DEVELOPER_TOKEN_ISSUER).toBe("https://api.example.dev/v1/auth");
    const { DEVELOPER_TOKEN_ISSUER: issuerSet, ROVARA_PUBLIC_API_URL: publicSet, AGENTX_SETTINGS: settingsSet, ...restSet } = env;
    const { DEVELOPER_TOKEN_ISSUER: issuerUnset, ROVARA_PUBLIC_API_URL: publicUnset, AGENTX_SETTINGS: settingsUnset, ...restUnset } = unset;
    expect([issuerSet, publicSet]).not.toEqual([issuerUnset, publicUnset]);
    expect(restSet).toEqual(restUnset);
    expect(settingsSet).toBe(settingsUnset!.replace(",pu=,", ",pu=api.example.dev,"));
  }, 120_000);

  it("derives nothing a named environment's name would decide differently (no metrics namespace, connector prefix or AI navigation prefix), and the core's queues under production's names", async () => {
    const { env } = await bootedBroker(template, {});
    for (const variable of ["AGENTX_METRICS_NAMESPACE", "CONNECTOR_SECRET_PREFIX", "AGENTX_E2E_AGENT_SETTINGS_PREFIX"]) expect(env[variable], variable).toBeUndefined();
    expect(env.CORE_DISPATCH_QUEUE_URL).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/agentx-production-core-dispatch");
    expect(env.CORE_LESSONS_REFLECT_QUEUE_URL).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/agentx-production-lessons-reflect");
    expect(env.ATTENTION_EMAIL_FUNCTION_NAME).toBe("agentx-production-attention-email");
    expect(env).not.toHaveProperty("ROVARA_CORE_ENGINE");
  }, 120_000);
});
