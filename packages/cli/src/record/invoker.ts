// `rovara record sagemaker`: the one thing the recorder sends anything to, the customer's OWN SageMaker endpoint. It calls the AWS CLI the customer already has (`aws sagemaker-runtime invoke-endpoint`), so it uses the
// customer's own credentials and profile, and Rovara gets no credential, no request and no answer. The recorder holds no AWS SDK client of its own and never reads or prints a credential; the AWS CLI does the signing.
// The invoker is an interface so a test (or a customer with a different client) can supply another: all the recorder needs is "send this request to the endpoint and say what came back".
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAGEMAKER_ENDPOINT_LIMITS } from "@agentx/contracts";

export interface InvokeRequest {
  endpointName: string;
  contentType: string;
  accept?: string | undefined;
  customAttributes?: string | undefined;
  targetVariant?: string | undefined;
  targetModel?: string | undefined;
  body: Uint8Array;
}

/** Why a call failed in a way that is not the model's answer. Fixed words: nothing of the service's message is kept. */
export const INVOKE_FAILURES = ["no_credentials", "access_denied", "endpoint_not_found", "throttled", "unavailable", "timeout", "reply_too_large", "aws_cli_missing", "failed"] as const;
export type InvokeFailure = (typeof INVOKE_FAILURES)[number];
export const INVOKE_FAILURE_WORDS: Record<InvokeFailure, string> = {
  no_credentials: "No AWS credentials were found. Sign in with your own AWS profile and try again.",
  access_denied: "Your AWS identity is not allowed to call this endpoint (sagemaker:InvokeEndpoint).",
  endpoint_not_found: "The endpoint was not found in this account and region, or it is not in service.",
  throttled: "SageMaker is throttling calls to this endpoint. Try again later.",
  unavailable: "SageMaker could not answer (the endpoint is not ready or the service is unavailable).",
  timeout: "The endpoint did not answer in time.",
  reply_too_large: "The endpoint's answer is larger than SageMaker's 6 MiB limit.",
  aws_cli_missing: "The AWS CLI (`aws`) was not found. Install it, or run the recorder where it is installed.",
  failed: "The call to the endpoint failed.",
};

export type InvokeOutcome =
  | { kind: "answer"; body: Uint8Array; contentType: string; customAttributes?: string | undefined; variant?: string | undefined }
  /** The model container answered with an error status (SageMaker's `ModelError`): the model's own answer, which tests may need. */
  | { kind: "model_error"; originalStatusCode: number }
  | { kind: "failed"; failure: InvokeFailure };

export interface SageMakerInvoker {
  invoke(request: InvokeRequest, signal: AbortSignal): Promise<InvokeOutcome>;
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/u;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.@+=,-]{0,127}$/u;
const HEADER_VALUE = /^[^\r\n\0]{1,1024}$/u;
/** What the AWS CLI does with a parameter value that starts like this: `file://` and `fileb://` read a file from disk, `http://` and `https://` (CLI v1) fetch a URL, and a leading `-` is read as an option. */
const CLI_SPECIAL_VALUE = /^(?:-|(?:file|fileb|https?):\/\/)/iu;

/**
 * Whether a value may be handed to the AWS CLI as a request header: one plain line of at most 1,024 characters that the CLI will not treat specially. The recorder's input file is the customer's own, but a file shared
 * between people (or generated) must not be able to make the CLI read a local file or fetch an address, or switch on an option. The input schema and the invoker both ask.
 */
export const isSafeCliValue = (value: string): boolean => HEADER_VALUE.test(value) && !CLI_SPECIAL_VALUE.test(value.trim());

export interface AwsCliInvokerOptions {
  region?: string | undefined;
  profile?: string | undefined;
  /** The AWS CLI program; `aws` by default. */
  command?: string | undefined;
  /** What to do after the temporary folder was removed because the process was told to stop: by default the signal is raised again so the process ends as it would have. For tests. */
  exit?: (signal: NodeJS.Signals) => void;
  /** The process runner, for tests. */
  run?: (file: string, args: readonly string[], options: { signal: AbortSignal; env: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }>;
}

/** The failure the AWS CLI's error text names. Only the error CODE (a plain word in parentheses) is read; the message after it is never kept. */
export function failureFromAwsCliError(stderr: string): { failure: InvokeFailure } | { modelError: number } {
  if (/Unable to locate credentials|NoCredentialsError|ExpiredToken|InvalidClientTokenId|could not be found.*credentials/iu.test(stderr)) return { failure: "no_credentials" };
  const code = /An error occurred \(([A-Za-z]{3,60})\)/u.exec(stderr)?.[1];
  if (code === "ModelError") {
    const status = /(?:server|client) error \((\d{3})\)/u.exec(stderr)?.[1];
    return { modelError: status === undefined ? 500 : Number(status) };
  }
  if (code === "AccessDeniedException" || code === "AccessDenied" || code === "UnrecognizedClientException") return { failure: "access_denied" };
  if (code === "ValidationError" || code === "ResourceNotFound") return { failure: "endpoint_not_found" };
  if (code === "ThrottlingException" || code === "TooManyRequestsException") return { failure: "throttled" };
  if (code === "ServiceUnavailable" || code === "ModelNotReadyException" || code === "InternalFailure") return { failure: "unavailable" };
  if (/timed out|Read timeout|Connect timeout/iu.test(stderr)) return { failure: "timeout" };
  return { failure: "failed" };
}

function defaultRun(file: string, args: readonly string[], options: { signal: AbortSignal; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { signal: options.signal, env: options.env, maxBuffer: 1_048_576, windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) { resolve({ code: 0, stdout, stderr }); return; }
      const failure = error as NodeJS.ErrnoException & { code?: number | string };
      if (failure.code === "ENOENT") { resolve({ code: 127, stdout: "", stderr: "", missing: true }); return; }
      if (failure.name === "AbortError" || failure.code === "ABORT_ERR") { resolve({ code: 124, stdout: "", stderr: "timed out" }); return; }
      resolve({ code: typeof failure.code === "number" ? failure.code : 1, stdout, stderr });
    });
  });
}

/** An invoker that calls the customer's AWS CLI. Every argument is passed as one argument (no shell), and values that could be read as options are refused. */
export function awsCliInvoker(options: AwsCliInvokerOptions = {}): SageMakerInvoker {
  const run = options.run ?? defaultRun;
  const command = options.command ?? "aws";
  if (options.region !== undefined && !REGION.test(options.region)) throw new RangeError("the region is not an AWS region name");
  if (options.profile !== undefined && !PROFILE.test(options.profile)) throw new RangeError("the profile is not a plain profile name");
  return {
    async invoke(request, signal) {
      for (const value of [request.contentType, request.accept, request.customAttributes, request.targetVariant, request.targetModel]) {
        if (value !== undefined && !isSafeCliValue(value)) return { kind: "failed", failure: "failed" };
      }
      if (request.body.length > SAGEMAKER_ENDPOINT_LIMITS.requestBytes) return { kind: "failed", failure: "failed" };
      const dir = await mkdtemp(join(tmpdir(), "rovara-record-"));
      // The folder holds the request, which may hold what the customer would not leave on disk. If the process is told to stop, it is removed first, then the signal is raised again.
      const onSignal = (signal: NodeJS.Signals): void => {
        rmSync(dir, { recursive: true, force: true });
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        (options.exit ?? ((raised: NodeJS.Signals) => { process.kill(process.pid, raised); }))(signal);
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        const input = join(dir, "request");
        const output = join(dir, "answer");
        await writeFile(input, request.body, { mode: 0o600 });
        const args = [
          "sagemaker-runtime", "invoke-endpoint", "--endpoint-name", request.endpointName, "--body", `fileb://${input}`, "--content-type", request.contentType,
          ...(request.accept === undefined ? [] : ["--accept", request.accept]), ...(request.customAttributes === undefined ? [] : ["--custom-attributes", request.customAttributes]),
          ...(request.targetVariant === undefined ? [] : ["--target-variant", request.targetVariant]), ...(request.targetModel === undefined ? [] : ["--target-model", request.targetModel]),
          ...(options.region === undefined ? [] : ["--region", options.region]), ...(options.profile === undefined ? [] : ["--profile", options.profile]),
          "--output", "json", "--no-cli-pager", output,
        ];
        const result = await run(command, args, { signal, env: { ...process.env, AWS_PAGER: "" } });
        if (result.missing === true) return { kind: "failed", failure: "aws_cli_missing" };
        if (signal.aborted) return { kind: "failed", failure: "timeout" };
        if (result.code !== 0) {
          const read = failureFromAwsCliError(result.stderr);
          return "modelError" in read ? { kind: "model_error", originalStatusCode: read.modelError } : { kind: "failed", failure: read.failure };
        }
        const body = await readFile(output);
        if (body.length > SAGEMAKER_ENDPOINT_LIMITS.replyBytes) return { kind: "failed", failure: "reply_too_large" };
        let meta: { ContentType?: unknown; CustomAttributes?: unknown; InvokedProductionVariant?: unknown } = {};
        try { meta = JSON.parse(result.stdout) as typeof meta; } catch { meta = {}; }
        const text = (value: unknown): string | undefined => (typeof value === "string" && HEADER_VALUE.test(value) ? value : undefined);
        return { kind: "answer", body: new Uint8Array(body), contentType: text(meta.ContentType) ?? "application/octet-stream", customAttributes: text(meta.CustomAttributes), variant: text(meta.InvokedProductionVariant) };
      } catch {
        return { kind: "failed", failure: "failed" };
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
