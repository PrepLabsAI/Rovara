// The default list a cloud install's DNS firewall and a laptop's egress gateway allow is pinned exactly, and the names that let anyone
// upload (a bucket of any AWS account, a GitHub repository or gist of any user) are not on it. Adding an entry means changing this file on purpose, with the reason.
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ALLOW_DOMAINS, isAllowedDomain } from "@agentx/contracts";
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

describe("the default allow-list", () => {
  it("is exactly this list", () => {
    expect([...DEFAULT_AGENT_ALLOW_DOMAINS]).toEqual(EXACT_LIST);
  });

  it("has no wildcard over AWS or over GitHub's hosts, and every entry is a name the firewall accepts", () => {
    const forbidden = ["*.amazonaws.com", "*.aws", "amazonaws.com", "*.github.com", "*.githubusercontent.com", "*.s3.amazonaws.com", "*.r2.cloudflarestorage.com"];
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
