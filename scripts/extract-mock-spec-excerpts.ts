// Writes the pinned vendor spec excerpts the mock-vs-spec check reads (lane L4-VS):
//   packages/contracts/src/mock-spec-excerpts.generated.ts   (the excerpt text, its sha-256 pin and where it came from)
//   tests/fixtures/mock-spec-slices/stripe-openapi-excerpt.json and github-openapi-excerpt.json   (a readable copy; a test requires it to equal the pin)
//
//   npx tsx scripts/extract-mock-spec-excerpts.ts <stripe spec3.json> <stripe commit sha> <github api.github.com.json> <github commit sha> [retrieved-date]
//
// The inputs are the public, MIT-licensed files github.com/stripe/openapi (latest/openapi.spec3.json) and github.com/github/rest-api-description
// (descriptions/api.github.com/api.github.com.json), checked out at the stated commits. Nothing here talks to the network and nothing about Rovara is sent anywhere.
//
// What an excerpt keeps, verbatim from the vendor file: the openapi version, the API title and version, and for each listed operation its path, method, operationId and the one success
// response's schema; for each schema named there, its `required` list and, for each REQUIRED property only, the keywords `type`, `format`, `enum` and `nullable`. Everything else (descriptions,
// examples, vendor extensions, optional properties, nested definitions, error responses) is removed, so the excerpt stays small and carries no example values.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export interface ExtractSelection { path: string; method: "get" | "post" | "put" | "patch" | "delete" }
export interface ExtractInfo { title: string; version: string }

export const STRIPE_OPERATIONS: readonly ExtractSelection[] = [
  { path: "/v1/charges", method: "post" },
  { path: "/v1/charges/{charge}", method: "get" },
  { path: "/v1/refunds", method: "post" },
  { path: "/v1/payment_intents", method: "post" },
  { path: "/v1/payment_intents/{intent}", method: "get" },
  { path: "/v1/customers", method: "post" },
];
export const GITHUB_OPERATIONS: readonly ExtractSelection[] = [
  { path: "/repos/{owner}/{repo}/issues", method: "get" },
  { path: "/repos/{owner}/{repo}/issues", method: "post" },
  { path: "/repos/{owner}/{repo}/issues/{issue_number}", method: "get" },
  { path: "/repos/{owner}/{repo}/issues/{issue_number}/comments", method: "get" },
  { path: "/repos/{owner}/{repo}/issues/{issue_number}/comments", method: "post" },
];

const KEPT_PROPERTY_KEYWORDS = ["type", "format", "enum", "nullable"] as const;
const isObj = (value: Json | undefined): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const need = (value: Json | undefined, what: string): Obj => { if (!isObj(value)) throw new Error(`vendor spec has no ${what}`); return value; };
const str = (value: Json | undefined, what: string): string => { if (typeof value !== "string") throw new Error(`vendor spec has no ${what}`); return value; };
const schemaNameOf = (ref: string): string => { const match = /^#\/components\/schemas\/([^/]+)$/u.exec(ref); if (match === null) throw new Error(`unsupported $ref ${ref}`); return match[1]!; };

/** Builds one excerpt object from a parsed vendor spec. Throws when a listed operation, its success response or a schema is missing, so a spec change cannot silently shrink the excerpt. */
export function extractExcerpt(spec: Json, selection: readonly ExtractSelection[]): Obj {
  const root = need(spec, "root");
  const info = need(root.info, "info");
  const paths = need(root.paths, "paths");
  const schemas = need(need(root.components, "components").schemas, "components.schemas");
  const outPaths: Obj = {};
  const outSchemas: Obj = {};
  const wanted = (name: string): void => {
    if (outSchemas[name] !== undefined) return;
    const schema = need(schemas[name], `schema ${name}`);
    const required = schema.required;
    if (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")) throw new Error(`schema ${name} lists no required properties`);
    const properties = need(schema.properties, `properties of ${name}`);
    const kept: Obj = {};
    for (const field of required as string[]) {
      const property = need(properties[field], `property ${name}.${field}`);
      const reduced: Obj = {};
      for (const keyword of KEPT_PROPERTY_KEYWORDS) if (property[keyword] !== undefined) reduced[keyword] = property[keyword]!;
      kept[field] = reduced;
    }
    outSchemas[name] = { type: "object", required: required as string[], properties: kept };
  };
  for (const { path, method } of selection) {
    const operation = need(need(paths[path], `path ${path}`)[method], `${method} ${path}`);
    const success = Object.entries(need(operation.responses, `responses of ${method} ${path}`)).filter(([status]) => /^2\d\d$/u.test(status));
    if (success.length !== 1) throw new Error(`${method} ${path} must document exactly one 2xx response`);
    const [status, response] = success[0]!;
    const schema = need(need(need(need(response, "response").content, "content")["application/json"], "application/json")["schema"], "response schema");
    let kept: Obj;
    if (typeof schema["$ref"] === "string") { wanted(schemaNameOf(schema["$ref"])); kept = { $ref: schema["$ref"] }; }
    else if (schema.type === "array" && isObj(schema.items) && typeof schema.items["$ref"] === "string") { wanted(schemaNameOf(schema.items["$ref"])); kept = { type: "array", items: { $ref: schema.items["$ref"] } }; }
    else throw new Error(`${method} ${path} has a response schema this extract does not read`);
    const operationId = operation.operationId;
    if (typeof operationId !== "string") throw new Error(`${method} ${path} has no operationId`);
    const forPath = (outPaths[path] ??= {}) as Obj;
    forPath[method] = { operationId, responses: { [status]: { content: { "application/json": { schema: kept } } } } };
  }
  return {
    openapi: str(root.openapi, "openapi version"),
    info: { title: str(info.title, "title"), version: str(info.version, "version") },
    paths: outPaths,
    components: { schemas: Object.fromEntries(Object.entries(outSchemas).sort(([a], [b]) => (a < b ? -1 : 1))) },
  };
}

export const excerptText = (excerpt: Obj): string => `${JSON.stringify(excerpt, null, 2)}\n`;
export const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const NOTICE = { stripe: "MIT, Copyright (c) 2011- Stripe, Inc. (see THIRD_PARTY_NOTICES.md)", github: "MIT, Copyright (c) 2020 GitHub (see THIRD_PARTY_NOTICES.md)" } as const;

function main(argv: string[]): void {
  const [stripePath, stripeSha, githubPath, githubSha, retrieved = new Date().toISOString().slice(0, 10)] = argv;
  if (stripePath === undefined || stripeSha === undefined || githubPath === undefined || githubSha === undefined) throw new Error("usage: extract-mock-spec-excerpts.ts <stripe spec3.json> <sha> <github api.github.com.json> <sha> [date]");
  for (const sha of [stripeSha, githubSha]) if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("a commit sha is 40 lowercase hex characters");
  const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const vendors = [
    { vendor: "stripe" as const, spec: JSON.parse(readFileSync(stripePath, "utf8")) as Json, ops: STRIPE_OPERATIONS, commit: stripeSha, url: "https://github.com/stripe/openapi", file: "latest/openapi.spec3.json" },
    { vendor: "github" as const, spec: JSON.parse(readFileSync(githubPath, "utf8")) as Json, ops: GITHUB_OPERATIONS, commit: githubSha, url: "https://github.com/github/rest-api-description", file: "descriptions/api.github.com/api.github.com.json" },
  ];
  const lines: string[] = ["// GENERATED by scripts/extract-mock-spec-excerpts.ts: do not edit. A test requires the text to hash to its pin and to equal tests/fixtures/mock-spec-slices/<vendor>-openapi-excerpt.json.", ""];
  for (const entry of vendors) {
    const excerpt = extractExcerpt(entry.spec, entry.ops);
    const text = excerptText(excerpt);
    const info = excerpt.info as Obj;
    writeFileSync(resolve(root, `tests/fixtures/mock-spec-slices/${entry.vendor}-openapi-excerpt.json`), text);
    const name = entry.vendor.toUpperCase();
    lines.push(
      `export const ${name}_SPEC_EXCERPT = ${JSON.stringify(text)};`,
      `export const ${name}_SPEC_PIN = ${JSON.stringify({
        specSha256: sha256Of(text),
        specVersion: `${str(info.version, "version")} (${entry.url.split("/").slice(-2).join("/")} ${entry.commit.slice(0, 12)})`,
        upstream: { url: entry.url, file: entry.file, commit: entry.commit, retrievedAt: retrieved, license: NOTICE[entry.vendor] },
      }, null, 2)} as const;`,
      "",
    );
  }
  mkdirSync(resolve(root, "packages/contracts/src"), { recursive: true });
  writeFileSync(resolve(root, "packages/contracts/src/mock-spec-excerpts.generated.ts"), lines.join("\n"));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
