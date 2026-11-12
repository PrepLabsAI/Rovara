// Convergence lane A3 (owner decision 72, O2): the Secrets Manager `secrets` adapter passes Code's conformance suite over a faithful stand-in, reads only under its prefix, reads a company's
// own secret only for that company, and never lets a value or the service's own words into an error.
import { describe, expect, it } from "vitest";
import { SecretValue } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { LocalSecretError } from "../../packages/broker/src/ports/secret-error.js";
import { createSecretsManagerSecretStore, isAwsSecretName, SecretsManagerSecretError } from "../../packages/aws-adapters/src/secrets-manager/index.js";
import { SecretsManagerSettingsSchema, secretsManagerSecretsPlugin } from "../../packages/broker/src/plugins/secrets/aws-secrets-manager/plugin.js";
import { FakeSecretsManager } from "../support/ports/aws-fakes.js";
import { runSecretStoreConformance } from "../support/ports/secret-store-conformance.js";

const COMPANY = "org_00000000000000000000";
const OTHER = "org_11111111111111111111";
const PREFIX = "agentx/staging/";

runSecretStoreConformance("AWS Secrets Manager", {
  async create() {
    const service = new FakeSecretsManager();
    return {
      store: createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: () => service }),
      ref: { awsSecret: "github-app/private-key" },
      unknownRef: { env: "GITHUB_TOKEN" },
      set: async (ref, value) => service.set(`${PREFIX}${ref.awsSecret!}`, value),
    };
  },
});

runSecretStoreConformance("AWS Secrets Manager, a company's own secret", {
  async create() {
    const service = new FakeSecretsManager();
    return {
      store: createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: () => service, companyPaths: ["org-connectors"] }),
      ref: { awsSecret: `org-connectors/${"org_00000000000000000000"}/conn-1` },
      unknownRef: { file: "/etc/hosts" },
      set: async (ref, value) => service.set(`${PREFIX}${ref.awsSecret!}`, value),
    };
  },
});

describe("Secrets Manager secrets: names", () => {
  it("reads the prefix plus the reference, the hosted product's own name, so no secret moves", async () => {
    const service = new FakeSecretsManager();
    service.set(`${PREFIX}org-connectors/${COMPANY}/conn-1`, "  the-value\n");
    const store = createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: () => service, companyPaths: ["org-connectors", "org-hooks"] });
    const read = await store.read(COMPANY, { awsSecret: `org-connectors/${COMPANY}/conn-1` });
    expect(read).toBeInstanceOf(SecretValue);
    expect(read?.reveal()).toBe("the-value");
    expect(service.reads).toEqual([`${PREFIX}org-connectors/${COMPANY}/conn-1`]);
  });

  it("refuses a name that could leave the prefix, before asking AWS", async () => {
    const service = new FakeSecretsManager();
    const store = createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: () => service });
    for (const value of ["../prod/x", "a/../../b", "/abs", "a//b", "a/", ".", "a b", "a\u0000b", "x".repeat(600), "a/./b"]) {
      await expect(store.read(COMPANY, { awsSecret: value }), JSON.stringify(value)).rejects.toBeInstanceOf(SecretsManagerSecretError);
    }
    expect(service.reads).toEqual([]);
    expect(isAwsSecretName("rovara/model-endpoints/org_1/src-1")).toBe(true);
  });

  it("reads a company's own secret only for that company", async () => {
    const service = new FakeSecretsManager();
    service.set(`${PREFIX}org-connectors/${OTHER}/conn-1`, "other-company-value");
    const store = createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: () => service, companyPaths: ["org-connectors", "org-hooks"] });
    for (const value of [`org-connectors/${OTHER}/conn-1`, `org-hooks/${OTHER}/hook`, "org-connectors/conn-1", `org-connectors/${COMPANY}`]) {
      const error = await store.read(COMPANY, { awsSecret: value }).catch((caught: unknown) => caught);
      expect(error, value).toBeInstanceOf(SecretsManagerSecretError);
      expect(String((error as Error).message)).not.toContain(OTHER);
    }
    expect(service.reads).toEqual([]);
    expect((await store.read(OTHER, { awsSecret: `org-connectors/${OTHER}/conn-1` }))?.reveal()).toBe("other-company-value");
  });

  it("asks for the client of the call's company, so a deployment can sign each company's reads with that company's session", async () => {
    const services = new Map([[COMPANY, new FakeSecretsManager()], [OTHER, new FakeSecretsManager()]]);
    services.get(COMPANY)!.set(`${PREFIX}shared`, "one");
    services.get(OTHER)!.set(`${PREFIX}shared`, "two");
    const asked: string[] = [];
    const store = createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: (companyId) => { asked.push(companyId); return services.get(companyId)!; } });
    expect((await store.read(COMPANY, { awsSecret: "shared" }))?.reveal()).toBe("one");
    expect((await store.read(OTHER, { awsSecret: "shared" }))?.reveal()).toBe("two");
    expect(asked).toEqual([COMPANY, OTHER]);
  });

  it("refuses a bad prefix or company path when it is built", () => {
    for (const namePrefix of ["agentx", "/agentx/", "../", "agentx//"]) expect(() => createSecretsManagerSecretStore({ namePrefix, clientFor: () => new FakeSecretsManager() }), namePrefix).toThrow(SecretsManagerSecretError);
    expect(() => createSecretsManagerSecretStore({ namePrefix: "", clientFor: () => new FakeSecretsManager(), companyPaths: ["a/b"] })).toThrow(SecretsManagerSecretError);
    expect(() => createSecretsManagerSecretStore({ namePrefix: "", clientFor: () => new FakeSecretsManager() })).not.toThrow();
  });
});

describe("Secrets Manager secrets: failures say nothing about the secret", () => {
  const value = ["very", "private", "value"].join("-");
  const name = "connections/acme-like-name";

  it("answers undefined for a missing secret, one scheduled for deletion, or an empty one", async () => {
    const service = new FakeSecretsManager();
    service.secrets.set(`${PREFIX}gone`, { string: value, deleted: true });
    service.secrets.set(`${PREFIX}empty`, { string: "   " });
    const store = createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: () => service });
    expect(await store.read(COMPANY, { awsSecret: "missing" })).toBeUndefined();
    expect(await store.read(COMPANY, { awsSecret: "gone" })).toBeUndefined();
    expect(await store.read(COMPANY, { awsSecret: "empty" })).toBeUndefined();
  });

  it("turns a refusal, a KMS failure, a binary secret and an outage into fixed sentences that quote neither the name nor the value", async () => {
    const service = new FakeSecretsManager();
    service.secrets.set(`${PREFIX}${name}-denied`, { string: value, denied: true });
    service.secrets.set(`${PREFIX}${name}-kms`, { string: value, undecryptable: true });
    service.secrets.set(`${PREFIX}${name}-binary`, { binary: new Uint8Array(Buffer.from(value)) });
    const store = createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: () => service });
    const sentences: string[] = [];
    for (const suffix of ["-denied", "-kms", "-binary"]) {
      const error = await store.read(COMPANY, { awsSecret: `${name}${suffix}` }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SecretsManagerSecretError);
      sentences.push((error as Error).message);
    }
    service.failing = true;
    const outage = await store.read(COMPANY, { awsSecret: `${name}-denied` }).catch((caught: unknown) => caught);
    expect(outage).toBeInstanceOf(SecretsManagerSecretError);
    sentences.push((outage as Error).message);
    expect(sentences).toEqual([
      "the secrets service refused to read this secret",
      "the secret could not be decrypted (check the key policy of the secret's KMS key)",
      "the secret is not text",
      "the secrets service could not be reached",
    ]);
    for (const sentence of sentences) {
      expect(sentence).not.toContain("acme");
      expect(sentence).not.toContain(value);
      expect(sentence).not.toContain(PREFIX);
    }
  });

  it("turns a client that cannot be built into the outage sentence", async () => {
    const store = createSecretsManagerSecretStore({ namePrefix: PREFIX, clientFor: () => { throw new Error(`AssumeRole failed for arn:aws:iam::123456789012:role/${name}`); } });
    await expect(store.read(COMPANY, { awsSecret: "x" })).rejects.toThrow(/^the secrets service could not be reached$/u);
  });
});

describe("Secrets Manager secrets: the plug-in", () => {
  const importer = (service: FakeSecretsManager): ModuleImporter => async () => ({ plugin: secretsManagerSecretsPlugin({ clientFor: () => service }) });

  it("is opt-in, needs one AWS identity and a prefix, and is the registry's secrets adapter once named", async () => {
    expect(SecretsManagerSettingsSchema.safeParse({ region: "us-west-2", namePrefix: "rovara/" }).success).toBe(false);
    expect(SecretsManagerSettingsSchema.safeParse({ region: "us-west-2", profile: "p" }).success).toBe(false);
    expect(SecretsManagerSettingsSchema.safeParse({ region: "us-west-2", profile: "p", namePrefix: "rovara" }).success).toBe(false);
    expect(SecretsManagerSettingsSchema.safeParse({ region: "us-west-2", roleArn: "arn:aws:iam::123456789012:role/rovara-secrets", namePrefix: "rovara/", companyPaths: ["org-connectors"] }).success).toBe(true);
    const service = new FakeSecretsManager();
    service.set("rovara/github", "token-value");
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "secrets", name: "aws-secrets-manager", module: "@agentx/broker/plugins/secrets-aws", settings: { region: "us-west-2", profile: "rovara-secrets", namePrefix: "rovara/" } }] }), { registry, importModule: importer(service) });
    const store = registry.require("secrets");
    expect((await store.read(COMPANY, { awsSecret: "github" }))?.reveal()).toBe("token-value");
    expect(await store.read(COMPANY, { env: "HOME" })).toBeUndefined();
    // Its refusals reach callers as Code's own LocalSecretError (shown as they are), with the same fixed sentence.
    service.secrets.set("rovara/denied", { string: "x", denied: true });
    const error = await store.read(COMPANY, { awsSecret: "denied" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalSecretError);
    expect((error as Error).message).toBe("the secrets service refused to read this secret");
    await expect(store.read(COMPANY, { awsSecret: "../x" })).rejects.toBeInstanceOf(LocalSecretError);
    await store.close?.();
  });
});
