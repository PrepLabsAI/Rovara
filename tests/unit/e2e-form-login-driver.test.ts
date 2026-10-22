import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createPlaywrightFormLoginDriver, isSessionCookieSecret, isSessionStorageSecret, parseSetCookie } from "../../packages/verifier/src/executor/form-login.js";

const signal = new AbortController().signal;
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }))); });

describe("which cookies are session secrets", () => {
  it("takes 16 characters or more, or HttpOnly and 8 to 15 that mix letters and digits, and nothing shorter or plainer (N1)", () => {
    const secret = (value: string, httpOnly = false) => isSessionCookieSecret({ value, httpOnly });
    expect(secret("0123456789abcdef")).toBe(true);
    expect(secret("0123456789abcde")).toBe(false);
    expect(secret("abcd1234", true)).toBe(true);
    expect(secret("abcd123", true)).toBe(false);
    for (const word of ["", "1", "true", "accepted", "dark", "en-US"]) expect(secret(word), word).toBe(false);
    // An HttpOnly cookie that is a plain word or a plain number (some frameworks make every server cookie HttpOnly) is a setting, not a session id.
    for (const plain of ["accepted", "AcceptedWord", "123456789", "en-US-latin"]) expect(secret(plain, true), plain).toBe(false);
    // Sixteen characters are a secret whatever they hold, HttpOnly or not.
    expect(secret("acceptedwordsonly")).toBe(true);
    expect(secret("acceptedwordsonly", true)).toBe(true);
  });

  it("takes a local storage value of 16 characters or more, and nothing shorter (N3)", () => {
    expect(isSessionStorageSecret("0123456789abcdef")).toBe(true);
    expect(isSessionStorageSecret("0123456789abcde")).toBe(false);
    expect(isSessionStorageSecret("dark")).toBe(false);
  });
});

describe("Set-Cookie lines", () => {
  it("reads the name, the value and HttpOnly, and nothing else", () => {
    expect(parseSetCookie("sid=abc.def==; Path=/; HttpOnly; SameSite=Strict")).toEqual({ name: "sid", value: "abc.def==", httpOnly: true });
    expect(parseSetCookie("consent=1; Path=/")).toEqual({ name: "consent", value: "1", httpOnly: false });
    expect(parseSetCookie("x=; Max-Age=0")).toEqual({ name: "x", value: "", httpOnly: false });
    expect(parseSetCookie("no-equals-sign")).toBeNull();
    expect(parseSetCookie("")).toBeNull();
  });
});

describe("the form login's request context", () => {
  it("hands back the Set-Cookie lines of every answer, and carries what the state held and what it was set since", async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(`${request.url} ${request.headers.cookie ?? ""}`);
      if (request.url === "/rotate") response.writeHead(200, { "set-cookie": ["sid=rotated-0123456789abcdef; HttpOnly; Path=/", "consent=2; Path=/"], "content-type": "text/plain" });
      else response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const driver = createPlaywrightFormLoginDriver({ cdpEndpoint: "ws://127.0.0.1:1/unused", guard: async () => undefined });
    const context = await driver.requestContext({ origin, state: { cookies: [{ name: "sid", value: "first-0123456789abcdef", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" }], origins: [] } });
    try {
      const first = await context.request({ method: "GET", path: "/rotate", signal });
      expect(first.status).toBe(200);
      expect(first.setCookies).toEqual(["sid=rotated-0123456789abcdef; HttpOnly; Path=/", "consent=2; Path=/"]);
      const second = await context.request({ method: "GET", path: "/next", signal });
      expect(second.setCookies).toEqual([]);
      expect(seen[0]).toContain("sid=first-0123456789abcdef");
      expect(seen[1]).toContain("sid=rotated-0123456789abcdef");
    } finally { await context.dispose(); }
  });
});
