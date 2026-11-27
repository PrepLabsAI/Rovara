// Real AWS CLI, CDK, HTTP, git, filesystem and clock ports for Code's model gateway release steps (#1578).
// Target-account calls use the stage profile (agentx-beta in beta; none in production).
// Release-account SSM calls (releaseSsm) always run with the build's own credentials (profile: null).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CDK_BOOTSTRAP_QUALIFIER } from "./context.js";
import { canonicalSha256, sha256Hex } from "./hash.js";
import { StageError } from "./types.js";
import type { ChangeRow, ExecOptions, ExecResult, Ports } from "./types.js";

export class AwsError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

export interface RealPortsArgs {
  region: string;
  exec8: string;
  profile: string | null;
}

function run(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => resolve({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const notThere = (error: unknown, pattern: RegExp): boolean => error instanceof AwsError && pattern.test(error.stderr);

function stringMap(list: unknown, key: string, value: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list as Array<Record<string, unknown>>) {
    if (typeof item[key] === "string" && typeof item[value] === "string") out[item[key]] = item[value];
  }
  return out;
}

function parseChangeRows(changes: unknown): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const change of (changes as Array<{ ResourceChange?: Record<string, unknown> }> | undefined) ?? []) {
    const rc = change.ResourceChange ?? {};
    const replacement = rc.Replacement === "True" || rc.Replacement === "False" || rc.Replacement === "Conditional" ? rc.Replacement : null;
    const details = Array.isArray(rc.Details) ? (rc.Details as Array<{ Target?: { Attribute?: unknown; Name?: unknown } }>) : null;
    const changedProperties = details === null
      ? undefined
      : [...new Set(details.map((d) => (typeof d.Target?.Attribute === "string" ? (typeof d.Target.Name === "string" ? `${d.Target.Attribute}:${d.Target.Name}` : d.Target.Attribute) : "")).filter((n) => n !== ""))];
    rows.push({
      action: str(rc.Action),
      logicalId: str(rc.LogicalResourceId),
      physicalId: typeof rc.PhysicalResourceId === "string" ? rc.PhysicalResourceId : null,
      resourceType: str(rc.ResourceType),
      replacement,
      ...(changedProperties === undefined ? {} : { changedProperties }),
    });
  }
  return rows;
}

function hashTemplate(template: unknown): string {
  if (typeof template === "string") {
    try { return canonicalSha256(JSON.parse(template)); } catch { return sha256Hex(template); }
  }
  return canonicalSha256(template);
}

function parseTemplate(template: unknown): unknown {
  if (typeof template !== "string") return template;
  try { return JSON.parse(template) as unknown; } catch { throw new StageError("FAILED", "CloudFormation returned a template that is not JSON"); }
}

async function assumeDeployRole(aws: Ports["aws"], region: string, exec8: string, account: string): Promise<Record<string, string>> {
  const role = `arn:aws:iam::${account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-deploy-role-${account}-${region}`;
  const answer = (await aws.json(["sts", "assume-role", "--role-arn", role, "--role-session-name", `rovara-gateway-${exec8}`])) as {
    Credentials?: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string };
  };
  if (answer?.Credentials === undefined) throw new StageError("FAILED", "the CDK deploy role returned no credentials");
  return {
    AWS_ACCESS_KEY_ID: answer.Credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: answer.Credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: answer.Credentials.SessionToken,
  };
}

function createCfnPort(cfnJson: (args: readonly string[]) => Promise<unknown>): Ports["cfn"] {
  const describeStack: Ports["cfn"]["describeStack"] = async (stack) => {
    try {
      const doc = (await cfnJson(["describe-stacks", "--stack-name", stack])) as { Stacks?: Array<Record<string, unknown>> };
      const s = doc.Stacks?.[0];
      if (s === undefined) return null;
      return {
        status: String(s.StackStatus),
        parameters: stringMap(s.Parameters, "ParameterKey", "ParameterValue"),
        outputs: stringMap(s.Outputs, "OutputKey", "OutputValue"),
        changeSetId: typeof s.ChangeSetId === "string" ? s.ChangeSetId : null,
        lastUpdatedTime: typeof s.LastUpdatedTime === "string" ? s.LastUpdatedTime : null,
      };
    } catch (error) {
      if (notThere(error, /does not exist/u)) return null;
      throw error;
    }
  };
  return {
    describeStack,
    async describeChangeSet(stack, name) {
      try {
        const doc = (await cfnJson(["describe-change-set", "--stack-name", stack, "--change-set-name", name])) as Record<string, unknown>;
        return {
          id: String(doc.ChangeSetId),
          status: String(doc.Status),
          executionStatus: String(doc.ExecutionStatus),
          statusReason: typeof doc.StatusReason === "string" ? doc.StatusReason : null,
          rows: parseChangeRows(doc.Changes),
        };
      } catch (error) {
        if (notThere(error, /ChangeSetNotFound|Stack \[[^\]]*\] does not exist/u)) return null;
        throw error;
      }
    },
    async listStackResources(stack) {
      const doc = (await cfnJson(["list-stack-resources", "--stack-name", stack])) as {
        StackResourceSummaries?: Array<{ LogicalResourceId?: string; ResourceType?: string; PhysicalResourceId?: string }>;
      } | null;
      return (doc?.StackResourceSummaries ?? [])
        .filter((r) => typeof r.PhysicalResourceId === "string" && r.PhysicalResourceId !== "")
        .map((r) => ({ logicalId: r.LogicalResourceId ?? "", resourceType: r.ResourceType ?? "", physicalId: r.PhysicalResourceId! }));
    },
    async templateSha256(stack, changeSetName) {
      const doc = (await cfnJson(["get-template", "--stack-name", stack, "--change-set-name", changeSetName, "--template-stage", "Original"])) as { TemplateBody?: unknown };
      return hashTemplate(doc.TemplateBody);
    },
    async templateBody(stack, changeSetName) {
      const doc = (await cfnJson(["get-template", "--stack-name", stack, "--change-set-name", changeSetName, "--template-stage", "Original"])) as { TemplateBody?: unknown };
      return parseTemplate(doc.TemplateBody);
    },
    async liveTemplateBody(stack) {
      try {
        const doc = (await cfnJson(["get-template", "--stack-name", stack, "--template-stage", "Original"])) as { TemplateBody?: unknown };
        return parseTemplate(doc.TemplateBody);
      } catch (error) {
        if (notThere(error, /does not exist/u)) return null;
        throw error;
      }
    },
    async executeChangeSet(stack, name) { await cfnJson(["execute-change-set", "--stack-name", stack, "--change-set-name", name]); },
    async deleteChangeSet(stack, name) {
      try { await cfnJson(["delete-change-set", "--stack-name", stack, "--change-set-name", name]); } catch (error) {
        if (notThere(error, /ChangeSetNotFound|Stack \[[^\]]*\] does not exist|Stack with id [^ ]+ does not exist/u)) return;
        throw error;
      }
    },
    async listChangeSetNames(stack) {
      const doc = (await cfnJson(["list-change-sets", "--stack-name", stack])) as { Summaries?: Array<{ ChangeSetName?: string }> };
      return (doc.Summaries ?? []).map((s) => s.ChangeSetName).filter((n): n is string => typeof n === "string");
    },
    async waitSettled(stack, timeoutSeconds) {
      const started = Date.now();
      for (;;) {
        const described = await describeStack(stack);
        const status = described?.status ?? "ABSENT";
        if (!status.endsWith("_IN_PROGRESS")) return status;
        if (Date.now() - started > timeoutSeconds * 1000) throw new StageError("DEPLOY_FAILED", `${stack} is still ${status} after ${timeoutSeconds} s`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    },
  };
}

export function createRealPorts(args: RealPortsArgs): Ports {
  const { region, profile } = args;
  const baseEnv: Record<string, string | undefined> = {
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_PAGER: "",
    ...(profile === null ? {} : { AWS_PROFILE: profile }),
  };
  const exec: Ports["exec"] = (cmd, a, opts) => run(cmd, a, { ...opts, env: { ...baseEnv, ...opts?.env } });
  const aws: Ports["aws"] = {
    async json(a, opts) {
      const awsEnv = {
        ...baseEnv,
        ...(opts?.profile === undefined ? {} : opts.profile === null ? { AWS_PROFILE: undefined } : { AWS_PROFILE: opts.profile }),
        ...opts?.env,
      };
      const result = await run("aws", [...a, "--region", region, "--output", "json"], { env: awsEnv });
      if (result.code !== 0) throw new AwsError(`aws ${a.slice(0, 2).join(" ")} failed: ${result.stderr.trim().split("\n").slice(-1)[0] ?? ""}`, result.stderr);
      return result.stdout.trim() === "" ? null : (JSON.parse(result.stdout) as unknown);
    },
  };
  let account: string | null = null;
  const sts: Ports["sts"] = {
    async account() {
      if (account === null) {
        const who = (await aws.json(["sts", "get-caller-identity"])) as { Account?: string };
        if (typeof who.Account !== "string" || !/^[0-9]{12}$/u.test(who.Account)) throw new StageError("REFUSED", "STS returned no account id");
        account = who.Account;
      }
      return account;
    },
  };
  let creds: { env: Record<string, string>; at: number } | null = null;
  const deployEnv = async (): Promise<Record<string, string>> => {
    if (creds !== null && Date.now() - creds.at < 40 * 60_000) return creds.env;
    creds = { at: Date.now(), env: await assumeDeployRole(aws, region, args.exec8, await sts.account()) };
    return creds.env;
  };
  const cfnJson = async (a: readonly string[]): Promise<unknown> => aws.json(["cloudformation", ...a], { env: await deployEnv(), profile: null });
  const ssmGet = async (name: string, useProfile: string | null | undefined): Promise<string | null> => {
    try {
      const doc = (await aws.json(["ssm", "get-parameter", "--name", name], useProfile === undefined ? undefined : { profile: useProfile })) as { Parameter: { Value: string } };
      return String(doc.Parameter.Value);
    } catch (error) {
      if (notThere(error, /ParameterNotFound/u)) return null;
      throw error;
    }
  };
  return {
    exec,
    aws,
    sts,
    cfn: createCfnPort(cfnJson),
    cdk: {
      async deployNoExecute(a) {
        if (a.stackName === "" || a.stackName.includes(":") || Object.keys(a.parameters).some((k) => k === "" || k.includes(":"))) {
          throw new StageError("USAGE", `cdk deploy: invalid stack or parameter name for ${a.stackName}`);
        }
        const context = Object.entries(a.context).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
        const parameters = Object.entries(a.parameters).flatMap(([k, v]) => ["--parameters", `${a.stackName}:${k}=${v}`]);
        const r = await exec("npx", [
          "--no-install", "cdk", "deploy", a.stackId, "--exclusively",
          "--app", "node infra/dist/bin/agentx.js",
          "--no-execute", "--require-approval", "never",
          "--change-set-name", a.changeSetName,
          "--progress", "events",
          ...context, ...parameters,
        ], { cwd: a.dir });
        if (r.code !== 0) {
          throw new StageError("FAILED", `cdk deploy --no-execute failed (exit ${r.code}): ${(r.stderr || r.stdout).split("\n").filter((l) => l !== "").slice(-4).join(" / ")}`);
        }
      },
    },
    ssm: { get: (name) => ssmGet(name, undefined) },
    releaseSsm: {
      get: (name) => ssmGet(name, null),
      async put(name, value) {
        await aws.json(["ssm", "put-parameter", "--name", name, "--value", value, "--type", "String", "--overwrite"], { profile: null });
      },
    },
    http: {
      async get(url, timeoutMs) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", headers: { accept: "application/json" } });
          return { status: response.status, body: (await response.text()).slice(0, 65_536) };
        } catch {
          return { status: 0 };
        }
      },
    },
    fs: {
      readText: (path) => readFileSync(path, "utf8"),
      writeText: (path, text) => writeFileSync(path, text),
      exists: (path) => existsSync(path),
      mkdirp: (path) => { mkdirSync(path, { recursive: true }); },
    },
    clock: { now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  };
}
