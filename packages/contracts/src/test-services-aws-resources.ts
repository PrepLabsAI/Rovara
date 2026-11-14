// Test services, slice 2 (design test-services.md 3.2 D7 and 5.4): the AWS resources a project's infrastructure code declares, in the form the worker seeds into Rovara local AWS when a run starts: DynamoDB tables with
// their key schema, S3 buckets and SQS queues. They are NAMES and attribute types only, read from infrastructure code by the D7 detector, so every field has a plain form (the rules of each service, tightened: a name that
// looks like a secret is refused, as the detector already does). Topics are not here: SNS is not served in this slice.
// Nothing here imports a Node module.
import { z } from "zod";
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

export const TaskAwsResourceSchema = z.discriminatedUnion("kind", [
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
