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
// Deliberately NOT here: `mcr.microsoft.com` (nobody outside Microsoft can push to it; the scope's recommendation is to keep it allowed), github.com (the worker's own git remote; a known residual, default-allow-domains.ts),
// and the model hosts (the laptop's sandbox-model-deny.ts; owner decision pending for EC2). Registries a project may add to its own list (registry.gitlab.com, *.azurecr.io) are not on the default list and so not here either.

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
