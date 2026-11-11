// The websites every agent machine in a cloud install may resolve: the DNS firewall allows exactly these, and a project's own allowed domains are
// checked against this list so that adding one of these is answered "already allowed" instead of waiting for approval.
/**
 * The websites the machines in a cloud install may resolve by default: GitHub's git host and container registry, package
 * registries, OS package mirrors, Docker registries, the AI providers, and Slack and the connector
 * hosts. Everything else gets NXDOMAIN. A wildcard entry matches subdomains only, not the bare domain.
 *
 * Narrow on purpose. The list governs a task sandbox as much as the worker beside it (one resolver, one list), so a name that lets anyone upload
 * (a bucket of any account, a repository or gist of any user) is an exit for an injected agent. Not on the list, and never to be added back as a wildcard:
 *  - `*.amazonaws.com`, `*.aws`: every AWS customer's storage bucket, API endpoint and so on. A cloud install adds the exact regional hosts its own
 *    machines call; a laptop needs none (model calls go through the host's proxy).
 *  - `*.github.com` and `*.githubusercontent.com`: the upload and API hosts (api., uploads., gist.) and user-content hosts live under them. A project that needs
 *    another host asks for it by name.
 * What stays of GitHub: `github.com` itself, because the worker (not the sandbox, but they share the list) runs `git clone`, `fetch` and `push` against it; that is
 * a known exit (a push to a repository of the attacker's with the attacker's own token) which only a per-task proxy closes. `ghcr.io`, `*.ghcr.io` and
 * `pkg-containers.githubusercontent.com` (the one host the blobs of a ghcr.io image come from) stay for image pulls. Four read-only download hosts stay as exact
 * names, for what build tools fetch (dev container features, version managers, LFS, `github:` npm dependencies, benchmark files): raw.githubusercontent.com,
 * objects.githubusercontent.com, release-assets.githubusercontent.com and codeload.github.com. Uploads go through the api and uploads hosts, which stay blocked.
 */
export const DEFAULT_AGENT_ALLOW_DOMAINS: readonly string[] = [
  // The VPC's own names: a machine's hostname (ip-10-42-....<region>.compute.internal, or ec2.internal in
  // us-east-1) and reverse lookups inside the VPC's 10.42.0.0/16 range. These are private zones, never
  // delegated to the internet, so allowing them opens no exfiltration path; build tools and test servers
  // that resolve their own hostname otherwise fail.
  "*.compute.internal", "*.ec2.internal", "*.42.10.in-addr.arpa",
  // GitHub: the git host for the worker's clone, fetch and push; ghcr.io for images (the model proxy image, dev container features), whose blobs come from the one host below
  "github.com", "ghcr.io", "*.ghcr.io", "pkg-containers.githubusercontent.com",
  // GitHub's read-only download hosts, exact names only (see above)
  "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "codeload.github.com",
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
