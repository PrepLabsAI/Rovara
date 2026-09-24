import { describe, expect, it, vi } from "vitest";
import { listCredentials, registerCredential } from "../../packages/cli/src/admin/credential.js";

describe("credential administration client", () => {
  it("posts a validated registration with the bearer token and returns the server's entry", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ credential: { ref: "linear" }, replaced: false }, { status: 201 }));
    const result = await registerCredential({ controlPlaneUrl: "https://agentx.example.test/", accessToken: "admin-token", ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" }, fetchImplementation);
    expect(result).toEqual({ credential: { ref: "linear" }, replaced: false });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://agentx.example.test/v1/admin/credentials");
    expect(init).toMatchObject({ method: "POST" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(JSON.parse(String(init?.body as string))).toEqual({ ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" });
  });

  it("refuses a bad secret name locally without calling the control plane", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "prod/db" }, fetchImplementation)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("surfaces the server's error code and message", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "CONFIG_INVALID", message: "credential linear: secret agentx/connectors/linear was not found" } }, { status: 400 }));
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" }, fetchImplementation))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: credential linear: secret agentx/connectors/linear was not found" });
  });

  it("surfaces a clean HTTP status when the control plane returns a non-JSON error body", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" }, fetchImplementation))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: HTTP 502" });
  });

  it("lists credentials", async () => {
    const credentials = [{ ref: "github-app", type: "github-app", secretName: "arn", builtIn: true, tokenCached: false }];
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ credentials }));
    expect(await listCredentials({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t" }, fetchImplementation)).toEqual({ credentials });
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });
});
