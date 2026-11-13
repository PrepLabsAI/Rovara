// TS-UX-1 (0.5.10): which commands need a database that exists only inside the test environment (seeds and migrations), so they are routed to the dependency's seed and never to SETUP.
import { describe, expect, it } from "vitest";
import { isDatabaseSeedCommand, parseCommandLine } from "@rovara-code/contracts";

const is = (line: string): boolean => isDatabaseSeedCommand(parseCommandLine(line, "svc", 900));

describe("a command that needs the test database", () => {
  it.each([
    "npm run seed", "npm run db:seed", "npm run seed:test", "yarn seed", "pnpm run db:migrate", "npm run migrate", "npx prisma db seed", "npx prisma migrate deploy", "npx knex seed:run", "npx sequelize db:migrate",
    "node scripts/seed.js", "tsx scripts/seed.ts", "python manage.py migrate", "python3 manage.py loaddata fixtures.json", "python scripts/seed_db.py", "alembic upgrade head", "flask db upgrade", "bundle exec rake db:seed", "rails db:setup",
    "make seed", "make db-migrate", "psql -f schema.sql",
  ])("%s is a seed or migration", (line) => expect(is(line)).toBe(true));
  it.each([
    "npm ci", "npm test", "npm run build", "pip install -r requirements.txt", "npx prisma generate", "python -m pytest", "make test", "node scripts/seedling-farm.js", "npm run reseed-nothing", "git clone x",
  ])("%s is not", (line) => expect(is(line)).toBe(false));
  // I-3: a path or a file name that merely holds the word is not the word. These are install and build steps, and they stay in setup.
  it.each([
    "npx tsc -p tsconfig.migrations.json", "tsc -p tsconfig.migrations.json", "npm ci --prefix packages/migrations", "npm install --prefix migrations", "node scripts/migrate-assets.js", "node scripts/seed-images-to-cdn.js", "python scripts/migrate_logs_to_s3.py",
    "npm run build --workspace packages/seeds", "node tools/migrations/build.js", "npm test -- --seed 5", "npx jest --config jest.migrations.config.js", "make -f seed.mk build",
  ])("%s is not, even though a path or an option holds the word", (line) => expect(is(line)).toBe(false));
  // Recall: the usual spellings of a migration or a seed in the tools' own words.
  it.each([
    "knex migrate:latest", "npx knex migrate:latest", "knex --knexfile db/knexfile.js migrate:latest", "npx knex migrate:rollback", "npx knex migrate:status", "npm run migrate:fresh", "npm run seed:ci", "npm run seed:e2e",
    "npm run prisma:migrate", "npm run prisma:seed", "npm run drizzle:migrate", "npm run typeorm:migration:run", "yarn migrate:prod", "npm run db:migrate:staging", "pnpm run seed:users",
    "python -m app.seed", "python -m app.db.migrate", "python3 -m app.db.seed_users", "node src/db/migrations/run.js", "node db/seeds/index.js",
  ])("%s is a seed or migration", (line) => expect(is(line)).toBe(true));
  it.each(["python -m pytest", "python -m app.build", "python -m http.server", "node src/db/migrations/build.js", "node reseed-docs.js", "npm run reseed-docs", "node scripts/seedling.js"])("%s is not", (line) => expect(is(line)).toBe(false));
  it.each(["npm run seed -- --reset", "python manage.py migrate --noinput", "npx ts-node prisma/seed.ts", "npm run db:seed:replant", "flask --app app db upgrade", "npm run migrate:test", "pnpm run db-migrate"])("%s still is", (line) => expect(is(line)).toBe(true));
});
