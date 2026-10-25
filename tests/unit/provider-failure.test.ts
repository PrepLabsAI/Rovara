import { describe, expect, it } from "vitest";
import { E2E_MODEL_FAILURE_CLASSES, type E2EModelFailureClass } from "../../packages/contracts/src/e2e-model-channel.js";
import type { ModelProvider } from "../../packages/contracts/src/model-providers.js";
import { classifyProviderFailure } from "../../packages/model-runtime/src/provider-failure.js";

// M1.4 Task 4.10B, test 16 and 19: one assertion per cell of the plan's D-5 table, plus the precedence rules.
type Cell = [provider: ModelProvider, input: { status?: number; signal?: string | null }, expected: E2EModelFailureClass];

const BEDROCK: Cell[] = [
  ["amazon-bedrock", { signal: "ThrottlingException", status: 429 }, "limit-or-rate-limited"],
  ["amazon-bedrock", { signal: "ServiceQuotaExceededException", status: 400 }, "limit-or-rate-limited"],
  ["amazon-bedrock", { status: 429 }, "limit-or-rate-limited"],
  ["amazon-bedrock", { signal: "AccessDeniedException", status: 403 }, "key-rejected"],
  ["amazon-bedrock", { signal: "UnrecognizedClientException", status: 403 }, "key-rejected"],
  ["amazon-bedrock", { signal: "ExpiredTokenException", status: 403 }, "key-rejected"],
  ["amazon-bedrock", { status: 401 }, "key-rejected"],
  ["amazon-bedrock", { status: 403 }, "key-rejected"],
  ["amazon-bedrock", { signal: "ResourceNotFoundException", status: 404 }, "model-not-found"],
  ["amazon-bedrock", { status: 404 }, "model-not-found"],
  ["amazon-bedrock", { signal: "ValidationException", status: 400 }, "request-rejected"],
  ["amazon-bedrock", { status: 400 }, "request-rejected"],
  ["amazon-bedrock", { status: 413 }, "request-rejected"],
  ["amazon-bedrock", { status: 422 }, "request-rejected"],
  ["amazon-bedrock", { signal: "ServiceUnavailableException", status: 503 }, "provider-outage"],
  ["amazon-bedrock", { signal: "InternalServerException", status: 500 }, "provider-outage"],
  ["amazon-bedrock", { signal: "ModelNotReadyException", status: 429 }, "provider-outage"],
  ["amazon-bedrock", { signal: "ModelTimeoutException", status: 408 }, "provider-outage"],
  ["amazon-bedrock", { signal: "ModelErrorException", status: 424 }, "provider-outage"],
  ["amazon-bedrock", { status: 500 }, "provider-outage"],
  ["amazon-bedrock", { status: 502 }, "provider-outage"],
  ["amazon-bedrock", { status: 408 }, "provider-outage"],
  ["amazon-bedrock", { status: 424 }, "provider-outage"],
];
const ANTHROPIC: Cell[] = [
  ["anthropic", { signal: "rate_limit_error", status: 429 }, "limit-or-rate-limited"],
  ["anthropic", { status: 429 }, "limit-or-rate-limited"],
  ["anthropic", { signal: "authentication_error", status: 401 }, "key-rejected"],
  ["anthropic", { signal: "permission_error", status: 403 }, "key-rejected"],
  ["anthropic", { status: 401 }, "key-rejected"],
  ["anthropic", { status: 403 }, "key-rejected"],
  ["anthropic", { signal: "not_found_error", status: 404 }, "model-not-found"],
  ["anthropic", { status: 404 }, "model-not-found"],
  ["anthropic", { signal: "invalid_request_error", status: 400 }, "request-rejected"],
  ["anthropic", { signal: "request_too_large", status: 413 }, "request-rejected"],
  ["anthropic", { status: 400 }, "request-rejected"],
  ["anthropic", { status: 413 }, "request-rejected"],
  ["anthropic", { signal: "api_error", status: 500 }, "provider-outage"],
  ["anthropic", { signal: "overloaded_error", status: 529 }, "provider-outage"],
  ["anthropic", { status: 529 }, "provider-outage"],
  ["anthropic", { status: 500 }, "provider-outage"],
];
const OPENAI: Cell[] = [
  ["openai", { signal: "rate_limit_exceeded", status: 429 }, "limit-or-rate-limited"],
  ["openai", { signal: "insufficient_quota", status: 429 }, "limit-or-rate-limited"],
  ["openai", { status: 429 }, "limit-or-rate-limited"],
  ["openai", { signal: "invalid_api_key", status: 401 }, "key-rejected"],
  ["openai", { status: 401 }, "key-rejected"],
  ["openai", { status: 403 }, "key-rejected"],
  ["openai", { signal: "model_not_found", status: 404 }, "model-not-found"],
  ["openai", { status: 404 }, "model-not-found"],
  ["openai", { status: 400 }, "request-rejected"],
  ["openai", { status: 422 }, "request-rejected"],
  ["openai", { status: 500 }, "provider-outage"],
  ["openai", { status: 503 }, "provider-outage"],
];
const OPENROUTER: Cell[] = [
  ["openrouter", { status: 429 }, "limit-or-rate-limited"],
  ["openrouter", { status: 402 }, "limit-or-rate-limited"],
  ["openrouter", { status: 401 }, "key-rejected"],
  ["openrouter", { status: 404 }, "model-not-found"],
  ["openrouter", { status: 400 }, "request-rejected"],
  ["openrouter", { status: 403 }, "request-rejected"],
  ["openrouter", { status: 408 }, "provider-outage"],
  ["openrouter", { status: 502 }, "provider-outage"],
  ["openrouter", { status: 503 }, "provider-outage"],
  ["openrouter", { status: 500 }, "provider-outage"],
  ["openrouter", { signal: "429", status: 429 }, "limit-or-rate-limited"],
];

describe("16. classifyProviderFailure: every cell of the plan's table", () => {
  for (const [provider, input, expected] of [...BEDROCK, ...ANTHROPIC, ...OPENAI, ...OPENROUTER]) {
    it(`${provider} ${JSON.stringify(input)} is ${expected}`, () => {
      expect(classifyProviderFailure({ provider, ...input }).class).toBe(expected);
    });
  }

  it("covers every class that has a status or signal cell (unknown and unreachable are tested below; the two pre-send classes come from the invoke, never from a response)", () => {
    const seen = new Set([...BEDROCK, ...ANTHROPIC, ...OPENAI, ...OPENROUTER].map((cell) => cell[2]));
    expect([...seen].sort()).toEqual(E2E_MODEL_FAILURE_CLASSES.filter((item) => item !== "unknown" && item !== "unreachable" && item !== "secret-unreadable" && item !== "not-in-catalog").sort());
  });

  it("ModelNotReadyException with a 429 is an outage, not a limit (the signal is checked before the status)", () => {
    expect(classifyProviderFailure({ provider: "amazon-bedrock", signal: "ModelNotReadyException", status: 429 })).toEqual({ class: "provider-outage", signal: "ModelNotReadyException" });
  });

  it("an unknown name with 418 is unknown, and so is a call with neither a signal nor a status", () => {
    expect(classifyProviderFailure({ provider: "amazon-bedrock", signal: "TeapotException", status: 418 })).toEqual({ class: "unknown", signal: "TeapotException" });
    expect(classifyProviderFailure({ provider: "anthropic", status: 418 })).toEqual({ class: "unknown", signal: null });
    expect(classifyProviderFailure({ provider: "openai" })).toEqual({ class: "unknown", signal: null });
  });

  it("an unknown signal is decided by the status", () => {
    expect(classifyProviderFailure({ provider: "amazon-bedrock", signal: "BrandNewException", status: 429 })).toEqual({ class: "limit-or-rate-limited", signal: "BrandNewException" });
    expect(classifyProviderFailure({ provider: "openai", signal: "something_new", status: 503 })).toEqual({ class: "provider-outage", signal: "something_new" });
  });

  it("a network error with no response is unreachable, and keeps only the code", () => {
    for (const networkCode of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "CERT_SIGNATURE_FAILURE"]) {
      expect(classifyProviderFailure({ provider: "anthropic", networkCode })).toEqual({ class: "unreachable", signal: networkCode });
    }
    expect(classifyProviderFailure({ provider: "amazon-bedrock", networkCode: "ENOTFOUND" }).class).toBe("unreachable");
  });

  it("a network code outside the allow-list is not trusted, and a response beats a network code", () => {
    expect(classifyProviderFailure({ provider: "anthropic", networkCode: "EWHATEVER" })).toEqual({ class: "unknown", signal: null });
    expect(classifyProviderFailure({ provider: "anthropic", networkCode: "ECONNRESET", status: 429 }).class).toBe("limit-or-rate-limited");
  });

  it("a timeout is an outage with the signal timeout, whatever else was seen", () => {
    expect(classifyProviderFailure({ provider: "openrouter", timedOut: true })).toEqual({ class: "provider-outage", signal: "timeout" });
    expect(classifyProviderFailure({ provider: "amazon-bedrock", timedOut: true, status: 504 })).toEqual({ class: "provider-outage", signal: "timeout" });
  });
});

describe("19. a signal outside the allow-list pattern is dropped, and the status still decides", () => {
  it("Bedrock signals are letters only, at most 64", () => {
    for (const signal of ["Throttling:Exception", "Throttling Exception", "x".repeat(65), "", "Throttling-Exception", "Throttling_1"]) {
      expect(classifyProviderFailure({ provider: "amazon-bedrock", signal, status: 429 }), signal).toEqual({ class: "limit-or-rate-limited", signal: null });
    }
  });
  it("keyed signals are lower-case letters, digits and underscores, at most 64", () => {
    for (const signal of ["Rate_Limit", "rate limit error", "rate-limit", "r".repeat(65), "sk-ant-SECRETVALUE", "the model said: hello"]) {
      expect(classifyProviderFailure({ provider: "anthropic", signal, status: 429 }), signal).toEqual({ class: "limit-or-rate-limited", signal: null });
    }
  });
  it("a hostile signal with no status is unknown with no signal", () => {
    expect(classifyProviderFailure({ provider: "openai", signal: "sk-ant-SECRETVALUE" })).toEqual({ class: "unknown", signal: null });
  });
});

describe("review I-1: a captured network code with no response decides unreachable before the timeout rule", () => {
  it("timed out with an allow-listed network code and no response is unreachable", () => {
    for (const networkCode of ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ENOTFOUND", "CERT_HAS_EXPIRED"]) {
      expect(classifyProviderFailure({ provider: "anthropic", timedOut: true, networkCode })).toEqual({ class: "unreachable", signal: networkCode });
    }
    expect(classifyProviderFailure({ provider: "amazon-bedrock", timedOut: true, networkCode: "ETIMEDOUT" })).toEqual({ class: "unreachable", signal: "ETIMEDOUT" });
  });
  it("a timeout with a code outside the allow-list, or with a response, is still an outage with the signal timeout", () => {
    expect(classifyProviderFailure({ provider: "openai", timedOut: true, networkCode: "EWHATEVER" })).toEqual({ class: "provider-outage", signal: "timeout" });
    expect(classifyProviderFailure({ provider: "openai", timedOut: true, networkCode: "ETIMEDOUT", status: 504 })).toEqual({ class: "provider-outage", signal: "timeout" });
  });
});
