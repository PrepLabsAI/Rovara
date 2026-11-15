// The staging switch-over parity additions (tests/contract/switchover-parity-infrastructure.test.ts checks each in full against the live staging templates): take them out of a
// synthesized named template, asserting their shape first, so a snapshot that pins "everything else" stays strict.
import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Condition?: { StringLike?: Record<string, unknown> } };
type Template = { Resources: Record<string, Resource>; Outputs?: Record<string, unknown> };

/** Foundation: the DNS firewall (8 resources), the egress alarms (a metric filter, the blocked-lookup alarm and one alarm per NAT gateway) and the ProjectAllowListId output. */
export function withoutDnsFirewall(template: unknown): unknown {
  const synthesized = template as Template;
  const ids = Object.keys(synthesized.Resources).filter((id) => id.startsWith("AgentDnsFirewall") || id.startsWith("EgressAlarms"));
  expect(ids.map((id) => synthesized.Resources[id]!.Type).sort()).toEqual([
    "AWS::CloudWatch::Alarm", "AWS::CloudWatch::Alarm", "AWS::CloudWatch::Alarm", "AWS::Logs::LogGroup", "AWS::Logs::MetricFilter",
    "AWS::Route53Resolver::FirewallDomainList", "AWS::Route53Resolver::FirewallDomainList", "AWS::Route53Resolver::FirewallDomainList",
    "AWS::Route53Resolver::FirewallRuleGroup", "AWS::Route53Resolver::FirewallRuleGroupAssociation",
    "AWS::Route53Resolver::ResolverQueryLoggingConfig", "AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation",
  ]);
  for (const id of ids) delete synthesized.Resources[id];
  expect(synthesized.Outputs?.ProjectAllowListId).toBeDefined();
  delete synthesized.Outputs!.ProjectAllowListId;
  return template;
}

/** Control plane: the four evidence and nightly-map expiry rules after the screenshot rule, and the broker's fixed role and function names. */
export function withoutSwitchoverControlPlaneParity(template: unknown): unknown {
  const synthesized = template as Template;
  const bucketId = Object.keys(synthesized.Resources).find((id) => /^Artifacts[0-9A-F]{8}$/.test(id))!;
  const rules = (synthesized.Resources[bucketId]!.Properties.LifecycleConfiguration as { Rules: Array<{ Id: string }> }).Rules;
  expect(rules.map((rule) => rule.Id)).toEqual(["ExpireE2EScreenshots", "ExpireEvidenceShort", "ExpireEvidenceStd", "ExpireEvidenceRecord", "ExpireNightlyMaps"]);
  rules.splice(1);
  const roleId = Object.keys(synthesized.Resources).find((id) => /^BrokerServiceRole[0-9A-F]{8}$/.test(id))!;
  const functionId = Object.keys(synthesized.Resources).find((id) => /^Broker[0-9A-F]{8}$/.test(id) && synthesized.Resources[id]!.Type === "AWS::Lambda::Function")!;
  const roleName = synthesized.Resources[roleId]!.Properties.RoleName as string;
  expect(roleName).toMatch(/^agentx-[a-z][a-z0-9-]*-broker-role$/);
  expect(synthesized.Resources[functionId]!.Properties.FunctionName).toBe(roleName.replace(/-role$/, ""));
  delete synthesized.Resources[roleId]!.Properties.RoleName;
  delete synthesized.Resources[functionId]!.Properties.FunctionName;
  return template;
}

/** Access: the DnsFirewall and DnsFirewallList statements in the deploy role's policy and the default boundary, the boundary's DenyDnsFirewallEscapes, and route53resolver in their service-linked role lists. */
export function withoutDnsFirewallAccess(template: unknown): unknown {
  const synthesized = template as Template;
  const documents: Array<{ Statement: Statement[] }> = [];
  for (const resource of Object.values(synthesized.Resources)) {
    if (resource.Type === "AWS::IAM::ManagedPolicy") documents.push(resource.Properties.PolicyDocument as { Statement: Statement[] });
    if (resource.Type === "AWS::IAM::Role") for (const policy of (resource.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }> | undefined) ?? []) documents.push(policy.PolicyDocument);
  }
  let firewallDocuments = 0;
  for (const document of documents) {
    const sids = document.Statement.map((statement) => statement.Sid);
    if (!sids.includes("DnsFirewall")) continue;
    firewallDocuments += 1;
    expect(sids.filter((sid) => sid === "DnsFirewall" || sid === "DnsFirewallList")).toEqual(["DnsFirewall", "DnsFirewallList"]);
    document.Statement = document.Statement.filter((statement) => statement.Sid !== "DnsFirewall" && statement.Sid !== "DnsFirewallList" && statement.Sid !== "DenyDnsFirewallEscapes");
    const linked = document.Statement.find((statement) => statement.Sid === "ServiceLinkedRoles")!;
    expect(linked.Condition!.StringLike!["iam:AWSServiceName"]).toEqual(["ecs.amazonaws.com", "route53resolver.amazonaws.com"]);
    linked.Condition!.StringLike!["iam:AWSServiceName"] = ["ecs.amazonaws.com"];
  }
  // The deploy role's inline policy and the default boundary.
  expect(firewallDocuments).toBe(2);
  return template;
}
