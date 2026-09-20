import type { Provider, StreamOptions } from "@earendil-works/pi-ai";

/** Trusted runtime opt-in; task/repository input cannot expand these limits. */
export function demoRunLimitsEnabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.AGENTX_DEMO_RUN_LIMITS;
  if (value === undefined || value === "0") return false;
  if (value !== "1") throw new Error("AGENTX_DEMO_RUN_LIMITS must be 0 or 1");
  // pi-ai 0.85.1 Bedrock ignores options.maxRetries when creating its SDK client.
  environment.AWS_MAX_ATTEMPTS = "1";
  return true;
}

export class DemoRunLimits {
  private calls = 0;
  private inputBytes = 0;
  private failure: Error | undefined;
  private readonly deadline = Date.now() + 180_000;
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private readonly timer = setTimeout(() => this.controller.abort(), 180_000).unref();

  dispose(): void { clearTimeout(this.timer); }

  assertActive(): void {
    if (this.failure) throw this.failure;
    if (Date.now() >= this.deadline || this.signal.aborted) this.fail("DEMO_TASK_DEADLINE");
  }

  private fail(reason: string): never {
    this.failure ??= new Error(reason);
    throw this.failure;
  }

  private reserve(payload: unknown): unknown {
    this.assertActive();
    if (this.calls >= 8) this.fail("DEMO_MODEL_CALL_LIMIT");
    if (!payload || typeof payload !== "object") this.fail("DEMO_PAYLOAD_UNSUPPORTED");
    const input = payload as Record<string, unknown>;
    if (input.modelId !== "amazon.nova-pro-v1:0" || input.additionalModelRequestFields !== undefined) {
      this.fail("DEMO_MODEL_UNSUPPORTED");
    }
    // Restrict the reservation to text/tool JSON. No binary/image/document input.
    const encoded = JSON.stringify(input, (key, value: unknown) => {
      if (["image", "document", "video"].includes(key) || ArrayBuffer.isView(value)) {
        this.fail("DEMO_PAYLOAD_UNSUPPORTED");
      }
      return value;
    });
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (this.inputBytes + bytes > 262_144) this.fail("DEMO_INPUT_LIMIT");
    this.calls += 1;
    this.inputBytes += bytes;
    // Reserve before dispatch, including failed/uncertain requests; never refund.
    return { ...input, inferenceConfig: { ...(input.inferenceConfig as object), maxTokens: 4096 } };
  }

  wrap(provider: Provider<"bedrock-converse-stream">): Provider<"bedrock-converse-stream"> {
    // Isolated demo worker only. Legacy provider construction does not touch this.
    process.env.AWS_MAX_ATTEMPTS = "1";
    const optionsFor = <T extends StreamOptions>(options?: T): T & StreamOptions => ({
      ...options, maxTokens: 4096, maxRetries: 0,
      signal: options?.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal,
      onPayload: async (payload, model) => {
        const amended = await options?.onPayload?.(payload, model);
        this.assertActive();
        if (process.env.AWS_MAX_ATTEMPTS !== "1") this.fail("DEMO_RETRY_CONFIGURATION");
        return this.reserve(amended === undefined ? payload : amended);
      },
    } as T & StreamOptions);
    return {
      ...provider,
      stream: (model, context, options) => provider.stream(model, context, optionsFor(options)),
      streamSimple: (model, context, options) => provider.streamSimple(model, context, optionsFor(options)),
    };
  }

  async run<T>(work: () => Promise<T>, abort: () => Promise<void>): Promise<T> {
    this.assertActive();
    let onAbort: () => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        this.failure ??= new Error("DEMO_TASK_DEADLINE");
        void abort().catch(() => undefined);
        reject(this.failure);
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([work(), deadline]);
      this.assertActive();
      return result;
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

}
