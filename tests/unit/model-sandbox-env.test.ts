// TE-F1b: the variables a sandbox gets so customer code is pointed at the model helper (te-f1 design 2.3): a base URL per row, a fixed dummy key, and Google's metadata-server variables ONLY for a project with a Vertex row. They are
// written through the env file of an exec (`withServiceEnvFile`), never the worker's own environment. The names are the catalog's allow-list; the helper's address must be .9 of a run network.
import { describe, expect, it } from "vitest";
import { MODEL_REDIRECT_ENV_NAMES, builtinModelCatalog, redactText, type CompanyGatewayRow, type ModelCatalogRow } from "@agentx/contracts";
import {
  MODEL_DUMMY_KEY, MODEL_HELPER_BASE_URL, MODEL_METADATA_PORT, ModelSandboxEnvError, buildModelSandboxEnvironment,
} from "../../packages/worker/src/model-sandbox-env.js";
import { withServiceEnvFile, type ServiceEnvironment } from "../../packages/worker/src/service-env.js";

const HELPER = "172.30.7.9";
const row = (id: string): ModelCatalogRow => builtinModelCatalog().rows.find((entry) => entry.id === id)!;
const asMap = (environment: ServiceEnvironment): Record<string, string> => Object.fromEntries(environment.entries);
const gateway = (family: CompanyGatewayRow["family"], over: Partial<CompanyGatewayRow> = {}): CompanyGatewayRow => ({ id: "corp-gw", host: "llm.gateway-example.com", family, auth: { scheme: "bearer" }, ...over });

describe("the base URL of a row", () => {
  it("is http://rovara-models:8080/p/<row> with the row's own API prefix for the clients that need it", () => {
    expect(MODEL_HELPER_BASE_URL).toBe("http://rovara-models:8080");
    expect(asMap(buildModelSandboxEnvironment({ rows: [row("gemini")], helperIp: HELPER }))["GOOGLE_GEMINI_BASE_URL"]).toBe("http://rovara-models:8080/p/gemini");
    expect(asMap(buildModelSandboxEnvironment({ rows: [row("openai")], helperIp: HELPER }))["OPENAI_BASE_URL"]).toBe("http://rovara-models:8080/p/openai/v1");
    expect(asMap(buildModelSandboxEnvironment({ rows: [row("gemini-openai")], helperIp: HELPER }))["OPENAI_BASE_URL"]).toBe("http://rovara-models:8080/p/gemini-openai/v1beta/openai");
    expect(asMap(buildModelSandboxEnvironment({ rows: [row("groq")], helperIp: HELPER }))["GROQ_BASE_URL"]).toBe("http://rovara-models:8080/p/groq/openai/v1");
    expect(asMap(buildModelSandboxEnvironment({ rows: [row("anthropic")], helperIp: HELPER }))["ANTHROPIC_BASE_URL"]).toBe("http://rovara-models:8080/p/anthropic");
    expect(asMap(buildModelSandboxEnvironment({ rows: [row("azure-openai")], helperIp: HELPER }))["AZURE_OPENAI_ENDPOINT"]).toBe("http://rovara-models:8080/p/azure-openai");
    expect(asMap(buildModelSandboxEnvironment({ rows: [row("cohere")], helperIp: HELPER }))["CO_API_URL"]).toBe("http://rovara-models:8080/p/cohere");
  });
  it("a company gateway row gets the variables of its API shape, at its own path", () => {
    expect(asMap(buildModelSandboxEnvironment({ rows: [gateway("openai_compatible", { pathPrefix: "/litellm" })], helperIp: HELPER }))).toEqual({ OPENAI_BASE_URL: "http://rovara-models:8080/p/corp-gw/litellm", OPENAI_API_KEY: MODEL_DUMMY_KEY });
    expect(asMap(buildModelSandboxEnvironment({ rows: [gateway("anthropic_messages")], helperIp: HELPER }))).toEqual({ ANTHROPIC_BASE_URL: "http://rovara-models:8080/p/corp-gw", ANTHROPIC_API_KEY: MODEL_DUMMY_KEY });
    expect(asMap(buildModelSandboxEnvironment({ rows: [gateway("gemini")], helperIp: HELPER }))).toEqual({ GOOGLE_GEMINI_BASE_URL: "http://rovara-models:8080/p/corp-gw", GEMINI_API_KEY: MODEL_DUMMY_KEY, GOOGLE_API_KEY: MODEL_DUMMY_KEY });
    expect(asMap(buildModelSandboxEnvironment({ rows: [gateway("cohere")], helperIp: HELPER }))).toEqual({ CO_API_URL: "http://rovara-models:8080/p/corp-gw", CO_API_KEY: MODEL_DUMMY_KEY });
  });
});

describe("the dummy key", () => {
  it("is one fixed non-secret string that matches no real key shape and that the redactor leaves alone", () => {
    expect(MODEL_DUMMY_KEY).toBe("rovara-test-key");
    for (const shape of [/^sk-/u, /^sk-ant-/u, /^AIza/u, /^gsk_/u, /^ya29\./u, /^xai-/u, /^[A-Za-z0-9_-]{32,}$/u, /^eyJ/u]) expect(MODEL_DUMMY_KEY).not.toMatch(shape);
    expect(redactText(`key=${MODEL_DUMMY_KEY}`)).toBe(`key=${MODEL_DUMMY_KEY}`);
  });
  it("every key variable of every built-in row is the dummy key, and no secret is registered for the redactor", () => {
    for (const entry of builtinModelCatalog().rows.filter((candidate) => candidate.redirect.some((redirect) => redirect.kind === "env_var") && candidate.family !== "bedrock")) {
      const environment = buildModelSandboxEnvironment({ rows: [entry], helperIp: HELPER, vertex: { projectId: "demo-project-1", location: "us-central1" } });
      for (const [name, value] of environment.entries) if (/_API_KEY$/u.test(name)) expect(value, `${entry.id} ${name}`).toBe(MODEL_DUMMY_KEY);
      expect(environment.secretValues).toEqual([]);
    }
  });
});

describe("Vertex", () => {
  it("sets the project, the location and the metadata-server variables (host:port of the helper) ONLY for a project with a Vertex row", () => {
    const environment = asMap(buildModelSandboxEnvironment({ rows: [row("vertex")], helperIp: HELPER, vertex: { projectId: "demo-project-1", location: "europe-west4" } }));
    expect(environment).toMatchObject({
      GOOGLE_VERTEX_BASE_URL: "http://rovara-models:8080/p/vertex", GOOGLE_CLOUD_PROJECT: "demo-project-1", GOOGLE_CLOUD_LOCATION: "europe-west4",
      GCE_METADATA_HOST: `${HELPER}:${String(MODEL_METADATA_PORT)}`, GCE_METADATA_IP: `${HELPER}:${String(MODEL_METADATA_PORT)}`, GOOGLE_API_KEY: MODEL_DUMMY_KEY,
    });
    expect(MODEL_METADATA_PORT).toBe(8081);
    for (const other of ["gemini", "openai", "anthropic", "mistral"]) {
      const names = Object.keys(asMap(buildModelSandboxEnvironment({ rows: [row(other)], helperIp: HELPER })));
      for (const name of ["GCE_METADATA_HOST", "GCE_METADATA_IP", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]) expect(names, `${other} ${name}`).not.toContain(name);
    }
  });
  it("refuses a Vertex row with no project, or with a project or location that is not plain", () => {
    expect(() => buildModelSandboxEnvironment({ rows: [row("vertex")], helperIp: HELPER })).toThrow(ModelSandboxEnvError);
    for (const projectId of ["", "A", "has space", "x\nGCE_METADATA_HOST=1.1.1.1", "UPPER-case-1", "a".repeat(31), "-start-1"]) {
      expect(() => buildModelSandboxEnvironment({ rows: [row("vertex")], helperIp: HELPER, vertex: { projectId, location: "us-central1" } }), projectId).toThrow(ModelSandboxEnvError);
    }
    for (const location of ["", "US CENTRAL", "us-central1\n", "../x", "a".repeat(41)]) expect(() => buildModelSandboxEnvironment({ rows: [row("vertex")], helperIp: HELPER, vertex: { projectId: "demo-project-1", location } }), location).toThrow(ModelSandboxEnvError);
  });
});

describe("what is refused", () => {
  it("a helper address that is not .9 of a run network", () => {
    for (const bad of ["172.30.7.8", "8.8.8.8", "172.30.7.9:8081", "", "localhost", "127.0.0.1"]) expect(() => buildModelSandboxEnvironment({ rows: [row("openai")], helperIp: bad }), bad).toThrow(ModelSandboxEnvError);
  });
  it("a row that names a variable outside the catalog's allow-list (a loader or proxy variable can never be written)", () => {
    for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "BASH_ENV", "PATH", "HTTPS_PROXY", "http_proxy", "AWS_ENDPOINT_URL"]) {
      const hostile = { ...row("openai"), redirect: [{ kind: "env_var", client: "x", names: [name], companion: [], verified: false }] } as unknown as ModelCatalogRow;
      expect(() => buildModelSandboxEnvironment({ rows: [hostile], helperIp: HELPER }), name).toThrow(ModelSandboxEnvError);
      const hostileCompanion = { ...row("openai"), redirect: [{ kind: "env_var", client: "x", names: ["OPENAI_BASE_URL"], companion: [name], verified: false }] } as unknown as ModelCatalogRow;
      expect(() => buildModelSandboxEnvironment({ rows: [hostileCompanion], helperIp: HELPER }), name).toThrow(ModelSandboxEnvError);
    }
    expect([...MODEL_REDIRECT_ENV_NAMES]).toContain("OPENAI_BASE_URL");
  });
  it("a non-Vertex row that asks for the metadata-server variables, and two rows that set one variable to two values", () => {
    const sneaky = { ...row("openai"), redirect: [{ kind: "env_var", client: "x", names: ["OPENAI_BASE_URL"], companion: ["GCE_METADATA_HOST"], verified: false }] } as unknown as ModelCatalogRow;
    expect(() => buildModelSandboxEnvironment({ rows: [sneaky], helperIp: HELPER })).toThrow(ModelSandboxEnvError);
    expect(() => buildModelSandboxEnvironment({ rows: [row("openai"), row("mistral")], helperIp: HELPER })).toThrow(ModelSandboxEnvError);
    expect(() => buildModelSandboxEnvironment({ rows: [row("openai"), row("openai")], helperIp: HELPER })).not.toThrow();
    expect(() => buildModelSandboxEnvironment({ rows: [row("openai"), row("anthropic")], helperIp: HELPER })).not.toThrow();
  });
  it("a row id that is not a plain id (it goes into a URL)", () => {
    for (const id of ["../x", "a b", "A", "x/y", "", "1abc"]) expect(() => buildModelSandboxEnvironment({ rows: [{ ...row("openai"), id }], helperIp: HELPER }), id).toThrow(ModelSandboxEnvError);
  });
  it("a Bedrock row (routed to the local AWS front, never the helper) and a row with no variable redirect add nothing and throw nothing", () => {
    expect(buildModelSandboxEnvironment({ rows: [], helperIp: HELPER }).entries).toEqual([]);
    const portkey = row("portkey");
    expect(buildModelSandboxEnvironment({ rows: [portkey], helperIp: HELPER }).entries).toEqual([]);
  });
  it("the error is one fixed sentence that never carries a value", () => {
    try {
      buildModelSandboxEnvironment({ rows: [row("openai")], helperIp: "secret-looking-value-123" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelSandboxEnvError);
      expect((error as Error).message).toBe("The model helper's environment could not be built");
      expect((error as Error).message).not.toContain("secret-looking");
    }
  });
});

describe("the entries", () => {
  it("are sorted by name, each a plain upper-case name and a printable value, and go through withServiceEnvFile (an env file, one NAME=value per line), not the process environment", async () => {
    const before = JSON.stringify(process.env);
    const environment = buildModelSandboxEnvironment({ rows: [row("openai"), row("anthropic"), row("gemini")], helperIp: HELPER });
    expect(environment.entries.map(([name]) => name)).toEqual([...environment.entries.map(([name]) => name)].sort());
    const written = new Map<string, string>();
    const used: string[][] = [];
    const files = { write: (name: string, content: string, mode: number) => { written.set(name, `${String(mode)}|${content}`); return Promise.resolve(`/run/x/${name}`); }, remove: (name: string) => { written.delete(name); return Promise.resolve(); } };
    await withServiceEnvFile(files, "model", environment, (args) => { used.push(args); expect(written.get("model.env")).toMatch(/^384\|/u); return Promise.resolve(); });
    expect(used).toEqual([["--env-file", "/run/x/model.env"]]);
    expect(written.size).toBe(0);
    expect(JSON.stringify(process.env)).toBe(before);
    for (const [name, value] of environment.entries) { expect(name).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/u); expect(value).toMatch(/^[\x21-\x7e]{1,2048}$/u); }
  });
});
