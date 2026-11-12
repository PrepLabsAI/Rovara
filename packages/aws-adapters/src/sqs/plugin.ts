// Convergence lane A2: the `queue` plug-in "sqs" for the registry. Opt-in: Code's default queue stays SQLite, and nothing loads this
// module unless the owner's config names it. Config entry:
//   { "point": "queue", "name": "sqs", "module": "@rovara/aws-adapters/sqs",
//     "settings": { "region": "us-west-2", "queues": { "dispatch": { "url": "https://sqs.us-west-2.amazonaws.com/<account>/<queue>", "deadLetterUrl": "..." } } } }
// The queues are declared by the deployment; this adapter creates none. `deadLetterUrl` is the queue the declared queue's redrive policy
// names (checked at first use). Credentials come from the AWS SDK's default chain; the config never holds one. A FIFO queue is one whose
// URL ends in `.fifo`.
import { SQSClient } from "@aws-sdk/client-sqs";
import type { JsonObject, PluginModule } from "@agentx/contracts";
import { SqsQueueService, type SqsQueueDeclaration, type SqsSender } from "./sqs-queue.js";

const SETTINGS = ["region", "endpoint", "queues"] as const;

const refuse = (message: string): Error => new Error(`sqs queue settings: ${message}`);

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "" || value.length > 1_024) throw refuse(`${what} is non-empty text`);
  return value;
}

/** The queue declarations from the settings. */
export function queuesOfSettings(value: unknown): Record<string, SqsQueueDeclaration> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) throw refuse("queues is an object naming at least one queue");
  const declared: Record<string, SqsQueueDeclaration> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw refuse(`queue ${JSON.stringify(name.slice(0, 40))} is an object`);
    const { url, deadLetterUrl, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw refuse(`queue ${JSON.stringify(name.slice(0, 40))} has url and deadLetterUrl only`);
    declared[name] = { url: text(url, `the url of queue ${JSON.stringify(name.slice(0, 40))}`), ...(deadLetterUrl === undefined ? {} : { deadLetterUrl: text(deadLetterUrl, "deadLetterUrl") }) };
  }
  return declared;
}

/** Builds the queue service from settings. `client` replaces the SDK client (tests); otherwise one is made for the region and endpoint given. */
export function createSqsQueueServiceFromSettings(settings: JsonObject, client?: SqsSender, now?: () => number): SqsQueueService {
  for (const key of Object.keys(settings)) if (!(SETTINGS as readonly string[]).includes(key)) throw refuse(`unknown setting ${JSON.stringify(key).slice(0, 40)}`);
  const region = settings.region === undefined ? undefined : text(settings.region, "region");
  const endpoint = settings.endpoint === undefined ? undefined : text(settings.endpoint, "endpoint");
  if (endpoint !== undefined && !/^https?:\/\/[^\s/]+(\/.*)?$/.test(endpoint)) throw refuse("endpoint is an http(s) URL");
  return new SqsQueueService({
    client: client ?? new SQSClient({ ...(region === undefined ? {} : { region }), ...(endpoint === undefined ? {} : { endpoint }) }),
    queues: queuesOfSettings(settings.queues),
    ...(now === undefined ? {} : { now }),
  });
}

export const plugin: PluginModule<"queue"> = {
  point: "queue",
  name: "sqs",
  create(context) {
    return createSqsQueueServiceFromSettings(context.settings);
  },
};

export default plugin;
