// One page of a pull request's changed files, for the task diff screen: the request GitHub is asked, the paging flag, and
// what is refused (a page or a file that does not read is an error, never a shorter answer).
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";

function provider(files: unknown, options: { link?: string; status?: number } = {}) {
  const urls: string[] = [];
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const instance = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), now: () => Date.parse("2026-10-30T10:00:00Z"),
    fetchImplementation: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 9, account: { login: "acme" } }));
      if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      return new Response(JSON.stringify(files), { status: options.status ?? 200, headers: options.link === undefined ? {} : { link: options.link } });
    },
  });
  return { instance, urls };
}
const file = (name: string, extra: Record<string, unknown> = {}) => ({ filename: name, status: "modified", additions: 2, deletions: 1, ...extra });

describe("getPullRequestFilesPage", () => {
  it("asks GitHub for the page and says whether another follows", async () => {
    const { instance, urls } = provider([file("a.ts", { patch: "@@ patch" }), file("b.png")], { link: '<https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last"' });
    const page = await instance.getPullRequestFilesPage("https://github.com/acme/demo", 7, 2, 30);
    expect(page).toEqual({ files: [{ filename: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ patch" }, { filename: "b.png", status: "modified", additions: 2, deletions: 1 }], more: true });
    expect(urls.at(-1)).toBe("https://api.github.com/repos/acme/demo/pulls/7/files?per_page=30&page=2");
    const last = provider([file("a.ts")], { link: '<https://api.github.com/x?page=1>; rel="prev"' });
    expect((await last.instance.getPullRequestFilesPage("https://github.com/acme/demo", 7, 2)).more).toBe(false);
    expect((await provider([]).instance.getPullRequestFilesPage("https://github.com/acme/demo", 7, 1)).more).toBe(false);
  });

  it("refuses a page or a file that does not read, and a page number that is not valid", async () => {
    for (const body of ["nope", {}, [file("")], [file("a", { additions: "1" })], [file("a", { status: 5 })], [null], [file("x".repeat(501))], Array.from({ length: 31 }, (_, index) => file(`f${index}`))]) {
      await expect(provider(body).instance.getPullRequestFilesPage("https://github.com/acme/demo", 7, 1, 30)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    }
    await expect(provider([], { status: 500 }).instance.getPullRequestFilesPage("https://github.com/acme/demo", 7, 1)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    for (const [number, page, perPage] of [[0, 1, 30], [7, 0, 30], [7, 101, 30], [7, 1.5, 30], [7, 1, 0], [7, 1, 101], [1.5, 1, 30]] as const) {
      await expect(provider([]).instance.getPullRequestFilesPage("https://github.com/acme/demo", number, page, perPage)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });
});
