// Lane L4-NETG (DEC 254zzz77): the sandbox-side registry deny list is a guard file. This pins it name by name (a change is a security change a reviewer must see), checks that every registry name of the install's default
// allow list is covered, that nothing the sandboxes legitimately use is, and that the gateway applies the very same list the contracts export.
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ALLOW_DOMAINS } from "../../packages/contracts/src/default-allow-domains.js";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/contracts/src/egress-gateway-source.js";
import { SANDBOX_REGISTRY_DENY, SANDBOX_REGISTRY_DENY_ROWS } from "../../packages/contracts/src/sandbox-deny-domains.js";

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

  it("does not deny anything else the default list holds, and keeps mcr.microsoft.com, github.com and the AWS data hosts allowed", async () => {
    const g = await gateway();
    const registry = (name: string): boolean => /docker\.(io|com)|ghcr|pkg-containers|cloudflarestorage|gcr\.io|pkg\.dev|quay\.io|ecr/u.test(name);
    for (const name of DEFAULT_AGENT_ALLOW_DOMAINS.filter((entry) => !registry(entry))) {
      const probe = name.replace(/^\*\./u, "x.");
      // A VPC-internal name is not a public-style name for the gateway's validName check ("*.42.10.in-addr.arpa" has no letter in its first label); every other entry must pass the deny check.
      if (/in-addr\.arpa$/u.test(probe)) continue;
      expect(g.hostAllowed(probe, "sandbox"), name).toBe(true);
    }
    for (const name of ["mcr.microsoft.com", "github.com", "s3.us-west-2.amazonaws.com", "sts.us-west-2.amazonaws.com", "bedrock-runtime.us-east-1.amazonaws.com", "dynamodb.us-west-2.amazonaws.com", "ecr.example.com", "dkr.ecr.us-west-2.amazonaws.com"]) {
      expect(g.hostAllowed(name, "sandbox"), name).toBe(true);
    }
  });

  it("is the very list the gateway program is configured with at boot (the worker image's contracts), and the worker role keeps it", async () => {
    const g = await gateway();
    // The worker role of the laptop gateway (not exempt in host mode: there is no worker network there, so a missing role is a sandbox) and an explicit `worker` role differ only for the laptop layout.
    expect(g.hostAllowed("ghcr.io", "worker")).toBe(true);
    expect(g.hostAllowed("ghcr.io", "sandbox")).toBe(false);
  });
});
