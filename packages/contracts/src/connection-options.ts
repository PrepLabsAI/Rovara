// The fixed choices the Connections page offers when a company adds a monitoring connection (Datadog site, CloudWatch regions). Plain constants, no imports, so the browser
// can list them and the broker's connection schemas (`connection-types-observability.ts`) check against the same lists.

export const DATADOG_SITES = ["datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com", "ap2.datadoghq.com", "ddog-gov.com", "us2.ddog-gov.com", "uk1.datadoghq.com"] as const;

/**
 * Every AWS region code (docs.aws.amazon.com/general/latest/gr/rande.html, 2026-10-22), with the two China regions and the two GovCloud regions. A region
 * outside it is refused when a connection or a connector scope is saved. A region AWS adds later is added here.
 */
export const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "af-south-1",
  "ap-east-1", "ap-east-2", "ap-south-1", "ap-south-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5", "ap-southeast-6", "ap-southeast-7",
  "ca-central-1", "ca-west-1",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2",
  "il-central-1", "me-central-1", "me-south-1", "mx-central-1", "sa-east-1",
  "cn-north-1", "cn-northwest-1", "us-gov-east-1", "us-gov-west-1",
] as const;

/** The most regions one CloudWatch connection reads. */
export const CLOUDWATCH_MAX_REGIONS = 5;
