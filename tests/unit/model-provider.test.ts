// Port lane P5 (item K2): the `model-provider` plug-in point: the contract's rules, the built-in rows, the module helper and Bedrock as a normal provider.
import { describe, expect, it } from "vitest";
import {
  MODEL_REQUEST_FORMATS, MODEL_ROUTE_APIS, PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, PluginConfigSchema, SecretValue, assertModelProvider, isLoopbackHost, modelPriceRows, modelProviderAddressProblem,
  type ModelProviderAdapter,
} from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters } from "../../packages/broker/src/ports/adapter-registry.js";
import {
  ANTHROPIC_PROVIDER, BEDROCK_PROVIDER_ID, BUILTIN_MODEL_PROVIDERS, NATIVE_CHAT_CAPABILITIES, OPENAI_PROVIDER, OPENROUTER_PROVIDER, bedrockModelProvider, bedrockModelProviderPlugin,
  modelProviderPlugin, registerBuiltinModelProviders,
} from "../../packages/broker/src/plugins/model-provider/index.js";
import { AWS_MODULE_MISSING, AwsCredentialSetupError, createAwsCredentialSource, describeBedrockSettings, assertBuiltinIdsKept, type AwsCredentialLoaders } from "../../packages/broker/src/plugins/model-provider/index.js";

const gateway: ModelProviderAdapter = {
  kind: "company-gateway", name: "Company gateway", address: "https://models.example.test/v1", signIn: { kind: "bearer-key" },
  formats: [{ format: "openai-completions", pathOverride: "/chat/completions", capabilities: NATIVE_CHAT_CAPABILITIES }],
};

describe("the model-provider point", () => {
  it("is a plug-in point that holds many providers, and the request formats are the worker's three", () => {
    expect(PLUGIN_POINTS).toContain("model-provider");
    expect(PLUGIN_POINT_CARDINALITY["model-provider"]).toBe("many");
    expect([...MODEL_REQUEST_FORMATS].sort()).toEqual([...MODEL_ROUTE_APIS].sort());
  });

  it("registers the built-in rows as defaults that a configured provider of the same name replaces", () => {
    const registry = createAdapterRegistry();
    registerBuiltinModelProviders(registry);
    expect(registry.names("model-provider")).toEqual(["anthropic", "openai", "openrouter"]);
    const replacement: ModelProviderAdapter = { ...ANTHROPIC_PROVIDER, name: "Anthropic through the gateway", address: "https://gateway.example.test" };
    registry.register("model-provider", "anthropic", replacement);
    expect(registry.require("model-provider", "anthropic").name).toBe("Anthropic through the gateway");
    expect(() => registry.register("model-provider", "company-gateway", { ...gateway, kind: "other" })).toThrow(/kind must be the name/u);
  });

  it("keeps the built-in rows to their address, sign-in and request format", () => {
    expect(Object.fromEntries(BUILTIN_MODEL_PROVIDERS.map((provider) => [provider.kind, provider.address]))).toEqual({ anthropic: "https://api.anthropic.com", openai: "https://api.openai.com", openrouter: "https://openrouter.ai/api" });
    expect(ANTHROPIC_PROVIDER.signIn).toEqual({ kind: "named-header", header: "x-api-key" });
    expect(OPENAI_PROVIDER.signIn).toEqual({ kind: "bearer-key" });
    expect(OPENROUTER_PROVIDER.formats.map((entry) => entry.format)).toEqual(["openai-completions"]);
    expect(BUILTIN_MODEL_PROVIDERS).toHaveLength(3);
  });
});

describe("what makes a provider valid", () => {
  it("accepts a company gateway over https, and a model on this computer over plain http", () => {
    expect(assertModelProvider(gateway)).toBe(gateway);
    const local: ModelProviderAdapter = { ...gateway, kind: "local-llm", address: "http://localhost:11434", signIn: { kind: "none" } };
    expect(assertModelProvider(local)).toBe(local);
  });

  it.each([
    ["an http address that is not this computer", { address: "http://models.example.test" }, /https/u],
    ["a user name in the address", { address: "https://user:pass@models.example.test" }, /user name/u],
    ["a query in the address", { address: "https://models.example.test/v1?key=1" }, /query/u],
    ["a file address", { address: "file:///etc/passwd" }, /https/u],
    ["no sign-in for a remote address", { signIn: { kind: "none" } }, /on this computer/u],
    ["an id with capitals", { kind: "Company" }, /provider id/u],
    ["a format listed twice", { formats: [gateway.formats[0], gateway.formats[0]] }, /twice/u],
    ["a path that walks up", { formats: [{ ...gateway.formats[0], pathOverride: "/a/../b" }] }, /\.\./u],
    ["a path with a query", { formats: [{ ...gateway.formats[0], pathOverride: "/chat?x=1" }] }, /path/u],
    ["the vertex variant on the chat format", { formats: [{ ...gateway.formats[0], variant: "vertex" }] }, /anthropic-messages/u],
    ["an extra field", { apiKey: "inline" }, undefined],
  ])("refuses %s", (_name, change, message) => {
    const provider = { ...gateway, ...change } as unknown as ModelProviderAdapter;
    if (message === undefined) expect(() => assertModelProvider(provider)).toThrow();
    else expect(() => assertModelProvider(provider)).toThrow(message);
  });

  it.each(["authorization", "x-api-key-override", "anthropic-beta", "content-type", "host", "x-litellm-key", "x-rovara-workspace"])("refuses %s as the sign-in header", (header) => {
    expect(() => assertModelProvider({ ...gateway, signIn: { kind: "named-header", header } })).toThrow();
  });

  it("takes the named header a cloud uses", () => {
    for (const header of ["api-key", "x-api-key", "x-goog-api-key"]) expect(assertModelProvider({ ...gateway, signIn: { kind: "named-header", header } }).kind).toBe("company-gateway");
  });

  it("never puts a secret in its words", () => {
    const secret = ["sk", "test", "never", "real", "0123456789"].join("-");
    try {
      assertModelProvider({ ...gateway, name: "", address: `https://${secret}@models.example.test` });
      throw new Error("should not pass");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });

  it("reads loopback hosts and refuses lookalikes", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "LOCALHOST"]) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ["localhost.example.test", "127.0.0.1.example.test", "10.0.0.1", "0.0.0.0"]) expect(isLoopbackHost(host), host).toBe(false);
    expect(modelProviderAddressProblem("http://127.0.0.1.example.test")).toMatch(/https/u);
  });
});

describe("the module helper", () => {
  it("makes a plug-in whose name is the provider id, and lets settings change the address, name, default model and prices only", async () => {
    const plugin = modelProviderPlugin(gateway);
    expect(plugin).toMatchObject({ point: "model-provider", name: "company-gateway" });
    const registry = createAdapterRegistry();
    await loadAdapters(
      PluginConfigSchema.parse({ version: 1, plugins: [{ point: "model-provider", name: "company-gateway", module: "./gateway.mjs", settings: { address: "https://other.example.test/v2", defaultModel: "house-model", prices: { currency: "USD", models: { "house-model": { inputMicrosPerMillionTokens: 5, outputMicrosPerMillionTokens: 6 } } } } }] }),
      { registry, importModule: async () => ({ plugin }) },
    );
    const provider = registry.require("model-provider", "company-gateway");
    expect(provider).toMatchObject({ address: "https://other.example.test/v2", defaultModel: "house-model", signIn: { kind: "bearer-key" } });
    expect(provider.prices?.models["house-model"]?.outputMicrosPerMillionTokens).toBe(6);
  });

  it("refuses a setting that would change the sign-in, a plain-http address, and an unknown setting", async () => {
    const plugin = modelProviderPlugin(gateway);
    for (const settings of [{ signIn: { kind: "none" } }, { address: "http://models.example.test" }, { apiKey: "inline" }]) {
      const registry = createAdapterRegistry();
      await expect(loadAdapters(
        PluginConfigSchema.parse({ version: 1, plugins: [{ point: "model-provider", name: "company-gateway", module: "./gateway.mjs", settings }] }),
        { registry, importModule: async () => ({ plugin }) },
      ), JSON.stringify(settings)).rejects.toMatchObject({ code: expect.stringMatching(/create_failed|bad_config/u) as string });
    }
  });

});

describe("Bedrock as a normal provider", () => {
  const credentials = async () => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "wJalrXUtnFEMI-never-real", sessionToken: "token-never-real" });

  it("signs with SigV4 in its region, speaks messages for Claude and chat for open models, and is a valid provider", () => {
    const provider = assertModelProvider(bedrockModelProvider({ region: "us-west-2", credentials }));
    expect(provider).toMatchObject({ kind: BEDROCK_PROVIDER_ID, address: "https://bedrock-runtime.us-west-2.amazonaws.com", signIn: { kind: "aws-sigv4", region: "us-west-2", service: "bedrock" } });
    expect(provider.formats.map((entry) => [entry.format, entry.pathOverride, entry.capabilities.forcedToolChoice])).toEqual([
      ["anthropic-messages", "/anthropic/v1/messages", false],
      ["openai-completions", "/openai/v1/chat/completions", false],
    ]);
  });

  it("resolves its credential at each call, as JSON a signer reads, and falls back to the key file when there is no role", async () => {
    const provider = bedrockModelProvider({ region: "us-west-2", credentials });
    expect(JSON.parse((await provider.credential!())!.reveal())).toEqual({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "wJalrXUtnFEMI-never-real", sessionToken: "token-never-real" });
    expect(String(await provider.credential!())).toBe("[secret]");
    const none = bedrockModelProvider({ region: "us-west-2", credentials: async () => { throw new Error(`AWS said no for ${"AKIAEXAMPLE"}`); } });
    expect(await none.credential!()).toBeUndefined();
  });

  it("is loaded from a config entry with a region, and refuses a bad region", async () => {
    const registry = createAdapterRegistry();
    await loadAdapters(
      PluginConfigSchema.parse({ version: 1, plugins: [{ point: "model-provider", name: "amazon-bedrock", module: "./bedrock.mjs", settings: { region: "eu-west-1", profile: "rovara-bedrock", defaultModel: "anthropic.claude-test-v1:0" } }] }),
      { registry, importModule: async () => ({ plugin: bedrockModelProviderPlugin({ credentials }) }) },
    );
    expect(registry.require("model-provider", "amazon-bedrock")).toMatchObject({ address: "https://bedrock-runtime.eu-west-1.amazonaws.com", defaultModel: "anthropic.claude-test-v1:0" });
    const bad = createAdapterRegistry();
    await expect(loadAdapters(
      PluginConfigSchema.parse({ version: 1, plugins: [{ point: "model-provider", name: "amazon-bedrock", module: "./bedrock.mjs", settings: { region: "somewhere", profile: "rovara-bedrock" } }] }),
      { registry: bad, importModule: async () => ({ plugin: bedrockModelProviderPlugin({ credentials }) }) },
    )).rejects.toMatchObject({ code: "bad_config" });
  });

  it("loads the AWS default provider chain only when asked for a credential (the module can be imported with no AWS)", async () => {
    const provider = bedrockModelProvider({ region: "us-west-2", identity: { kind: "ambient" } });
    expect(typeof provider.credential).toBe("function");
    expect(new SecretValue("x").reveal()).toBe("x");
  });
});

describe("Bedrock needs an AWS identity the owner named (review M1)", () => {
  const credentials = async () => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret-never-real" });
  const load = (settings: Record<string, unknown>) => loadAdapters(
    PluginConfigSchema.parse({ version: 1, plugins: [{ point: "model-provider", name: "amazon-bedrock", module: "./bedrock.mjs", settings }] }),
    { registry: createAdapterRegistry(), importModule: async () => ({ plugin: bedrockModelProviderPlugin({ credentials }) }) },
  );
  const role = "arn:aws:iam::123456789012:role/rovara-bedrock";

  it("takes a profile, a role, or the explicit opt-in to the default chain", async () => {
    for (const identity of [{ profile: "rovara-bedrock" }, { roleArn: role }, { allowAmbientAwsCredentials: true }]) await expect(load({ region: "us-west-2", ...identity }), JSON.stringify(identity)).resolves.toBeUndefined();
    await expect(load({ region: "us-west-2", roleArn: "not-an-arn" })).rejects.toThrow();
  });

  it("describes the identity for rovara up --check without loading anything", () => {
    expect(describeBedrockSettings({ region: "us-west-2", profile: "rovara-bedrock" })).toEqual({ ok: true, identity: 'the AWS profile "rovara-bedrock"', priced: false });
    expect(describeBedrockSettings({ region: "us-west-2", roleArn: role })).toMatchObject({ ok: true, identity: expect.stringContaining(role) as string });
    expect(describeBedrockSettings({ region: "us-west-2", allowAmbientAwsCredentials: true })).toMatchObject({ ok: true, identity: expect.stringContaining("you opted in") as string });
    expect(describeBedrockSettings({ region: "us-west-2", profile: "p", prices: { currency: "USD", models: { m: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 } } } })).toMatchObject({ ok: true, priced: true });
    expect(describeBedrockSettings({ region: "us-west-2" })).toMatchObject({ ok: false });
  });

  it("will not build a provider with no identity and no credential function", () => {
    expect(() => bedrockModelProvider({ region: "us-west-2" })).toThrow(/identity/u);
  });
});

describe("the AWS credential source (review L1, L2)", () => {
  const value = (expiration?: Date) => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret-never-real", ...(expiration === undefined ? {} : { expiration }) });
  const loaders = (calls: { built: string[]; asked: number }, make: () => Promise<ReturnType<typeof value>>): AwsCredentialLoaders => {
    const provider = async () => { calls.asked += 1; return make(); };
    return {
      async profile(profile) { calls.built.push(`profile:${profile}`); return provider; },
      async ambient() { calls.built.push("ambient"); return provider; },
      async role(roleArn, region) { calls.built.push(`role:${roleArn}:${region}`); return provider; },
    };
  };

  it("builds the provider once and caches the credential until a minute before it expires", async () => {
    let now = 1_000_000;
    const calls = { built: [] as string[], asked: 0 };
    const source = createAwsCredentialSource({ kind: "role", roleArn: "arn:aws:iam::123456789012:role/r" }, "us-west-2", { loaders: loaders(calls, async () => value(new Date(now + 15 * 60_000))), now: () => now });
    await source.resolve(); await source.resolve(); await source.resolve();
    expect(calls).toEqual({ built: ["role:arn:aws:iam::123456789012:role/r:us-west-2"], asked: 1 });
    now += 14 * 60_000 + 1;
    await source.resolve();
    expect(calls.asked).toBe(2);
    expect(calls.built).toHaveLength(1);
  });

  it("says 'AWS credential module missing' for a module that cannot be loaded, not that the owner should sign in, and tries again next time", async () => {
    let missing = true;
    const calls = { built: [] as string[], asked: 0 };
    const source = createAwsCredentialSource({ kind: "ambient" }, "us-west-2", { loaders: {
      async profile() { throw new Error("n/a"); }, async role() { throw new Error("n/a"); },
      async ambient() { if (missing) throw new AwsCredentialSetupError(AWS_MODULE_MISSING); return loaders(calls, async () => value()).ambient(); },
    } });
    await expect(source.resolve()).rejects.toThrow(AWS_MODULE_MISSING);
    expect(source.problem()).toBe("AWS credential module missing");
    missing = false;
    await expect(source.resolve()).resolves.toMatchObject({ accessKeyId: "AKIAEXAMPLE" });
    expect(source.problem()).toBeUndefined();
  });

  it("gives a fixed sentence per identity for any other failure, never the SDK's words", async () => {
    const secret = "AKIASECRETWORDS";
    for (const [identity, sentence] of [
      [{ kind: "profile", profile: "p" }, "the AWS profile named in your config could not be used"],
      [{ kind: "role", roleArn: "arn:aws:iam::123456789012:role/r" }, "the AWS role named in your config could not be assumed"],
      [{ kind: "ambient" }, "no AWS credentials were found on this computer"],
    ] as const) {
      const source = createAwsCredentialSource(identity, "us-west-2", { loaders: loaders({ built: [], asked: 0 }, async () => { throw new Error(`boom ${secret}`); }) });
      await expect(source.resolve()).rejects.toThrow(sentence);
      expect(source.problem()).toBe(sentence);
      expect(String(source.problem())).not.toContain(secret);
    }
  });

  it("is what the Bedrock provider reports as its problem", async () => {
    const provider = bedrockModelProvider({ region: "us-west-2", identity: { kind: "profile", profile: "p" }, loaders: loaders({ built: [], asked: 0 }, async () => { throw new Error("x"); }) });
    expect(await provider.credential!()).toBeUndefined();
    expect(provider.credentialProblem!()).toBe("the AWS profile named in your config could not be used");
  });
});

describe("prices of zero (review L3)", () => {
  const priced = (price: Record<string, unknown>) => ({ ...gateway, prices: { currency: "USD", models: { m: price } } });
  it("are refused unless the model is marked free, and a free model has every price 0", () => {
    expect(() => assertModelProvider(priced({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 }) as unknown as ModelProviderAdapter)).toThrow(/price of 0/u);
    expect(() => assertModelProvider(priced({ inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 0 }) as unknown as ModelProviderAdapter)).toThrow(/price of 0/u);
    expect(() => assertModelProvider(priced({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, free: true }) as unknown as ModelProviderAdapter)).not.toThrow();
    expect(() => assertModelProvider(priced({ inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 0, free: true }) as unknown as ModelProviderAdapter)).toThrow(/free/u);
    expect(() => assertModelProvider(priced({ inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 }) as unknown as ModelProviderAdapter)).not.toThrow();
  });
  it("drops the free mark before the price reaches the metering table", () => {
    const rows = modelPriceRows([{ ...gateway, prices: { currency: "USD", models: { m: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, free: true } } } }]);
    expect(rows.models["company-gateway/m"]).toEqual({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
  });
});

describe("provider ids and AWS hosts (review L4, L6)", () => {
  it("refuses ids that belong to other parts of Rovara", () => {
    for (const kind of ["github", "linear", "slack", "jira"]) expect(() => assertModelProvider({ ...gateway, kind }), kind).toThrow(/another part of Rovara/u);
  });

  it("lets a plug-in of a built-in's id change its name and prices, but not where it is or how it signs in", () => {
    expect(() => assertBuiltinIdsKept({ ...ANTHROPIC_PROVIDER, name: "Anthropic, priced", prices: { currency: "USD", models: { m: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 } } } })).not.toThrow();
    expect(() => assertBuiltinIdsKept({ ...ANTHROPIC_PROVIDER, address: "https://elsewhere.example.test" })).toThrow(/another address/u);
    expect(() => assertBuiltinIdsKept({ ...OPENAI_PROVIDER, signIn: { kind: "named-header", header: "api-key" } })).toThrow(/another way/u);
    expect(() => assertBuiltinIdsKept({ ...gateway, kind: "amazon-bedrock" })).toThrow(/Bedrock/u);
    const aws = (address: string): ModelProviderAdapter => ({ ...gateway, kind: "amazon-bedrock", address, signIn: { kind: "aws-sigv4", region: "us-west-2", service: "bedrock" } });
    expect(() => assertBuiltinIdsKept(aws("https://bedrock-runtime.us-west-2.amazonaws.com"))).not.toThrow();
    expect(() => assertBuiltinIdsKept(aws("https://bedrock-runtime-fips.us-west-2.amazonaws.com"))).not.toThrow();
    for (const address of ["https://bedrock-runtime.s3.us-west-2.amazonaws.com", "https://bedrock-runtime.evil.us-west-2.amazonaws.com", "https://bedrock-runtime.us-east-1.amazonaws.com", "https://x.bedrock-runtime.us-west-2.amazonaws.com"]) {
      expect(() => assertBuiltinIdsKept(aws(address)), address).toThrow(/signing region/u);
    }
    expect(() => assertBuiltinIdsKept(bedrockModelProvider({ region: "us-west-2", credentials: async () => ({ accessKeyId: "A", secretAccessKey: "S" }) }))).not.toThrow();
  });

  it("refuses to move a built-in's address through the settings", async () => {
    const registry = createAdapterRegistry();
    await expect(loadAdapters(
      PluginConfigSchema.parse({ version: 1, plugins: [{ point: "model-provider", name: "anthropic", module: "./a.mjs", settings: { address: "https://elsewhere.example.test" } }] }),
      { registry, importModule: async () => ({ plugin: modelProviderPlugin(ANTHROPIC_PROVIDER) }) },
    )).rejects.toMatchObject({ code: "bad_config" });
  });

  it("sends an AWS sign-in only to https *.amazonaws.com in the signing region", () => {
    const aws = (address: string, region = "us-west-2"): ModelProviderAdapter => ({ ...gateway, kind: "aws-gateway", address, signIn: { kind: "aws-sigv4", region, service: "bedrock" } });
    expect(() => assertModelProvider(aws("https://bedrock-runtime.us-west-2.amazonaws.com"))).not.toThrow();
    expect(() => assertModelProvider(aws("https://bedrock-runtime.cn-north-1.amazonaws.com.cn", "cn-north-1"))).not.toThrow();
    for (const address of ["https://models.example.test", "https://amazonaws.com.example.test", "https://bedrock-runtime.us-east-1.amazonaws.com", "http://127.0.0.1:9", "https://evil-amazonaws.com", "https://bedrock-runtime.us-west-2.example.test"]) {
      expect(() => assertModelProvider(aws(address)), address).toThrow();
    }
  });
});
