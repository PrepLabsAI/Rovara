// Setup and test health SH4: the setup recipe contract and its fingerprint (match and miss; no repository names inside).
import { describe, expect, it } from "vitest";
import {
  SETUP_MARKER_FILES, SetupRecipeBodySchema, markerFilesOf, parseSetupRecipeSource, recipeFits, recipeNamesRepository, setupFingerprint, setupRecipeDigest, setupRecipeSource, type SetupRecipeBody,
} from "@agentx/contracts";

const cmd = (executable: string, args: string[] = [], cwd = "{repo}") => ({ cwd, executable, args, timeoutSeconds: 600 });
const recipe = (): SetupRecipeBody => SetupRecipeBodySchema.parse({
  schemaVersion: 1,
  label: "Python services",
  buildSystems: ["python"],
  toolchains: [{ tool: "python", version: "3.12" }],
  setupCommands: [cmd("uv", ["sync", "--frozen"])],
  updateCommands: [cmd("uv", ["sync", "--frozen"])],
  checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"], "{repo}/tests"), kind: "test", reportPath: "{repo}/reports/junit.xml", selectArgs: ["{tests}"] }],
  approvedHosts: ["Pypi.Internal.Example.com"],
  devcontainerBaseImage: "mcr.microsoft.com/devcontainers/python:3.12",
  match: { markerFiles: ["pyproject.toml", "requirements.txt"], registryHosts: ["pypi.internal.example.com"] },
});

describe("fingerprint", () => {
  it("is a sha256 hex, the same whatever the order or case of the inputs", () => {
    const one = setupFingerprint({ markerFiles: ["pyproject.toml", "requirements.txt"], registryHosts: ["a.example.com", "b.example.com"] });
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(setupFingerprint({ markerFiles: ["requirements.txt", "pyproject.toml", "pyproject.toml"], registryHosts: ["B.example.com", "a.EXAMPLE.com", "a.example.com"] })).toBe(one);
  });

  it("misses when a marker file or a registry host differs", () => {
    const base = setupFingerprint({ markerFiles: ["pyproject.toml"], registryHosts: ["a.example.com"] });
    expect(setupFingerprint({ markerFiles: ["pyproject.toml", "setup.py"], registryHosts: ["a.example.com"] })).not.toBe(base);
    expect(setupFingerprint({ markerFiles: ["package.json"], registryHosts: ["a.example.com"] })).not.toBe(base);
    expect(setupFingerprint({ markerFiles: ["pyproject.toml"], registryHosts: ["b.example.com"] })).not.toBe(base);
    expect(setupFingerprint({ markerFiles: ["pyproject.toml"], registryHosts: [] })).not.toBe(base);
  });

  it("takes only known marker files: a stray file name (which could be a repository name) is refused", () => {
    expect(() => setupFingerprint({ markerFiles: ["orders-service.iml"], registryHosts: [] })).toThrow();
    expect(() => setupFingerprint({ markerFiles: [], registryHosts: [] })).toThrow();
  });

  it("refuses a host that is an IP literal, a wildcard or a bare label", () => {
    for (const host of ["10.0.0.5", "*.example.com", "localhost", "https://a.example.com"]) expect(() => setupFingerprint({ markerFiles: ["go.mod"], registryHosts: [host] })).toThrow();
  });

  it("carries nothing of the repository's name: markers are taken by file name, directories dropped", () => {
    expect(markerFilesOf(["services/orders-service/pyproject.toml", "orders-service/README.md", "orders-service.iml", "go.mod", "pkg/go.mod"])).toEqual(["go.mod", "pyproject.toml"]);
    const a = setupFingerprint({ markerFiles: markerFilesOf(["orders-service/pyproject.toml"]), registryHosts: [] });
    const b = setupFingerprint({ markerFiles: markerFilesOf(["billing-engine/sub/pyproject.toml"]), registryHosts: [] });
    expect(a).toBe(b);
  });

  it("lists the markers the detectors key on", () => {
    for (const name of ["package.json", "pyproject.toml", "pom.xml", "build.gradle", "Config", "go.mod"]) expect(SETUP_MARKER_FILES).toContain(name);
  });
});

describe("recipeFits", () => {
  it("fits a repository with the same marker files and registry hosts only", () => {
    expect(recipeFits(recipe(), { markerFiles: ["requirements.txt", "pyproject.toml"], registryHosts: ["PYPI.internal.example.com"] })).toBe(true);
    expect(recipeFits(recipe(), { markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"] })).toBe(false);
    expect(recipeFits(recipe(), { markerFiles: ["requirements.txt", "pyproject.toml"], registryHosts: [] })).toBe(false);
  });

  it("fits nothing, without throwing, when the repository's input does not parse", () => {
    expect(recipeFits(recipe(), { markerFiles: [], registryHosts: [] })).toBe(false);
    expect(recipeFits(recipe(), { markerFiles: ["pyproject.toml"], registryHosts: ["10.1.1.1"] })).toBe(false);
  });
});

describe("recipe body", () => {
  it("accepts a recipe and lower-cases its hosts", () => {
    expect(recipe().approvedHosts).toEqual(["pypi.internal.example.com"]);
  });

  it("has no place for secrets, accounts, seeds or a repository name (strict)", () => {
    const body = recipe();
    for (const extra of [{ secretNames: ["TOKEN"] }, { accounts: [] }, { seeds: [] }, { repositoryId: "svc" }, { repositoryName: "acme/svc" }]) expect(SetupRecipeBodySchema.safeParse({ ...body, ...extra }).success).toBe(false);
    expect(SetupRecipeBodySchema.safeParse({ ...body, setupCommands: [{ ...body.setupCommands[0], env: { A: "b" } }] }).success).toBe(false);
  });

  it("takes paths only as {repo} templates", () => {
    const body = recipe();
    for (const cwd of ["service", "/abs", "{repo}/../x", "{repo}x", "{repo}//x", "other/{repo}"]) expect(SetupRecipeBodySchema.safeParse({ ...body, setupCommands: [cmd("npm", ["ci"], cwd)] }).success, cwd).toBe(false);
    expect(SetupRecipeBodySchema.safeParse({ ...body, setupCommands: [cmd("npm", ["ci"], "{repo}/web")] }).success).toBe(true);
    const withPath = (field: string, value: string) => SetupRecipeBodySchema.safeParse({ ...body, checks: [{ ...body.checks[0], [field]: value }] }).success;
    for (const field of ["reportPath", "coveragePath", "sarifPath"]) {
      expect(withPath(field, "{repo}/reports/x.xml"), field).toBe(true);
      // A bare workspace path (`orders-api/reports/junit.xml`), a path above the repository, an absolute path and the bare placeholder are all refused.
      for (const bad of ["orders-api/reports/junit.xml", "reports/junit.xml", "../x.xml", "{repo}/../x.xml", "/abs/x.xml", "{repo}", "{repo}//x"]) expect(withPath(field, bad), `${field} ${bad}`).toBe(false);
    }
  });

  it("holds {tests} exactly once in selectArgs, and only for a test check", () => {
    const body = recipe();
    const withArgs = (selectArgs: string[], kind = "test") => SetupRecipeBodySchema.safeParse({ ...body, checks: [{ ...body.checks[0], kind, selectArgs }] }).success;
    expect(withArgs(["{tests}"])).toBe(true);
    expect(withArgs(["-k", "{tests}"])).toBe(true);
    expect(withArgs(["-k"])).toBe(false);
    expect(withArgs(["{tests}", "{tests}"])).toBe(false);
    expect(withArgs(["{tests}"], "lint")).toBe(false);
  });

  it("refuses wildcard hosts, IP hosts and a dev container image that is not an image reference", () => {
    const body = recipe();
    expect(SetupRecipeBodySchema.safeParse({ ...body, approvedHosts: ["*.example.com"] }).success).toBe(false);
    expect(SetupRecipeBodySchema.safeParse({ ...body, approvedHosts: ["192.168.1.1"] }).success).toBe(false);
    expect(SetupRecipeBodySchema.safeParse({ ...body, devcontainerBaseImage: "not an image; rm -rf /" }).success).toBe(false);
    expect(SetupRecipeBodySchema.safeParse({ ...body, devcontainerBaseImage: "mcr.microsoft.com/devcontainers/go@sha256:" + "a".repeat(64) }).success).toBe(true);
  });

  it("bounds every list and keeps check ids unique", () => {
    const body = recipe();
    expect(SetupRecipeBodySchema.safeParse({ ...body, setupCommands: Array.from({ length: 21 }, () => cmd("npm")) }).success).toBe(false);
    expect(SetupRecipeBodySchema.safeParse({ ...body, approvedHosts: Array.from({ length: 51 }, (_, index) => `h${String(index)}.example.com`) }).success).toBe(false);
    expect(SetupRecipeBodySchema.safeParse({ ...body, checks: [body.checks[0], body.checks[0]] }).success).toBe(false);
    expect(SetupRecipeBodySchema.safeParse({ ...body, buildSystems: [] }).success).toBe(false);
  });

  it("has a digest that ignores key order and changes with content", () => {
    const body = recipe();
    const reordered = Object.fromEntries(Object.entries(body).reverse()) as unknown as SetupRecipeBody;
    expect(setupRecipeDigest(reordered)).toBe(setupRecipeDigest(body));
    expect(setupRecipeDigest({ ...body, label: "Other" })).not.toBe(setupRecipeDigest(body));
  });
});

describe("repository names", () => {
  it("finds a repository's full name, short name or owner in any value, as a whole word, in any case", () => {
    const body = recipe();
    expect(recipeNamesRepository(body, ["acme/orders-service"])).toBe(false);
    expect(recipeNamesRepository({ ...body, label: "Setup for Orders-Service" }, ["acme/orders-service"])).toBe(true);
    expect(recipeNamesRepository({ ...body, setupCommands: [cmd("make", ["-C", "acme"])] }, ["acme/orders-service"])).toBe(true);
    expect(recipeNamesRepository({ ...body, setupCommands: [cmd("make", ["-C", "orders-service/api"])] }, ["orders-service"])).toBe(true);
  });

  it("does not match inside another word, and ignores {repo} and the schema's own keys", () => {
    const body = recipe();
    expect(recipeNamesRepository(body, ["unit"])).toBe(true); // the check id "unit" is a value
    expect(recipeNamesRepository(body, ["uvx"])).toBe(false);
    expect(recipeNamesRepository(body, ["repo"])).toBe(false);
    expect(recipeNamesRepository(body, ["cwd", "executable", "args"])).toBe(false);
    expect(recipeNamesRepository(body, ["", "a"])).toBe(false);
    expect(recipeNamesRepository(body, ["pyth"])).toBe(false);
  });

  it("treats - _ . and space in a name as the same separator", () => {
    const body = recipe();
    for (const text of ["orders-api", "orders_api", "Orders.Api", "orders api"]) {
      expect(recipeNamesRepository({ ...body, label: `Setup for ${text}` }, ["acme/orders-api"]), text).toBe(true);
    }
    expect(recipeNamesRepository({ ...body, label: "ordersapi" }, ["acme/orders-api"])).toBe(false);
    expect(recipeNamesRepository({ ...body, setupCommands: [{ cwd: "{repo}", executable: "pip", args: ["install", "-r", "/home/ci/orders-api/requirements.txt"], timeoutSeconds: 60 }] }, ["orders-api"])).toBe(true);
  });
});

describe("recipe source", () => {
  it("round-trips recipe:<id>@<revision>", () => {
    const id = `rcp_${"ab12".repeat(5)}`;
    expect(setupRecipeSource(id, 3)).toBe(`recipe:${id}@3`);
    expect(parseSetupRecipeSource(setupRecipeSource(id, 3))).toEqual({ id, revision: 3 });
    expect(parseSetupRecipeSource("recipe:x@1")).toBeUndefined();
    expect(parseSetupRecipeSource(`recipe:${id}@0`)).toBeUndefined();
    expect(() => setupRecipeSource("bad", 1)).toThrow();
  });
});
