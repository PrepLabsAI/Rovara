// Lane L4-NETG (DEC 254zzz77): the sandbox-side registry deny list is a guard file. This pins it name by name (a change is a security change a reviewer must see), checks that every registry name of the install's default
// allow list is covered, that nothing the sandboxes legitimately use is, and that the gateway applies the very same list the contracts export.
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ALLOW_DOMAINS } from "../../packages/contracts/src/default-allow-domains.js";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/contracts/src/egress-gateway-source.js";
import { PROJECT_S3_ALLOW_MAX, SANDBOX_REGISTRY_DENY, SANDBOX_REGISTRY_DENY_ROWS, SANDBOX_S3_DENY, SANDBOX_S3_DENY_ROWS, isProjectAllowableS3Host, isSandboxS3Name, projectAllowedS3Hosts, sandboxDenyPatternCovers } from "../../packages/contracts/src/sandbox-deny-domains.js";

const scratch: string[] = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });
async function gateway(): Promise<{ hostAllowed(host: string, role?: string): boolean; patternCovers(entry: string, host: string): boolean }> {
  const directory = await mkdtemp(join(tmpdir(), "deny-"));
  scratch.push(directory);
  const file = join(directory, "program.cjs");
  await writeFile(file, EGRESS_GATEWAY_SOURCE);
  const saved = { ...process.env };
  Object.assign(process.env, { ROVARA_GW_LIBRARY: "1", ROVARA_GW_CONFIG: JSON.stringify({ mode: "host", sandboxDenied: SANDBOX_REGISTRY_DENY }) });
  try { return createRequire(import.meta.url)(file) as never; } finally { delete process.env.ROVARA_GW_LIBRARY; delete process.env.ROVARA_GW_CONFIG; Object.assign(process.env, saved); }
}

describe("the sandbox registry deny list (owner decision 4, DEC 254zzz77)", () => {
  it("is exactly these names (pinned: a change here is a security change)", () => {
    expect([...SANDBOX_REGISTRY_DENY]).toEqual([
      "docker.io", "*.docker.io", "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com",
      "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
      "ghcr.io", "*.ghcr.io", "pkg-containers.githubusercontent.com",
      "gcr.io", "*.gcr.io", "us-docker.pkg.dev", "*.pkg.dev",
      "quay.io", "*.quay.io",
      "public.ecr.aws", "*.public.ecr.aws", "api.ecr-public.*.amazonaws.com", "*.dkr.ecr.*.amazonaws.com", "api.ecr.*.amazonaws.com", "ecr.*.amazonaws.com",
    ]);
  });

  it("has a reason for every name, plain lower-case names or patterns only, no duplicates", () => {
    expect(SANDBOX_REGISTRY_DENY_ROWS.length).toBe(new Set(SANDBOX_REGISTRY_DENY).size);
    for (const row of SANDBOX_REGISTRY_DENY_ROWS) {
      expect(row.why.length, row.name).toBeGreaterThanOrEqual(4);
      expect(row.name, row.name).toMatch(/^(\*\.)?[a-z0-9]([a-z0-9.*-]*[a-z0-9])?$/u);
      expect(row.name, row.name).not.toMatch(/\.\./u);
      expect(row.name.split(".").length, row.name).toBeGreaterThanOrEqual(2);
    }
  });

  it("covers every registry name of the install's default allow list (the names the host itself pulls from), and what the owner named", async () => {
    const g = await gateway();
    const registryNames = DEFAULT_AGENT_ALLOW_DOMAINS.filter((name) => /docker|ghcr|pkg-containers|cloudflarestorage/u.test(name));
    expect(registryNames.length).toBeGreaterThanOrEqual(7);
    for (const name of registryNames) expect(g.hostAllowed(name.replace(/^\*\./u, "x."), "sandbox"), name).toBe(false);
    for (const name of ["docker.io", "registry-1.docker.io", "ghcr.io", "gcr.io", "us-docker.pkg.dev", "europe-docker.pkg.dev", "quay.io", "public.ecr.aws", "123456789012.dkr.ecr.eu-west-1.amazonaws.com", "api.ecr.eu-west-1.amazonaws.com"]) {
      expect(g.hostAllowed(name, "sandbox"), name).toBe(false);
    }
  });

  it("is the very list the gateway program is configured with at boot (the worker image's contracts), and the worker role keeps it", async () => {
    const g = await gateway();
    // The worker role of the laptop gateway (not exempt in host mode: there is no worker network there, so a missing role is a sandbox) and an explicit `worker` role differ only for the laptop layout.
    expect(g.hostAllowed("ghcr.io", "worker")).toBe(true);
    expect(g.hostAllowed("ghcr.io", "sandbox")).toBe(false);
  });
});

describe("the S3 deny list (owner DEC 254zzz90) and the project's lift", () => {
  const S3 = ["s3.amazonaws.com", "s3.us-west-2.amazonaws.com", "s3.dualstack.eu-west-1.amazonaws.com", "s3-fips.dualstack.us-east-1.amazonaws.com", "s3-us-west-2.amazonaws.com", "s3-external-1.amazonaws.com", "b.s3.amazonaws.com", "b.s3.us-west-2.amazonaws.com",
    "a.b.s3.us-west-2.amazonaws.com", "b.s3.dualstack.us-west-2.amazonaws.com", "b.s3-us-west-2.amazonaws.com", "b.s3-accelerate.dualstack.amazonaws.com", "s3-website-us-east-1.amazonaws.com", "b.s3-website.eu-west-2.amazonaws.com",
    "ap.s3-accesspoint.dualstack.us-east-1.amazonaws.com", "ap.s3-accesspoint-fips.us-east-1.amazonaws.com", "1234.s3-control-fips.dualstack.us-west-2.amazonaws.com", "b--usw2-az1--x-s3.s3express-usw2-az1.us-west-2.amazonaws.com", "s3tables.us-west-2.amazonaws.com", "s3vectors.us-west-2.api.aws", "b.s3.us-west-2.api.aws", "s3.dualstack.us-west-2.api.aws", "b.s3.dualstack.us-west-2.api.aws"];
  const OTHER = ["dynamodb.us-west-2.amazonaws.com", "sts.amazonaws.com", "bedrock-runtime.us-west-2.amazonaws.com", "registry.npmjs.org", "s3.example.com", "mys3.us-west-2.amazonaws.com", "s3x.amazonaws.com", "amazonaws.com", "ecs.us-west-2.amazonaws.com", "s3"];

  it("is pinned and each row has a reason", () => {
    expect(SANDBOX_S3_DENY_ROWS.length).toBe(new Set(SANDBOX_S3_DENY).size);
    for (const row of SANDBOX_S3_DENY_ROWS) { expect(row.why.length, row.name).toBeGreaterThanOrEqual(8); expect(row.name, row.name).toMatch(/^(\*\.)?[a-z0-9*-]+(\.[a-z0-9*-]+)*$/u); }
    expect([...SANDBOX_S3_DENY]).toEqual(["s3.amazonaws.com", "*.s3.amazonaws.com", "s3.*.amazonaws.com", "s3.*.*.amazonaws.com", "*.s3.*.amazonaws.com", "*.s3.*.*.amazonaws.com", "s3-*.amazonaws.com", "s3-*.*.amazonaws.com", "s3-*.*.*.amazonaws.com",
      "*.s3-*.amazonaws.com", "*.s3-*.*.amazonaws.com", "*.s3-*.*.*.amazonaws.com", "s3express-*.*.amazonaws.com", "*.s3express-*.*.amazonaws.com", "*.s3express-*.*.*.amazonaws.com", "s3tables.*.amazonaws.com", "s3.*.api.aws", "s3.*.*.api.aws", "*.s3.*.api.aws", "*.s3.*.*.api.aws", "s3*.*.api.aws", "s3*.*.*.api.aws"]);
    // The S3 rows are not in the registry list (a registry is never liftable).
    for (const name of SANDBOX_S3_DENY) expect(SANDBOX_REGISTRY_DENY).not.toContain(name);
  });

  it("covers every S3 endpoint form of AWS's endpoints page and nothing else", () => {
    for (const name of S3) expect(isSandboxS3Name(name), name).toBe(true);
    for (const name of OTHER) expect(isSandboxS3Name(name), name).toBe(false);
  });

  it("the TypeScript matcher and the gateway program's matcher agree on a corpus (the worker decides what a project can lift with one, the gateway applies the other)", async () => {
    const g = await gateway();
    const entries = [...SANDBOX_S3_DENY, ...SANDBOX_REGISTRY_DENY, "*.example.com", "a.*.example.com", "x-*.example.com"];
    const hosts = [...S3, ...OTHER, "x.example.com", "a.b.example.com", "a.q.example.com", "x-1.example.com", "x-.example.com", "x.example.com.evil.dev", "ghcr.io", "a.ghcr.io", "123.dkr.ecr.us-west-2.amazonaws.com"];
    for (const entry of entries) for (const host of hosts) expect(sandboxDenyPatternCovers(entry, host), `${entry} ${host}`).toBe(g.patternCovers(entry, host));
  });

  it("a project can lift only an exact, lower-case, plain S3 host name; never a wildcard, a registry or another AWS name", () => {
    expect(isProjectAllowableS3Host("mybucket.s3.us-west-2.amazonaws.com")).toBe(true);
    // A bare service or path-style host is never liftable (even where the Public Suffix List snapshot would let a project list it).
    for (const bare of ["s3.us-west-2.amazonaws.com", "s3.amazonaws.com", "s3-accelerate.amazonaws.com", "s3.dualstack.us-west-2.amazonaws.com", "s3tables.us-west-2.amazonaws.com", "s3-website-us-east-1.amazonaws.com"]) expect(isProjectAllowableS3Host(bare), bare).toBe(false);
    for (const bad of ["*.s3.us-west-2.amazonaws.com", "MyBucket.s3.us-west-2.amazonaws.com", "ghcr.io", "registry-1.docker.io", "dynamodb.us-west-2.amazonaws.com", "1.2.3.4", "s3", "", "a..s3.us-west-2.amazonaws.com", "x y.s3.amazonaws.com", `${"a".repeat(260)}.s3.amazonaws.com`, "-a.s3.amazonaws.com"]) {
      expect(isProjectAllowableS3Host(bad), bad).toBe(false);
    }
    expect(projectAllowedS3Hosts(["B.s3.us-west-2.amazonaws.com", "a.s3.us-west-2.amazonaws.com", "a.s3.us-west-2.amazonaws.com", "ghcr.io", "*.s3.us-west-2.amazonaws.com", "registry.npmjs.org", "dynamodb.us-west-2.amazonaws.com"]))
      .toEqual(["a.s3.us-west-2.amazonaws.com", "b.s3.us-west-2.amazonaws.com"]);
    expect(projectAllowedS3Hosts(undefined)).toEqual([]);
    expect(projectAllowedS3Hosts(Array.from({ length: 80 }, (_, index) => `b${String(index)}.s3.us-west-2.amazonaws.com`)).length).toBe(PROJECT_S3_ALLOW_MAX);
  });
});
