import { readFileSync } from "node:fs";
import { App, Stack, aws_cloudwatch as cloudwatch, aws_logs as logs, aws_sns as sns } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ALLOW_DOMAINS, GOOGLE_VERTEX_AI_ALLOW_GROUP } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import {
  DNS_FIREWALL_ASSOCIATION_PRIORITY, EGRESS_ALLOW_DOMAINS_CONTEXT_KEY, installAgentAllowDomains, isBroadAllowedDomain, parseExtraAllowDomains,
} from "../../infra/lib/agent-dns-firewall.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { EgressAlarms } from "../../infra/lib/egress-alarms.js";
import { ProductionFoundationStack } from "../../infra/lib/production-foundation.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// The staging switch-over (DEC 227, option A) updates the old hosted stacks in place with Code's templates. These tests pin what must survive that update unchanged: the
// worker DNS firewall and egress alarms (same logical ids, names, priorities and contents, so the change set keeps the live resources), the artifact bucket's evidence expiry
// (exactly the live rules; never shorter, since S3 applies a rule to objects already stored), and the broker's fixed role and function names (so they are updated, not replaced).
// The fixtures are the live staging templates' resources before the switch-over (0.5.18, us-west-2), Metadata removed.

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: unknown; DeletionPolicy?: string; UpdateReplacePolicy?: string };
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/switchover/${name}`, import.meta.url), "utf8")) as T;
const liveFirewall = fixture<{ resources: Record<string, Resource> }>("staging-foundation-dns-firewall.json").resources;
const liveLifecycle = fixture<{ rules: Array<Record<string, unknown>> }>("staging-artifact-lifecycle.json").rules;

const stagingStacks = (() => {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxRegion: "us-west-2" });
  const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
  const byName = (name: string) => stacks.find((stack) => stack.stackName === name)!;
  return { foundation: Template.fromStack(byName("agentx-staging-foundation")).toJSON() as { Resources: Record<string, Resource>; Outputs: Record<string, unknown> },
    controlPlane: Template.fromStack(byName("agentx-staging-control-plane")).toJSON() as { Resources: Record<string, Resource> } };
})();
const withoutMetadata = (resource: Resource): Resource => {
  const copy = { ...resource } as Resource & { Metadata?: unknown };
  delete copy.Metadata;
  return copy;
};
const resourcesOf = (template: Template, type: string) => template.findResources(type) as Record<string, Resource>;

describe("the staging foundation keeps the live DNS firewall and egress alarms", () => {
  // The one intended change since the live 0.5.18 template: the allow list also holds the named "Google Vertex AI" group (owner 2026-11-17). Everything else is the live resource, byte for byte.
  const vertexHosts = GOOGLE_VERTEX_AI_ALLOW_GROUP.hosts.map((entry) => entry.host);
  const allowListId = Object.entries(liveFirewall).find(([, resource]) => resource.Type === "AWS::Route53Resolver::FirewallDomainList" && resource.Properties.Name === "agentx-staging-allow")![0];

  it("has every live firewall and alarm resource under the same logical id with the same type and properties, the allow list differing only by the Google Vertex AI group", () => {
    expect(Object.keys(liveFirewall)).toHaveLength(12);
    for (const [id, live] of Object.entries(liveFirewall)) {
      const synthesized = stagingStacks.foundation.Resources[id];
      expect(synthesized, id).toBeDefined();
      if (id !== allowListId) expect(withoutMetadata(synthesized!), id).toStrictEqual(live);
    }
  });

  it("adds only the Google Vertex AI group to the allow list: the live domains in the live order, with exactly these exact hosts in one block after the default list's own names", () => {
    const synthesized = withoutMetadata(stagingStacks.foundation.Resources[allowListId]!);
    const domains = synthesized.Properties.Domains as string[];
    const start = domains.indexOf(vertexHosts[0]!);
    expect(start).toBeGreaterThan(0);
    expect(domains.slice(start, start + vertexHosts.length)).toEqual(vertexHosts);
    const without = [...domains.slice(0, start), ...domains.slice(start + vertexHosts.length)];
    expect({ ...synthesized, Properties: { ...synthesized.Properties, Domains: without } }).toStrictEqual(liveFirewall[allowListId]);
    // The block is the end of Code's default list; nothing broad came with it.
    expect(domains.slice(0, start + vertexHosts.length)).toEqual([...DEFAULT_AGENT_ALLOW_DOMAINS]);
    expect(domains.filter((domain) => typeof domain === "string" && domain.endsWith("googleapis.com"))).toEqual(vertexHosts);
    expect(vertexHosts.some((host) => host.includes("*"))).toBe(false);
  });

  it("keeps the fixed names, the rule priorities and actions, and the association priority", () => {
    const byType = (type: string) => Object.values(stagingStacks.foundation.Resources).filter((resource) => resource.Type === type);
    expect(byType("AWS::Route53Resolver::FirewallDomainList").map((list) => list.Properties.Name)).toEqual(["agentx-staging-allow", "agentx-staging-project-allow", "agentx-staging-block-all"]);
    const [group] = byType("AWS::Route53Resolver::FirewallRuleGroup");
    expect((group!.Properties.FirewallRules as Array<{ Priority: number; Action: string }>).map((rule) => [rule.Priority, rule.Action])).toEqual([[100, "ALLOW"], [150, "ALLOW"], [200, "BLOCK"]]);
    expect(byType("AWS::Route53Resolver::FirewallRuleGroupAssociation").map((association) => association.Properties.Priority)).toEqual([DNS_FIREWALL_ASSOCIATION_PRIORITY]);
    expect(byType("AWS::Logs::LogGroup").map((group) => group.Properties.LogGroupName)).toContain("/agentx/staging/dns-firewall");
  });

  it("never declares the project allow list's domains, which are managed at runtime", () => {
    expect(stagingStacks.foundation.Resources.AgentDnsFirewallProjectAllowList1C0C2230!.Properties).not.toHaveProperty("Domains");
    expect(stagingStacks.foundation.Outputs).toHaveProperty("ProjectAllowListId");
  });

  it("allows Code's default list first, then the install's own AWS hosts, with only the known regional wildcards", () => {
    const domains = installAgentAllowDomains("us-west-2", "123456789012");
    expect(domains.slice(0, DEFAULT_AGENT_ALLOW_DOMAINS.length)).toEqual([...DEFAULT_AGENT_ALLOW_DOMAINS]);
    expect(domains).toContain("123456789012.dkr.ecr.us-west-2.amazonaws.com");
    // No account-wide or GitHub-wide wildcard; the only regional wildcards are the four known residuals the live list carries (INSTALL_AWS_HOSTS).
    expect(domains).not.toContain("*.amazonaws.com");
    expect(domains.filter(isBroadAllowedDomain)).toEqual(["*.s3.us-west-2.amazonaws.com", "*.execute-api.us-west-2.amazonaws.com", "*.us-west-2.elb.amazonaws.com", "*.us-west-2.rds.amazonaws.com"]);
    expect(() => installAgentAllowDomains("not a region")).toThrow(/needs an AWS region/);
  });

  it("adds a valid extra domain from context once, and refuses a broad or malformed one without echoing it", () => {
    expect(parseExtraAllowDomains("artifactory.example.com, github.com ,artifactory.example.com", ["github.com"])).toEqual(["artifactory.example.com"]);
    expect(parseExtraAllowDomains(undefined, [])).toEqual([]);
    for (const bad of ["*.amazonaws.com", "*.s3.amazonaws.com", "https://evil.example/x", 7]) {
      let message = "";
      try {
        parseExtraAllowDomains(bad, []);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, String(bad)).toMatch(new RegExp(`^${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} `));
      if (typeof bad === "string") expect(message).not.toContain(bad);
    }
    const foundation = (context: string) => {
      const app = new App({ context: { [EGRESS_ALLOW_DOMAINS_CONTEXT_KEY]: context } });
      return Template.fromStack(new ProductionFoundationStack(app, "ExtraFoundation", { deploymentRegion: "us-west-2", naming: environmentNaming("staging") }));
    };
    const allow = Object.values(resourcesOf(foundation("pkgs.example.com"), "AWS::Route53Resolver::FirewallDomainList")).find((list) => list.Properties.Name === "agentx-staging-allow");
    expect((allow!.Properties.Domains as unknown[]).at(-1)).toBe("pkgs.example.com");
  });

  it("is not in the legacy production foundation", () => {
    const legacy = Template.fromStack(new ProductionFoundationStack(new App(), "LegacyFoundation", { deploymentRegion: "us-east-1" }));
    for (const type of ["AWS::Route53Resolver::FirewallDomainList", "AWS::Route53Resolver::FirewallRuleGroup", "AWS::Route53Resolver::FirewallRuleGroupAssociation", "AWS::CloudWatch::Alarm", "AWS::Logs::MetricFilter"]) {
      expect(Object.keys(legacy.findResources(type)), type).toEqual([]);
    }
  });
});

describe("the staging artifact bucket keeps the live evidence expiry", () => {
  const bucket = () => stagingStacks.controlPlane.Resources.Artifacts82DD59A1!;

  it("has exactly the live lifecycle rules, so the change set shows no lifecycle change", () => {
    expect((bucket().Properties.LifecycleConfiguration as { Rules: unknown[] }).Rules).toStrictEqual(liveLifecycle);
  });

  it("has no rule shorter than the live rule with the same id", () => {
    const live = new Map(liveLifecycle.map((rule) => [rule.Id, rule.ExpirationInDays as number]));
    for (const rule of (bucket().Properties.LifecycleConfiguration as { Rules: Array<{ Id: string; ExpirationInDays: number }> }).Rules) {
      expect(live.has(rule.Id), rule.Id).toBe(true);
      expect(rule.ExpirationInDays, rule.Id).toBeGreaterThanOrEqual(live.get(rule.Id)!);
    }
  });

  it("does not read a retention setting from context that could shorten a rule", () => {
    const app = new App({ context: { evidenceRetentionDays: JSON.stringify({ "evidence-short": 1, "evidence-std": 7 }) } });
    const template = Template.fromStack(new ControlPlaneStack(app, "ContextControlPlane", { naming: environmentNaming("staging") }));
    const [artifacts] = Object.entries(resourcesOf(template, "AWS::S3::Bucket")).filter(([id]) => /^Artifacts[0-9A-F]{8}$/.test(id)).map(([, resource]) => resource);
    expect((artifacts!.Properties.LifecycleConfiguration as { Rules: unknown[] }).Rules).toStrictEqual(liveLifecycle);
  });
});

describe("the staging broker keeps its fixed names", () => {
  const resources = () => stagingStacks.controlPlane.Resources;

  it("names the role and function as the live install does, under the same logical ids", () => {
    expect(resources().BrokerServiceRole1938BCC9!.Properties).toMatchObject({ RoleName: "agentx-staging-broker-role", Path: "/agentx/staging/" });
    expect(resources().BrokerE1355FD6!.Properties.FunctionName).toBe("agentx-staging-broker");
  });

  it("attaches no managed policy to the broker role and keeps its inline policy under IAM's size limit", () => {
    const managed = Object.values(resources()).filter((resource) => resource.Type === "AWS::IAM::ManagedPolicy"
      && ((resource.Properties.Roles as Array<{ Ref?: string }> | undefined) ?? []).some((role) => role.Ref === "BrokerServiceRole1938BCC9"));
    expect(managed).toEqual([]);
    // Only AWS's own Lambda logging policy, as on the live role; never a customer managed policy.
    expect(resources().BrokerServiceRole1938BCC9!.Properties.ManagedPolicyArns).toStrictEqual([
      { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]] },
    ]);
    const inline = Object.values(resources()).filter((resource) => resource.Type === "AWS::IAM::Policy"
      && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === "BrokerServiceRole1938BCC9"));
    expect(inline.length).toBeGreaterThan(0);
    // IAM's limit is 10,240 characters for all of a role's inline policies together (whitespace not counted); the template form, with its unresolved references, stands in for it.
    const size = inline.reduce((total, policy) => total + JSON.stringify(policy.Properties.PolicyDocument).length, 0);
    expect(size).toBeLessThan(10_240);
  });

  it("leaves the legacy broker's names to CloudFormation", () => {
    const legacy = Template.fromStack(new ControlPlaneStack(new App(), "LegacyBrokerControlPlane"));
    const functions = Object.entries(resourcesOf(legacy, "AWS::Lambda::Function")).filter(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
    expect(functions).toHaveLength(1);
    expect(functions[0]![1].Properties.FunctionName).toBeUndefined();
    const roles = Object.entries(resourcesOf(legacy, "AWS::IAM::Role")).filter(([id]) => /^BrokerServiceRole[0-9A-F]{8}$/.test(id));
    expect(roles[0]![1].Properties.RoleName).toBeUndefined();
  });
});

describe("the health probe's egress-alarm exemption", () => {
  it("covers only the two live egress alarm names; another alarm inside EgressAlarms still fails synthesis", () => {
    const app = new App();
    const stack = new ControlPlaneStack(app, "ExemptionControlPlane", { naming: environmentNaming("staging") });
    const alarms = new EgressAlarms(stack, "EgressAlarms", {
      env: "staging", resourcePrefix: "agentx-staging", natGateways: [],
      dnsFirewallLogGroup: new logs.LogGroup(stack, "QueryLogs"), alertsTopic: new sns.Topic(stack, "Alerts"),
    });
    new cloudwatch.Alarm(alarms, "Extra", { alarmName: "agentx-staging-something-else", metric: new cloudwatch.Metric({ namespace: "X", metricName: "Y" }), threshold: 1, evaluationPeriods: 1 });
    expect(() => app.synth()).toThrow(/health probe does not read alarm .*agentx-staging-something-else/);
  });
});

describe("the default boundary keeps the DNS firewall closed", () => {
  it("denies switching it to fail open, sharing it, and routing DNS around it, in the synthesized access stack", () => {
    const access = buildAgentXApp({ agentxEnv: "staging", agentxRegion: "us-west-2" }).node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-access")!;
    const boundary = Object.values(resourcesOf(Template.fromStack(access), "AWS::IAM::ManagedPolicy"))[0]!;
    const statements = (boundary.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Effect: string; Action: string[] }> }).Statement;
    expect(statements.find((statement) => statement.Sid === "DenyDnsFirewallEscapes")).toMatchObject({ Effect: "Deny", Action: expect.arrayContaining(["route53resolver:UpdateFirewallConfig"]) as unknown });
  });
});
