// TS-UX-1 (0.5.10): a dependency named only by the settings the CODE reads (`process.env.DATABASE_URL`, `os.environ["REDIS_URL"]`) is found without a hidden `.env.example`. Read-only and bounded; a comment is not a use;
// a value is never copied; a bare `DATABASE_URL` is Postgres unless a driver names another database, and a question when two kinds of database are in use.
import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { codeEnvReferences } from "../../packages/worker/src/env-detect/env-config.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

describe("references to a setting in code", () => {
  it("reads the names JavaScript and TypeScript use, with their lines", () => {
    const text = [
      "const a = process.env.DATABASE_URL;",
      "const b = process.env['REDIS_URL'];",
      "const { MYSQL_HOST, KAFKA_BROKERS: brokers = 'x' } = process.env;",
      "const c = import.meta.env.VITE_ORDERS;",
      "const d = Deno.env.get(\"AMQP_URL\");",
    ].join("\n");
    expect(codeEnvReferences("src/a.ts", text)).toEqual([
      { name: "DATABASE_URL", line: 1 }, { name: "REDIS_URL", line: 2 }, { name: "MYSQL_HOST", line: 3 }, { name: "KAFKA_BROKERS", line: 3 }, { name: "VITE_ORDERS", line: 4 }, { name: "AMQP_URL", line: 5 },
    ]);
  });
  it("reads the names Python uses", () => {
    const text = ["import os", 'a = os.environ["DATABASE_URL"]', "b = os.environ.get('REDIS_URL', 'x')", 'c = os.getenv("MONGO_URI")', 'd = environ["SMTP_HOST"]'].join("\n");
    expect(codeEnvReferences("app/db.py", text).map((item) => item.name)).toEqual(["DATABASE_URL", "REDIS_URL", "MONGO_URI", "SMTP_HOST"]);
  });
  it("does not count a line comment, a block comment or a docstring (positive control: the same text uncommented is found)", () => {
    const js = ["// const a = process.env.DATABASE_URL;", "/* process.env.REDIS_URL", "   process.env.MYSQL_HOST */", " * process.env.KAFKA_BROKERS", "const live = process.env.AMQP_URL; // process.env.SMTP_HOST"].join("\n");
    expect(codeEnvReferences("src/a.js", js)).toEqual([{ name: "AMQP_URL", line: 5 }]);
    const py = ['# a = os.environ["DATABASE_URL"]', '"""', 'os.environ["REDIS_URL"]', '"""', 'live = os.environ["AMQP_URL"]  # os.getenv("SMTP_HOST")'].join("\n");
    expect(codeEnvReferences("app/a.py", py)).toEqual([{ name: "AMQP_URL", line: 5 }]);
    expect(codeEnvReferences("src/a.js", "const a = process.env.DATABASE_URL;")).toEqual([{ name: "DATABASE_URL", line: 1 }]);
  });
  it("reads no other kind of file, a name that is not upper case, or a name shaped like a key", () => {
    expect(codeEnvReferences("README.md", "process.env.DATABASE_URL")).toEqual([]);
    expect(codeEnvReferences("src/a.ts", "process.env.databaseUrl; process.env.X")).toEqual([]);
  });
});

describe("a dependency found from code", () => {
  it("finds Postgres from process.env.DATABASE_URL with no .env file at all", async () => {
    const detection = await detect({ "src/db.ts": "import http from 'node:http';\nexport const url = process.env.DATABASE_URL;\n" });
    expect(family(detection, "postgres")).toMatchObject({ kind: "database", strength: "mentioned", evidence: [{ path: "src/db.ts", line: 2 }], hints: { envNames: ["DATABASE_URL"], seenBy: ["code"] } });
    expect(detection.notes.join(" ")).toContain("assumed Postgres");
  });
  it("finds Python references the same way and cites the file and line", async () => {
    const detection = await detect({ "app/settings_db.py": "import os\n\nREDIS = os.environ.get('REDIS_URL')\n" });
    expect(family(detection, "redis")).toMatchObject({ kind: "cache", strength: "used", evidence: [{ path: "app/settings_db.py", line: 3 }], hints: { envNames: ["REDIS_URL"] } });
  });
  it("gives a bare DATABASE_URL to the one database a driver names, and assumes nothing then", async () => {
    const detection = await detect({ "package.json": JSON.stringify({ dependencies: { mysql2: "3" } }), "src/db.ts": "export const url = process.env.DATABASE_URL;\n" });
    expect(family(detection, "mysql")!.evidence.some((item) => item.path === "src/db.ts" && item.line === 1)).toBe(true);
    expect(family(detection, "mysql")!.hints.envNames).toEqual(["DATABASE_URL"]);
    expect(family(detection, "postgres")).toBeUndefined();
    expect(detection.notes.join(" ")).not.toContain("assumed Postgres");
  });
  it("asks which database when two kinds are in use, and adds none for the bare setting", async () => {
    const detection = await detect({ "package.json": JSON.stringify({ dependencies: { pg: "8", mysql2: "3" } }), "src/db.ts": "export const url = process.env.DATABASE_URL;\n" });
    expect(detection.questions.join(" ")).toContain("DATABASE_URL");
    expect(family(detection, "postgres")!.hints.envNames).toBeUndefined();
    expect(family(detection, "mysql")!.hints.envNames).toBeUndefined();
  });
  it("leaves a comment alone: no dependency from a commented reference", async () => {
    const detection = await detect({ "src/db.ts": "// export const url = process.env.DATABASE_URL;\nexport const x = 1;\n" });
    expect(detection.dependencies).toBeUndefined();
  });
  it("never copies a value: only the name and the place", async () => {
    const secret = ["pw", "q".repeat(20), "Z9"].join("-");
    const detection = await detect({ "src/db.ts": `const url = process.env.DATABASE_URL ?? "postgres://app:${secret}@db.internal.example-corp.net/app";\n` });
    expect(JSON.stringify(detection)).not.toContain(secret);
    expect(JSON.stringify(detection)).not.toContain("example-corp");
  });
  it("skips a test folder and a dependency folder, and reads no more than the source budget", async () => {
    const detection = await detect({ "tests/db.test.ts": "process.env.REDIS_URL;", "node_modules/x/index.js": "process.env.MYSQL_HOST;" });
    expect(detection.dependencies).toBeUndefined();
  });
});

describe("Prisma", () => {
  it("names the database from the schema's provider and the setting from env(), and copies no value", async () => {
    const schema = ['generator client {', '  provider = "prisma-client-js"', '}', 'datasource db {', '  provider = "postgresql"', '  url      = env("DATABASE_URL")', '}'].join("\n");
    const detection = await detect({ "prisma/schema.prisma": schema });
    expect(family(detection, "postgres")).toMatchObject({ kind: "database", strength: "used", evidence: [{ path: "prisma/schema.prisma", line: 5 }], hints: { envNames: ["DATABASE_URL"], seenBy: ["env"] } });
    const mongo = await detect({ "schema.prisma": 'datasource db {\n  provider = "mongodb"\n  url = env("MONGO_URL")\n}\n' });
    expect(family(mongo, "mongodb")).toBeDefined();
    expect((await detect({ "schema.prisma": 'datasource db {\n  provider = "sqlite"\n  url = "file:dev.db"\n}\n' })).dependencies).toBeUndefined();
  });
});
