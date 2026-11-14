// Port lane W0: the model key store. Code reads keys from a local file or the environment; Cloud adapts it to its secret store
// and its model proxy. A key never travels as a bare string through code that might log it: it is a `SecretValue`.
import { inspect } from "node:util";

const REDACTED = "[secret]";

/** A secret that prints as `[secret]` everywhere (string, JSON, console) and gives itself up only to `reveal()`. */
export class SecretValue {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface ModelKeyStore {
  /** The key a company uses for a model provider (`anthropic`, `openai`, and so on), or undefined when none is set. Code's stores ignore the company. */
  get(companyId: string, provider: string): Promise<SecretValue | undefined>;
  /** The providers that have a key for this company. Never the keys. */
  providers(companyId: string): Promise<string[]>;
}
