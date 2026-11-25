// CODE-PUBLIC-URL (owner DEC 254zzz505): a new URL must not bypass the setting. The control plane's own API host (`attrApiEndpoint`) may be composed into a URL in exactly one file of
// infra/lib, the helper (public-api-url.ts), and the broker may build an API host (`<id>.execute-api...`) only where it derives the sign-in issuer from a packed API id; anything else is
// refused here, so a later lane that builds an external URL from the raw host fails this test and goes through publicApiBase / publicApiUrl instead.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sources(path);
    return /\.(ts|tsx|mts)$/u.test(name) && !/\.d\.ts$/u.test(name) ? [path] : [];
  });
}

/**
 * Code without comments (a doc comment may name the host; only code builds a URL). A block comment is one that starts a line (an ARN's `/*` inside a string is not one), and a `//` after
 * a colon or a quote is a URL's, not a comment's.
 */
export function withoutComments(text: string): string {
  return text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gmu, "").replace(/(^|[^:"'`\\])\/\/.*$/gmu, "$1");
}

/** The files (relative to the repository) whose code mentions `pattern`, with the lines. */
export function uses(files: string[], pattern: RegExp): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    const lines = withoutComments(readFileSync(file, "utf8")).split("\n").filter((line) => pattern.test(line)).map((line) => line.trim());
    if (lines.length > 0) found.set(relative(ROOT, file), lines);
  }
  return found;
}

const INFRA = sources(join(ROOT, "infra", "lib"));
const BROKER = sources(join(ROOT, "packages", "broker", "src"));

describe("no external URL bypasses the public address helper", () => {
  it("composes the control plane API's own host (attrApiEndpoint) only in the helper, and in the installer's own setup API", () => {
    const found = uses(INFRA, /attrApiEndpoint/u);
    // installer.ts: the installer's own SetupApi (its setup page), not the control plane.
    expect([...found.keys()].sort()).toEqual(["infra/lib/installer.ts", "infra/lib/public-api-url.ts"]);
    expect(found.get("infra/lib/public-api-url.ts")).toEqual(["return api.attrApiEndpoint;"]);
  });

  it("reads the raw host (rawApiEndpoint) only for the helper's own base and the raw ApiEndpoint output", () => {
    const found = uses(INFRA, /rawApiEndpoint\(/u);
    expect([...found.keys()].sort()).toEqual(["infra/lib/control-plane.ts", "infra/lib/public-api-url.ts"]);
    expect(found.get("infra/lib/control-plane.ts")).toEqual(['new CfnOutput(this, "ApiEndpoint", { value: rawApiEndpoint(api) });']);
  });

  it("builds an API host in the broker only where the sign-in issuer is derived from a packed API id (and has no public address)", () => {
    const found = uses(BROKER, /\.execute-api\./u);
    expect([...found.keys()]).toEqual(["packages/broker/src/aws/broker-environment.ts"]);
    const lines = found.get("packages/broker/src/aws/broker-environment.ts")!;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^return `https:\/\/\$\{value\}\..*\/v1\/auth`;$/u);
  });

  it("reaches that one site only after the public address is read first", () => {
    const text = readFileSync(join(ROOT, "packages", "broker", "src", "aws", "broker-environment.ts"), "utf8");
    const publicRead = text.indexOf("if (isSet(origin)) return `${origin}/v1/auth`;");
    expect(publicRead).toBeGreaterThan(0);
    expect(text.indexOf(".execute-api.", publicRead)).toBeGreaterThan(publicRead);
  });

  it("the scan itself sees a bypass (a mutant that composes the raw host into a URL is caught)", () => {
    const mutant = "const callback = `${props.api.attrApiEndpoint}/v1/slack/events`; // attrApiEndpoint in a comment is fine\nconst raw = rawApiEndpoint(api);\n";
    expect(withoutComments(mutant)).toContain("props.api.attrApiEndpoint}/v1/slack/events");
    expect(withoutComments("// attrApiEndpoint only in a comment\n/* attrApiEndpoint */\n/**\n * attrApiEndpoint\n */\nconst a = 'https://x';")).not.toMatch(/attrApiEndpoint/u);
    expect(withoutComments("const u = `https://abc.example/v1`;")).toContain("https://abc.example/v1");
  });
});
