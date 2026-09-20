import { describe, expect, it } from "vitest";
import { canonicalGitHubRepository, parseAdditionalGitHubAppBindings } from "../../packages/contracts/src/github-app-binding.js";

const binding = {
  credentialRef: "github-charterarc-demo", account: "PrepLabsAI", appId: "5006456", installationId: "163149623",
  privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:charterarc/demo/github-app-private-key-AbCd12",
  repositories: ["https://github.com/PrepLabsAI/charterarc-integration-demo.git"],
};
describe("additional GitHub App bindings", () => {
  it("normalizes repository aliases and accepts absent additional bindings as an empty array", () => {
    expect(parseAdditionalGitHubAppBindings([], "legacy")).toEqual([]);
    expect(canonicalGitHubRepository("https://github.com/PrepLabsAI/charterarc-integration-demo"))
      .toBe("https://github.com/preplabsai/charterarc-integration-demo.git");
    expect(parseAdditionalGitHubAppBindings([binding], "legacy")[0]?.repositories)
      .toEqual(["https://github.com/preplabsai/charterarc-integration-demo.git"]);
  });
  it.each([
    "https://token@github.com/PrepLabsAI/repo.git", "https://github.com:443/PrepLabsAI/repo.git",
    "https://github.com.evil.test/PrepLabsAI/repo.git", "http://github.com/PrepLabsAI/repo.git",
    "https://github.com/x/../PrepLabsAI/repo", "https://github.com/PrepLabsAI/%72epo",
    "https://github.com/PrepLabsAI//repo", "https://github.com/PrepLabsAI/repo/",
    "https://github.com/PrepLabsAI/repo?x=1", "https://github.com/PrepLabsAI/repo#x",
    "https://github.com/PrepLabsAI/..", "https://github.com/PrepLabsAI/repo\n",
    "https://github.com\\PrepLabsAI\\repo",
  ])("rejects noncanonical repository spelling: %s", (url) => {
    expect(() => canonicalGitHubRepository(url)).toThrow(/CONFIG_INVALID/);
  });
  it.each([
    { ...binding, appId: "0" }, { ...binding, installationId: "NaN" },
    { ...binding, credentialRef: "legacy" }, { ...binding, repositories: [] },
    { ...binding, repositories: ["https://github.com/other/repo.git"] },
    { ...binding, privateKeySecretArn: "*" },
    { ...binding, privateKeySecretArn: binding.privateKeySecretArn.replace("AbCd12", "??????") },
    { ...binding, privateKeySecretArn: "arn:aws:s3:::bucket" },
    { ...binding, privateKey: "secret-sentinel" },
  ])("rejects invalid binding without reflecting input", (value) => {
    expect(() => parseAdditionalGitHubAppBindings([value], "legacy"))
      .toThrow("CONFIG_INVALID: invalid GitHub App binding configuration");
  });
  it("rejects repeated references and assignments including aliases within one binding", () => {
    expect(() => parseAdditionalGitHubAppBindings([binding, binding], "legacy")).toThrow();
    expect(() => parseAdditionalGitHubAppBindings([binding, { ...binding, credentialRef: "other",
      repositories: ["https://github.com/preplabsai/charterarc-integration-demo"] }], "legacy")).toThrow();
    expect(() => parseAdditionalGitHubAppBindings([{ ...binding, repositories: [
      binding.repositories[0], "https://github.com/preplabsai/charterarc-integration-demo",
    ] }], "legacy")).toThrow();
  });
  it.each([null, {}, "secret-sentinel", [{ secret: "secret-sentinel" }]])("rejects wrong shapes with a redacted error", (value) => {
    expect(() => parseAdditionalGitHubAppBindings(value, "legacy"))
      .toThrow("CONFIG_INVALID: invalid GitHub App binding configuration");
  });
});
