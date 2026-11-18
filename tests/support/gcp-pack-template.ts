// L4-E8I (owner DEC 254zzz62): the GCP pack's additions to a named environment's templates, taken out of a synthesized template with their shape asserted first, so the snapshot that pins "everything else" keeps its
// recorded value (the rule-D proof: nothing else in the foundation, the VPC, its security groups, its routes, or the control plane moved). The additions are checked in full by tests/contract/gcp-pack-infrastructure.test.ts.
import { expect } from "vitest";
import { GCP_PACK_PARAMETER_VALUES, GCP_PACK_PULL_REGISTRY_HOSTS, GCP_PACK_SETTING_VARIABLE, gcpPackMirrorRepositories } from "@agentx/contracts";
import { removePackedPieces } from "./broker-environment-template.js";

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Template = { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };
type Statement = { Sid?: string };

/**
 * Foundation (named): the TestServicesGcpPack parameter (off by default) and its one condition (the `pulled` group is on); the allow list's Domains as an Fn::If that adds exactly gcr.io and us-docker.pkg.dev under that condition; the three pack image repositories; and the worker role's GcpPackImageRead statement. Nothing else.
 */
export function withoutGcpPackFoundation<T>(template: T, env = "staging"): T {
  const synthesized = template as unknown as Template;
  expect(synthesized.Parameters?.TestServicesGcpPack).toMatchObject({ Type: "String", Default: "off", AllowedValues: [...GCP_PACK_PARAMETER_VALUES] });
  delete synthesized.Parameters!.TestServicesGcpPack;
  expect(Object.keys(synthesized.Conditions ?? {}).filter((id) => id.startsWith("GcpPack"))).toEqual(["GcpPackPullsFromSource"]);
  delete synthesized.Conditions!.GcpPackPullsFromSource;
  if (Object.keys(synthesized.Conditions!).length === 0) delete synthesized.Conditions;
  const entries = Object.entries(synthesized.Resources);
  const lists = entries.filter(([, resource]) => resource.Type === "AWS::Route53Resolver::FirewallDomainList");
  // No new list, rule or priority: the base allow list's Domains is an Fn::If of itself with and without the two registries, and nothing else about the firewall changes.
  expect(lists.map(([, resource]) => resource.Properties.Name).sort()).toEqual([`agentx-${env}-allow`, `agentx-${env}-block-all`, `agentx-${env}-project-allow`]);
  const allow = lists.find(([, resource]) => resource.Properties.Name === `agentx-${env}-allow`)![1];
  const domains = allow.Properties.Domains as { "Fn::If": [string, string[], string[]] };
  expect(Object.keys(domains)).toEqual(["Fn::If"]);
  const [condition, on, off] = domains["Fn::If"];
  expect(condition).toBe("GcpPackPullsFromSource");
  expect(on).toEqual([...off, ...GCP_PACK_PULL_REGISTRY_HOSTS]);
  expect(off.some((domain) => GCP_PACK_PULL_REGISTRY_HOSTS.includes(domain))).toBe(false);
  allow.Properties.Domains = off;
  const groups = Object.values(synthesized.Resources).filter((resource) => resource.Type === "AWS::Route53Resolver::FirewallRuleGroup");
  expect(groups).toHaveLength(1);
  expect(JSON.stringify(groups[0]!.Properties.FirewallRules)).not.toContain("GcpPack");
  const repositories = entries.filter(([id]) => id.includes("GcpPackRepository"));
  expect(repositories.map(([, resource]) => resource.Type)).toEqual(["AWS::ECR::Repository", "AWS::ECR::Repository", "AWS::ECR::Repository"]);
  expect(repositories.map(([, resource]) => resource.Properties.RepositoryName)).toEqual(gcpPackMirrorRepositories(env).map((mirror) => mirror.repositoryName));
  for (const [id] of repositories) delete synthesized.Resources[id];
  const workerPolicies = Object.values(synthesized.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes("InstanceRole"));
  let removed = 0;
  for (const policy of workerPolicies) {
    const document = policy.Properties.PolicyDocument as { Statement: Statement[] };
    const kept = document.Statement.filter((statement) => statement.Sid !== "GcpPackImageRead");
    removed += document.Statement.length - kept.length;
    document.Statement = kept;
  }
  expect(removed).toBe(1);
  return template;
}

/**
 * Control plane (named): the TestServicesGcpPack parameter (off by default), its packed piece `gp` on the broker and the dispatcher, and its one plain variable on the session steps function.
 */
export function withoutGcpPackControlPlane<T>(template: T): T {
  const synthesized = template as unknown as Template;
  expect(synthesized.Parameters?.TestServicesGcpPack).toMatchObject({ Type: "String", Default: "off", AllowedValues: [...GCP_PACK_PARAMETER_VALUES] });
  delete synthesized.Parameters!.TestServicesGcpPack;
  const functions = (pattern: RegExp) => Object.entries(synthesized.Resources).filter(([id, resource]) => pattern.test(id) && resource.Type === "AWS::Lambda::Function");
  for (const [id, fn] of [...functions(/^Broker[0-9A-F]{8}$/u), ...functions(/^Dispatcher[0-9A-F]{8}$/u)]) {
    const variables = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    const join = (variables.AGENTX_SETTINGS as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
    expect(join[1].filter((part) => /^,?gp=$/u.test(String(part))), id).toHaveLength(1);
    expect(join[1][join[1].findIndex((part) => /^,?gp=$/u.test(String(part))) + 1], id).toEqual({ Ref: "TestServicesGcpPack" });
    removePackedPieces(variables, "AGENTX_SETTINGS", ["gp"]);
  }
  const steps = Object.values(synthesized.Resources).filter((resource) => resource.Type === "AWS::Lambda::Function" && (resource.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables?.[GCP_PACK_SETTING_VARIABLE] !== undefined);
  // The broker and the dispatcher carry it packed, never plain: only the session steps function has the plain variable.
  expect(steps).toHaveLength(1);
  const variables = (steps[0]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(variables[GCP_PACK_SETTING_VARIABLE]).toEqual({ Ref: "TestServicesGcpPack" });
  delete variables[GCP_PACK_SETTING_VARIABLE];
  return template;
}
