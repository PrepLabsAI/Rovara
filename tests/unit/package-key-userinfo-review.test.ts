// Review-written (REVIEW-SONNET-d2f4842d4): a credential in a URL's userinfo must never surface as a registry host.
import { describe, expect, it } from "vitest";
import { classifyInstallFailure, detectStaticPackageKeys } from "../../packages/contracts/src/package-key-detect.js";
import { parseLockfile } from "../../packages/contracts/src/package-key-parse.js";

// Built at run time so no key-shaped literal sits in the source (the public repo refuses those).
const SECRET = ["tok3n", "9abcdef", "0123456789"].join("");
describe("userinfo in a URL is never a host", () => {
  it("lockfile resolved URL with user info", () => {
    const text = `  resolved "https://${SECRET}@registry.corp.example/pkg/-/pkg-1.0.0.tgz"\n  resolved "https://user:${SECRET}@registry.corp.example/pkg/-/p.tgz"\n`;
    const parsed = parseLockfile(text);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
    expect(parsed.refs.map((r) => r.host)).toEqual(["registry.corp.example"]);
  });
  it("end to end static result", () => {
    const text = JSON.stringify({ packages: { a: { resolved: `https://${SECRET}@registry.corp.example/x/-/x.tgz` } } }, null, 2);
    const result = detectStaticPackageKeys({ repo: "r", files: [{ path: "package-lock.json", text }], hasCompanyToken: () => false });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it("install output with user info", () => {
    const out = `npm error code E401\nnpm error 401 Unauthorized - GET https://${SECRET}@registry.corp.example/x\n`;
    const r = classifyInstallFailure({ output: out, exitCode: 1, repos: [{ repo: "r", registries: [{ host: "registry.corp.example", scopes: [] }] }], hasCompanyToken: () => false });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("surviving mutants (review-written)", () => {
  it("exit code 0 is never a failure even when the output looks like a 401", () => {
    const out = "npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fui\n";
    expect(classifyInstallFailure({ output: out, exitCode: 0, repos: [{ repo: "r", registries: [{ host: "npm.pkg.github.com", scopes: [] }] }], hasCompanyToken: () => false })).toEqual({ outcome: "other" });
  });
  it("a public registry set in .npmrc is not a private registry", () => {
    const result = detectStaticPackageKeys({ repo: "r", files: [{ path: ".npmrc", text: "registry=https://registry.npmjs.org/\n@x:registry=https://REGISTRY.NPMJS.ORG/\n" }], hasCompanyToken: () => false });
    expect(result.registries).toEqual([]);
    expect(result.untested).toBeUndefined();
  });
});

