import { VERTEX_LOCATIONS } from "./vertex-locations.js";

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
const BASE_AGENT_ALLOW_DOMAINS: readonly string[] = [
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

/** A named set of default websites with one stated purpose. A group is kept apart so it can be found, explained and removed as a unit (see `DEFAULT_AGENT_ALLOW_GROUPS`). */
export interface AgentAllowGroup {
  readonly id: string;
  /** The name shown to people. */
  readonly name: string;
  /** Every host with the reason it is on the list. Exact names only. */
  readonly hosts: ReadonlyArray<{ readonly host: string; readonly why: string }>;
}

/**
 * Google Vertex AI and the Gemini API (owner decision 2026-11-17): a customer whose tests call Gemini through Vertex AI (a service account or workload identity, no API key) would otherwise get NXDOMAIN
 * from the worker's DNS firewall for every host of the call. Exact names only, the minimum for a model call plus Google sign-in from a service account key or from workload identity federation (an AWS role
 * exchanged at STS). Checked against Google's own pages on 2026-11-17: the service account token request goes to https://oauth2.googleapis.com/token, the workload identity federation token swap calls
 * sts.googleapis.com (and iamcredentials.googleapis.com when it impersonates a service account), and Vertex's endpoints are the global host and one `<location>-aiplatform` host per location.
 *
 * ONE KNOWN GAP, on purpose (security review 2026-11-17): Google's Python `google.auth.default()` asks cloudresourcemanager.googleapis.com for the project id when an AWS (workload identity) credential file is
 * used and no project is set, and fails when the name does not resolve. That host can create and label projects, so it is NOT here. A customer on workload identity sets `GOOGLE_CLOUD_PROJECT` (a service
 * account key file carries its own project id and is not affected).
 *
 * NOT on this list, on purpose, and never to be added as `*.googleapis.com` (one entry would let anyone's Cloud Storage bucket and every other Google data API through, an exit for an injected agent):
 *  - `storage.googleapis.com`, `bigquery.googleapis.com` and the other data stores. A project that needs one asks for it by name.
 *  - `www.googleapis.com`: it only appears inside the `https://www.googleapis.com/auth/cloud-platform` scope text, which is an identifier and not a call. (Google's libraries read it only for ID-token certificates and
 *    for the old key-file token address; a project that needs those asks for it.)
 *  - `*.mtls.googleapis.com` and the regional `*.rep.googleapis.com` names (context-aware access and regional endpoints, a choice of the customer's own cloud setup), the Cloud metadata server
 *    (`metadata.google.internal`, an address that only exists on Google's machines; the setup flow refuses it as a private name) and Firebase AI Logic.
 *
 * The firewall of a cloud install is one resolver for every project of the install, so the group cannot be removed for one project. To remove it, delete it from `DEFAULT_AGENT_ALLOW_GROUPS` and deploy the
 * foundation stack (infra/lib/agent-dns-firewall.ts). The broker's "already allowed" answer and a laptop's egress gateway read the same list, so they follow it.
 * A model host stays denied in a laptop's task sandbox either way (isolation/sandbox-model-deny.ts) unless the owner allows model hosts for that project. A hosted sandbox has no such deny: it had the DNS
 * firewall's NXDOMAIN for these names and now has only the hosts-file block of a project with a model row (model-helper-block.ts), the same standing as api.openai.com and api.anthropic.com. The Gemini Files
 * API, Vertex uploads and `rawPredict` can carry data to a Google project of an attacker's with that attacker's own key; the token hosts are a narrow channel through an attacker's own federation pool.
 * This is the accepted cost of the owner's decision; `accounts.google.com` (old key files' token address) is not here either.
 */
export const GOOGLE_VERTEX_AI_ALLOW_GROUP: AgentAllowGroup = {
  id: "google-vertex-ai",
  name: "Google Vertex AI",
  hosts: [
    { host: "aiplatform.googleapis.com", why: "Vertex AI's global endpoint (Gemini, Express mode)" },
    ...VERTEX_LOCATIONS.map((location) => ({ host: `${location}-aiplatform.googleapis.com`, why: `Vertex AI's ${location} endpoint (one exact name per location, never a wildcard)` })),
    { host: "generativelanguage.googleapis.com", why: "the Gemini API (Google AI Studio keys)" },
    { host: "oauth2.googleapis.com", why: "access token for a service account key (signed JWT) and a refresh token" },
    { host: "sts.googleapis.com", why: "workload identity federation: swaps an AWS role's credential for a Google token" },
    { host: "iamcredentials.googleapis.com", why: "service account impersonation after the federation token swap" },
  ],
};

/** The named groups that are part of the default list, after the base names. */
export const DEFAULT_AGENT_ALLOW_GROUPS: readonly AgentAllowGroup[] = [GOOGLE_VERTEX_AI_ALLOW_GROUP];

/** The default list: the base names, then every group's hosts in order. */
export const DEFAULT_AGENT_ALLOW_DOMAINS: readonly string[] = [...BASE_AGENT_ALLOW_DOMAINS, ...DEFAULT_AGENT_ALLOW_GROUPS.flatMap((group) => group.hosts.map((entry) => entry.host))];
