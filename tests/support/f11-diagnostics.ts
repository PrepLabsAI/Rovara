// Test-only diagnostics: no executor, gateway policy, or runtime contract changes.
export const F11_ALLOWED_TARGETS = {
  allowed: "https://registry.npmjs.org/-/ping",
  allowedSecond: "https://github.com/",
};

interface ProbeRequest {
  url(): string;
  failure(): { errorText: string } | null;
  redirectedFrom(): ProbeRequest | null;
}
interface ProbeResponse {
  url(): string;
  status(): number;
  request(): ProbeRequest;
}
export interface ProbePage {
  on(event: "requestfailed", listener: (request: ProbeRequest) => void): void;
  on(event: "response", listener: (response: ProbeResponse) => void): void;
  off(event: "requestfailed", listener: (request: ProbeRequest) => void): void;
  off(event: "response", listener: (response: ProbeResponse) => void): void;
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<ProbeResponse | null>;
  locator(selector: string): { innerText(): Promise<string> };
}

// Self-contained so its source can run in the hardened executor's node -e probe.
export async function probeF11Navigation(page: ProbePage, url: string, timeout: number) {
  const requestFailures: Array<{ url: string; errorText: string | null }> = [];
  const responses: Array<{ url: string; status: number; redirects: string[] }> = [];
  const failed = (request: ProbeRequest) => {
    requestFailures.push({ url: request.url(), errorText: request.failure()?.errorText ?? null });
  };
  const responded = (response: ProbeResponse) => {
    const redirects: string[] = [];
    for (let previous = response.request().redirectedFrom(); previous !== null; previous = previous.redirectedFrom()) redirects.unshift(previous.url());
    responses.push({ url: response.url(), status: response.status(), redirects });
  };
  page.on("requestfailed", failed);
  page.on("response", responded);
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    return { status: response?.status() ?? null, body: (await page.locator("body").innerText()).slice(0, 2000), requestFailures, responses };
  } catch (error) {
    return { error: typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error), requestFailures, responses };
  } finally {
    page.off("requestfailed", failed);
    page.off("response", responded);
  }
}

export function f11GatewaySource(source: string): string {
  const anchor = "const parsed = serverNameOf(held);";
  if (source.split(anchor).length !== 2) throw new Error("F11 TLS diagnostic anchor must occur exactly once");
  // Test fixture only: observe even successful/incomplete parses, without the
  // production refusal logger's rate limit or any change to the allow decision.
  return source.replace(anchor, anchor + String.raw`
      process.stdout.write(JSON.stringify({ event: "f11_tls_sni", port: 443, host: parsed.name ?? null, error: parsed.error ?? null, more: parsed.more === true }) + "\n");`);
}

// Cleanup can fail after it has deleted the containers that own the evidence.
// Snapshot first; emit only on failure, preserving collection errors as evidence.
export async function snapshotF11Diagnostics(sources: Record<string, () => Promise<unknown>>) {
  return Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([label, collect]) => {
    let evidence: unknown;
    try { evidence = await collect(); }
    catch (error) { evidence = { diagnosticError: String(error) }; }
    return [label, async () => evidence] as const;
  })));
}

export async function withF11FailureDiagnostics<T>(action: () => Promise<T>, sources: Record<string, () => Promise<unknown>>, write: (message: string) => void): Promise<T> {
  try {
    return await action();
  } catch (error) {
    for (const [label, collect] of Object.entries(sources)) {
      let evidence: unknown;
      try { evidence = await collect(); }
      catch (diagnosticError) { evidence = { diagnosticError: String(diagnosticError) }; }
      // A diagnostic sink must never replace the assertion/command failure.
      try { write(`[F11 ${label}]\n${typeof evidence === "string" ? evidence : JSON.stringify(evidence, null, 2)}`); }
      catch { /* Continue with the remaining evidence sources. */ }
    }
    throw error;
  }
}

// Also serialized into node -e; queries use the sandbox's configured resolver.
export async function probeF11Dns(resolver: { resolve4(host: string): Promise<string[]>; resolve6(host: string): Promise<string[]> }, hosts: string[]) {
  const answer = async (query: () => Promise<string[]>) => {
    try { return { addresses: await query() }; }
    catch (error) { return { error: typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error) }; }
  };
  return Object.fromEntries(await Promise.all(hosts.map(async (host) => [host, {
    ipv4: await answer(() => resolver.resolve4(host)),
    ipv6: await answer(() => resolver.resolve6(host)),
  }] as const)));
}
