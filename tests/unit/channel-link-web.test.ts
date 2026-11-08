// Spec 062 FR-031: the link page signs the person in, names what they are linking, and links only on a same-origin confirm.
import { describe, expect, it, vi } from "vitest";
import { agentXError } from "@agentx/contracts";
import { createChannelLinkWeb } from "../../packages/broker/src/aws/channel-link-web.js";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../packages/broker/src/aws/web-session.js";

const origin = "https://rovara.example.com";
const code = "A".repeat(32);
const caller = { developerId: "dev-1", sessionId: "s", amr: "oidc", name: "Ada <script>", email: "ada@example.com" } as never;
const csrf = "c".repeat(40);
const actor = { channel: "whatsapp", tenant: "+14155550100", userId: "+919876544821" };

function setup(options: { signedIn?: boolean; preview?: boolean; redeem?: () => Promise<never> } = {}) {
  const redeem = vi.fn(options.redeem ?? (async () => ({ actor, developerId: "dev-1", linkedAt: "2026-11-08T10:00:00.000Z" })));
  const web = createChannelLinkWeb({
    origin,
    authenticateSession: async (sessionId) => (options.signedIn === false || sessionId !== "session-1" ? undefined : caller),
    preview: async () => (options.preview === false ? undefined : { channel: "whatsapp", maskedUserId: "+91 ••• 4821" }),
    redeem,
  });
  const cookie = `${SESSION_COOKIE}=session-1; ${CSRF_COOKIE}=${csrf}`;
  const get = (path = `/review/link/${code}`, headers: Record<string, string> = { cookie }) =>
    web({ method: "GET", path, headers, requestId: "r" }, new URL(path, origin));
  const confirm = (body = `csrf=${csrf}`, headers: Record<string, string> = { cookie, origin }) => {
    const path = `/review/link/${code}/confirm`;
    return web({ method: "POST", path, headers, body, requestId: "r" }, new URL(path, origin));
  };
  return { get, confirm, redeem };
}

describe("the link page", () => {
  it("sends a signed-out person to sign in and back", async () => {
    const answer = await setup().get(`/review/link/${code}`, {});
    expect(answer.statusCode).toBe(302);
    expect(answer.headers.location).toBe(`/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/link/${code}`)}`);
  });

  it("names the channel, the masked user ID and the login, warns about links from others, and escapes", async () => {
    const answer = await setup().get();
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain("Link <strong>whatsapp</strong> user <strong>+91 ••• 4821</strong> to your Rovara login, <strong>Ada &lt;script&gt;</strong>?");
    expect(answer.body).toContain("If someone else sent it to you, close this page.");
    expect(answer.body).not.toContain("<script>");
    expect(answer.body).toContain(`name="csrf" value="${csrf}"`);
    expect(answer.headers["cache-control"]).toContain("no-store");
  });

  it("says an expired or used code has expired", async () => {
    expect((await setup({ preview: false }).get()).statusCode).toBe(404);
  });

  it("links on a same-origin confirm with the CSRF token", async () => {
    const { confirm, redeem } = setup();
    const answer = await confirm();
    expect(answer.statusCode).toBe(200);
    expect(redeem).toHaveBeenCalledWith("dev-1", code);
  });

  it.each([
    ["another origin", `csrf=${csrf}`, { origin: "https://evil.example.com" }],
    ["a missing CSRF token", "", {}],
    ["a wrong CSRF token", `csrf=${"d".repeat(40)}`, {}],
  ])("refuses a confirm from %s", async (_name, body, headers) => {
    const { confirm, redeem } = setup();
    const answer = await confirm(body, { cookie: `${SESSION_COOKIE}=session-1; ${CSRF_COOKIE}=${csrf}`, origin, ...headers });
    expect(answer.statusCode).toBe(403);
    expect(redeem).not.toHaveBeenCalled();
  });

  it("refuses a signed-out confirm, and a GET to the confirm path", async () => {
    const { confirm, get, redeem } = setup();
    expect((await confirm(`csrf=${csrf}`, { origin })).statusCode).toBe(401);
    expect((await get(`/review/link/${code}/confirm`)).statusCode).toBe(405);
    expect(redeem).not.toHaveBeenCalled();
  });

  it("explains a used code and an account already linked", async () => {
    expect((await setup({ redeem: async () => { throw agentXError("NOT_FOUND", "x"); } }).confirm()).statusCode).toBe(404);
    expect((await setup({ redeem: async () => { throw agentXError("CHANGE_STALE", "x"); } }).confirm()).statusCode).toBe(409);
  });
});
