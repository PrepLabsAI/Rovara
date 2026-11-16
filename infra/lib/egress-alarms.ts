import {
  Duration,
  Stack,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  type aws_ec2 as ec2,
  aws_logs as logs,
  aws_sns as sns,
} from "aws-cdk-lib";
import { Construct } from "constructs";

/** The blocked-lookup alarm goes off when this many queries are blocked within 5 minutes. */
export const BLOCKED_DNS_ALARM_THRESHOLD = 200;
/** A NAT gateway alarm goes off when this many bytes leave through it toward the internet within an hour (20 GiB). */
export const NAT_EGRESS_ALARM_BYTES_PER_HOUR = 20 * 1024 ** 3;

export interface EgressAlarmsProps {
  /** The install, for the alarm names and the metric namespace AgentX/<env>. */
  env: string;
  /** The alarm and metric name prefix, for example agentx-<env>. */
  resourcePrefix: string;
  /** The DNS firewall query log group, /agentx/<env>/dns-firewall. */
  dnsFirewallLogGroup: logs.ILogGroup;
  /** The install's NAT gateways, each with the availability zone it serves; one alarm per entry. */
  natGateways: ReadonlyArray<{ az: string; natGateway: ec2.CfnNatGateway }>;
  /** The install-wide alerts topic every alarm notifies. */
  alertsTopic: sns.ITopic;
}

/**
 * Alarms for unusual outbound traffic. A metric filter turns the firewall's blocked lookups into
 * AgentX/<env>/BlockedDnsQueries, and one alarm per NAT gateway watches the bytes sent out. A
 * firewall that blocks a burst of lookups, or a large transfer out, is the signal that an agent
 * machine is doing something unexpected. They notify the existing operator alerts topic.
 */
export class EgressAlarms extends Construct {
  readonly blockedDnsAlarm: cloudwatch.Alarm;
  readonly natAlarms: readonly cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: EgressAlarmsProps) {
    super(scope, id);
    const notify = new cloudwatchActions.SnsAction(props.alertsTopic);
    const namespace = `AgentX/${props.env}`;
    // The documented name, not the log group's token, so the description reads plainly.
    const logGroupName = `/agentx/${props.env}/dns-firewall`;

    // Route 53 Resolver query logs are JSON; a query the firewall blocked carries firewall_rule_action BLOCK.
    new logs.MetricFilter(this, "BlockedDnsQueriesFilter", {
      logGroup: props.dnsFirewallLogGroup,
      filterPattern: logs.FilterPattern.stringValue("$.firewall_rule_action", "=", "BLOCK"),
      metricNamespace: namespace,
      metricName: "BlockedDnsQueries",
      metricValue: "1",
      defaultValue: 0,
    });
    this.blockedDnsAlarm = new cloudwatch.Alarm(this, "BlockedDnsSpikeAlarm", {
      alarmName: `${props.resourcePrefix}-blocked-dns-spike`,
      alarmDescription: `Agent machines had ${BLOCKED_DNS_ALARM_THRESHOLD} or more website lookups blocked by the DNS firewall in 5 minutes. Check the DNS firewall log ${logGroupName} for the blocked names and the source addresses, and check which workspaces were running. A tool that needs a site not on the allowlist is the usual cause; add it with the agentxEgressAllowDomains context if it is legitimate.`,
      metric: new cloudwatch.Metric({ namespace, metricName: "BlockedDnsQueries", statistic: "Sum", period: Duration.minutes(5) }),
      threshold: BLOCKED_DNS_ALARM_THRESHOLD,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.blockedDnsAlarm.addAlarmAction(notify);

    this.natAlarms = props.natGateways.map(({ az, natGateway }) => {
      const alarm = new cloudwatch.Alarm(this, `NatEgressSpikeAlarm-${az}`, {
        alarmName: `${props.resourcePrefix}-nat-egress-spike-${az}`,
        alarmDescription: `More than 20 GiB left through the NAT gateway in ${az} in an hour. Check which workspaces were running then, and check the DNS firewall log ${logGroupName} for what they looked up. The firewall does not stop a connection made straight to an IP address, so a large transfer may not show in the log.`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/NATGateway",
          metricName: "BytesOutToDestination",
          dimensionsMap: { NatGatewayId: natGateway.ref },
          statistic: "Sum",
          period: Duration.hours(1),
        }),
        threshold: NAT_EGRESS_ALARM_BYTES_PER_HOUR,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(notify);
      return alarm;
    });
  }
}

/**
 * The install's alerts topic by its fixed name (AgentXNaming.alertsTopicName). The control plane owns
 * the topic and is deployed after this stack, so the ARN is built from the name instead of passed in
 * as a parameter: a parameter would make each stack wait for the other.
 */
export function alertsTopicFromName(scope: Construct, id: string, topicName: string): sns.ITopic {
  return sns.Topic.fromTopicArn(scope, id, Stack.of(scope).formatArn({ service: "sns", resource: topicName }));
}
