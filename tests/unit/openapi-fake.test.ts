// General fakes slice 1 (DEC 234): the OpenAPI adapter of the contract finder. A spec becomes per-operation answers through PR 589's generic shape and mock code; anything it cannot fake
// exactly is refused per operation ("operation_unsupported"), never guessed, and a file that is not an OpenAPI 3 description is "spec_unreadable".
import { describe, expect, it } from "vitest";
import { answerOpenApiFake, buildOpenApiFake, OPENAPI_FAKE_LIMITS } from "../../packages/contracts/src/openapi-fake.js";

const spec = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ openapi: "3.0.3", info: { title: "t", version: "1" }, paths, ...extra });
const json = (schema: unknown, status = "200") => ({ responses: { [status]: { description: "ok", content: { "application/json": { schema } } } } });

describe("buildOpenApiFake", () => {
  it("answers each operation with a typical body built from its JSON answer schema, through components refs", () => {
    const fake = buildOpenApiFake(spec({
      "/pets/{petId}": { get: json({ $ref: "#/components/schemas/Pet" }) },
      "/pets": { get: json({ type: "array", items: { $ref: "#/components/schemas/Pet" } }), post: json({ $ref: "#/components/schemas/Pet" }, "201") },
    }, { components: { schemas: { Pet: { type: "object", description: "a pet", required: ["id"], properties: { id: { type: "integer", format: "int64", minimum: 1, maximum: 9 }, name: { type: "string", example: "Rex" }, tags: { type: "array", items: { type: "string" } } } } } } }), "repo/api/openapi.yaml");
    expect(fake.status).toBe("built");
    expect(answerOpenApiFake(fake, "GET", "/pets/42")).toEqual({ kind: "served", status: 200, body: { id: 5, name: "example", tags: ["example"] } });
    expect(answerOpenApiFake(fake, "get", "/pets")).toEqual({ kind: "served", status: 200, body: [{ id: 5, name: "example", tags: ["example"] }] });
    expect(answerOpenApiFake(fake, "POST", "/pets")).toEqual({ kind: "served", status: 201, body: { id: 5, name: "example", tags: ["example"] } });
  });

  it("matches a concrete path before a templated one, strips the server's base path, and ignores the query", () => {
    const fake = buildOpenApiFake(spec({
      "/users/{id}": { get: json({ type: "object", properties: { kind: { type: "string" } } }) },
      "/users/me": { get: json({ type: "object", properties: { me: { type: "boolean" } } }) },
    }, { servers: [{ url: "https://api.example.test/v1/" }] }), "openapi.json");
    expect(answerOpenApiFake(fake, "GET", "/users/me")).toEqual({ kind: "served", status: 200, body: { me: true } });
    expect(answerOpenApiFake(fake, "GET", "/v1/users/me?x=1")).toEqual({ kind: "served", status: 200, body: { me: true } });
    expect(answerOpenApiFake(fake, "GET", "/v1/users/7")).toEqual({ kind: "served", status: 200, body: { kind: "example" } });
  });

  it("answers an operation with no answer body with its status and no body", () => {
    const fake = buildOpenApiFake(spec({ "/pets/{id}": { delete: { responses: { "204": { description: "gone" } } } } }), "openapi.yaml");
    expect(answerOpenApiFake(fake, "DELETE", "/pets/1")).toEqual({ kind: "served", status: 204, body: undefined });
  });

  it("an unlisted path or method is operation_unknown", () => {
    const fake = buildOpenApiFake(spec({ "/pets": { get: json({ type: "string" }) } }), "openapi.yaml");
    expect(answerOpenApiFake(fake, "GET", "/owners")).toEqual({ kind: "cannot_answer", reason: "operation_unknown" });
    expect(answerOpenApiFake(fake, "PUT", "/pets")).toEqual({ kind: "cannot_answer", reason: "operation_unknown" });
    expect(answerOpenApiFake(fake, "GET", "/pets/extra")).toEqual({ kind: "cannot_answer", reason: "operation_unknown" });
  });

  it("refuses per operation what it cannot fake exactly (enum, oneOf, nullable, additionalProperties, external refs, cycles, non-JSON, no 2xx), and keeps the rest", () => {
    const unsupported = [
      json({ type: "string", enum: ["a", "b"] }),
      json({ oneOf: [{ type: "string" }, { type: "integer" }] }),
      json({ type: "object", properties: { a: { type: "string", nullable: true } } }),
      json({ type: "object", additionalProperties: { type: "string" } }),
      json({ $ref: "other.yaml#/Pet" }),
      json({ $ref: "#/components/schemas/Loop" }),
      { responses: { "200": { description: "x", content: { "text/plain": { schema: { type: "string" } } } } } },
      { responses: { "404": { description: "x" } } },
      json({ $ref: "#/components/schemas/Missing" }),
    ];
    const paths = Object.fromEntries(unsupported.map((operation, index) => [`/u${String(index)}`, { get: operation }]));
    const fake = buildOpenApiFake(spec({ ...paths, "/ok": { get: json({ type: "boolean" }) } }, { components: { schemas: { Loop: { type: "object", properties: { next: { $ref: "#/components/schemas/Loop" } } } } } }), "openapi.yaml");
    for (const index of unsupported.keys()) expect(answerOpenApiFake(fake, "GET", `/u${String(index)}`), `case ${String(index)}`).toEqual({ kind: "cannot_answer", reason: "operation_unsupported" });
    expect(answerOpenApiFake(fake, "GET", "/ok")).toEqual({ kind: "served", status: 200, body: true });
  });

  it("anything that is not an OpenAPI 3 description is spec_unreadable, with no echoed text", () => {
    for (const document of [null, "openapi: 3", [], { swagger: "2.0", paths: {} }, { openapi: "4.0.0", paths: {} }, { openapi: "3.1.0" }, { openapi: "3.0.0", paths: [] }, { openapi: "3.0.0", paths: { "no-slash": {} } }]) {
      expect(buildOpenApiFake(document, "openapi.yaml")).toEqual({ status: "not_built", reason: "spec_unreadable" });
    }
  });

  it("a description past the operation limit is spec_unreadable as a whole, never partly served", () => {
    const paths = Object.fromEntries(Array.from({ length: OPENAPI_FAKE_LIMITS.operations + 1 }, (_, index) => [`/p${String(index)}`, { get: json({ type: "string" }) }]));
    expect(buildOpenApiFake(spec(paths), "openapi.yaml")).toEqual({ status: "not_built", reason: "spec_unreadable" });
  });

  it("a deep chain of refs over the whole-document budget refuses those operations in bounded time", () => {
    const schemas: Record<string, unknown> = {};
    for (let index = 0; index < 400; index += 1) schemas[`S${String(index)}`] = { type: "object", properties: Object.fromEntries(Array.from({ length: 50 }, (_, field) => [`f${String(field)}`, index === 399 ? { type: "string" } : { $ref: `#/components/schemas/S${String(index + 1)}` }])) };
    const paths = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`/p${String(index)}`, { get: json({ $ref: "#/components/schemas/S0" }) }]));
    const started = performance.now();
    const fake = buildOpenApiFake(spec(paths, { components: { schemas } }), "openapi.yaml");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(answerOpenApiFake(fake, "GET", "/p0")).toEqual({ kind: "cannot_answer", reason: "operation_unsupported" });
  });

  it("never copies example values from the description into answers", () => {
    const fake = buildOpenApiFake(spec({ "/s": { get: json({ type: "object", properties: { secret: { type: "string", example: "sk-live-looking-value", default: "x-default" } } }) } }), "openapi.yaml");
    expect(JSON.stringify(answerOpenApiFake(fake, "GET", "/s"))).not.toMatch(/sk-live|x-default/u);
  });
});
