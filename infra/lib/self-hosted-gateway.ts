import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  type CfnParameterProps,
  CustomResource,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_scheduler as scheduler,
  aws_sns as sns,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { KEYED_MODEL_PROVIDERS } from "@agentx/contracts";
import {
  MODEL_GATEWAY_CALL_CEILING_SECONDS,
  MODEL_GATEWAY_COMPANY_KEY_PREFIX,
  MODEL_GATEWAY_ENV,
  MODEL_GATEWAY_LEDGER_INDEXES,
  MODEL_GATEWAY_LOG_EVENTS,
  MODEL_GATEWAY_MARKERS_TTL_ATTRIBUTE,
  MODEL_GATEWAY_METER_INDEXES,
  MODEL_GATEWAY_MIN_TASKS,
  MODEL_GATEWAY_PORT,
} from "./model-gateway.js";
import { grantProviderKeySecrets, providerKeyParameters } from "./model-keys.js";
import type { AgentXNaming } from "./naming.js";

/** Standalone-only Model Gateway env var names (mirroring packages/model-gateway/src/deploy.ts). */
const STANDALONE_GATEWAY_ENV = {
  defaultCompanyCapMicros: "GATEWAY_DEFAULT_COMPANY_CAP_MICROS",
  openaiKeySecret: "GATEWAY_OPENAI_KEY_SECRET",
  openrouterKeySecret: "GATEWAY_OPENROUTER_KEY_SECRET",
  standaloneProvider: "GATEWAY_STANDALONE_PROVIDER",
  seedPricesOnStart: "GATEWAY_SEED_PRICES_ON_START",
} as const;

/**
 * Pure Node 22 inline CloudFormation custom resource (< 4 KB): generates a per-install ECDSA P-256
 * CA and server certificate for the internal ALB DNS name, imports the leaf + CA chain into ACM,
 * stores only the public CA cert PEM in SSM, and discards the CA private key immediately.
 */
export const GATEWAY_TLS_CERT_CODE = `const c=require("node:crypto"),h=require("node:https"),{ACMClient:A,ImportCertificateCommand:I,DeleteCertificateCommand:D}=require("@aws-sdk/client-acm"),{SSMClient:S,PutParameterCommand:P,DeleteParameterCommand:R}=require("@aws-sdk/client-ssm");
const B=Buffer,cat=(...p)=>B.concat(p),len=n=>n<128?B.of(n):n<256?B.of(129,n):B.of(130,n>>8,n&255),tlv=(t,...p)=>{const b=cat(...p);return cat(B.of(t),len(b.length),b)},seq=(...p)=>tlv(48,...p),set=(...p)=>tlv(49,...p),exp=(t,...p)=>tlv(160|t,...p),oct=b=>tlv(4,b),u8=s=>tlv(12,B.from(s)),bit=(b,u=0)=>tlv(3,B.of(u),b);
const int=b=>{let i=0;while(i<b.length-1&&b[i]===0)i++;const x=b.subarray(i);return tlv(2,x[0]>=128?cat(B.of(0),x):x)};
const oid=s=>{const n=s.split(".").map(Number),o=[n[0]*40+n[1]];for(const v of n.slice(2)){const g=[v&127];for(let r=v>>>7;r>0;r>>>=7)g.unshift((r&127)|128);o.push(...g)}return tlv(6,B.from(o))};
const ut=m=>{const d=new Date(m),p=v=>String(v).padStart(2,"0");return tlv(23,B.from(p(d.getUTCFullYear()%100)+p(d.getUTCMonth()+1)+p(d.getUTCDate())+p(d.getUTCHours())+p(d.getUTCMinutes())+p(d.getUTCSeconds())+"Z"))};
const alg=()=>seq(oid("1.2.840.10045.4.3.2")),nm=s=>seq(set(seq(oid("2.5.4.3"),u8(s)))),ext=(o,r,v)=>seq(oid(o),...(r?[tlv(1,B.of(255))]:[]),oct(v)),spki=k=>k.export({type:"spki",format:"der"}),ski=k=>c.createHash("sha256").update(spki(k)).digest().subarray(0,20);
const pem=(l,d)=>\`-----BEGIN \${l}-----\\n\${d.toString("base64").replace(/.{1,64}/g,"$&\\n").trimEnd()}\\n-----END \${l}-----\\n\`;
const mk=(sub,iss,pub,ik,nb,na,ex)=>{const s=c.randomBytes(16);s[0]=(s[0]&127)|1;const tbs=seq(exp(0,int(B.of(2))),int(s),alg(),nm(iss),seq(ut(nb),ut(na)),nm(sub),spki(pub),exp(3,seq(...ex)));return seq(tbs,alg(),bit(c.sign("sha256",tbs,ik)))};
const gen=dns=>{const nb=Date.now()-36e5,na=nb+31536e7,ca=c.generateKeyPairSync("ec",{namedCurve:"P-256"}),lf=c.generateKeyPairSync("ec",{namedCurve:"P-256"}),cn="rovara-gateway-ca",ck=ski(ca.publicKey),lk=ski(lf.publicKey);return{ca:pem("CERTIFICATE",mk(cn,cn,ca.publicKey,ca.privateKey,nb,na,[ext("2.5.29.19",1,seq(tlv(1,B.of(255)),int(B.of(0)))),ext("2.5.29.15",1,bit(B.of(6),1)),ext("2.5.29.14",0,oct(ck))])),lf:pem("CERTIFICATE",mk(dns.slice(0,64),cn,lf.publicKey,ca.privateKey,nb,na,[ext("2.5.29.19",1,seq()),ext("2.5.29.15",1,bit(B.of(128),7)),ext("2.5.29.37",0,seq(oid("1.3.6.1.5.5.7.3.1"))),ext("2.5.29.17",0,seq(tlv(130,B.from(dns)))),ext("2.5.29.14",0,oct(lk)),ext("2.5.29.35",0,seq(tlv(128,ck)))])),key:lf.privateKey.export({type:"pkcs8",format:"pem"}).toString()}};
const send=(e,st,id,d,r)=>new Promise(z=>{const b=JSON.stringify({Status:st,Reason:r,PhysicalResourceId:id,StackId:e.StackId,RequestId:e.RequestId,LogicalResourceId:e.LogicalResourceId,Data:d});const q=h.request(e.ResponseURL,{method:"PUT",headers:{"content-type":"","content-length":B.byteLength(b)}},s=>{s.resume();s.on("end",z)});q.on("error",z);q.end(b)});
exports.handler=async e=>{const acm=new A({}),ssm=new S({}),p=e.ResourceProperties||{},id=e.PhysicalResourceId||"gateway-tls-cert";try{if(e.RequestType==="Delete"){if(id.startsWith("arn:"))await acm.send(new D({CertificateArn:id})).catch(()=>{});if(p.CaCertParameter)await ssm.send(new R({Name:p.CaCertParameter})).catch(()=>{});return await send(e,"SUCCESS",id,{},"ok")}const g=gen(String(p.DnsName)),res=await acm.send(new I({...(id.startsWith("arn:")?{CertificateArn:id}:{}),Certificate:B.from(g.lf),PrivateKey:B.from(g.key),CertificateChain:B.from(g.ca)}));await ssm.send(new P({Name:p.CaCertParameter,Value:g.ca,Type:"String",Overwrite:true}));await send(e,"SUCCESS",res.CertificateArn,{CertificateArn:res.CertificateArn},"ok")}catch(x){await send(e,"FAILED",id,{},String(x&&x.message||x).slice(0,200))}};`;

export interface SelfHostedModelGatewayStackProps extends StackProps {
  naming: AgentXNaming;
}

/**
 * Self-hosted Model Gateway (`agentx-<env>-gateway`, issue #1554):
 * Runs `packages/model-gateway` standalone inside `foundation`'s existing VPC (no duplicate VPC, no
 * Rovara Cloud account, no custom domain or ACM certificate required by default).
 *
 * Dual-path zero-domain HTTPS:
 * - VPC-internal ALB (60m idle timeout) + per-install auto-imported ACM certificate (or operator's
 *   `CertificateArn`) for long-streaming in-VPC worker calls.
 * - API Gateway HTTP API + VPC Link fronting the internal ALB for AWS-trusted HTTPS from the
 *   out-of-VPC broker, `rovara init`, `rovara doctor`, and CodeBuild `InstallerJob` (hostname <= 56 chars).
 */
export class SelfHostedModelGatewayStack extends Stack {
  constructor(scope: Construct, id: string, props: SelfHostedModelGatewayStackProps) {
    super(scope, id, props);
    const { naming } = props;
    if (naming.env === undefined) {
      throw new Error("SelfHostedModelGatewayStack requires a named environment");
    }
    const env = naming.env;
    const param = (name: string, definition: CfnParameterProps) => new CfnParameter(this, name, definition);

    const imageUri = param("GatewayImageUri", {
      type: "String",
      allowedPattern: "^.+@sha256:[a-f0-9]{64}$",
      description: "Immutable private ECR linux/arm64 Model Gateway image URI",
    });
    const imageRepositoryName = param("GatewayImageRepositoryName", {
      type: "String",
      allowedPattern: "^(?:\\{\\{output:access\\.PullThroughPrefix\\}\\}/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$",
      description: "ECR repository containing the selected Model Gateway image",
    });
    const vpcId = param("VpcId", {
      type: "AWS::EC2::VPC::Id",
      description: "Foundation VPC ID where the Model Gateway runs",
    });
    const privateSubnetIds = param("PrivateSubnetIds", {
      type: "List<AWS::EC2::Subnet::Id>",
      description: "Foundation private subnets with NAT egress",
    });
    const codeUrl = param("CodeUrl", {
      type: "String",
      allowedPattern: "^https://[^\\s/]+(?:/[^\\s]*)?$",
      description: "Control plane URL whose /v1/auth/.well-known/jwks.json the gateway trusts",
    });
    const codeTaskKeyIds = param("CodeTaskKeyIds", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9_-]{16}(?:,[A-Za-z0-9_-]{16})?$",
      description: "Comma-separated task-token JWKS key IDs published by the control plane",
    });
    const alertsTopicArn = param("OperatorAlertsTopicArn", {
      type: "String",
      description: "Operator alerts SNS topic ARN output of the control plane stack",
    });
    const defaultCompanyCapMicros = param("DefaultCompanyCapMicros", {
      type: "String",
      default: "100000000",
      allowedPattern: "^[1-9][0-9]{0,11}$",
      description: "Default monthly spend cap in micro-dollars for standalone installs (default $100)",
    });
    const standaloneProvider = param("StandaloneProvider", {
      type: "String",
      default: "bedrock",
      allowedValues: ["bedrock", "anthropic", "openai", "openrouter"],
      description: "Primary AI provider for the self-hosted Model Gateway",
    });
    const certificateArn = param("CertificateArn", {
      type: "String",
      default: "",
      allowedPattern: "^$|^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/[0-9a-f-]+$",
      description: "Optional ACM certificate ARN for the gateway ALB HTTPS listener; empty generates a per-install internal certificate",
    });
    const gatewayHost = param("GatewayHost", {
      type: "String",
      default: "",
      allowedPattern: "^$|^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$",
      description: "Optional custom gateway hostname; empty uses the gateway HTTP API hostname",
    });
    const providerKeys = providerKeyParameters(this);

    const hasCertificateArn = new CfnCondition(this, "HasCertificateArn", {
      expression: Fn.conditionNot(Fn.conditionEquals(certificateArn.valueAsString, "")),
    });
    const useAutoCert = new CfnCondition(this, "UseAutoCert", {
      expression: Fn.conditionEquals(certificateArn.valueAsString, ""),
    });
    const hasCustomHost = new CfnCondition(this, "HasCustomHost", {
      expression: Fn.conditionNot(Fn.conditionEquals(gatewayHost.valueAsString, "")),
    });

    // ---- DynamoDB tables: Meter & Ledger retained (RetainExceptOnCreate via app aspect); Markers & Prices destroy cleanly
    const tableProps = (policy: RemovalPolicy): dynamodb.TableProps => ({
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: policy,
      ...(policy === RemovalPolicy.RETAIN ? { pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true } } : {}),
    });
    const meter = new dynamodb.Table(this, "Meter", tableProps(RemovalPolicy.RETAIN));
    meter.addGlobalSecondaryIndex({
      indexName: MODEL_GATEWAY_METER_INDEXES.openHolds.name,
      partitionKey: { name: MODEL_GATEWAY_METER_INDEXES.openHolds.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: MODEL_GATEWAY_METER_INDEXES.openHolds.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const ledger = new dynamodb.Table(this, "Ledger", tableProps(RemovalPolicy.RETAIN));
    for (const idx of [MODEL_GATEWAY_LEDGER_INDEXES.pendingByKey, MODEL_GATEWAY_LEDGER_INDEXES.pendingByAge]) {
      ledger.addGlobalSecondaryIndex({
        indexName: idx.name,
        partitionKey: { name: idx.partitionKey, type: dynamodb.AttributeType.STRING },
        sortKey: { name: idx.sortKey, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }
    const markers = new dynamodb.Table(this, "Markers", {
      ...tableProps(RemovalPolicy.DESTROY),
      timeToLiveAttribute: MODEL_GATEWAY_MARKERS_TTL_ATTRIBUTE,
    });
    const prices = new dynamodb.Table(this, "Prices", tableProps(RemovalPolicy.DESTROY));

    // ---- Security groups inside foundation's existing VPC
    const albSg = new ec2.CfnSecurityGroup(this, "AlbSecurityGroup", {
      groupDescription: `AgentX ${env} self-hosted model gateway internal load balancer`,
      vpcId: vpcId.valueAsString,
      securityGroupIngress: [{
        ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "10.42.0.0/16",
        description: "HTTPS from foundation VPC (workers and in-VPC callers)",
      }],
      tags: [{ key: "Application", value: "AgentX" }],
    });
    const vpcLinkSg = new ec2.CfnSecurityGroup(this, "VpcLinkSecurityGroup", {
      groupDescription: `AgentX ${env} model gateway HTTP API VPC Link`,
      vpcId: vpcId.valueAsString,
      tags: [{ key: "Application", value: "AgentX" }],
    });
    const taskSg = new ec2.CfnSecurityGroup(this, "TaskSecurityGroup", {
      groupDescription: `AgentX ${env} self-hosted model gateway tasks`,
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [{
        ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0",
        description: "HTTPS to AWS APIs, model providers, Code JWKS, and price catalogs",
      }],
      tags: [{ key: "Application", value: "AgentX" }],
    });
    new ec2.CfnSecurityGroupEgress(this, "AlbToTaskEgress", {
      groupId: albSg.attrGroupId, ipProtocol: "tcp", fromPort: MODEL_GATEWAY_PORT, toPort: MODEL_GATEWAY_PORT,
      destinationSecurityGroupId: taskSg.attrGroupId, description: "ALB to gateway tasks",
    });
    new ec2.CfnSecurityGroupIngress(this, "TaskFromAlbIngress", {
      groupId: taskSg.attrGroupId, ipProtocol: "tcp", fromPort: MODEL_GATEWAY_PORT, toPort: MODEL_GATEWAY_PORT,
      sourceSecurityGroupId: albSg.attrGroupId, description: "Gateway tasks accept traffic only from the ALB",
    });
    new ec2.CfnSecurityGroupEgress(this, "VpcLinkToAlbEgress", {
      groupId: vpcLinkSg.attrGroupId, ipProtocol: "tcp", fromPort: 8081, toPort: 8081,
      destinationSecurityGroupId: albSg.attrGroupId, description: "HTTP API VPC Link to internal ALB listener",
    });
    new ec2.CfnSecurityGroupIngress(this, "AlbFromVpcLinkIngress", {
      groupId: albSg.attrGroupId, ipProtocol: "tcp", fromPort: 8081, toPort: 8081,
      sourceSecurityGroupId: vpcLinkSg.attrGroupId, description: "Internal ALB listener accepts traffic only from VPC Link",
    });

    // ---- Internal ALB + Target Group
    const alb = new elbv2.CfnLoadBalancer(this, "LoadBalancer", {
      scheme: "internal",
      type: "application",
      subnets: privateSubnetIds.valueAsList,
      securityGroups: [albSg.attrGroupId],
      loadBalancerAttributes: [
        { key: "idle_timeout.timeout_seconds", value: String(MODEL_GATEWAY_CALL_CEILING_SECONDS) },
        { key: "routing.http.drop_invalid_header_fields.enabled", value: "true" },
      ],
      tags: [{ key: "Application", value: "AgentX" }],
    });
    const targetGroup = new elbv2.CfnTargetGroup(this, "TargetGroup", {
      vpcId: vpcId.valueAsString,
      port: MODEL_GATEWAY_PORT,
      protocol: "HTTP",
      targetType: "ip",
      healthCheckPath: "/healthz",
      healthCheckIntervalSeconds: 30,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      targetGroupAttributes: [
        { key: "deregistration_delay.timeout_seconds", value: String(MODEL_GATEWAY_CALL_CEILING_SECONDS) },
        { key: "stickiness.enabled", value: "false" },
      ],
      tags: [{ key: "Application", value: "AgentX" }],
    });

    // ---- Zero-domain per-install TLS certificate custom resource (only when CertificateArn is empty)
    const caCertParameter = `/agentx/${env}/gateway/ca-cert`;
    const tlsCertFn = new lambda.Function(this, "GatewayTlsCertFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      timeout: Duration.seconds(60),
      code: lambda.Code.fromInline(GATEWAY_TLS_CERT_CODE),
      description: `Generates per-install internal TLS certificate for agentx-${env}-gateway`,
    });
    tlsCertFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["acm:ImportCertificate", "acm:DeleteCertificate"],
      resources: [Fn.sub("arn:${AWS::Partition}:acm:${AWS::Region}:${AWS::AccountId}:certificate/*")],
    }));
    tlsCertFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
      resources: [Fn.sub(`arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${caCertParameter}`)],
    }));
    const tlsCert = new CustomResource(this, "GatewayTlsCert", {
      serviceToken: tlsCertFn.functionArn,
      properties: { DnsName: alb.attrDnsName, CaCertParameter: caCertParameter },
    });
    (tlsCert.node.defaultChild as CustomResource["node"]["defaultChild"] & { cfnOptions: { condition?: CfnCondition } }).cfnOptions.condition = useAutoCert;

    new elbv2.CfnListener(this, "HttpsListener", {
      loadBalancerArn: alb.ref,
      port: 443,
      protocol: "HTTPS",
      sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
      certificates: [{
        certificateArn: Fn.conditionIf(hasCertificateArn.logicalId, certificateArn.valueAsString, tlsCert.getAttString("CertificateArn")).toString(),
      }],
      defaultActions: [{ type: "forward", targetGroupArn: targetGroup.ref }],
    });
    const vpcLinkListener = new elbv2.CfnListener(this, "VpcLinkListener", {
      loadBalancerArn: alb.ref,
      port: 8081,
      protocol: "HTTP",
      defaultActions: [{ type: "forward", targetGroupArn: targetGroup.ref }],
    });

    // ---- API Gateway HTTP API + VPC Link for AWS-trusted HTTPS without a custom domain
    const vpcLink = new apigwv2.CfnVpcLink(this, "VpcLink", {
      name: `${naming.resourcePrefix}-gateway`,
      subnetIds: privateSubnetIds.valueAsList,
      securityGroupIds: [vpcLinkSg.attrGroupId],
    });
    const httpApi = new apigwv2.CfnApi(this, "HttpApi", {
      name: `${naming.resourcePrefix}-gateway`,
      protocolType: "HTTP",
      description: `HTTPS entry point for agentx-${env}-gateway`,
    });
    const integration = new apigwv2.CfnIntegration(this, "HttpApiIntegration", {
      apiId: httpApi.ref,
      integrationType: "HTTP_PROXY",
      integrationMethod: "ANY",
      integrationUri: vpcLinkListener.ref,
      connectionType: "VPC_LINK",
      connectionId: vpcLink.ref,
      payloadFormatVersion: "1.0",
      timeoutInMillis: 30_000,
    });
    new apigwv2.CfnRoute(this, "HttpApiRoute", {
      apiId: httpApi.ref,
      routeKey: "$default",
      target: Fn.join("/", ["integrations", integration.ref]),
    });
    new apigwv2.CfnStage(this, "HttpApiStage", {
      apiId: httpApi.ref,
      stageName: "$default",
      autoDeploy: true,
    });

    // ---- ECS Cluster, Logs, Roles, Task Definitions & Service
    const cluster = new ecs.CfnCluster(this, "Cluster", {
      clusterSettings: [{ name: "containerInsights", value: "disabled" }],
      tags: [{ key: "Application", value: "AgentX" }],
    });
    const serveLogs = new logs.LogGroup(this, "ServeLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fetchLogs = new logs.LogGroup(this, "PriceFetchLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const ecsPrincipal = () => new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
      conditions: { StringEquals: { "aws:SourceAccount": this.account } },
    });
    const executionRole = new iam.Role(this, "ServeExecutionRole", {
      assumedBy: ecsPrincipal(),
      description: `Pulls the agentx-${env}-gateway image and writes logs`,
    });
    executionRole.addToPolicy(new iam.PolicyStatement({ actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "EcrSelectedImage",
      actions: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      resources: [Fn.sub("arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/${RepositoryName}", { RepositoryName: imageRepositoryName.valueAsString })],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "EcrPullThroughCache",
      actions: [
        "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        "ecr:BatchImportUpstreamImage", "ecr:CreateRepository",
      ],
      resources: [Fn.join("", ["arn:", Aws.PARTITION, ":ecr:", Aws.REGION, ":", Aws.ACCOUNT_ID, ":repository/", naming.pullThroughPrefix, "/*"])],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [Fn.join("", [serveLogs.logGroupArn, ":*"]), Fn.join("", [fetchLogs.logGroupArn, ":*"])],
    }));

    const serveTaskRole = new iam.Role(this, "ServeTaskRole", {
      assumedBy: ecsPrincipal(),
      description: `Runtime role for agentx-${env}-gateway tasks`,
    });
    serveTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: "CompanyMeterTables",
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
      resources: [meter.tableArn, ledger.tableArn, markers.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${MODEL_GATEWAY_COMPANY_KEY_PREFIX}*`] } },
    }));
    serveTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: "CompanyMeterIndexes",
      actions: ["dynamodb:Query"],
      resources: [
        Fn.join("/", [meter.tableArn, "index", MODEL_GATEWAY_METER_INDEXES.openHolds.name]),
        Fn.join("/", [ledger.tableArn, "index", MODEL_GATEWAY_LEDGER_INDEXES.pendingByKey.name]),
        Fn.join("/", [ledger.tableArn, "index", MODEL_GATEWAY_LEDGER_INDEXES.pendingByAge.name]),
      ],
    }));
    serveTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: "PricesTableSeedAndRead",
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
      resources: [prices.tableArn],
    }));
    serveTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: "BedrockInvoke",
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        Fn.sub("arn:${AWS::Partition}:bedrock:*::foundation-model/*"),
        Fn.sub("arn:${AWS::Partition}:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/*"),
      ],
    }));
    grantProviderKeySecrets(this, [serveTaskRole.roleName]);
    const providerConditionId = (provider: keyof typeof KEYED_MODEL_PROVIDERS) =>
      (this.node.findChild(`${KEYED_MODEL_PROVIDERS[provider].constructPrefix}Enabled`) as CfnCondition).logicalId;

    const issuer = Fn.join("", [codeUrl.valueAsString, "/v1/auth"]);
    const serveTask = new ecs.CfnTaskDefinition(this, "ServeTask", {
      family: `${naming.resourcePrefix}-gateway`,
      cpu: "512",
      memory: "1024",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: serveTaskRole.roleArn,
      containerDefinitions: [{
        name: "gateway",
        image: imageUri.valueAsString,
        essential: true,
        readonlyRootFilesystem: true,
        user: "1000:1000",
        stopTimeout: 120,
        portMappings: [{ containerPort: MODEL_GATEWAY_PORT, protocol: "tcp" }],
        environment: [
          { name: MODEL_GATEWAY_ENV.mode, value: "serve" },
          { name: MODEL_GATEWAY_ENV.port, value: String(MODEL_GATEWAY_PORT) },
          { name: MODEL_GATEWAY_ENV.installIssuer, value: issuer },
          { name: MODEL_GATEWAY_ENV.installJwksUrl, value: Fn.join("", [issuer, "/.well-known/jwks.json"]) },
          { name: MODEL_GATEWAY_ENV.installTaskKids, value: codeTaskKeyIds.valueAsString },
          { name: MODEL_GATEWAY_ENV.meterTable, value: meter.tableName },
          { name: MODEL_GATEWAY_ENV.ledgerTable, value: ledger.tableName },
          { name: MODEL_GATEWAY_ENV.markersTable, value: markers.tableName },
          { name: MODEL_GATEWAY_ENV.pricesTable, value: prices.tableName },
          { name: STANDALONE_GATEWAY_ENV.defaultCompanyCapMicros, value: defaultCompanyCapMicros.valueAsString },
          { name: STANDALONE_GATEWAY_ENV.standaloneProvider, value: standaloneProvider.valueAsString },
          { name: MODEL_GATEWAY_ENV.rovaraAiModels, value: "on" },
          { name: STANDALONE_GATEWAY_ENV.seedPricesOnStart, value: "on" },
          Fn.conditionIf(providerConditionId("anthropic"), { Name: MODEL_GATEWAY_ENV.anthropicKeySecret, Value: providerKeys.anthropic.valueAsString }, Aws.NO_VALUE),
          Fn.conditionIf(providerConditionId("openai"), { Name: STANDALONE_GATEWAY_ENV.openaiKeySecret, Value: providerKeys.openai.valueAsString }, Aws.NO_VALUE),
          Fn.conditionIf(providerConditionId("openrouter"), { Name: STANDALONE_GATEWAY_ENV.openrouterKeySecret, Value: providerKeys.openrouter.valueAsString }, Aws.NO_VALUE),
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": serveLogs.logGroupName,
            "awslogs-region": Aws.REGION,
            "awslogs-stream-prefix": "gateway",
          },
        },
      }],
    });

    const service = new ecs.CfnService(this, "Service", {
      cluster: cluster.ref,
      taskDefinition: serveTask.ref,
      desiredCount: MODEL_GATEWAY_MIN_TASKS,
      launchType: "FARGATE",
      enableExecuteCommand: false,
      healthCheckGracePeriodSeconds: 60,
      deploymentConfiguration: {
        minimumHealthyPercent: 100,
        maximumPercent: 200,
        deploymentCircuitBreaker: { enable: true, rollback: true },
      },
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: privateSubnetIds.valueAsList,
          securityGroups: [taskSg.attrGroupId],
          assignPublicIp: "DISABLED",
        },
      },
      loadBalancers: [{
        containerName: "gateway",
        containerPort: MODEL_GATEWAY_PORT,
        targetGroupArn: targetGroup.ref,
      }],
    });
    service.addResourceDependency(vpcLinkListener);

    // ---- Daily scheduled price refresh task (uses EventBridge Scheduler, already in SERVICE_ROLE_SERVICES)
    const fetchTaskRole = new iam.Role(this, "PriceFetchTaskRole", {
      assumedBy: ecsPrincipal(),
      description: `Refreshes price snapshots for agentx-${env}-gateway`,
    });
    fetchTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
      resources: [prices.tableArn],
    }));
    const priceFetchTask = new ecs.CfnTaskDefinition(this, "PriceFetchTask", {
      family: `${naming.resourcePrefix}-gateway-price-fetch`,
      cpu: "256",
      memory: "512",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: fetchTaskRole.roleArn,
      containerDefinitions: [{
        name: "price-fetch",
        image: imageUri.valueAsString,
        essential: true,
        readonlyRootFilesystem: true,
        user: "1000:1000",
        environment: [
          { name: MODEL_GATEWAY_ENV.mode, value: "price-fetch" },
          { name: MODEL_GATEWAY_ENV.pricesTable, value: prices.tableName },
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": fetchLogs.logGroupName,
            "awslogs-region": Aws.REGION,
            "awslogs-stream-prefix": "price-fetch",
          },
        },
      }],
    });
    const scheduleRole = new iam.Role(this, "PriceFetchScheduleRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: `Runs the daily price-fetch task for agentx-${env}-gateway`,
    });
    scheduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecs:RunTask"],
      resources: [priceFetchTask.ref],
      conditions: { ArnEquals: { "ecs:cluster": cluster.attrArn } },
    }));
    scheduleRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [fetchTaskRole.roleArn, executionRole.roleArn],
      conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
    }));
    new scheduler.CfnSchedule(this, "DailyPriceFetchSchedule", {
      description: `Daily price snapshot refresh for agentx-${env}-gateway`,
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "cron(0 6 * * ? *)",
      target: {
        arn: cluster.attrArn,
        roleArn: scheduleRole.roleArn,
        ecsParameters: {
          taskDefinitionArn: priceFetchTask.ref,
          launchType: "FARGATE",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: privateSubnetIds.valueAsList,
              securityGroups: [taskSg.attrGroupId],
              assignPublicIp: "DISABLED",
            },
          },
        },
      },
    });

    // ---- Alarms (all registered in HEALTH_ALARM_SUFFIXES)
    const notify = new cloudwatchActions.SnsAction(sns.Topic.fromTopicArn(this, "OperatorAlerts", alertsTopicArn.valueAsString));
    serveLogs.addMetricFilter("GatewaySettleFailedMetric", {
      filterPattern: logs.FilterPattern.stringValue("$.event", "=", MODEL_GATEWAY_LOG_EVENTS.settleFailed),
      metricNamespace: naming.metricsNamespace,
      metricName: "GatewaySettleFailures",
      metricValue: "1",
    });
    const target5xx = new cloudwatch.Alarm(this, "GatewayTarget5xxAlarm", {
      alarmName: naming.alarmName("GatewayTarget5xx"),
      alarmDescription: "Self-hosted Model Gateway returned 5xx errors.",
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApplicationELB",
        metricName: "HTTPCode_Target_5XX_Count",
        dimensionsMap: { LoadBalancer: alb.attrLoadBalancerFullName, TargetGroup: targetGroup.attrTargetGroupFullName },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    target5xx.addAlarmAction(notify);
    const healthyTasks = new cloudwatch.Alarm(this, "GatewayHealthyTasksAlarm", {
      alarmName: naming.alarmName("GatewayHealthyTasks"),
      alarmDescription: "Self-hosted Model Gateway has fewer than 1 healthy task.",
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApplicationELB",
        metricName: "HealthyHostCount",
        dimensionsMap: { LoadBalancer: alb.attrLoadBalancerFullName, TargetGroup: targetGroup.attrTargetGroupFullName },
        statistic: "Minimum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    healthyTasks.addAlarmAction(notify);
    const settleFailures = new cloudwatch.Alarm(this, "GatewaySettleFailuresAlarm", {
      alarmName: naming.alarmName("GatewaySettleFailures"),
      alarmDescription: "Self-hosted Model Gateway failed to settle a call hold.",
      metric: new cloudwatch.Metric({
        namespace: naming.metricsNamespace,
        metricName: "GatewaySettleFailures",
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    settleFailures.addAlarmAction(notify);

    // ---- Outputs
    const effectiveGatewayHost = Fn.conditionIf(
      hasCustomHost.logicalId,
      gatewayHost.valueAsString,
      Fn.join("", [httpApi.ref, ".execute-api.", Aws.REGION, ".", Aws.URL_SUFFIX]),
    ).toString();
    const gatewayHostOutput = new CfnOutput(this, "GatewayHostOutput", { value: effectiveGatewayHost, description: "HTTPS hostname for the Model Gateway (used as CoreModelGatewayHost)" });
    gatewayHostOutput.overrideLogicalId("GatewayHost");
    new CfnOutput(this, "GatewayUrl", { value: Fn.join("", ["https://", effectiveGatewayHost]), description: "HTTPS URL for the Model Gateway" });
    new CfnOutput(this, "InternalGatewayUrl", { value: Fn.join("", ["https://", alb.attrDnsName]), description: "VPC-internal ALB HTTPS URL for long-streaming worker calls" });
    new CfnOutput(this, "GatewayCaCertParameter", { value: caCertParameter, description: "SSM parameter holding the public CA certificate PEM for InternalGatewayUrl" });
    new CfnOutput(this, "Issuer", { value: issuer, description: "Control plane issuer trusted by this Model Gateway" });
    new CfnOutput(this, "ClusterArn", { value: cluster.attrArn });
    new CfnOutput(this, "ServiceArn", { value: service.attrServiceArn });
  }
}
