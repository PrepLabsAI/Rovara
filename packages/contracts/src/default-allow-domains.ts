// The websites every agent machine in a cloud install may resolve (Plan 2, Task 17 moved this list here from infra/lib/agent-dns-firewall.ts,
// which re-exports it): the DNS firewall allows exactly these, and a project's own allowed domains are checked against it so that adding
// one of these is answered "already allowed" instead of waiting for approval.
/**
 * The websites the machines in a cloud install may resolve by default: AWS, GitHub, package
 * registries, OS package mirrors, Docker registries, the AI providers, and Slack and the connector
 * hosts. Everything else gets NXDOMAIN. A wildcard entry matches subdomains only, not the bare domain.
 */
export const DEFAULT_AGENT_ALLOW_DOMAINS: readonly string[] = [
  // AWS services
  "*.amazonaws.com", "*.aws",
  // The VPC's own names: a machine's hostname (ip-10-42-....<region>.compute.internal, or ec2.internal in
  // us-east-1) and reverse lookups inside the VPC's 10.42.0.0/16 range. These are private zones, never
  // delegated to the internet, so allowing them opens no exfiltration path; build tools and test servers
  // that resolve their own hostname otherwise fail.
  "*.compute.internal", "*.ec2.internal", "*.42.10.in-addr.arpa",
  // GitHub (the model proxy image comes from ghcr.io, whose blobs come from *.githubusercontent.com)
  "github.com", "*.github.com", "*.githubusercontent.com", "ghcr.io", "*.ghcr.io",
  // Package registries: npm and Yarn, Python, Rust, Go, Java, Ruby
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "*.crates.io",
  "proxy.golang.org", "sum.golang.org",
  "repo.maven.apache.org", "repo1.maven.org",
  "rubygems.org", "*.rubygems.org",
  // OS package mirrors: Debian, Ubuntu, Alpine
  "deb.debian.org", "security.debian.org",
  "archive.ubuntu.com", "ports.ubuntu.com", "security.ubuntu.com",
  "dl-cdn.alpinelinux.org",
  // Docker images
  "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com",
  // Docker Hub's layer storage for anonymous and Personal-plan pulls (Docker's allowlist page; found live on staging).
  // The exact bucket host only: a *.r2.cloudflarestorage.com wildcard would allow uploads to anyone's bucket.
  "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
  // Dev container base images and the toolchains their common features download (ruling R40)
  "mcr.microsoft.com", "*.data.mcr.microsoft.com", "nodejs.org",
  // AI providers (model proxy, ChatGPT plans)
  "api.anthropic.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "openrouter.ai",
  // Slack and connectors
  "slack.com", "*.slack.com", "api.linear.app", "mcp.linear.app", "*.atlassian.net", "app.asana.com",
];
