// The default list a cloud install's DNS firewall and a laptop's egress gateway allow is pinned exactly, and the names that let anyone
// upload (a bucket of any AWS account, a GitHub repository or gist of any user) are not on it. Adding an entry means changing this file on purpose, with the reason.
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ALLOW_DOMAINS, DEFAULT_AGENT_ALLOW_GROUPS, GOOGLE_VERTEX_AI_ALLOW_GROUP, isAllowedDomain } from "@agentx/contracts";
import { VERTEX_LOCATIONS } from "../../packages/contracts/src/vertex-locations.js";
import { LOCAL_DEFAULT_ALLOW_DOMAINS, hostIsAllowed } from "../../packages/broker/src/local/isolation/allow-list.js";
import { hostAlreadyAllowed } from "../../packages/broker/src/core/setup-agent/host-refusal.js";

const EXACT_LIST = [
  "*.compute.internal", "*.ec2.internal", "*.42.10.in-addr.arpa",
  "github.com", "ghcr.io", "*.ghcr.io", "pkg-containers.githubusercontent.com",
  "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "codeload.github.com",
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "*.crates.io",
  "proxy.golang.org", "sum.golang.org",
  "repo.maven.apache.org", "repo1.maven.org",
  "rubygems.org", "*.rubygems.org",
  "deb.debian.org", "security.debian.org",
  "archive.ubuntu.com", "ports.ubuntu.com", "security.ubuntu.com",
  "dl-cdn.alpinelinux.org",
  "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com",
  "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
  "mcr.microsoft.com", "*.data.mcr.microsoft.com", "nodejs.org",
  "api.anthropic.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "openrouter.ai",
  "slack.com", "*.slack.com", "api.linear.app", "mcp.linear.app", "*.atlassian.net", "app.asana.com",
];
// The named group "Google Vertex AI" (owner 2026-11-17), after the base names: the global host, one host per Vertex location, the Gemini API and Google's three token hosts.
const VERTEX_GROUP_HOSTS = [
  "aiplatform.googleapis.com", ...VERTEX_LOCATIONS.map((location) => `${location}-aiplatform.googleapis.com`),
  "generativelanguage.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com",
];
// Google names that must never be reachable by default: any other Google API (data stores above all), the mTLS and regional-endpoint forms, www.googleapis.com, the metadata server.
const GOOGLE_EXITS = [
  "storage.googleapis.com", "bucket.storage.googleapis.com", "firebasestorage.googleapis.com", "bigquery.googleapis.com", "drive.googleapis.com", "docs.googleapis.com", "sheets.googleapis.com", "cloudfunctions.googleapis.com",
  "run.googleapis.com", "www.googleapis.com", "content-storage.googleapis.com", "x.googleapis.com", "googleapis.com", "aiplatform.mtls.googleapis.com", "aiplatform.us-central1.rep.googleapis.com",
  "evil-aiplatform.googleapis.com.example.net", "aiplatform.googleapis.com.evil.dev", "x.aiplatform.googleapis.com", "us-central1-aiplatform.googleapis.com.evil.dev", "sts.us-central1.rep.googleapis.com",
  "metadata.google.internal", "accounts.google.com", "storage.cloud.google.com", "docs.google.com", "drive.google.com", "firebasevertexai.googleapis.com",
];

describe("the default allow-list", () => {
  it("is exactly this list", () => {
    expect([...DEFAULT_AGENT_ALLOW_DOMAINS]).toEqual([...EXACT_LIST, ...VERTEX_GROUP_HOSTS]);
  });

  it("pins the Vertex AI locations by hand: the list is not whatever the catalog constant holds", () => {
    expect(VERTEX_LOCATIONS).toHaveLength(45);
    expect([...VERTEX_LOCATIONS].sort().join(" ")).toBe(
      "africa-south1 asia-east1 asia-east2 asia-northeast1 asia-northeast2 asia-northeast3 asia-south1 asia-south2 asia-southeast1 asia-southeast2 australia-southeast1 australia-southeast2 eu europe-central2 europe-north1 europe-north2 europe-southwest1 europe-west1 europe-west10 europe-west12 europe-west2 europe-west3 europe-west4 europe-west6 europe-west8 europe-west9 me-central1 me-central2 me-west1 northamerica-northeast1 northamerica-northeast2 northamerica-south1 southamerica-east1 southamerica-west1 us us-central1 us-east1 us-east4 us-east5 us-south1 us-west1 us-west2 us-west3 us-west4 us-west8",
    );
  });

  it("holds Google's Vertex AI and Gemini names as one named group of exact hosts, each with a reason, and nothing broad", () => {
    expect(DEFAULT_AGENT_ALLOW_GROUPS.map((group) => group.id)).toEqual(["google-vertex-ai"]);
    expect(GOOGLE_VERTEX_AI_ALLOW_GROUP.name).toBe("Google Vertex AI");
    expect(GOOGLE_VERTEX_AI_ALLOW_GROUP.hosts.map((entry) => entry.host)).toEqual(VERTEX_GROUP_HOSTS);
    for (const entry of GOOGLE_VERTEX_AI_ALLOW_GROUP.hosts) {
      expect(entry.why.length, entry.host).toBeGreaterThan(10);
      expect(entry.host, entry.host).not.toContain("*");
      expect(entry.host, entry.host).toMatch(/^[a-z0-9-]+\.googleapis\.com$/u);
    }
    const hosts = GOOGLE_VERTEX_AI_ALLOW_GROUP.hosts.map((entry) => entry.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hosts.filter((host) => host.endsWith("-aiplatform.googleapis.com"))).toHaveLength(VERTEX_LOCATIONS.length);
    for (const host of ["us-central1-aiplatform.googleapis.com", "europe-west4-aiplatform.googleapis.com", "us-aiplatform.googleapis.com", "eu-aiplatform.googleapis.com"]) expect(hosts, host).toContain(host);
    // Every Google name of the whole default list is in the group (nothing else under googleapis.com was added by hand).
    expect(DEFAULT_AGENT_ALLOW_DOMAINS.filter((entry) => entry.endsWith("googleapis.com"))).toEqual(hosts);
    expect(DEFAULT_AGENT_ALLOW_DOMAINS.filter((entry) => entry.includes("google") && !entry.endsWith("googleapis.com"))).toEqual([]);
  });

  it("lets the Vertex AI, Gemini and Google token hosts through, by the way the firewall, the broker and the gateway read the list", () => {
    for (const host of VERTEX_GROUP_HOSTS) {
      expect(hostIsAllowed(host, DEFAULT_AGENT_ALLOW_DOMAINS), host).toBe(true);
      expect(hostIsAllowed(host, LOCAL_DEFAULT_ALLOW_DOMAINS), host).toBe(true);
      expect(hostAlreadyAllowed(host, []), host).toBe(true);
    }
  });

  it("keeps storage and every other Google API blocked, and a lookalike or sub-name of an allowed Google host", () => {
    for (const host of GOOGLE_EXITS) {
      expect(hostIsAllowed(host, DEFAULT_AGENT_ALLOW_DOMAINS), host).toBe(false);
      expect(hostIsAllowed(host, LOCAL_DEFAULT_ALLOW_DOMAINS), host).toBe(false);
      expect(hostAlreadyAllowed(host, []), host).toBe(false);
    }
  });

  it("has no wildcard over AWS or over GitHub's hosts, and every entry is a name the firewall accepts", () => {
    const forbidden = ["*.amazonaws.com", "*.aws", "amazonaws.com", "*.github.com", "*.githubusercontent.com", "*.s3.amazonaws.com", "*.r2.cloudflarestorage.com", "*.googleapis.com", "*.google.com", "googleapis.com", "*-aiplatform.googleapis.com", "*.aiplatform.googleapis.com", "*.storage.googleapis.com"];
    for (const entry of forbidden) expect(DEFAULT_AGENT_ALLOW_DOMAINS, entry).not.toContain(entry);
    for (const entry of DEFAULT_AGENT_ALLOW_DOMAINS) {
      expect(entry.endsWith("amazonaws.com") || entry.endsWith(".aws"), entry).toBe(false);
      // GitHub: only the git host, the image registry's blob host and the four read-only download hosts, each by exact name.
      if (entry.endsWith("githubusercontent.com")) expect(["pkg-containers.githubusercontent.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]).toContain(entry);
      if (entry.endsWith("github.com")) expect(["github.com", "codeload.github.com"]).toContain(entry);
    }
    for (const entry of DEFAULT_AGENT_ALLOW_DOMAINS.filter((name) => !name.endsWith(".internal") && !name.endsWith(".in-addr.arpa"))) expect(isAllowedDomain(entry), entry).toBe(true);
  });

  it("does not let a bucket, an API, a gist or a user-content host of anyone's through, by the way the firewall and the gateway read the list", () => {
    const exits = [
      "attacker-bucket.s3.amazonaws.com", "attacker-bucket.s3.us-west-2.amazonaws.com", "s3.amazonaws.com", "abc123.execute-api.us-east-1.amazonaws.com", "x.lambda-url.us-east-1.on.aws", "x.api.aws",
      "api.github.com", "gist.github.com", "uploads.github.com", "gist.githubusercontent.com", "user-images.githubusercontent.com", "avatars.githubusercontent.com", "x.codeload.github.com",
    ];
    for (const host of exits) {
      expect(hostIsAllowed(host, DEFAULT_AGENT_ALLOW_DOMAINS), host).toBe(false);
      expect(hostIsAllowed(host, LOCAL_DEFAULT_ALLOW_DOMAINS), host).toBe(false);
      expect(hostAlreadyAllowed(host, []), host).toBe(false);
    }
  });

  it("still lets the worker's git, the image pulls and the read-only download hosts through", () => {
    for (const host of ["github.com", "ghcr.io", "x.ghcr.io", "pkg-containers.githubusercontent.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "codeload.github.com"]) expect(hostAlreadyAllowed(host, []), host).toBe(true);
  });
});
