// L4-E8I (owner DEC 254zzz62): the infrastructure half of the GCP stand-in pack, named environments only, off by default. What must hold, on the synthesized templates and on the policy documents:
//   1. EGRESS. The worker hosts may pull from Google's image registries gcr.io and us-docker.pkg.dev and nothing else, only while the setting names the `pulled` group: the base allow list's Domains is an Fn::If of itself with
//      and without exactly those two exact names; no new list, rule, priority, endpoint or resolver rule; the block-everything rule stays last. HTTPS only: the worker security group's egress is the one 443 rule it always had.
//   2. THE SEALED BOX. Nothing that gives a box a route out was touched: the security groups' egress, routes, NAT gateways, gateway endpoints, the firewall rule group and the launch template are the ones in the recorded snapshot
//      (named-templates.test.ts: the snapshot passes with only these additions taken out), and the stage's wall code is byte for byte what it was (ec2-test-services-stage.test.ts).
//   3. COPIES. Three ECR repositories (Spanner, fake-gcs-server, BigQuery) in the starter copies' family of names, outside the pull-through prefix; immutable tags, scan on push, AES256, a lifecycle that only ever removes the oldest of
//      more than twenty TAGGED copies; emptied and deleted with the stack. No repository for Google's SDK image, ever.
//   4. IAM. The worker role reads exactly those three repositories with exactly the three ECR read actions, in one statement of its own; the existing prefix read does not reach them (so this is the narrowest addition); no push, delete,
//      pull-through or create. The deploy role and the default boundary allow what CloudFormation does for these resources (checked on the policy documents: a template diff misses the boundary).
//   5. THE SETTING. TestServicesGcpPack, default off, the same values on the foundation and the control plane; packed `gp` for the broker and the dispatcher; one plain variable for the session steps; the legacy deployment has none of it.
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  GCP_PACK_PARAMETER_DEFAULT, GCP_PACK_PARAMETER_VALUES, GCP_PACK_PULL_REGISTRY_HOSTS, GCP_PACK_SETTING_VARIABLE, OWNER_GCP_PACK_IMAGES, defaultBoundaryStatements, environmentPullThroughPrefix, gcpPackGroupsOf,
  gcpPackMirrorRepositories, gcpPackPullsFromSource, serviceRoleStatements, type PolicyStatementJson,
} from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { GCP_PACK_MIRROR_KEEP_TAGGED, GCP_PACK_MIRROR_LIFECYCLE_POLICY, GCP_PACK_MIRROR_READ_SID, TEST_SERVICE_MIRROR_READ_ACTIONS } from "../../infra/lib/test-service-mirror.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string; Condition?: string };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
const resourcesOf = (template: Template) => template.toJSON().Resources as Record<string, Resource>;
const ofType = (template: Template, type: string) => Object.entries(resourcesOf(template)).filter(([, r]) => r.Type === type);
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const repositoryArn = (name: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ecr:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:repository/${name}`]] });
const matches = (pattern: string, action: string): boolean => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "iu").test(action);
/** A plain evaluation for one action on one resource ARN (`*` stands for any): allowed by an Allow statement that names the action and whose resource pattern covers it, and by no Deny that does. No conditions are read. */
function allows(statements: readonly PolicyStatementJson[], action: string, arn = "*"): boolean {
  const covers = (statement: PolicyStatementJson) => [statement.Resource].flat().some((pattern) => matches(String(pattern), arn) || String(pattern) === "*");
  const named = (statement: PolicyStatementJson) => [statement.Action].flat().some((pattern) => matches(String(pattern), action)) && covers(statement);
  if (statements.some((statement) => statement.Effect === "Deny" && named(statement))) return false;
  return statements.some((statement) => statement.Effect === "Allow" && named(statement));
}

describe("the GCP pack's infrastructure (L4-E8I)", () => {
  let foundation: Template;
  let controlPlane: Template;
  let legacy: Template[];

  beforeAll(() => {
    const stacks = stacksOf(buildAgentXApp({ agentxEnv: "staging" }));
    foundation = Template.fromStack(stacks.find((stack) => stack.stackName === "agentx-staging-foundation")!);
    controlPlane = Template.fromStack(stacks.find((stack) => stack.stackName === "agentx-staging-control-plane")!);
    legacy = stacksOf(buildAgentXApp()).map((stack) => Template.fromStack(stack));
  }, 240_000);

  describe("the setting", () => {
    it("is one parameter, off by default, with the same values on the foundation and the control plane: every non-empty combination of the three groups, colon-separated", () => {
      expect(GCP_PACK_PARAMETER_DEFAULT).toBe("off");
      expect([...GCP_PACK_PARAMETER_VALUES]).toEqual(["off", "mirrored", "pulled", "mirrored:pulled", "bigquery", "mirrored:bigquery", "pulled:bigquery", "mirrored:pulled:bigquery"]);
      for (const template of [foundation, controlPlane]) {
        const parameter = (template.toJSON().Parameters as Record<string, Record<string, unknown>>).TestServicesGcpPack!;
        expect(parameter).toMatchObject({ Type: "String", Default: "off", AllowedValues: [...GCP_PACK_PARAMETER_VALUES] });
      }
    });

    it("reads as groups: off is none, and every other value names exactly the groups it spells", () => {
      expect([...gcpPackGroupsOf("off")]).toEqual([]);
      expect([...gcpPackGroupsOf(undefined)]).toEqual([]);
      for (const value of GCP_PACK_PARAMETER_VALUES.slice(1)) expect([...gcpPackGroupsOf(value)].sort(), value).toEqual(value.split(":").sort());
      // The laptop's comma list is the same list.
      expect([...gcpPackGroupsOf("mirrored,pulled")].sort()).toEqual(["mirrored", "pulled"]);
    });

    it("is packed `gp` for the broker and the dispatcher and a plain variable on the session steps, and read as ROVARA_TEST_SERVICES_GCP_PACK", () => {
      expect(GCP_PACK_SETTING_VARIABLE).toBe("ROVARA_TEST_SERVICES_GCP_PACK");
      const functions = ofType(controlPlane, "AWS::Lambda::Function");
      const packed = (pattern: RegExp) => functions.filter(([id]) => pattern.test(id)).map(([, fn]) => (fn.Properties.Environment as { Variables: Record<string, { "Fn::Join": [string, unknown[]] }> }).Variables.AGENTX_SETTINGS!["Fn::Join"][1]);
      for (const parts of [...packed(/^Broker[0-9A-F]{8}$/u), ...packed(/^Dispatcher[0-9A-F]{8}$/u)]) {
        const at = parts.findIndex((part) => /^,?gp=$/u.test(String(part)));
        expect(at).toBeGreaterThan(-1);
        expect(parts[at + 1]).toEqual({ Ref: "TestServicesGcpPack" });
      }
      expect(packed(/^Broker[0-9A-F]{8}$/u)).toHaveLength(1);
      expect(packed(/^Dispatcher[0-9A-F]{8}$/u)).toHaveLength(1);
      const plain = functions.filter(([, fn]) => (fn.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables?.[GCP_PACK_SETTING_VARIABLE] !== undefined);
      expect(plain).toHaveLength(1);
      expect((plain[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables[GCP_PACK_SETTING_VARIABLE]).toEqual({ Ref: "TestServicesGcpPack" });
    });

    it("the legacy deployment has none of it: no parameter, no condition, no registry, no repository, no statement", () => {
      for (const template of legacy) {
        const text = JSON.stringify(template.toJSON());
        for (const word of ["TestServicesGcpPack", "GcpPack", "gcr.io", "pkg.dev", "gcp-pack", "ROVARA_TEST_SERVICES_GCP_PACK"]) expect(text, word).not.toContain(word);
      }
    });
  });

  describe("egress: Google's two image registries, only while `pulled` is on", () => {
    const allowList = () => ofType(foundation, "AWS::Route53Resolver::FirewallDomainList").find(([, list]) => list.Properties.Name === "agentx-staging-allow")![1];

    it("the egress hosts are exactly gcr.io and us-docker.pkg.dev: exact names, no wildcard, no storage host", () => {
      expect([...GCP_PACK_PULL_REGISTRY_HOSTS]).toEqual(["gcr.io", "us-docker.pkg.dev"]);
      for (const host of GCP_PACK_PULL_REGISTRY_HOSTS) expect(host).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/u);
      // Every source-pulled pack image comes from one of them (a new image on another host cannot be pulled without this list being reviewed).
      for (const image of OWNER_GCP_PACK_IMAGES.filter((entry) => entry.distribution === "pulled_from_source")) expect(GCP_PACK_PULL_REGISTRY_HOSTS).toContain(image.reference.split("/")[0]);
    });

    it("the base allow list is an Fn::If of itself with and without exactly those two names, under one condition", () => {
      const [condition, on, off] = (allowList().Properties.Domains as { "Fn::If": [string, string[], string[]] })["Fn::If"];
      expect(condition).toBe("GcpPackPullsFromSource");
      expect(on).toEqual([...off, "gcr.io", "us-docker.pkg.dev"]);
      expect(off.some((domain) => /(^|\.)gcr\.io$|(^|\.)pkg\.dev$|^\*$/u.test(domain))).toBe(false);
      expect(on.slice(off.length)).toEqual([...GCP_PACK_PULL_REGISTRY_HOSTS]);
    });

    it("the condition is true for exactly the values that name `pulled`, and no other", () => {
      const conditions = (foundation.toJSON().Conditions as Record<string, { "Fn::Or": Array<{ "Fn::Equals": [{ Ref: string }, string] }> }>);
      expect(Object.keys(conditions)).toContain("GcpPackPullsFromSource");
      const equals = conditions.GcpPackPullsFromSource!["Fn::Or"].map((each) => { expect(each["Fn::Equals"][0]).toEqual({ Ref: "TestServicesGcpPack" }); return each["Fn::Equals"][1]; });
      expect(equals.sort()).toEqual([...GCP_PACK_PARAMETER_VALUES].filter((value) => gcpPackPullsFromSource(value)).sort());
      expect(equals.sort()).toEqual(["mirrored:pulled", "mirrored:pulled:bigquery", "pulled", "pulled:bigquery"]);
      // `mirrored` (ECR, already reachable) and `bigquery` alone open nothing.
      for (const value of ["off", "mirrored", "bigquery", "mirrored:bigquery"]) expect(equals).not.toContain(value);
    });

    it("adds no list, rule, priority, endpoint or resolver rule: the rule group is allow base (100), allow project (150), block everything (200), and the firewall still fails closed", () => {
      expect(ofType(foundation, "AWS::Route53Resolver::FirewallDomainList").map(([, list]) => list.Properties.Name).sort()).toEqual(["agentx-staging-allow", "agentx-staging-block-all", "agentx-staging-project-allow"]);
      const group = ofType(foundation, "AWS::Route53Resolver::FirewallRuleGroup")[0]![1];
      expect((group.Properties.FirewallRules as Array<{ Priority: number; Action: string }>).map((rule) => [rule.Priority, rule.Action])).toEqual([[100, "ALLOW"], [150, "ALLOW"], [200, "BLOCK"]]);
      for (const type of ["AWS::Route53Resolver::ResolverEndpoint", "AWS::Route53Resolver::ResolverRule", "AWS::Route53Resolver::ResolverRuleAssociation", "AWS::Route53Resolver::FirewallConfig"]) expect(ofType(foundation, type), type).toEqual([]);
      expect(JSON.stringify(group.Properties.FirewallRules)).not.toContain("GcpPack");
    });

    it("is HTTPS only, from the worker host: the worker security group's egress is the one 443 rule it always had", () => {
      const worker = ofType(foundation, "AWS::EC2::SecurityGroup").find(([, group]) => group.Properties.GroupName === "agentx-staging-ec2-workers")![1];
      expect(worker.Properties.SecurityGroupEgress).toEqual([{ CidrIp: "0.0.0.0/0", Description: "HTTPS to ECR, Bedrock, CloudWatch, the control plane, package repositories and Git providers", FromPort: 443, IpProtocol: "tcp", ToPort: 443 }]);
      // Every security group's egress in the stack is TCP 443 to anywhere, or the worker port to another group: nothing with another port, protocol or range, and nothing was added for the registries.
      for (const [id, group] of ofType(foundation, "AWS::EC2::SecurityGroup")) for (const rule of asList(group.Properties.SecurityGroupEgress ?? []) as Array<Record<string, unknown>>) expect([rule.IpProtocol, rule.FromPort, rule.ToPort, rule.CidrIp], id).toEqual(["tcp", 443, 443, "0.0.0.0/0"]);
      for (const [id, rule] of ofType(foundation, "AWS::EC2::SecurityGroupEgress")) expect([rule.Properties.IpProtocol, rule.Properties.FromPort, rule.Properties.ToPort], id).toEqual(["tcp", 8080, 8080]);
      expect(ofType(foundation, "AWS::EC2::SecurityGroupEgress").every(([, rule]) => rule.Properties.CidrIp === undefined)).toBe(true);
    });

    it("the sealed box's network is untouched: the foundation's routes, gateways, endpoints and address allocations are the ones it had (and the snapshot test passes with only this lane's additions taken out)", () => {
      const count = (type: string) => ofType(foundation, type).length;
      expect([count("AWS::EC2::VPC"), count("AWS::EC2::InternetGateway"), count("AWS::EC2::NatGateway"), count("AWS::EC2::EIP"), count("AWS::EC2::Route"), count("AWS::EC2::RouteTable"), count("AWS::EC2::VPCEndpoint"), count("AWS::EC2::SecurityGroup"), count("AWS::EC2::SecurityGroupEgress"), count("AWS::EC2::SecurityGroupIngress"), count("AWS::EC2::LaunchTemplate"), count("AWS::EC2::NetworkAcl")]).toEqual([1, 1, 2, 2, 4, 4, 1, 3, 2, 2, 1, 0]);
      // The one gateway endpoint is S3's, as it was; the routes are the two public default routes (to the internet gateway) and the two private ones (to the NAT gateways).
      expect(ofType(foundation, "AWS::EC2::VPCEndpoint").map(([, endpoint]) => endpoint.Properties.VpcEndpointType)).toEqual(["Gateway"]);
      expect(ofType(foundation, "AWS::EC2::Route").map(([, route]) => Object.keys(route.Properties).filter((key) => key.endsWith("Id") && key !== "RouteTableId").join(",")).sort()).toEqual(["GatewayId", "GatewayId", "NatGatewayId", "NatGatewayId"]);
    });
  });

  describe("the three image copies", () => {
    const repositories = () => ofType(foundation, "AWS::ECR::Repository").filter(([id]) => id.includes("GcpPackRepository"));

    it("names three repositories, one per mirrorable image, in the starter copies' family of names and outside every pull-through prefix", () => {
      const mirrors = gcpPackMirrorRepositories("staging");
      expect(mirrors.map((mirror) => mirror.repositoryName)).toEqual([
        "agentx-staging--test-services/spanner-1.5.59/spanner", "agentx-staging--test-services/gcs-1.56.1/gcs", "agentx-staging--test-services/bigquery-0.8.1/bigquery",
      ]);
      expect(mirrors.map((mirror) => mirror.image.distribution)).toEqual(["mirrored", "mirrored", "mirrored"]);
      for (const mirror of mirrors) {
        expect(mirror.repositoryName.startsWith(`${environmentPullThroughPrefix("staging")}/`)).toBe(false);
        expect(mirror.repositoryName.split("/")[0]).toBe("agentx-staging--test-services");
        expect(mirror.tag).toBe(`${mirror.image.version}-${mirror.digest.slice(0, 12)}`);
      }
      // Google's SDK image is never copied: no repository for it, whatever its family.
      expect(mirrors.map((mirror) => mirror.image.family).sort()).toEqual(["bigquery", "gcs", "spanner"]);
      expect(() => gcpPackMirrorRepositories("Staging")).toThrow();
    });

    it("creates exactly those three: immutable tags, scan on push, AES256, the tagged-only lifecycle, emptied and deleted with the stack", () => {
      expect(repositories().map(([, repository]) => repository.Properties.RepositoryName)).toEqual(gcpPackMirrorRepositories("staging").map((mirror) => mirror.repositoryName));
      for (const [id, repository] of repositories()) {
        expect(repository.Properties.ImageTagMutability, id).toBe("IMMUTABLE");
        expect(repository.Properties.ImageScanningConfiguration, id).toEqual({ ScanOnPush: true });
        expect(repository.Properties.EncryptionConfiguration, id).toEqual({ EncryptionType: "AES256" });
        expect(repository.Properties.LifecyclePolicy, id).toEqual({ LifecyclePolicyText: GCP_PACK_MIRROR_LIFECYCLE_POLICY });
        expect(repository.Properties.EmptyOnDelete, id).toBe(true);
        expect(repository.Properties, id).not.toHaveProperty("RepositoryPolicyText");
        // Not kept: one more retained resource would push the destroy inventory over SSM's limit (destroy-inventory-size.test.ts).
        expect(repository.DeletionPolicy, id).toBeUndefined();
      }
      expect(ofType(foundation, "AWS::ECR::Repository")).toHaveLength(8);
      expect(JSON.stringify(ofType(foundation, "AWS::ECR::Repository"))).not.toMatch(/cloudsdktool|google-cloud-cli|pubsub|firestore|datastore|bigtable/u);
    });

    it("the lifecycle rule can only remove the oldest of more than twenty TAGGED copies: no rule on untagged images (a multi-platform copy's platform images are untagged in ECR), no age rule", () => {
      const policy = JSON.parse(GCP_PACK_MIRROR_LIFECYCLE_POLICY) as { rules: Array<{ selection: Record<string, unknown>; action: { type: string } }> };
      expect(policy.rules).toHaveLength(1);
      expect(policy.rules[0]!.selection).toEqual({ tagStatus: "tagged", tagPatternList: ["*"], countType: "imageCountMoreThan", countNumber: GCP_PACK_MIRROR_KEEP_TAGGED });
      expect(GCP_PACK_MIRROR_KEEP_TAGGED).toBe(20);
      expect(policy.rules[0]!.action).toEqual({ type: "expire" });
      expect(JSON.stringify(policy.rules)).not.toMatch(/"untagged"|sinceImagePushed/u);
    });
  });

  describe("the worker role's read", () => {
    const workerStatements = (): Statement[] => ofType(foundation, "AWS::IAM::Policy").filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes("InstanceRole"))
      .flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement);

    it("reads exactly the three copies with exactly the three ECR read actions, in one statement of its own", () => {
      const read = workerStatements().filter((statement) => statement.Sid === GCP_PACK_MIRROR_READ_SID);
      expect(read).toHaveLength(1);
      expect(read[0]).toEqual({ Sid: "GcpPackImageRead", Effect: "Allow", Action: [...TEST_SERVICE_MIRROR_READ_ACTIONS], Resource: gcpPackMirrorRepositories("staging").map((mirror) => repositoryArn(mirror.repositoryName)) });
      expect([...TEST_SERVICE_MIRROR_READ_ACTIONS]).toEqual(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]);
    });

    it("is the narrowest addition: the existing prefix read does not reach the copies, so without this statement the worker could not pull them", () => {
      const prefixRead = workerStatements().find((statement) => statement.Sid === "EcrImageAccess")!;
      expect(JSON.stringify(prefixRead.Resource)).toContain(`:repository/${environmentPullThroughPrefix("staging")}/*`);
      for (const mirror of gcpPackMirrorRepositories("staging")) expect(mirror.repositoryName.startsWith(`${environmentPullThroughPrefix("staging")}/`)).toBe(false);
      // No wildcard repository anywhere new, and nothing else names a copy.
      const others = workerStatements().filter((statement) => statement.Sid !== "TestServiceImageRead" && statement.Sid !== GCP_PACK_MIRROR_READ_SID && JSON.stringify(statement.Resource).includes("test-services"));
      expect(others).toEqual([]);
      expect(JSON.stringify(workerStatements().find((statement) => statement.Sid === GCP_PACK_MIRROR_READ_SID)!.Resource)).not.toContain("*");
    });

    it("the role has no write, delete, import or create on ECR beyond what it had (the pull-through statement, on the prefix only), and no Google registry or credential anywhere", () => {
      const ecr = workerStatements().filter((statement) => asList(statement.Action).some((action) => String(action).startsWith("ecr:")));
      expect(ecr.map((statement) => statement.Sid).sort()).toEqual(["EcrImageAccess", "EcrPullThroughCache", "EcrTokenAccess", "GcpPackImageRead", "TestServiceImageRead"]);
      for (const statement of ecr.filter((entry) => entry.Sid === "GcpPackImageRead" || entry.Sid === "TestServiceImageRead")) {
        for (const action of asList(statement.Action)) expect(action, `${String(statement.Sid)}: ${String(action)}`).toMatch(/^ecr:(BatchCheckLayerAvailability|BatchGetImage|GetDownloadUrlForLayer)$/u);
      }
      expect(JSON.stringify(workerStatements())).not.toMatch(/gcr\.io|pkg\.dev|google|artifactregistry/iu);
    });

    it("the deploy role and the default boundary allow what CloudFormation does for these resources, and the worker role's new statement is inside the boundary; the DNS firewall escapes stay denied", () => {
      const scope = { env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", artifactBucketArn: "arn:aws:s3:::bucket", pullThroughPrefix: "agentx-staging", cloudFormationRoleName: "agentx-staging-cloudformation" };
      const deploy = serviceRoleStatements(scope);
      const boundary = defaultBoundaryStatements(scope);
      // ECR: create with a lifecycle policy, scan and encryption settings and tags, and the emptying a stack delete does (EmptyOnDelete).
      const ecrActions = ["ecr:CreateRepository", "ecr:DeleteRepository", "ecr:DescribeRepositories", "ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:DeleteLifecyclePolicy", "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability",
        "ecr:TagResource", "ecr:UntagResource", "ecr:ListTagsForResource", "ecr:ListImages", "ecr:BatchDeleteImage"];
      // The allow list's change is an update of an existing domain list.
      const dnsActions = ["route53resolver:UpdateFirewallDomains", "route53resolver:ListFirewallDomains", "route53resolver:GetFirewallDomainList"];
      const ecrArn = "arn:aws:ecr:us-west-2:111122223333:repository/agentx-staging--test-services/spanner-1.5.59/spanner";
      const listArn = "arn:aws:route53resolver:us-west-2:111122223333:firewall-domain-list/rslvr-fdl-0123456789abcdef";
      for (const action of ecrActions) {
        expect(allows(deploy, action, ecrArn), `deploy role: ${action}`).toBe(true);
        expect(allows(boundary, action, ecrArn), `boundary: ${action}`).toBe(true);
      }
      for (const action of dnsActions) {
        expect(allows(deploy, action, listArn), `deploy role: ${action}`).toBe(true);
        expect(allows(boundary, action, listArn), `boundary: ${action}`).toBe(true);
        // On another account's list, or in another region, it is not (the statement is this account and region only).
        expect(allows(deploy, action, listArn.replace("111122223333", "999999999999")) && !action.includes("List"), `deploy role, another account: ${action}`).toBe(false);
      }
      for (const action of [...TEST_SERVICE_MIRROR_READ_ACTIONS, "ecr:GetAuthorizationToken"]) expect(allows(boundary, action, ecrArn), `boundary: ${action}`).toBe(true);
      // Nothing about the escapes changed: no role may fail the firewall open, share it or route DNS around it.
      for (const action of ["route53resolver:UpdateFirewallConfig", "route53resolver:PutResolverQueryLogConfigPolicy", "route53resolver:CreateResolverEndpoint", "route53resolver:CreateResolverRule", "route53resolver:AssociateResolverRule"]) {
        // The deploy role is itself bounded: an action is allowed only if both documents allow it, and the boundary denies these whatever the role allows.
        expect(allows(deploy, action, listArn) && allows(boundary, action, listArn), `deploy role within the boundary: ${action}`).toBe(false);
        expect(allows(boundary, action, listArn), `boundary: ${action}`).toBe(false);
      }
      // The deploy role's resolver actions are on this account and region only, as before.
      expect(deploy.find((statement) => statement.Sid === "DnsFirewall")?.Resource).toBe("arn:aws:route53resolver:us-west-2:111122223333:*");
    });
  });
});
