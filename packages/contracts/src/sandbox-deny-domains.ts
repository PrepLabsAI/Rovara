// Lane L4-NETG (owner DEC 254zzz77, decision 4 of briefs/lead4/L4-NETC-SCOPE.md): the names a task SANDBOX or DEVCONTAINER on an EC2 worker may not reach, although the host itself keeps them.
//
// Why: the worker host pulls its images (the worker's own, the test-service images, a project's devcontainer base image and features) from these registries, so the install's VPC DNS list has to allow them. Code that
// an injected agent controls runs in a sandbox on that same host. A sandbox has no Docker socket and nothing in it pulls an image, so it needs none of these names, and every one of them takes a push from anyone with an account of
// their own: a way to move the workspace out as an image. The egress gateway of the worker host (egress-gateway-source.ts, "host" mode) answers NXDOMAIN for these names to the sandbox side and refuses them at the TLS name
// and the Host header. The HOST's own Docker is not behind the gateway, so it keeps its registries.
//
// One entry is an exact name, `*.suffix` (every name under it, never the bare suffix), or a pattern whose inner `*` is exactly one label (the gateway's `patternCovers`). Lower case only. This file is a guard file: a change to it
// is a security change (tests/contract/sandbox-deny-domains.test.ts pins the list and checks every registry name of the default allow list is covered).
//
// S3 (L4-NETG follow-up, owner DEC 254zzz90): every Amazon S3 name form is in SANDBOX_S3_DENY_ROWS. S3 is on the install's VPC list (`s3.<region>`, `*.s3.<region>`: the artifact buckets and the ECR layer bucket, which the HOST uses), but a path-style or
// virtual-hosted request there reaches ANY bucket of ANY account in the region: an upload exit. Sandboxes have no AWS credentials and nothing in them needs S3 today (checked: the only S3 calls in the worker are the worker container's own,
// on the host network: e2e-model-canary-cli.ts, swebench/reporter.ts; package installs use PyPI, npm, Maven, Debian, none of them S3 names). Unlike a registry, a project's package installs can genuinely need an exact S3 host, so the S3 rows are
// the ONLY rows a project can lift, bucket host by bucket host (`projectAllowedS3Hosts`), through its own allowed websites (the existing audited, role- and company-checked flow, customer-approved; no Rovara staff step is added). A registry row is never liftable.
// Scope, said plainly (REVIEW-S3-1 M1, M2): a lifted bucket host is region-wide S3 for that project's sandboxes (the gateway sees the TLS name, S3 routes by the Host header inside TLS), and for the install's own region the VPC list already allows `*.s3.<region>`, so no staff step holds it.
//
// Deliberately NOT here: `mcr.microsoft.com` (nobody outside Microsoft can push to it; the scope's recommendation is to keep it allowed), github.com (the worker's own git remote; a known residual, default-allow-domains.ts),
// and the model hosts (the laptop's sandbox-model-deny.ts; owner decision pending for EC2). Registries a project may add to its own list (registry.gitlab.com, *.azurecr.io) are not on the default list and so not here either.

import { z } from "zod";

export interface SandboxDenyRow {
  /** An exact lower-case name, `*.suffix`, or a pattern with a one-label `*` inside. */
  readonly name: string;
  readonly why: string;
}

export const SANDBOX_REGISTRY_DENY_ROWS: readonly SandboxDenyRow[] = [
  // Docker Hub: the registry, its auth host, its blob hosts and the layer bucket (the exact bucket host the default list holds)
  { name: "docker.io", why: "Docker Hub" },
  { name: "*.docker.io", why: "Docker Hub (registry-1, index, registry)" },
  { name: "registry-1.docker.io", why: "Docker Hub registry (pushes and pulls)" },
  { name: "auth.docker.io", why: "Docker Hub token service" },
  { name: "production.cloudflare.docker.com", why: "Docker Hub blob host" },
  { name: "production.cloudfront.docker.com", why: "Docker Hub blob host" },
  { name: "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com", why: "Docker Hub layer storage (the one bucket host)" },
  // GitHub Container Registry
  { name: "ghcr.io", why: "GitHub Container Registry" },
  { name: "*.ghcr.io", why: "GitHub Container Registry" },
  { name: "pkg-containers.githubusercontent.com", why: "GitHub Container Registry blob host" },
  // Google
  { name: "gcr.io", why: "Google Container Registry" },
  { name: "*.gcr.io", why: "Google Container Registry (us., eu., asia.)" },
  { name: "us-docker.pkg.dev", why: "Google Artifact Registry (the Google SDK emulator image)" },
  { name: "*.pkg.dev", why: "Google Artifact Registry, every region" },
  // Quay
  { name: "quay.io", why: "Quay" },
  { name: "*.quay.io", why: "Quay blob hosts (cdn, cdn01)" },
  // AWS: public ECR, and the private ECR registry and API endpoints of every region
  { name: "public.ecr.aws", why: "Amazon ECR Public" },
  { name: "*.public.ecr.aws", why: "Amazon ECR Public" },
  { name: "api.ecr-public.*.amazonaws.com", why: "Amazon ECR Public API" },
  { name: "*.dkr.ecr.*.amazonaws.com", why: "Amazon ECR registry endpoints (<account>.dkr.ecr.<region>)" },
  { name: "api.ecr.*.amazonaws.com", why: "Amazon ECR API" },
  { name: "ecr.*.amazonaws.com", why: "Amazon ECR API (alternate host)" },
];

/** The names, in the order of the rows, for the gateway's `sandboxDenied` setting. */
export const SANDBOX_REGISTRY_DENY: readonly string[] = SANDBOX_REGISTRY_DENY_ROWS.map((row) => row.name);

/**
 * Amazon S3 name forms (docs.aws.amazon.com/general/latest/gr/s3.html, checked 2026-11-18). Pattern syntax is the gateway's (`patternCovers`): a leading `*` is one or more labels, an inner `*` exactly one label, and a label that ends in `*`
 * (`s3-*`) is any one label with that prefix. All under `amazonaws.com` (plus the `api.aws` dual-stack form, listed although the docs page does not show it: a deny of a name that does not exist is harmless).
 *  - regional and dual-stack: `s3.<r>`, `s3.dualstack.<r>`, `s3-fips.<r>`, `s3-fips.dualstack.<r>`; the legacy `s3-<r>`; the global `s3.amazonaws.com`, `s3-external-1`, `s3-accelerate`;
 *  - virtual-hosted style: `<bucket>.` in front of any of those (a bucket name may contain dots, so the leading `*` is one or more labels);
 *  - website (`s3-website-<r>`, `s3-website.<r>`), access points (`<ap>.s3-accesspoint[-fips][.dualstack].<r>`), control (`<acct>.s3-control...`), Outposts, directory buckets (`s3express-*`), tables (`s3tables.<r>`).
 */
export const SANDBOX_S3_DENY_ROWS: readonly SandboxDenyRow[] = [
  { name: "s3.amazonaws.com", why: "S3 global endpoint" },
  { name: "*.s3.amazonaws.com", why: "S3 virtual-hosted buckets on the global endpoint" },
  { name: "s3.*.amazonaws.com", why: "S3 regional endpoint (path style)" },
  { name: "s3.*.*.amazonaws.com", why: "S3 dual-stack endpoint" },
  { name: "*.s3.*.amazonaws.com", why: "S3 virtual-hosted buckets, regional" },
  { name: "*.s3.*.*.amazonaws.com", why: "S3 virtual-hosted buckets, dual-stack" },
  { name: "s3-*.amazonaws.com", why: "S3 legacy dash-region, fips, accelerate, external-1, website, access point and control endpoints" },
  { name: "s3-*.*.amazonaws.com", why: "S3 dash forms with a region label (fips, website, access point, control)" },
  { name: "s3-*.*.*.amazonaws.com", why: "S3 dash forms, dual-stack with a region label" },
  { name: "*.s3-*.amazonaws.com", why: "S3 virtual-hosted buckets on a legacy dash-region or accelerate endpoint" },
  { name: "*.s3-*.*.amazonaws.com", why: "S3 buckets, access points and account control endpoints with a region label" },
  { name: "*.s3-*.*.*.amazonaws.com", why: "S3 buckets, access points and control endpoints, dual-stack" },
  { name: "s3express-*.*.amazonaws.com", why: "S3 directory-bucket control endpoints" },
  { name: "*.s3express-*.*.amazonaws.com", why: "S3 directory buckets" },
  { name: "*.s3express-*.*.*.amazonaws.com", why: "S3 directory buckets, dual-stack" },
  { name: "s3tables.*.amazonaws.com", why: "S3 Tables" },
  { name: "s3.*.api.aws", why: "S3 on the api.aws domain" },
  { name: "s3.*.*.api.aws", why: "S3 dual-stack on the api.aws domain" },
  { name: "*.s3.*.api.aws", why: "S3 buckets on the api.aws domain" },
  { name: "*.s3.*.*.api.aws", why: "S3 buckets, dual-stack, on the api.aws domain" },
  { name: "s3*.*.api.aws", why: "S3 family services on the api.aws domain (s3tables, s3vectors, s3-control)" },
  { name: "s3*.*.*.api.aws", why: "S3 family services on the api.aws domain, dual-stack" },
];

/** The S3 names, in the order of the rows, for the gateway's `sandboxDeniedS3` setting (the only deny a project's allowed websites can lift). */
export const SANDBOX_S3_DENY: readonly string[] = SANDBOX_S3_DENY_ROWS.map((row) => row.name);

/**
 * The same name matching as the gateway's `patternCovers` (egress-gateway-source.ts), in TypeScript, so the worker can decide which of a project's allowed websites are S3 names without running the gateway program. A test runs both over one
 * corpus and fails if they ever disagree. Names are compared whole, lower case.
 */
export function sandboxDenyPatternCovers(entry: string, host: string): boolean {
  if (entry.indexOf("*") === -1) return host === entry;
  const e = entry.split(".");
  const h = host.split(".");
  const labelMatches = (pattern: string, label: string): boolean => (pattern.length > 1 && pattern.endsWith("*") ? label.length >= pattern.length && label.startsWith(pattern.slice(0, -1)) : pattern === label);
  let ei = e.length - 1;
  let hi = h.length - 1;
  while (ei >= 0) {
    const pattern = e[ei]!;
    if (pattern === "*") {
      if (ei === 0) return hi >= 0;
      if (hi < 0) return false;
    } else if (hi < 0 || !labelMatches(pattern, h[hi]!)) return false;
    ei -= 1;
    hi -= 1;
  }
  return hi < 0;
}

/** Whether `host` is an Amazon S3 name in any form SANDBOX_S3_DENY lists. */
export function isSandboxS3Name(host: string): boolean {
  return SANDBOX_S3_DENY.some((entry) => sandboxDenyPatternCovers(entry, host.toLowerCase()));
}

/** A host name a project may be allowed to reach in spite of the S3 deny: an exact, lower-case, plain BUCKET name (no wildcard), at most 253 characters, that is an S3 name. HONEST SCOPE (review M2): the gateway judges the TLS server name and then tunnels bytes, and S3 serves every bucket of a region behind one front end, so lifting one bucket host lets that project's sandboxes reach S3 in that region by Host-header fronting; "exact" limits the name a client asks for, not what S3 then serves. The owner accepted this (DEC 254zzz90); the allowed-websites card for an S3 name must say so. Anything else is not one. */
export function isProjectAllowableS3Host(host: string): boolean {
  return typeof host === "string" && host.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) && host.includes(".") && !host.includes("..") && isSandboxS3Name(host)
    // A bucket host only: a name with a bucket label in front (the rows that start with `*.`). A bare service or path-style host (`s3.<region>.amazonaws.com`, `s3-accelerate...`) is never liftable, whatever the Public Suffix List snapshot says.
    && SANDBOX_S3_DENY.some((entry) => entry.startsWith("*.") && sandboxDenyPatternCovers(entry, host));
}

/** The most S3 hosts one project may lift (the allowed websites list holds at most 50 entries). */
export const PROJECT_S3_ALLOW_MAX = 50;

/** From a project's allowed websites: the exact S3 host names among them, sorted, no duplicates, at most PROJECT_S3_ALLOW_MAX. A wildcard entry and any non-S3 name is left out. */
export function projectAllowedS3Hosts(allowedDomains: readonly string[] | undefined): string[] {
  const found = new Set<string>();
  for (const domain of allowedDomains ?? []) {
    const host = typeof domain === "string" ? domain.toLowerCase() : "";
    if (isProjectAllowableS3Host(host)) found.add(host);
  }
  return [...found].sort().slice(0, PROJECT_S3_ALLOW_MAX);
}

/** The prepare invocation's `egressS3Allow` as the BROKER writes it: exact S3 bucket host names only, at most PROJECT_S3_ALLOW_MAX. (The worker's own payload schema takes any short strings and filters with isProjectAllowableS3Host, so a broker with a newer deny list never makes an older worker refuse a prepare.) */
export const EgressS3AllowSchema = z.array(z.string().refine(isProjectAllowableS3Host, "not an exact S3 host name")).max(PROJECT_S3_ALLOW_MAX);
