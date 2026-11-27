// Shared types, exit codes and errors for Code's model gateway release steps (#1578).
export type PipelineEnv = "beta" | "production";
export type GatewayStepName = "image" | "deploy" | "check";
export type PipelineMode = "release" | "adopt" | "rollback";

export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  REFUSED: 3,
  GATE_FAILED: 10,
  CHANGE_SET_MISMATCH: 20,
  DEPLOY_FAILED: 30,
  ROLLBACK_REFUSED: 40,
  ADOPTION_REQUIRED: 42,
} as const;
export type ExitName = keyof typeof EXIT;

export class StageError extends Error {
  readonly exitName: ExitName;
  constructor(exitName: ExitName, message: string) {
    super(message);
    this.exitName = exitName;
  }
}

export interface ChangeRow {
  action: string;
  logicalId: string;
  physicalId: string | null;
  resourceType: string;
  replacement: "True" | "False" | "Conditional" | null;
  changedProperties?: string[];
}

export interface ChangeCounts {
  add: number;
  modify: number;
  remove: number;
  replace: number;
}

export interface ChangeSetDescription {
  id: string;
  status: string;
  executionStatus: string;
  statusReason: string | null;
  rows: ChangeRow[];
}

export interface ChangeSetRecord {
  part: "gateway";
  stack: string;
  changeSetName: string;
  changeSetId: string | null;
  noChanges: boolean;
  status: string;
  executionStatus: string;
  templateSha256: string | null;
  rows: ChangeRow[];
  counts: ChangeCounts;
  previewedAt: string;
  executedAt: string | null;
  finalStatus: string | null;
}

export interface GateVerdict {
  name: string;
  phase: "change-sets" | "gateway-live";
  result: "pass" | "fail" | "skipped";
  failures?: string[];
  notes?: string[];
  skippedReason?: string;
  data?: Record<string, unknown>;
}

export interface GatewayImageState {
  digest: string | null;
  source: "built" | "copied" | "supplied" | "adopted" | null;
  imageTag: string | null;
  repository: string | null;
  codeSha: string | null;
}

export interface StageRecord {
  env: PipelineEnv;
  account: string | null;
  startedAt: string;
  dryRun: boolean;
  changeSet: ChangeSetRecord | null;
  gates: GateVerdict[];
  warnings: string[];
}

export interface GatewayManifest {
  schema: 1;
  executionId: string;
  exec8: string;
  createdAt: string;
  mode: PipelineMode;
  skipped: boolean;
  skipReason?: string;
  code: {
    sha: string;
    rollbackTarget: string | null;
    liveSha: Record<PipelineEnv, string | null>;
  };
  gateway: GatewayImageState;
  stages: Partial<Record<PipelineEnv, StageRecord>>;
}

export interface PreviousGatewayRecord {
  digest: string;
  codeSha: string | null;
}

export interface GatewayLastGoodRecord {
  schema: 1;
  env: PipelineEnv;
  recordedAt: string;
  executionId: string;
  mode: PipelineMode;
  gateway: {
    digest: string;
    codeSha: string | null;
    imageTag: string | null;
    repository: string | null;
  };
  checks: string[];
  previous: PreviousGatewayRecord | null;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface StackDescription {
  status: string;
  parameters: Record<string, string>;
  outputs: Record<string, string>;
  changeSetId: string | null;
  lastUpdatedTime: string | null;
}

export interface AwsJsonOptions {
  profile?: string | null;
  env?: Record<string, string | undefined>;
}

export interface Ports {
  exec(cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  aws: {
    json(args: readonly string[], opts?: AwsJsonOptions): Promise<unknown>;
  };
  sts: {
    account(): Promise<string>;
  };
  cfn: {
    describeStack(stack: string): Promise<StackDescription | null>;
    describeChangeSet(stack: string, name: string): Promise<ChangeSetDescription | null>;
    listStackResources(stack: string): Promise<Array<{ logicalId: string; resourceType: string; physicalId: string }>>;
    templateSha256(stack: string, changeSetName: string): Promise<string>;
    templateBody(stack: string, changeSetName: string): Promise<unknown>;
    liveTemplateBody(stack: string): Promise<unknown>;
    executeChangeSet(stack: string, name: string): Promise<void>;
    deleteChangeSet(stack: string, name: string): Promise<void>;
    listChangeSetNames(stack: string): Promise<string[]>;
    waitSettled(stack: string, timeoutSeconds: number): Promise<string>;
  };
  cdk: {
    deployNoExecute(args: {
      dir: string;
      stackId: string;
      stackName: string;
      changeSetName: string;
      context: Record<string, string>;
      parameters: Record<string, string>;
    }): Promise<void>;
  };
  /** Target environment SSM (read-only legacy handover check). */
  ssm: {
    get(name: string): Promise<string | null>;
  };
  /** Release account SSM (Code's own model-gateway-last-good and code-released records; never uses beta profile). */
  releaseSsm: {
    get(name: string): Promise<string | null>;
    put(name: string, value: string): Promise<void>;
  };
  http: {
    get(url: string, timeoutMs: number): Promise<{ status: number; body?: string }>;
  };
  fs: {
    readText(path: string): string;
    writeText(path: string, text: string): void;
    exists(path: string): boolean;
    mkdirp(path: string): void;
  };
  clock: {
    now(): Date;
    sleep(ms: number): Promise<void>;
  };
}
