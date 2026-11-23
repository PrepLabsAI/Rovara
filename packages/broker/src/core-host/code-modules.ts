// Engine host (lane E2, step 3): the adapter modules Code's own AWS deployment runs the core on. The counterpart of the laptop's `local/runtime.ts` list.
//
// Every module builds one point from Code's public AWS adapters (`@rovara/aws-adapters`, the same adapters the laptop can load by config) and the GitHub plug-ins:
//   storage         DynamoDB over the State table, ALWAYS through Code's retention wrapper (retention.ts): the table's TTL attribute is a real delete, so a core expiry on a kind the
//                   deployed broker keeps for good is removed (the core's own kinds keep theirs). The module refuses to hand out a store that skips the wrapper.
//   queue           SQS over the declared queues; the core's dispatch queue must be among them, or the module refuses (a queue map without it would look wired while no task could start).
//   object-storage  S3 over the artifacts bucket (write once; tags only for mapped retention classes).
//   secrets         Secrets Manager under the install's prefix; a company's own secrets (`org-connectors/<company>/...`) are read only for that company (the adapter's company paths).
//   code-host       GitHub (the GitHub App provider the deployment builds).
//   check-runner    GitHub Actions, when the deployment gives its provider.
//   worker-machines The EC2 workspace sessions (aws/worker-machines/session-worker-machines.ts), when the deployment gives their operations: ONE fleet for every company, which answers
//                   only through `forCompany` (the core runtime binds it per company, core-runtime.ts). Only the dispatcher may start, sign for and post to a worker.
//
// Points this list never fills (each stays empty, so `buildCoreRegistry` refuses the switch by name, the intended fail-closed state): model-keys
// (lane G moves model keys out of Code), and the NEVER_DEFAULT points admission, metering, identity, approvers and audit-sink (security-list lanes G, ID, T, AU). `owedPoints` names them.
//
// Nothing here makes an AWS call when it is built: the SDK clients are made lazily by the adapters (or given by tests), and the registry is built only while the switch serves (app.ts).
import { INDEX_EXPIRY_ATTRIBUTE, type IndexDefinition, type JsonObject, type JsonValue, type PluginPoint } from "@agentx/contracts";
import { createDynamoStoreFromSettings } from "@rovara/aws-adapters/dynamodb";
import { createSqsQueueServiceFromSettings } from "@rovara/aws-adapters/sqs";
import { S3ObjectStorage, type S3ObjectStorageOptions } from "@rovara/aws-adapters/s3";
import { createSecretsManagerSecretStore, type SecretsManagerSecretStoreOptions } from "@rovara/aws-adapters/secrets-manager";
import { STATE_TABLE_INDEXES } from "@rovara/aws-adapters";
import { TASK_FLOW_INDEXES } from "../core/task-flow/flow.js";
import { githubCodeHost } from "../plugins/code-host/github/index.js";
import { GITHUB_ACTIONS_RUNNER_KIND, githubActionsCheckRunner, type GitHubActionsProvider } from "../plugins/check-runner/github-actions/index.js";
import { SessionWorkerFleet, type SessionWorkerFleetDependencies } from "../aws/worker-machines/session-worker-machines.js";
import { appliesCodeRetention, codeRetentionStore, type RetentionLog } from "./retention.js";
import { coreAdapter, type CoreAdapterModule } from "./registry.js";

/** The core's dispatch queue (`TaskFlowDeps.dispatchQueue`'s default). */
export const CORE_DISPATCH_QUEUE = "task-dispatch";

/** The first parts of a secret name that belong to one company (`org-connectors/<company>/<id>`): the adapter reads such a secret only for the company of the call. */
export const COMPANY_SECRET_PATHS: readonly string[] = Object.freeze(["org-connectors", "org-hooks"]);

/**
 * The State table's indexes the core reads: the table's own (session state, the workspace index, webhook recovery, the dispatch due index) and the core's (the outbox's pending index).
 * The outbox index is NOT on Code's State table yet (infra/lib/control-plane.ts): adding the GSI is an infrastructure step, owed before the outbox relay can run on AWS.
 */
export function stateTableIndexes(): IndexDefinition[] {
  const byName = new Map<string, IndexDefinition>();
  for (const index of [...STATE_TABLE_INDEXES, ...TASK_FLOW_INDEXES]) {
    const known = byName.get(index.name);
    if (known === undefined) byName.set(index.name, { ...index });
    else if (known.partitionAttribute !== index.partitionAttribute || known.sortAttribute !== index.sortAttribute) throw new Error(`the ${index.name} index is defined two ways`);
  }
  return [...byName.values()];
}

export interface CodeModuleDeps {
  /** The State table's name (`STATE_TABLE_NAME`). */
  tableName: string;
  /** The DynamoDB client (tests give the wire-level fake); absent, the adapter makes one for `region`. */
  dynamo?: Parameters<typeof createDynamoStoreFromSettings>[1];
  region?: string;
  /** Where Code's retention reports a stripped expiry (a kind, never a value). */
  retentionLog?: RetentionLog;
  /** The declared queues (`{ region, queues: { "task-dispatch": { url, deadLetterUrl } } }`) and, in tests, the client. The queues are the stack's; this makes none. */
  queue: { settings: JsonObject; client?: Parameters<typeof createSqsQueueServiceFromSettings>[1] };
  objects: Omit<S3ObjectStorageOptions, "now">;
  /** `companyPaths` is fixed by this list (`COMPANY_SECRET_PATHS`). */
  secrets: Omit<SecretsManagerSecretStoreOptions, "companyPaths">;
  codeHost: { provider: Parameters<typeof githubCodeHost>[0]; options: Parameters<typeof githubCodeHost>[1] };
  /** GitHub Actions. Absent: the check-runner point stays empty and the registry refuses the switch. */
  checkRunner?: { githubActions: GitHubActionsProvider };
  /** The EC2 workspace sessions (what this function may do with a worker). Absent: the worker-machines point stays empty and the registry refuses the switch. */
  workerMachines?: SessionWorkerFleetDependencies;
}

const refuseHollow = (what: string, missing: readonly string[]): never => { throw new Error(`the ${what} input is hollow: ${missing.join(", ")} missing`); };
const isFunction = (value: unknown): boolean => typeof value === "function";
function requireFunctions(what: string, value: object | undefined, names: readonly string[]): void {
  const missing = names.filter((name) => !isFunction((value as Record<string, unknown> | undefined)?.[name]));
  if (missing.length > 0) refuseHollow(what, missing);
}

export function codeAdapterModules(deps: CodeModuleDeps): CoreAdapterModule[] {
  return [
    coreAdapter({
      point: "storage", name: "dynamodb", owner: "E2 (Code's AWS deployment)",
      create: () => {
        if (typeof deps.tableName !== "string" || deps.tableName === "") refuseHollow("storage", ["tableName"]);
        const settings: JsonObject = { tableName: deps.tableName, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, indexes: JSON.parse(JSON.stringify(stateTableIndexes())) as JsonValue, ...(deps.region === undefined ? {} : { region: deps.region }) };
        const store = codeRetentionStore(createDynamoStoreFromSettings(settings, deps.dynamo), deps.retentionLog);
        // Belt and braces: the table's TTL attribute deletes, so a store without the wrapper is never handed out.
        if (!appliesCodeRetention(store)) throw new Error("the deployed store must apply Code's retention");
        return store;
      },
    }),
    coreAdapter({
      point: "queue", name: "sqs", owner: "E2 (Code's AWS deployment)",
      create: (context) => {
        const queues = (deps.queue?.settings as { queues?: Record<string, unknown> } | undefined)?.queues;
        const dispatch = queues === undefined || typeof queues !== "object" || queues === null ? undefined : queues[CORE_DISPATCH_QUEUE];
        if (typeof (dispatch as { url?: unknown } | undefined)?.url !== "string") refuseHollow("queue", [`queues.${CORE_DISPATCH_QUEUE}.url`]);
        return createSqsQueueServiceFromSettings(deps.queue.settings, deps.queue.client, () => context.now().getTime());
      },
    }),
    coreAdapter({
      point: "object-storage", name: "s3", owner: "E2 (Code's AWS deployment)",
      create: (context) => {
        if (typeof deps.objects?.bucket !== "string" || deps.objects.bucket === "") refuseHollow("objects", ["bucket"]);
        requireFunctions("objects.client", deps.objects.client, ["send"]);
        return new S3ObjectStorage({ ...deps.objects, now: () => context.now().getTime() });
      },
    }),
    coreAdapter({
      point: "secrets", name: "secrets-manager", owner: "E2 (Code's AWS deployment)",
      create: () => {
        requireFunctions("secrets", deps.secrets, ["clientFor"]);
        return createSecretsManagerSecretStore({ ...deps.secrets, companyPaths: COMPANY_SECRET_PATHS });
      },
    }),
    coreAdapter({
      point: "code-host", name: "github", owner: "E2 (Code's AWS deployment)",
      create: () => {
        if (deps.codeHost?.provider === undefined || typeof deps.codeHost.options?.credentialRef !== "string" || deps.codeHost.options.credentialRef === "") refuseHollow("codeHost", ["provider", "options.credentialRef"]);
        return githubCodeHost(deps.codeHost.provider, deps.codeHost.options);
      },
    }),
    ...(deps.checkRunner === undefined ? [] : [coreAdapter({
      point: "check-runner", name: GITHUB_ACTIONS_RUNNER_KIND, owner: "E2 (Code's AWS deployment)",
      create: () => {
        requireFunctions("checkRunner.githubActions", deps.checkRunner!.githubActions, ["getPullRequestStatus", "getJobLogTail"]);
        return { kind: GITHUB_ACTIONS_RUNNER_KIND, create: () => githubActionsCheckRunner(deps.checkRunner!.githubActions) };
      },
    })]),
    ...(deps.workerMachines === undefined ? [] : [coreAdapter({
      point: "worker-machines", name: "ec2-sessions", owner: "E2 (Code's AWS deployment)",
      create: () => {
        const given = deps.workerMachines!;
        requireFunctions("workerMachines", given, ["companyOfWorkspace", "binding", "stopInstance", "sign", "post", "ping"]);
        requireFunctions("workerMachines.sessions", given.sessions, ["get", "ensureSession", "deleteSession", "claimStop", "requestStop", "markStopped"]);
        return new SessionWorkerFleet(given);
      },
    })]),
  ];
}

/** Why a point stays empty on Code's deployment, and who fills it. Shown with a refused switch and in the lane report. */
export const OWED_POINTS = {
  "worker-machines": "give `workerMachines` (the EC2 session operations) in the module deps",
  "model-keys": "lane G: model keys leave Code for the model gateway",
  "check-runner": "give `checkRunner.githubActions` in the module deps",
  admission: "lane G (money at the gateway); never Code's allow-all default",
  metering: "lane G (money at the gateway); never Code's price-table default",
  identity: "lanes ID and T (Code's sign-in, company membership)",
  approvers: "lanes ID and T (project roles)",
  "audit-sink": "lane AU (engine audit records)",
} as const satisfies Partial<Record<PluginPoint, string>>;

/** The points `codeAdapterModules(deps)` leaves empty, with what each needs. */
export function owedPoints(deps: Pick<CodeModuleDeps, "checkRunner" | "workerMachines">): Array<{ point: keyof typeof OWED_POINTS; needs: string }> {
  return (Object.keys(OWED_POINTS) as Array<keyof typeof OWED_POINTS>)
    .filter((point) => (point !== "check-runner" || deps.checkRunner === undefined) && (point !== "worker-machines" || deps.workerMachines === undefined))
    .map((point) => ({ point, needs: OWED_POINTS[point] }));
}
