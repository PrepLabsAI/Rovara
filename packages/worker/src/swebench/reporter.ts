import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SwebenchRunnerConfig } from "@agentx/contracts";
import type { RunReporter } from "./run.js";

const CALLBACK_ATTEMPTS = 5;

/**
 * Reports a run to the control plane through the run's eval callback (FR-007), and stores its
 * artifacts under the run's prefix in the artifact bucket (FR-015).
 */
export function createRunReporter(
  config: SwebenchRunnerConfig,
  options: {
    s3?: Pick<S3Client, "send">;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): RunReporter {
  const s3 = options.s3 ?? new S3Client({});
  const fetchImplementation = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const base = `${config.controlPlaneUrl.replace(/\/$/, "")}/v1/internal/evals/${config.runId}`;
  // Retried: the result is the only record of a run that took an hour, and the broker applies it once.
  const post = async (path: "started" | "result", body: unknown): Promise<void> => {
    let failure = "";
    for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchImplementation(`${base}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-agentx-callback-capability": config.capability },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) return;
        failure = `HTTP ${response.status}`;
        // A refusal will not change on a retry.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (attempt < CALLBACK_ATTEMPTS) await sleep(2 ** attempt * 1_000);
    }
    throw new Error(`eval callback ${path} failed: ${failure}`);
  };
  return {
    started: () => post("started", {}),
    result: (result) => post("result", result),
    async artifact(name, body, contentType) {
      await s3.send(new PutObjectCommand({
        Bucket: config.artifactBucket,
        Key: `${config.artifactsPrefix}${name}`,
        Body: body,
        ContentType: contentType,
      }));
    },
  };
}
