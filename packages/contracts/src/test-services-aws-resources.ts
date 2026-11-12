// Test services (design test-services.md 3.2 D7 and 5.4): the AWS resources a project's infrastructure code declares, in the form the worker seeds into Rovara local AWS when a run starts: DynamoDB tables with
// their key schema, S3 buckets, SQS queues, SNS topics (and the queues they deliver to), Secrets Manager secrets, SSM parameters, KMS keys and EventBridge buses and rules. They are NAMES and plain settings only, read from
// infrastructure code by the D7 detector, so every field has a plain form (the rules of each service, tightened: a name that looks like a secret is refused, as the detector already does). A secret's VALUE is never in
// here: the worker generates a placeholder when it seeds. Only a plain `String` SSM parameter is a resource (a SecureString or a StringList is not seeded). Every other service of the generated table starts empty and the tests create what they need.
// Nothing here imports a Node module.
import { z } from "zod";
import { normaliseAwsServiceKey } from "./aws-emulator-service-keys.js";
import { looksLikeSecretValue } from "./test-services-shared.js";

/** The most resources one emulator is seeded with (the same as the detectors' cap). */
export const TASK_AWS_RESOURCES_MAX = 24;

const notSecret = (name: string): boolean => !looksLikeSecretValue(name) && !looksLikeSecretValue(name.toUpperCase());

/** A DynamoDB key attribute: its name and its type (S, N or B), as the table's attribute definitions say. */
const KeyAttributeSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/u), type: z.enum(["S", "N", "B"]) }).strict();

/** DynamoDB's table names: 3 to 255 of letters, digits, `_`, `-` and `.`. */
const TableNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/u).refine(notSecret, "a name, not a secret");
/** S3's general-purpose bucket names: 3 to 63 of lower-case letters, digits, `-` and `.`, starting and ending with a letter or digit, no `..`, and not shaped like an address. */
const BucketNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)
  .refine((name) => !name.includes("..") && !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(name), "a bucket name, not an address")
  .refine(notSecret, "a name, not a secret");
/** SQS' queue names: 1 to 80 of letters, digits, `-` and `_`, and a FIFO queue's name ends in `.fifo`. */
const QueueNameSchema = z.string().regex(/^(?:[A-Za-z0-9_-]{1,75}\.fifo|[A-Za-z0-9_-]{1,80})$/u).refine(notSecret, "a name, not a secret");

/** SNS' topic names: 1 to 256 of letters, digits, `-` and `_`; a FIFO topic's name ends in `.fifo`. */
const TopicNameSchema = z.string().regex(/^(?:[A-Za-z0-9_-]{1,251}\.fifo|[A-Za-z0-9_-]{1,256})$/u).refine(notSecret, "a name, not a secret");
/** Secrets Manager's secret names: 1 to 256 of letters, digits and `/_+=.@-`. */
const SecretNameSchema = z.string().regex(/^[A-Za-z0-9/_+=.@-]{1,256}$/u).refine(notSecret, "a name, not a secret");
/** SSM parameter names: letters, digits and `./_-`, at most 200, and not under the `aws` or `ssm` prefixes AWS keeps. */
const ParameterNameSchema = z.string().regex(/^\/?[A-Za-z0-9_./-]{1,200}$/u).refine((name) => !/^\/?(?:aws|ssm)(?:\/|$)/iu.test(name), "not a reserved prefix").refine(notSecret, "a name, not a secret");
/** A parameter's literal default: one printable line of at most 200 characters that is not shaped like a key. */
const ParameterValueSchema = z.string().max(200).regex(/^[\x20-\x7e]*$/u).refine((value) => !looksLikeSecretValue(value) && !looksLikeSecretValue(value.toUpperCase()), "a plain value, not a secret");
/** A KMS key's label (what the key is called in the template) and its alias, as KMS spells one. */
const KeyLabelSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u).refine(notSecret, "a name, not a secret");
const KeyAliasSchema = z.string().regex(/^alias\/[A-Za-z0-9/_-]{1,250}$/u).refine((alias) => !alias.startsWith("alias/aws/"), "not a reserved alias");
/** EventBridge's bus and rule names: letters, digits and `._-`; the account's `default` bus exists already. */
const BusNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,256}$/u).refine((name) => name !== "default", "a bus of its own").refine(notSecret, "a name, not a secret");
const RuleNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u).refine(notSecret, "a name, not a secret");
const RuleScheduleSchema = z.string().regex(/^(?:rate|cron)\([A-Za-z0-9 ,*?/#L,W-]{1,100}\)$/u);
const RulePatternSchema = z.string().max(1_000).refine((text) => { try { const value: unknown = JSON.parse(text); return typeof value === "object" && value !== null && !Array.isArray(value); } catch { return false; } }, "a JSON object");

/** The most queues one topic delivers to. */
export const TASK_AWS_TOPIC_QUEUES_MAX = 8;

export const TaskAwsResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("topic"), name: TopicNameSchema, /** The queues (by name) the project declares as subscribers: the worker subscribes each by its ARN. */ queues: z.array(QueueNameSchema).max(TASK_AWS_TOPIC_QUEUES_MAX).optional() }).strict(),
  z.object({ kind: z.literal("secret"), name: SecretNameSchema }).strict(),
  z.object({
    kind: z.literal("parameter"), name: ParameterNameSchema,
    /** The template's literal default of a `String` parameter; absent when the template builds the value (the worker then makes a placeholder). */
    value: ParameterValueSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("key"), name: KeyLabelSchema, alias: KeyAliasSchema.optional() }).strict(),
  z.object({ kind: z.literal("bus"), name: BusNameSchema }).strict(),
  z.object({ kind: z.literal("rule"), name: RuleNameSchema, bus: BusNameSchema.optional(), pattern: RulePatternSchema.optional(), schedule: RuleScheduleSchema.optional() }).strict().superRefine((rule, context) => {
    if (rule.pattern === undefined && rule.schedule === undefined) context.addIssue({ code: "custom", path: ["pattern"], message: "a rule has an event pattern or a schedule" });
  }),
  z.object({ kind: z.literal("table"), name: TableNameSchema, keySchema: z.object({ partitionKey: KeyAttributeSchema, sortKey: KeyAttributeSchema.optional() }).strict() }).strict(),
  z.object({ kind: z.literal("bucket"), name: BucketNameSchema }).strict(),
  z.object({ kind: z.literal("queue"), name: QueueNameSchema }).strict(),
]);
export type TaskAwsResource = z.infer<typeof TaskAwsResourceSchema>;

/** The resources of one emulator: unique by kind and name, and a table's partition and sort keys are different attributes. */
export const TaskAwsResourcesSchema = z
  .array(TaskAwsResourceSchema)
  .max(TASK_AWS_RESOURCES_MAX)
  .superRefine((resources, context) => {
    const seen = new Set<string>();
    resources.forEach((resource, index) => {
      const key = `${resource.kind}\0${resource.name}`;
      if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "a resource is listed once" });
      seen.add(key);
      if (resource.kind === "table" && resource.keySchema.sortKey?.name === resource.keySchema.partitionKey.name) context.addIssue({ code: "custom", path: [index, "keySchema"], message: "the sort key is a different attribute" });
    });
  });


/**
 * The resource kinds Rovara can create from a project's declarations, by service key: the services that have a seed handler. A service of the table that is not here starts empty (its candidate says so). Legacy spellings
 * are read as their keys.
 */
export const AWS_SEEDED_KINDS: Readonly<Record<string, readonly TaskAwsResource["kind"][]>> = {
  s3: ["bucket"], sqs: ["queue"], dynamodb: ["table"], sns: ["topic"], "secrets-manager": ["secret"], ssm: ["parameter"], kms: ["key"], eventbridge: ["bus", "rule"],
};
export function awsSeededKinds(service: string): readonly TaskAwsResource["kind"][] {
  const key = normaliseAwsServiceKey(service) ?? service;
  return Object.hasOwn(AWS_SEEDED_KINDS, key) ? AWS_SEEDED_KINDS[key]! : [];
}
