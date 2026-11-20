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

  it("an unknown name with 418 is unknown, and so is a call with neither a signal nor a status", () => {
    expect(classifyProviderFailure({ provider: "amazon-bedrock", signal: "TeapotException", status: 418 })).toEqual({ class: "unknown", signal: "TeapotException" });
    expect(classifyProviderFailure({ provider: "anthropic", status: 418 })).toEqual({ class: "unknown", signal: null });
    expect(classifyProviderFailure({ provider: "openai" })).toEqual({ class: "unknown", signal: null });
  });

  it("a network error with no response is unreachable, and keeps only the code", () => {
    for (const networkCode of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "CERT_SIGNATURE_FAILURE"]) {
      expect(classifyProviderFailure({ provider: "anthropic", networkCode })).toEqual({ class: "unreachable", signal: networkCode });
    }
    expect(classifyProviderFailure({ provider: "amazon-bedrock", networkCode: "ENOTFOUND" }).class).toBe("unreachable");
  });

});

