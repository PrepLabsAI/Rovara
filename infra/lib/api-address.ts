// The permanent public address of an install's control-plane API (DEC 254zzz505): a custom domain (`api.<host>`), its ACM certificate, and the
// API mapping onto the control plane's `$default` stage, in a stack of their own. This is `BetaDomainStack` (beta-domain.ts) generalised: the
// same certificate, domain name and mapping, but no longer beta-only, with the API id as the ONE parameter, a certificate-expiry alarm to a topic
// the stack owns, and the origin as an output the control-plane pipeline consumes.
//
// Long-lived. Deployed once per environment, by hand, and NEVER rebuilt with the control plane: a rebuilt control plane has a new API id, and the
// address is pointed at it by ONE parameter update of this stack (`ApiId`), run through the pipeline as a named change set that must contain exactly
// one ApiMapping Modify (scripts/address-flip.ts). The stack owns nothing the control plane owns, and a control-plane rebuild never touches DNS,
// the certificate or the domain name.
//
// Opt-in: nothing is deployed unless `-c agentxApiAddress=<domain>` is given (maybeApiAddressStack, called from app.ts), for example
// `-c agentxApiAddress=api.beta.example.com`. The domain is baked into the template, not a parameter, so a long-lived stack cannot be re-addressed by
// a stray parameter value. Stack name: `AgentXApiAddress` for the deployment that predates environments, `agentx-<env>-address` for a named one.
//
// DNS is by hand, because the zone is in another account (the release account) and this stack never creates Route 53 records there:
//   1. the ACM DNS-validation CNAME: the deploy waits in CREATE_IN_PROGRESS until it exists. CloudFormation cannot output it (the certificate resource
//      has no attribute for it), so the `CertificateValidationRecordsCommand` output is the exact `aws acm describe-certificate` call that prints it;
//      the certificate's ARN is on the stack's Certificate resource while the stack waits. The CNAMEs stay in the zone for ACM's renewals.
//   2. after the deploy, the alias A (and AAAA) record for the domain, pointing at RegionalDomainName in RegionalHostedZoneId.
// A failed FIRST create: in a named layout the aspect RetainExceptOnCreate cleans up what the failed create made, so a retry is clean. In the legacy layout the policy is plain Retain, so a first create
// that fails after the domain name exists (for example the mapping, on a wrong ApiId) leaves an orphan domain name (and certificate) that the retry would clash on: delete the failed stack, then
// `aws apigatewayv2 delete-domain-name --domain-name <domain>` (it has no mapping, so it serves nothing) and, once nothing uses it, delete the certificate, then retry.
// Before the certificate is requested, the zone must not have a CAA record that excludes Amazon (amazon.com, amazontrust.com, awstrust.com, amazonaws.com).
import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_certificatemanager as acm,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_iam as iam,
  aws_sns as sns,
  type App,
} from "aws-cdk-lib";
import { API_ADDRESS_DOMAIN_MAX_LENGTH, LEGACY_ADDRESS_STACK_NAME, PUBLIC_API_ORIGIN_OUTPUT, publicApiAddressStackName } from "@agentx/contracts";
import type { Construct, IConstruct } from "constructs";
import type { AgentXNaming } from "./naming.js";

/** The context key that opts an install in; its value is the address's domain name, for example `api.beta.example.com`. */
export const API_ADDRESS_CONTEXT_KEY = "agentxApiAddress";

/** The certificate-expiry alarm goes off when the certificate has this many days or fewer left: ACM starts renewing 60 days out, so this means the renewal is failing (a validation record removed). */
export const CERTIFICATE_EXPIRY_ALARM_DAYS = 45;

/** The ApiId parameter's pattern: an HTTP API id. */
export const API_ID_PATTERN = "^[a-z0-9]{10}$";

/** A lowercase DNS name of at least two labels: no wildcard, no trailing dot, no label that starts or ends with a hyphen. At most API_ADDRESS_DOMAIN_MAX_LENGTH characters, the control plane's PublicApiUrl host limit. */
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/u;

/** Throws unless `domain` is a plain lowercase host name of at most API_ADDRESS_DOMAIN_MAX_LENGTH (64) characters. */
export function assertApiAddressDomain(domain: unknown): asserts domain is string {
  if (typeof domain !== "string" || domain.length > API_ADDRESS_DOMAIN_MAX_LENGTH || !DOMAIN_PATTERN.test(domain)) {
    throw new Error(`${API_ADDRESS_CONTEXT_KEY} must be a lowercase host name of at most ${API_ADDRESS_DOMAIN_MAX_LENGTH} characters, such as api.beta.example.com (got ${JSON.stringify(domain)})`);
  }
}

/** The names the address stack uses in one layout. */
export interface ApiAddressNames {
  readonly stackName: string;
  readonly alertsTopicName: string;
  readonly certificateExpiryAlarmName: string;
}

export function apiAddressNames(naming: Pick<AgentXNaming, "env">): ApiAddressNames {
  if (naming.env === undefined) {
    return { stackName: LEGACY_ADDRESS_STACK_NAME, alertsTopicName: "AgentXApiAddressAlerts", certificateExpiryAlarmName: "AgentXApiAddressCertificateExpiry" };
  }
  return {
    stackName: publicApiAddressStackName(naming.env),
    alertsTopicName: `agentx-${naming.env}-address-alerts`,
    certificateExpiryAlarmName: `agentx-${naming.env}-address-cert-expiry`,
  };
}

export interface ApiAddressStackProps extends StackProps {
  readonly naming: Pick<AgentXNaming, "env">;
  /** The address's domain name, for example `api.beta.example.com`. */
  readonly domainName: string;
}

export class ApiAddressStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiAddressStackProps) {
    super(scope, id, props);
    assertApiAddressDomain(props.domainName);
    const names = apiAddressNames(props.naming);
    const domainName = props.domainName;

    // The one parameter, with no default: every create and every update says which API the address points at. The flip is a change of this value alone.
    const apiId = new CfnParameter(this, "ApiId", {
      type: "String",
      allowedPattern: API_ID_PATTERN,
      description: "The control plane's HTTP API id (the host part of its ApiEndpoint output) that the address points at. Changed only by the pipeline's flip change set.",
    });

    // DNS validation: the record is created by hand in the zone's account (see the header). Kept on delete and on a replacing update: the domain's DNS and what the apps registered must outlive any stack operation.
    const certificate = new acm.CfnCertificate(this, "Certificate", {
      domainName,
      validationMethod: "DNS",
      tags: [{ key: "Name", value: domainName }],
    });
    certificate.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const domain = new apigwv2.CfnDomainName(this, "Domain", {
      domainName,
      domainNameConfigurations: [{ certificateArn: certificate.ref, endpointType: "REGIONAL", securityPolicy: "TLS_1_2" }],
    });
    domain.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // The control plane's API has one stage, $default; the whole API sits at the domain's root, so every path (/v1/slack/events, ...) is unchanged.
    // Pointing the address at another API is an in-place change of ApiId (UNVERIFIED that it is not a replacement: a replacement would clash on the
    // domain and roll back, leaving the address mapped; the flip script refuses any change set that is not exactly one Modify, no Replace).
    new apigwv2.CfnApiMapping(this, "Mapping", { apiId: apiId.valueAsString, domainName: domain.ref, stage: "$default" });

    // The expiry alarm lives HERE, with a topic this stack owns, so it survives every control-plane rebuild. No subscription by default (as the control
    // plane's operator topic): the deployer subscribes an address or connects AWS Chatbot.
    const alerts = new sns.Topic(this, "AddressAlerts", {
      topicName: names.alertsTopicName,
      displayName: "API address alerts",
      enforceSSL: true,
    });
    // enforceSSL leaves only a Deny in the topic policy, which replaces SNS's default same-account Allow, so the alarm needs its own grant to publish.
    alerts.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
      actions: ["sns:Publish"],
      resources: [alerts.topicArn],
      conditions: {
        StringEquals: { "aws:SourceAccount": this.account },
        ArnLike: { "aws:SourceArn": `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:*` },
      },
    }));
    // ACM publishes DaysToExpiry daily for an issued certificate; while the certificate is still pending there is no data, which must not alarm.
    new cloudwatch.Alarm(this, "CertificateExpiryAlarm", {
      alarmName: names.certificateExpiryAlarmName,
      alarmDescription: `The certificate for ${domainName} has ${CERTIFICATE_EXPIRY_ALARM_DAYS} days or fewer left, so ACM's renewal is failing. Check that the certificate's DNS validation CNAME is still in the zone (aws acm describe-certificate shows it); never delete it.`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/CertificateManager",
        metricName: "DaysToExpiry",
        dimensionsMap: { CertificateArn: certificate.ref },
        statistic: "Minimum",
        period: Duration.days(1),
      }),
      threshold: CERTIFICATE_EXPIRY_ALARM_DAYS,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alerts));

    // What the control-plane pipeline consumes: PublicApiOrigin is passed to EVERY create and update of the control plane as its PublicApiUrl.
    new CfnOutput(this, PUBLIC_API_ORIGIN_OUTPUT, { value: `https://${domainName}`, description: "The address as an https origin (no path, no trailing slash): the control plane's PublicApiUrl" });
    new CfnOutput(this, "PublicApiDomain", { value: domainName });
    new CfnOutput(this, "RegionalDomainName", { value: domain.attrRegionalDomainName, description: "The alias record's target (with RegionalHostedZoneId); created by hand in the zone" });
    new CfnOutput(this, "RegionalHostedZoneId", { value: domain.attrRegionalHostedZoneId });
    new CfnOutput(this, "MappedApiId", { value: apiId.valueAsString, description: "The API the address points at now" });
    new CfnOutput(this, "CertificateArn", { value: certificate.ref });
    new CfnOutput(this, "CertificateValidationRecordsCommand", {
      value: `aws acm describe-certificate --region ${this.region} --certificate-arn ${certificate.ref} --query 'Certificate.DomainValidationOptions[].ResourceRecord'`,
      description: "Prints the DNS-validation CNAME name and value to add by hand to the domain's zone (it stays there for renewals)",
    });
    new CfnOutput(this, "AlertsTopicArn", { value: alerts.topicArn });
  }
}

/** Creates the address stack when `-c agentxApiAddress=<domain>` is given; with the key unset nothing is created and no other template changes. */
export function maybeApiAddressStack(app: App, naming: Pick<AgentXNaming, "env">, region: string | undefined): ApiAddressStack | undefined {
  const domainName: unknown = app.node.tryGetContext(API_ADDRESS_CONTEXT_KEY);
  if (domainName === undefined) return undefined;
  assertApiAddressDomain(domainName);
  return new ApiAddressStack(app, "AgentXApiAddress", {
    description: "The permanent public address of the control plane's API: certificate, custom domain and API mapping",
    stackName: apiAddressNames(naming).stackName,
    terminationProtection: true,
    env: { region: region ?? "us-east-1" },
    naming,
    domainName,
  });
}

/** Whether a construct is inside the address stack: the control plane's health-alarm check (unlistedAlarms) leaves its expiry alarm alone, since that alarm is not an install health alarm. */
export function inApiAddressStack(construct: IConstruct): boolean {
  return construct.node.scopes.some((parent) => parent instanceof ApiAddressStack);
}
