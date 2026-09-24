import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvedTools, type GitHubMcpContext } from "../../packages/broker/src/github-mcp.js";
import { GITHUB_MCP_ENDPOINT, githubBinder } from "../../packages/gateway/src/index.js";

const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
  : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)]))
  : item;
const legacyHash = (value: unknown) => createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");

describe("GitHub connector on the gateway", () => {
  it("keeps feature 007 schema hashes so in-flight turns survive the release", () => {
    const repository = { name: "app", url: "https://github.com/acme/app.git", credentialRef: "github-app" };
    const policy = { name: "list_issues", access: "read" as const };
    const context: GitHubMcpContext = { workspaceId: "w", ownerKey: "o", repository, policy: { tools: [policy] } };
    const upstream = { name: "list_issues", description: "List", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } };
    const [tool] = approvedTools({ tools: [upstream] }, context);
    expect(tool?.schemaHash).toBe(legacyHash({ upstream, policy, repository }));
    expect(tool?.repository).toBe("app");
  });

  it("binds owner and repo from the App-issued credential and uses GitHub's hosted endpoint", () => {
    expect(GITHUB_MCP_ENDPOINT.href).toBe("https://api.githubcopilot.com/mcp/");
    expect(githubBinder.properties).toEqual(["owner", "repo"]);
    const scope = { name: "app", url: "https://github.com/acme/app.git", credentialRef: "github-app" };
    expect(githubBinder.bind(scope, { token: "t", bindings: { owner: "acme", repo: "app" } })).toEqual({ owner: "acme", repo: "app" });
  });
});
