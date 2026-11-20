// #1242: beta's own address (beta.rovara.dev), in front of the beta control plane's API, as production's apps have app.rovara.dev. Deployed once into the
// beta account, by hand (-c agentxBetaDomain=enabled); no release deploys it, and the control plane's template is unchanged (the API is only mapped here).
//
// The domain's DNS zone is in another account (the release account), so the certificate is validated by hand: the deploy waits until the validation
// record ACM asks for (shown in the ACM console, or `aws acm describe-certificate`) is added to that zone. After the deploy, the zone gets an alias record
// for the domain pointing at RegionalDomainName (in RegionalHostedZoneId).
import { CfnOutput, CfnParameter, Stack, type StackProps, aws_apigatewayv2 as apigwv2, aws_certificatemanager as acm } from "aws-cdk-lib";
import type { Construct } from "constructs";

export class BetaDomainStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const domainName = new CfnParameter(this, "DomainName", {
      type: "String",
      allowedPattern: "^[a-z0-9-]+(\\.[a-z0-9-]+)+$",
      description: "Beta's address, for example beta.rovara.dev",
    });
    const apiId = new CfnParameter(this, "ApiId", {
      type: "String",
      allowedPattern: "^[a-z0-9]{10}$",
      description: "The beta control plane's HTTP API id (the host part of AgentXControlPlane's ApiEndpoint output)",
    });
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: domainName.valueAsString,
      validation: acm.CertificateValidation.fromDns(),
    });
    const domain = new apigwv2.CfnDomainName(this, "Domain", {
      domainName: domainName.valueAsString,
      domainNameConfigurations: [{ certificateArn: certificate.certificateArn, endpointType: "REGIONAL", securityPolicy: "TLS_1_2" }],
    });
    // The control plane's API has one stage, $default; the whole API sits at the domain's root, so every path (/v1/slack/events, ...) is unchanged.
    new apigwv2.CfnApiMapping(this, "Mapping", { apiId: apiId.valueAsString, domainName: domain.ref, stage: "$default" });
    new CfnOutput(this, "RegionalDomainName", { value: domain.attrRegionalDomainName });
    new CfnOutput(this, "RegionalHostedZoneId", { value: domain.attrRegionalHostedZoneId });
  }
}
