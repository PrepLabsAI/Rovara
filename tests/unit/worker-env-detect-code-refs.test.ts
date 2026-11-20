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
});

describe("a dependency found from code", () => {
  it("asks which database when two kinds are in use, and adds none for the bare setting", async () => {
    const detection = await detect({ "package.json": JSON.stringify({ dependencies: { pg: "8", mysql2: "3" } }), "src/db.ts": "export const url = process.env.DATABASE_URL;\n" });
    expect(detection.questions.join(" ")).toContain("DATABASE_URL");
    expect(family(detection, "postgres")!.hints.envNames).toBeUndefined();
    expect(family(detection, "mysql")!.hints.envNames).toBeUndefined();
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
