import { createHash } from "node:crypto";
import { Stack, type App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { API_ADDRESS_CONTEXT_KEY, ApiAddressStack, apiAddressNames, assertApiAddressDomain } from "../../infra/lib/api-address.js";
import { API_ADDRESS_DOMAIN_MAX_LENGTH, LEGACY_ADDRESS_STACK_NAME, PUBLIC_API_ORIGIN_OUTPUT, publicApiAddressStackName } from "@agentx/contracts";
import { legacyNaming } from "../../infra/lib/naming.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties?: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };

const stacksOf = (app: App): Stack[] => app.node.children.filter((child): child is Stack => Stack.isStack(child));
const addressStackOf = (app: App): Stack => {
  const stack = stacksOf(app).find((candidate) => candidate instanceof ApiAddressStack);
  if (stack === undefined) throw new Error("no address stack");
  return stack;
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The two layouts, each with the address its real install would use: the deployment that predates environments is production, a named environment here is beta.
const LEGACY = { context: { [API_ADDRESS_CONTEXT_KEY]: "api.example.com" }, stackName: "AgentXApiAddress", topic: "AgentXApiAddressAlerts", alarm: "AgentXApiAddressCertificateExpiry", origin: "https://api.example.com" };
const NAMED = { context: { agentxEnv: "beta", [API_ADDRESS_CONTEXT_KEY]: "api.beta.example.com" }, stackName: "agentx-beta-address", topic: "agentx-beta-address-alerts", alarm: "agentx-beta-address-cert-expiry", origin: "https://api.beta.example.com" };

// The new stack's full templates are pinned (a change to either is a reviewed change to a long-lived, hand-deployed stack). To re-pin, run this file and read the hash from the failure.
const ADDRESS_TEMPLATE_PINS = {
  legacy: "ebde7054f722dfd6b112c021d1b91c18cce0faa9c25212bbe972339d9fb54500",
  named: "6d831245a3d2522284a4597990ad668e9ce252bcb770b360a793aebcb42a0dbd",
};

describe.each([
  ["legacy", LEGACY],
  ["named", NAMED],
] as const)("the address stack, %s layout", (layout, setup) => {
  const app = buildAgentXApp(setup.context);
  const stack = addressStackOf(app);
  const template = Template.fromStack(stack);
  const resources = template.toJSON().Resources as Record<string, Resource>;
  const domain = setup.context[API_ADDRESS_CONTEXT_KEY];

  it("is named for its layout (the shared contracts names) and has termination protection on", () => {
    expect(stack.stackName).toBe(setup.stackName);
    expect(publicApiAddressStackName(layout === "legacy" ? undefined : "beta")).toBe(setup.stackName);
    expect(LEGACY_ADDRESS_STACK_NAME).toBe("AgentXApiAddress");
    expect(setup.origin).toBeDefined();
    template.hasOutput(PUBLIC_API_ORIGIN_OUTPUT, { Value: setup.origin });
    expect(stack.terminationProtection).toBe(true);
    expect(apiAddressNames(layout === "legacy" ? legacyNaming() : { env: "beta" }).stackName).toBe(setup.stackName);
  });

  it("has a DNS-validated certificate, a regional TLS 1.2 domain and one mapping onto $default, with the API id as the only parameter", () => {
    template.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: domain, ValidationMethod: "DNS" });
    template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainName: domain,
      DomainNameConfigurations: [{ CertificateArn: { Ref: "Certificate" }, EndpointType: "REGIONAL", SecurityPolicy: "TLS_1_2" }],
    });
    template.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::ApiMapping", { ApiId: { Ref: "ApiId" }, DomainName: { Ref: "Domain" }, Stage: "$default" });
    const parameters = Object.keys(template.toJSON().Parameters as Record<string, unknown>).filter((name) => name !== "BootstrapVersion");
    expect(parameters).toEqual(["ApiId"]);
    template.hasParameter("ApiId", { Type: "String", AllowedPattern: "^[a-z0-9]{10}$" });
    expect((template.toJSON().Parameters as Record<string, unknown>).ApiId).not.toHaveProperty("Default");
    // The domain is baked in, never a parameter: a long-lived stack cannot be re-addressed by a stray value.
    expect(JSON.stringify(resources)).not.toContain('"Ref":"DomainName"');
  });

  it("keeps the certificate and the domain name when the stack is deleted or they are replaced", () => {
    for (const logicalId of ["Certificate", "Domain"]) {
      const resource = resources[logicalId]!;
      expect(resource.UpdateReplacePolicy, logicalId).toBe("Retain");
      // Named environments turn Retain into RetainExceptOnCreate (retention.ts), so a failed first create (a validation record never added) cleans up and a retry does not clash on the fixed domain name.
      expect(resource.DeletionPolicy, logicalId).toBe(layout === "legacy" ? "Retain" : "RetainExceptOnCreate");
    }
    expect(resources.Mapping!.DeletionPolicy).toBeUndefined();
  });

  it("outputs the origin the pipeline consumes, the alias record's target, the mapped API and the certificate lookup", () => {
    template.hasOutput("PublicApiOrigin", { Value: setup.origin });
    // The origin is exactly what the control plane's PublicApiUrl accepts: an https origin with no path and no trailing slash.
    expect(setup.origin).toMatch(/^https:\/\/[^/\s]+$/u);
    template.hasOutput("PublicApiDomain", { Value: domain });
    template.hasOutput("RegionalDomainName", { Value: { "Fn::GetAtt": ["Domain", "RegionalDomainName"] } });
    template.hasOutput("RegionalHostedZoneId", { Value: { "Fn::GetAtt": ["Domain", "RegionalHostedZoneId"] } });
    template.hasOutput("MappedApiId", { Value: { Ref: "ApiId" } });
    template.hasOutput("CertificateArn", { Value: { Ref: "Certificate" } });
    template.hasOutput("AlertsTopicArn", { Value: Match.anyValue() });
    // CloudFormation cannot output the validation CNAME (the certificate has no attribute for it): the output is the exact lookup that prints it.
    const lookup = JSON.stringify((template.toJSON().Outputs as Record<string, { Value: unknown }>).CertificateValidationRecordsCommand!.Value);
    expect(lookup).toContain("aws acm describe-certificate");
    expect(lookup).toContain('{"Ref":"Certificate"}');
    expect(lookup).toContain("DomainValidationOptions[].ResourceRecord");
  });

  it("alarms on the certificate's DaysToExpiry to a topic this stack owns, and only this stack's alarm may publish to it", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: setup.alarm,
      Namespace: "AWS/CertificateManager",
      MetricName: "DaysToExpiry",
      Dimensions: [{ Name: "CertificateArn", Value: { Ref: "Certificate" } }],
      Statistic: "Minimum",
      Period: 86400,
      EvaluationPeriods: 1,
      Threshold: 45,
      ComparisonOperator: "LessThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: Match.stringLikeRegexp("^AddressAlerts") }],
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties("AWS::SNS::Topic", { TopicName: setup.topic });
    // No other resource in the stack points at a topic the control plane owns.
    expect(JSON.stringify(template.toJSON())).not.toContain("OperatorAlerts");
    const policy = Object.values(resources).find((resource) => resource.Type === "AWS::SNS::TopicPolicy")!;
    const statements = (policy.Properties as { PolicyDocument: { Statement: Array<{ Effect: string; Principal: unknown; Action: string; Condition?: Record<string, unknown> }> } }).PolicyDocument.Statement;
    const allows = statements.filter((statement) => statement.Effect === "Allow");
    expect(allows).toHaveLength(1);
    expect(allows[0]!.Principal).toEqual({ Service: "cloudwatch.amazonaws.com" });
    expect(allows[0]!.Action).toBe("sns:Publish");
    expect(Object.keys(allows[0]!.Condition ?? {}).sort()).toEqual(["ArnLike", "StringEquals"]);
    expect(statements.some((statement) => statement.Effect === "Deny" && JSON.stringify(statement.Condition) === '{"Bool":{"aws:SecureTransport":"false"}}')).toBe(true);
  });

  it("owns nothing the control plane owns: no role, policy, Lambda, secret, DNS record or hosted zone", () => {
    expect(Object.values(resources).map((resource) => resource.Type).sort()).toEqual([
      "AWS::ApiGatewayV2::ApiMapping",
      "AWS::ApiGatewayV2::DomainName",
      "AWS::CertificateManager::Certificate",
      "AWS::CloudWatch::Alarm",
      "AWS::SNS::Topic",
      "AWS::SNS::TopicPolicy",
    ]);
    expect(JSON.stringify(template.toJSON())).not.toContain("Route53");
    // No import of anything the control plane exports.
    expect(JSON.stringify(template.toJSON())).not.toContain("Fn::ImportValue");
  });

  it("is pinned", () => {
    expect(hash(normalizedTemplate(stack)), `the ${layout} address stack's template`).toBe(ADDRESS_TEMPLATE_PINS[layout]);
  });
});

describe("the address stack is opt-in and changes no other template", () => {
  it("is not created unless the context names a domain", () => {
    expect(stacksOf(buildAgentXApp()).some((stack) => stack instanceof ApiAddressStack)).toBe(false);
    expect(stacksOf(buildAgentXApp({ agentxEnv: "beta" })).some((stack) => stack instanceof ApiAddressStack)).toBe(false);
  });

  it.each([
    ["legacy", {}, LEGACY.context],
    ["named", { agentxEnv: "beta" }, NAMED.context],
  ] as const)("adds exactly one stack to the %s app and leaves every other stack's template as it was", (layout, without, withAddress) => {
    const before = stacksOf(buildAgentXApp(without));
    const after = stacksOf(buildAgentXApp(withAddress));
    const added = after.filter((stack) => !before.some((old) => old.stackName === stack.stackName));
    expect(added.map((stack) => stack.stackName)).toEqual([layout === "legacy" ? "AgentXApiAddress" : "agentx-beta-address"]);
    const unchanged = after.filter((stack) => !added.includes(stack));
    expect(unchanged.map((stack) => stack.stackName)).toEqual(before.map((stack) => stack.stackName));
    for (const stack of unchanged) {
      const old = before.find((candidate) => candidate.stackName === stack.stackName)!;
      expect(hash(normalizedTemplate(stack)), `${stack.stackName} must be byte-identical with the address stack on`).toBe(hash(normalizedTemplate(old)));
    }
  }, 300_000);

  it("coexists with the hand-deployed beta domain stack (kept unchanged until its retirement): both can be in one app, as different stacks with no shared name", () => {
    const app = buildAgentXApp({ agentxBetaDomain: "enabled", [API_ADDRESS_CONTEXT_KEY]: "api.beta.example.com" });
    const names = stacksOf(app).map((stack) => stack.stackName);
    expect(names).toContain("AgentXBetaDomain");
    expect(names).toContain("AgentXApiAddress");
    expect(new Set(names).size).toBe(names.length);
    const betaDomain = JSON.stringify(Template.fromStack(stacksOf(app).find((stack) => stack.stackName === "AgentXBetaDomain")!).toJSON());
    expect(betaDomain).not.toContain("api.beta.example.com");
    expect(betaDomain).not.toContain("AWS::CloudWatch::Alarm");
  }, 120_000);

  it.each(["", "API.example.com", "api", "*.example.com", "api.example.com.", "-api.example.com", "api-.example.com", "https://api.example.com", "api.example.com/x", "api example.com", `${"a".repeat(64)}.example.com`])(
    "refuses the domain %j",
    (domain) => {
      expect(() => assertApiAddressDomain(domain)).toThrow(/must be a lowercase host name/u);
      expect(() => buildAgentXApp({ [API_ADDRESS_CONTEXT_KEY]: domain })).toThrow(/must be a lowercase host name/u);
    },
  );

  it.each(["api.example.com", "api.beta.example.com", "a1.b-2.example.com"])("accepts the domain %j", (domain) => {
    expect(() => assertApiAddressDomain(domain)).not.toThrow();
  });

  it("derives the stack name from a valid environment only", () => {
    for (const env of ["", "Beta", "a--b", "connectors"]) expect(() => publicApiAddressStackName(env), env).toThrow();
  });

  it("caps the domain at 64 characters, the control plane's PublicApiUrl host limit, so the origin it outputs is never one the pipeline refuses", () => {
    const longest = `${"a".repeat(40)}.${"b".repeat(23)}`;
    expect(API_ADDRESS_DOMAIN_MAX_LENGTH).toBe(64);
    expect(longest).toHaveLength(64);
    expect(() => assertApiAddressDomain(longest)).not.toThrow();
    const tooLong = `${"a".repeat(40)}.${"b".repeat(24)}`;
    expect(tooLong).toHaveLength(65);
    expect(() => assertApiAddressDomain(tooLong)).toThrow(/at most 64 characters/u);
    expect(() => buildAgentXApp({ [API_ADDRESS_CONTEXT_KEY]: tooLong })).toThrow(/at most 64 characters/u);
    // The same limit as the consumer: `https://` plus the host is 72 characters at most.
    expect(`https://${longest}`.length).toBe(72);
  });
});
