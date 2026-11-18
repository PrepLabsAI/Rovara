import { type CfnCondition, Fn, RemovalPolicy, Token, aws_logs as logs, aws_route53resolver as resolver } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DEFAULT_AGENT_ALLOW_DOMAINS } from "@agentx/contracts";

// A named environment's DNS firewall: the machines in the install's VPC resolve only an allowlist of websites. Ported from the hosted install's foundation (agentx-<env>-foundation,
// 0.5.18) with the same construct ids, names and list, so an in-place update of a stack that already has it keeps the live firewall instead of deleting and recreating it.

/** The CDK context key holding extra allowed domains, comma separated (for example an internal package registry). */
export const EGRESS_ALLOW_DOMAINS_CONTEXT_KEY = "agentxEgressAllowDomains";

/**
 * The priority of the rule group's association with the VPC. This is a different scale from the rule priorities inside the group (100, 150 and 200). Resolver rejects 100 and 9900
 * as reserved ("[RSLVR-02017] ... Provide a number between "100" and "9900"", both bounds exclusive), so a valid association priority is 101..9899.
 */
export const DNS_FIREWALL_ASSOCIATION_PRIORITY = 101;

/**
 * Commercial AWS regions a company AI source (a Bedrock role in the company's own account) may name; the model caller assumes the company's role and calls Bedrock there. GovCloud and
 * China regions are not served. Pinned (the commercial regions of the AWS Regions page, 2026-11-11).
 */
export const BEDROCK_SOURCE_REGIONS: readonly string[] = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "ca-west-1", "sa-east-1", "mx-central-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2",
  "ap-east-1", "ap-east-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5", "ap-southeast-6", "ap-southeast-7",
  "me-central-1", "me-south-1", "af-south-1", "il-central-1",
];

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/u;

/**
 * The AWS hosts the install's own machines resolve in its region. These replace `*.amazonaws.com` and `*.aws`, which would let any AWS customer's bucket or API through.
 * KNOWN RESIDUALS, each a name under which anyone in the region can host something, kept because the owning stack generates the name after this stack is deployed:
 * `*.s3.<region>` (the artifact buckets and the ECR layer bucket) and `s3.<region>` itself (a path-style request reaches any bucket in the region), `*.execute-api.<region>` (the control plane's API), `*.<region>.elb` and `*.<region>.rds` (a model gateway's load
 * balancer and database). Closing them needs the owning stacks to publish their exact names to the firewall.
 */
export const INSTALL_AWS_HOSTS: ReadonlyArray<{ host: (region: string, account?: string) => string | undefined; why: string }> = [
  { host: (r) => `dynamodb.${r}.amazonaws.com`, why: "state tables (session Lambdas, Slack orchestrator)" },
  { host: (r) => `sqs.${r}.amazonaws.com`, why: "queues (session Lambdas, Slack orchestrator)" },
  { host: (r) => `s3.${r}.amazonaws.com`, why: "S3 regional endpoint" },
  { host: (r) => `*.s3.${r}.amazonaws.com`, why: "the install's buckets (generated names, see KNOWN RESIDUALS) and the ECR layer bucket (image pulls)" },
  { host: (r) => `al2023-repos-${r}-de612dc2.s3.dualstack.${r}.amazonaws.com`, why: "Amazon Linux 2023 package repository: a worker's boot installs Docker from it (exact bucket host)" },
  { host: (r) => `kms.${r}.amazonaws.com`, why: "session Lambdas sign and verify with the invoke key" },
  { host: (r) => `ssm.${r}.amazonaws.com`, why: "settings parameters" },
  { host: (r) => `ec2.${r}.amazonaws.com`, why: "worker instances (reaper, reconciler)" },
  { host: (r) => `states.${r}.amazonaws.com`, why: "Step Functions (provisioner, deleter, dispatcher)" },
  { host: (r) => `lambda.${r}.amazonaws.com`, why: "Lambda API (dispatcher, reconciler)" },
  { host: (r) => `email.${r}.amazonaws.com`, why: "SES v2 (operator mail)" },
  { host: (r) => `secretsmanager.${r}.amazonaws.com`, why: "secrets of in-VPC tasks (the Slack orchestrator)" },
  { host: (r) => `scheduler.${r}.amazonaws.com`, why: "EventBridge Scheduler (reconciler)" },
  { host: (r) => `sts.${r}.amazonaws.com`, why: "role sessions (reconciler, company Bedrock roles)" },
  { host: () => "sts.amazonaws.com", why: "the global STS name some SDKs and the AWS CLI still use" },
  { host: () => "pricing.us-east-1.amazonaws.com", why: "AWS's public, read-only Price List host (model price refresh); an exact name with nothing to upload to" },
  { host: (r) => `monitoring.${r}.amazonaws.com`, why: "CloudWatch metrics (reconciler)" },
  { host: (r) => `logs.${r}.amazonaws.com`, why: "CloudWatch Logs: the worker's awslogs driver, ECS task logs" },
  { host: (r) => `api.ecr.${r}.amazonaws.com`, why: "ECR login token for worker and ECS image pulls" },
  { host: (r, account) => (account === undefined ? undefined : `${account}.dkr.ecr.${r}.amazonaws.com`), why: "this account's ECR registry: the worker, executor and sandbox images (exact)" },
  { host: (r) => `bedrock-runtime.${r}.amazonaws.com`, why: "model calls" },
  { host: (r) => `bedrock.${r}.amazonaws.com`, why: "Bedrock model and profile discovery (worker model check)" },
  { host: (r) => `servicequotas.${r}.amazonaws.com`, why: "Bedrock quota read by the worker's model check" },
  { host: (r) => `*.execute-api.${r}.amazonaws.com`, why: "the control plane's API: the worker's callbacks and the Slack orchestrator (see KNOWN RESIDUALS)" },
  { host: (r) => `*.${r}.elb.amazonaws.com`, why: "a model gateway's internal load balancer (a generated name, see KNOWN RESIDUALS)" },
  { host: (r) => `*.${r}.rds.amazonaws.com`, why: "a model gateway's database endpoint (a generated name, see KNOWN RESIDUALS)" },
];

/** The exact AWS names of an install in `region` (`account` pins its ECR registry), then the Bedrock and STS names of every region a company source can name. */
export function installAwsAllowDomains(region: string, account?: string): string[] {
  if (!REGION.test(region)) throw new Error("installAwsAllowDomains needs an AWS region such as us-west-2");
  const own = INSTALL_AWS_HOSTS.map((entry) => entry.host(region, account)).filter((host): host is string => host !== undefined);
  const bedrockSources = BEDROCK_SOURCE_REGIONS.flatMap((source) => [`bedrock-runtime.${source}.amazonaws.com`, `bedrock.${source}.amazonaws.com`, `sts.${source}.amazonaws.com`]);
  return [...new Set([...own, ...bedrockSources])];
}

/** The base allow-list of a named environment: Code's default list, then the install's own AWS hosts. */
export function installAgentAllowDomains(region: string, account?: string): string[] {
  return [...DEFAULT_AGENT_ALLOW_DOMAINS, ...installAwsAllowDomains(region, account)];
}

const BROAD_ALLOW_ENTRIES: readonly string[] = ["*.amazonaws.com", "*.aws", "*.github.com", "*.githubusercontent.com"];
const BROAD_WILDCARD_BASES = /(^|\.)(amazonaws\.com|amazonaws\.com\.cn|aws|github\.com|githubusercontent\.com)$/u;

/** Whether an operator may not add this name: the broad entries, and any wildcard over AWS or GitHub names (one entry is VPC-wide and would reopen what the default list closed). */
export function isBroadAllowedDomain(domain: string): boolean {
  const name = domain.toLowerCase();
  if (BROAD_ALLOW_ENTRIES.includes(name)) return true;
  return name.startsWith("*.") && BROAD_WILDCARD_BASES.test(name.slice(2));
}

/** Resolver accepts a domain specification of 1-255 characters. */
const MAX_DOMAIN_LENGTH = 255;
const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** The extra domains from a context value: trimmed, validated, without blanks or duplicates of `existing`. Fixed refusal text: the value is not echoed. */
export function parseExtraAllowDomains(value: unknown, existing: readonly string[]): string[] {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") throw new Error(`${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} must be a comma-separated string of domain names`);
  const seen = new Set(existing.map((domain) => domain.toLowerCase()));
  const extra: string[] = [];
  for (const entry of value.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    if (entry.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(entry)) {
      throw new Error(`${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} entries must be domain names of at most ${MAX_DOMAIN_LENGTH} characters, such as artifactory.example.com or *.example.com, without a scheme or path`);
    }
    if (isBroadAllowedDomain(entry)) throw new Error(`${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} cannot hold a wildcard over AWS or GitHub names; name the exact host`);
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    extra.push(entry);
  }
  return extra;
}

export interface AgentDnsFirewallProps {
  /** The named environment, for the resource names and the query log group /agentx/<env>/dns-firewall. */
  env: string;
  vpcId: string;
  /** The base allow-list (`installAgentAllowDomains`). */
  baseAllowDomains: readonly string[];
  /** Allowed in addition to the base list. */
  extraAllowDomains?: readonly string[];
  /**
   * L4-E8I (owner DEC 254zzz62): the registries the GCP pack's source-pulled image is pulled from (VPC-wide, like every entry of this list: see the KNOWN RESIDUAL on GCP_PACK_PULL_REGISTRY_HOSTS) (contracts GCP_PACK_PULL_REGISTRY_HOSTS: exactly `gcr.io` and `us-docker.pkg.dev`, no wildcard). They join the base allow
   * list ONLY while `condition` holds (the install's TestServicesGcpPack setting names the `pulled` group): the allow list's Domains is an Fn::If of the same list with and without them. No new list, rule or priority; with the setting
   * off (the default) the resolved list is exactly what it was.
   */
  pullFromSource?: { condition: CfnCondition; hosts: readonly string[] };
}

/**
 * A Route 53 Resolver DNS Firewall for the install VPC, so agent machines resolve only an allowlist of websites. Rule group, in order: priority 100 ALLOW the base list, priority 150
 * ALLOW the project list, priority 200 BLOCK `*` with NXDOMAIN. Every query is logged to /agentx/<env>/dns-firewall (30 days).
 *
 * The project list is declared with no `domains` on purpose: the template never owns its contents, so a stack update cannot reset domains an operator or a broker sync added.
 *
 * It governs the whole VPC (one resolver): every task, Lambda and service in the VPC resolves through it, so a host any of them needs must be on the list.
 *
 * Fail closed: no FirewallConfig is created, so FirewallFailOpen keeps the AWS default, DISABLED; a query the firewall cannot evaluate fails instead of being let through.
 *
 * Known limit: DNS filtering does not stop a connection made straight to an IP address.
 */
export class AgentDnsFirewall extends Construct {
  readonly logGroup: logs.LogGroup;
  readonly ruleGroup: resolver.CfnFirewallRuleGroup;
  readonly projectAllowListId: string;
  readonly allowDomains: readonly string[];

  constructor(scope: Construct, id: string, props: AgentDnsFirewallProps) {
    super(scope, id);
    this.allowDomains = [...props.baseAllowDomains, ...(props.extraAllowDomains ?? [])];

    const allowList = new resolver.CfnFirewallDomainList(this, "AllowList", {
      name: `agentx-${props.env}-allow`,
      domains: props.pullFromSource === undefined ? [...this.allowDomains]
        : Token.asList(Fn.conditionIf(props.pullFromSource.condition.logicalId, [...this.allowDomains, ...props.pullFromSource.hosts.filter((host) => !this.allowDomains.some((domain) => typeof domain === "string" && domain.toLowerCase() === host))], [...this.allowDomains])),
    });
    const projectAllowList = new resolver.CfnFirewallDomainList(this, "ProjectAllowList", {
      name: `agentx-${props.env}-project-allow`,
    });
    this.projectAllowListId = projectAllowList.attrId;
    const blockList = new resolver.CfnFirewallDomainList(this, "BlockAllList", {
      name: `agentx-${props.env}-block-all`,
      domains: ["*"],
    });
    this.ruleGroup = new resolver.CfnFirewallRuleGroup(this, "RuleGroup", {
      name: `agentx-${props.env}-agents`,
      firewallRules: [
        // An allowed name may CNAME to a CDN name not on the list (auth.docker.io -> *.cdn.cloudflare.net); trust the chain only for names this rule already allowed.
        { action: "ALLOW", priority: 100, firewallDomainListId: allowList.attrId, firewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN" },
        { action: "ALLOW", priority: 150, firewallDomainListId: projectAllowList.attrId, firewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN" },
        { action: "BLOCK", blockResponse: "NXDOMAIN", priority: 200, firewallDomainListId: blockList.attrId },
      ],
    });
    new resolver.CfnFirewallRuleGroupAssociation(this, "Association", {
      firewallRuleGroupId: this.ruleGroup.attrId,
      vpcId: props.vpcId,
      priority: DNS_FIREWALL_ASSOCIATION_PRIORITY,
      name: `agentx-${props.env}-agents`,
    });

    this.logGroup = new logs.LogGroup(this, "QueryLogs", {
      logGroupName: `/agentx/${props.env}/dns-firewall`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const queryLogging = new resolver.CfnResolverQueryLoggingConfig(this, "QueryLogging", {
      name: `agentx-${props.env}-dns-firewall`,
      // The log group ARN with its trailing ":*" is the documented form for a CloudWatch Logs destination.
      destinationArn: this.logGroup.logGroupArn,
    });
    new resolver.CfnResolverQueryLoggingConfigAssociation(this, "QueryLoggingAssociation", {
      resolverQueryLogConfigId: queryLogging.attrId,
      resourceId: props.vpcId,
    });
  }
}
