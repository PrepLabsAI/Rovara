// FR-045 and FR-046: subscribe the alert address to the environment's topic, and send a test alarm
// through CloudWatch (the test alarm in the Slack stack), so PagerDuty and Opsgenie receive a real
// alarm. A webhook address carries its integration key: it is sent to SNS and never printed.
// Owner decision 3 (F14): no test alarm is sent until a subscription on the topic is confirmed.
import { DescribeBudgetCommand } from "@aws-sdk/client-budgets";
import { DescribeAlarmHistoryCommand, SetAlarmStateCommand } from "@aws-sdk/client-cloudwatch";
import { ListSubscriptionsByTopicCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { agentXError } from "@agentx/contracts";
import type { Prompter } from "../init/prompts.js";

export interface Subscription { arn: string; protocol: string; endpoint: string }
export interface AlertsApi {
  subscriptions(topicArn: string): Promise<Subscription[]>;
  subscribe(topicArn: string, protocol: "email" | "https", endpoint: string): Promise<void>;
  setAlarmState(alarmName: string, state: "ALARM" | "OK", reason: string): Promise<void>;
  /** True when the alarm's history shows a change to ALARM at or after `since`. */
  wentToAlarm(alarmName: string, since: Date): Promise<boolean>;
  /** DescribeBudget: the monthly limit in dollars, or undefined when there is no such budget. */
  budget(account: string, name: string): Promise<number | undefined>;
}
export type AlertTarget = { kind: "email"; address: string } | { kind: "webhook"; endpoint: string; display: string };

export const CONFIRM_WAIT_MS = 10 * 60_000;
const POLL_MS = 15_000;
/** How long CloudWatch may take to show the ALARM change in the alarm's history. */
const HISTORY_WAIT_MS = 20_000;
/** The history is read from a little before the change, so a local clock a few seconds ahead of
 * AWS's does not hide it. */
const HISTORY_SLACK_MS = 60_000;
const SELF_CONFIRMING = /(^|\.)(pagerduty\.com|opsgenie\.com)$/;
/** SNS's SubscriptionArn for a subscription nobody has confirmed yet. */
const PENDING = "PendingConfirmation";

export function testAlarmName(env: string): string {
  return `agentx-${env}-TestAlarm`;
}

type Send = { send(command: unknown): Promise<unknown> };
export function awsAlertsApi(clients: { sns: Send; cloudWatch: Send; budgets: Send }): AlertsApi {
  return {
    async subscriptions(topicArn) {
      const all: Subscription[] = [];
      let token: string | undefined;
      do {
        const page = (await clients.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, ...(token === undefined ? {} : { NextToken: token }) }))) as { Subscriptions?: Array<{ SubscriptionArn?: string; Protocol?: string; Endpoint?: string }>; NextToken?: string };
        all.push(...(page.Subscriptions ?? []).map((entry) => ({ arn: entry.SubscriptionArn ?? "", protocol: entry.Protocol ?? "", endpoint: entry.Endpoint ?? "" })));
        token = page.NextToken;
      } while (token !== undefined);
      return all;
    },
    async subscribe(topicArn, protocol, endpoint) {
      await clients.sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: protocol, Endpoint: endpoint }));
    },
    async setAlarmState(alarmName, state, reason) {
      await clients.cloudWatch.send(new SetAlarmStateCommand({ AlarmName: alarmName, StateValue: state, StateReason: reason }));
    },
    async wentToAlarm(alarmName, since) {
      const history = (await clients.cloudWatch.send(new DescribeAlarmHistoryCommand({ AlarmName: alarmName, HistoryItemType: "StateUpdate", StartDate: since, MaxRecords: 10 }))) as { AlarmHistoryItems?: Array<{ HistorySummary?: string }> };
      return (history.AlarmHistoryItems ?? []).some((item) => /to ALARM/.test(item.HistorySummary ?? ""));
    },
    async budget(account, name) {
      try {
        const response = (await clients.budgets.send(new DescribeBudgetCommand({ AccountId: account, BudgetName: name }))) as { Budget?: { BudgetLimit?: { Amount?: string } } };
        return Number(response.Budget?.BudgetLimit?.Amount ?? "0");
      } catch (error) {
        if (error instanceof Error && error.name === "NotFoundException") return undefined;
        throw error;
      }
    },
  };
}

const sameEndpoint = (a: string, b: string, kind: AlertTarget["kind"]) => (kind === "email" ? a.toLowerCase() === b.toLowerCase() : a === b);
const isConfirmed = (entry: Subscription) => entry.arn.startsWith("arn:");

/** An SNS error may quote the endpoint it refused: for a webhook, that is the integration key. */
async function withoutEndpoint<T>(target: AlertTarget, action: () => Promise<T>): Promise<T> {
  if (target.kind === "email") return action();
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(target.endpoint)) {
      throw agentXError("RUNTIME_UNAVAILABLE", `SNS refused the subscription: ${error.message.split(target.endpoint).join(target.display)}`);
    }
    throw error;
  }
}

/** Spec 048 FR-025: subscribes the address as soon as the topic exists, so the confirmation email is
 * already waiting by the Finish phase. Never waits for the confirmation (ensureSubscribed, in the
 * alerts step, does), and never subscribes an address twice. */
export async function subscribeAlertsEarly(input: { api: AlertsApi; topicArn: string; target: AlertTarget; write: (line: string) => void }): Promise<void> {
  const { target } = input;
  const protocol = target.kind === "email" ? "email" : "https";
  const endpoint = target.kind === "email" ? target.address : target.endpoint;
  const known = (await input.api.subscriptions(input.topicArn)).some((entry) => entry.protocol === protocol && sameEndpoint(entry.endpoint, endpoint, target.kind));
  if (known) return;
  await withoutEndpoint(target, () => input.api.subscribe(input.topicArn, protocol, endpoint));
  input.write(target.kind === "email"
    ? `AWS sent ${target.address} an email from AWS Notifications; confirm it any time before the install ends.`
    : `Subscribed ${target.display} to AgentX's alerts.`);
}

/** `onWaiting` is called once, when the subscription is still pending and the wait for its
 * confirmation begins (the install page shows a card for that wait). */
export async function ensureSubscribed(input: { api: AlertsApi; topicArn: string; target: AlertTarget; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number; onWaiting?: () => void }): Promise<"confirmed" | "pending"> {
  const { target } = input;
  const protocol = target.kind === "email" ? "email" : "https";
  const endpoint = target.kind === "email" ? target.address : target.endpoint;
  const find = async () => (await input.api.subscriptions(input.topicArn)).find((entry) => entry.protocol === protocol && sameEndpoint(entry.endpoint, endpoint, target.kind));
  // Idempotent: an address already on the topic, confirmed or not, is never subscribed twice.
  let found = await find();
  if (found === undefined) {
    await withoutEndpoint(target, () => input.api.subscribe(input.topicArn, protocol, endpoint));
    if (target.kind === "email") {
      input.write(`AWS sent ${target.address} an email from AWS Notifications; open it and choose "Confirm subscription". Waiting up to 10 minutes.`);
    } else {
      const host = new URL(target.endpoint).host;
      input.write(SELF_CONFIRMING.test(host)
        ? `Subscribed ${target.display}. PagerDuty and Opsgenie confirm the subscription on their own.`
        : `Subscribed ${target.display}. A webhook that is not PagerDuty or Opsgenie must confirm the subscription itself, by opening the SubscribeURL in the first message SNS sends it.`);
    }
    found = await find();
  }
  if (found?.arn === PENDING) input.onWaiting?.();
  const deadline = input.now() + CONFIRM_WAIT_MS;
  while (found !== undefined && found.arn === PENDING) {
    if (input.now() >= deadline) return "pending";
    await input.sleep(POLL_MS);
    found = await find();
  }
  return "confirmed";
}

/** The alerts topic, from the control-plane stack's OperatorAlertsTopicArn output. */
export async function alertsTopicArn(input: { stackOutputs: (stackName: string) => Promise<Record<string, string> | undefined>; stackName: string; next: string }): Promise<string> {
  const topicArn = (await input.stackOutputs(input.stackName))?.OperatorAlertsTopicArn;
  if (topicArn === undefined || topicArn === "") throw agentXError("CONFIG_INVALID", `the control-plane stack reports no OperatorAlertsTopicArn; ${input.next}`);
  return topicArn;
}

/** Owner decision 3: the test alarm goes out only once someone on the topic has confirmed. */
async function requireConfirmedSubscription(api: AlertsApi, topicArn: string, env: string): Promise<void> {
  const subscriptions = await api.subscriptions(topicArn);
  const topic = `agentx-${env}-alerts`;
  if (subscriptions.length === 0) {
    throw agentXError("CONFIG_INVALID", `nobody is subscribed to the ${topic} topic; run agentx init --env ${env} to subscribe the alert address, then run agentx alerts test`);
  }
  if (!subscriptions.some(isConfirmed)) {
    throw agentXError("CONFIG_INVALID", `no subscription to the ${topic} topic is confirmed yet; confirm it (the AWS Notifications email, or your webhook's SubscribeURL), then run agentx alerts test`);
  }
}

export async function sendTestAlarm(input: { api: AlertsApi; topicArn: string; env: string; shownAs: string; prompter: Prompter; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<void> {
  await requireConfirmedSubscription(input.api, input.topicArn, input.env);
  const name = testAlarmName(input.env);
  const since = new Date(input.now() - HISTORY_SLACK_MS);
  await input.api.setAlarmState(name, "ALARM", "agentx alerts test: a test alarm, not a real problem");
  let recorded: boolean;
  try {
    input.write(`Sent a test alarm (${name}) to ${input.shownAs}.`);
    await input.sleep(HISTORY_WAIT_MS);
    recorded = await input.api.wentToAlarm(name, since);
  } finally {
    // Always back to OK, so the test alarm never stays raised.
    await input.api.setAlarmState(name, "OK", "agentx alerts test: done");
  }
  if (!recorded) throw agentXError("RUNTIME_UNAVAILABLE", `CloudWatch did not record the test alarm going off; check that the ${name} alarm exists in the Slack stack (it needs this AgentX release), then run agentx alerts test`);
  if (!(await input.prompter.confirm(`Did a test alarm named ${name} arrive at ${input.shownAs}?`, { defaultValue: true }))) {
    throw agentXError("CONFIG_INVALID", `the test alarm did not arrive; check the subscription is confirmed (aws sns list-subscriptions-by-topic --topic-arn <the agentx-${input.env}-alerts topic>) and your spam folder, then run agentx alerts test`);
  }
}
