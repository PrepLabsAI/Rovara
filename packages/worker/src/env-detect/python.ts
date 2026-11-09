// Python detector: pytest (with the report path the config already writes, or the flag to add as a PROPOSAL), ruff, flake8, mypy, bandit, requirements and lockfiles.
import { awsClientCandidate, callArguments, candidate, isOwnedElsewhere, mergeCandidates, normalizeAwsService, scanDrivers, type DriverRule } from "./dependency-candidates.js";
import { type DependencyCandidate, type Detection, type Detector, type DetectorContext, findLine } from "./types.js";

const TIMEOUT = { test: 1_800, lint: 600, setup: 900 } as const;
const cmd = (cwd: string, executable: string, args: string[], timeoutSeconds: number) => ({ cwd, executable, args, timeoutSeconds });

async function firstExisting(context: DetectorContext, names: readonly string[]): Promise<{ path: string; text: string } | undefined> {
  for (const name of names) {
    if (!context.repo.paths.includes(name)) continue;
    const text = await context.repo.read(name);
    if (text !== undefined) return { path: name, text };
  }
  return undefined;
}

const detectPythonBuild: Detector = async (context) => {
  const { repo, cwd } = context;
  const found: Partial<Detection> = { setupCommands: [], checks: [], fullSuiteOn: [], notes: [], questions: [] };
  const setup = found.setupCommands!;
  const checks = found.checks!;
  const hasPython = repo.paths.some((path) => path.endsWith(".py")) || ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini", "requirements.txt"].some((name) => repo.paths.includes(name));
  if (!hasPython) return {};

  const pyproject = await firstExisting(context, ["pyproject.toml"]);
  const pytestIni = await firstExisting(context, ["pytest.ini", "tox.ini", "setup.cfg"]);
  const configs = [pyproject, pytestIni].filter((item) => item !== undefined);
  const requirements = await firstExisting(context, ["requirements-dev.txt", "requirements.txt"]);

  if (repo.paths.includes("requirements.txt")) setup.push({ value: cmd(cwd, "pip", ["install", "-r", "requirements.txt"], TIMEOUT.setup), source: { path: "requirements.txt", line: 1 } });
  else if (pyproject !== undefined && /^\[(?:project|tool\.poetry)\]/mu.test(pyproject.text)) setup.push({ value: cmd(cwd, "pip", ["install", "-e", "."], TIMEOUT.setup), source: { path: "pyproject.toml", line: findLine(pyproject.text, /^\[(?:project|tool\.poetry)\]/mu) ?? 1 } });
  if (repo.paths.includes("requirements-dev.txt") && requirements?.path === "requirements-dev.txt") setup.push({ value: cmd(cwd, "pip", ["install", "-r", "requirements-dev.txt"], TIMEOUT.setup), source: { path: "requirements-dev.txt", line: 1 } });

  for (const lock of ["poetry.lock", "Pipfile.lock", "uv.lock", "requirements.txt", "requirements-dev.txt", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini"]) if (repo.paths.includes(lock)) found.fullSuiteOn!.push({ value: lock, source: `detector:python` });
  if (repo.paths.some((path) => path === "conftest.py" || path.endsWith("/conftest.py"))) found.fullSuiteOn!.push({ value: "**/conftest.py", source: "detector:python" });

  // pytest
  let pytestAt: { path: string; line: number } | undefined;
  for (const config of configs) {
    const line = findLine(config.text, /^\[(?:tool\.pytest\.ini_options|tool:pytest|pytest)\]/mu);
    if (line !== undefined) { pytestAt = { path: config.path, line }; break; }
  }
  if (pytestAt === undefined && requirements !== undefined) {
    const line = findLine(requirements.text, /^[ \t]*pytest(?:[<>=!~\s[]|$)/mu);
    if (line !== undefined) pytestAt = { path: requirements.path, line };
  }
  if (pytestAt === undefined && repo.paths.some((path) => /(?:^|\/)test_[^/]+\.py$/u.test(path))) pytestAt = undefined;
  const looksTested = pytestAt !== undefined || repo.paths.some((path) => /(?:^|\/)test_[^/]+\.py$/u.test(path));
  if (looksTested) {
    const text = configs.map((config) => config.text).join("\n");
    const junit = /--junit-?xml[= ]([A-Za-z0-9_./-]{1,200})/u.exec(text)?.[1];
    const coverage = /--cov-report[= ]xml:([A-Za-z0-9_./-]{1,200})/u.exec(text)?.[1] ?? (/--cov-report[= ]xml(?![:\w])/u.test(text) ? "coverage.xml" : undefined);
    const reportPath = junit ?? "reports/junit.xml";
    const args = ["-q", ...(junit === undefined ? [`--junitxml=${reportPath}`] : [])];
    checks.push({
      value: { id: "unit", label: "Unit tests (pytest)", kind: "test", command: cmd(cwd, "pytest", args, TIMEOUT.test), reportPath, ...(coverage === undefined ? {} : { coveragePath: coverage }), selectArgs: ["{tests}"] },
      source: pytestAt ?? "detector:python",
    });
    if (junit === undefined) found.notes!.push("pytest does not write a JUnit report yet: the proposed command adds --junitxml so test names and counts can be shown. The maintainer approves the command.");
    if (coverage === undefined) found.notes!.push("No XML coverage report is configured, so changed-line coverage will show as not measured.");
  }

  // linters and type checkers
  const toml = pyproject?.text ?? "";
  const ruff = findLine(toml, /^\[tool\.ruff/mu);
  if (ruff !== undefined || repo.paths.includes("ruff.toml") || repo.paths.includes(".ruff.toml")) checks.push({ value: { id: "lint", label: "Lint (ruff)", kind: "lint", command: cmd(cwd, "ruff", ["check", "."], TIMEOUT.lint) }, source: ruff === undefined ? "detector:python" : { path: "pyproject.toml", line: ruff } });
  else if (repo.paths.includes(".flake8") || /^\[flake8\]/mu.test(pytestIni?.text ?? "")) checks.push({ value: { id: "lint", label: "Lint (flake8)", kind: "lint", command: cmd(cwd, "flake8", [], TIMEOUT.lint) }, source: repo.paths.includes(".flake8") ? { path: ".flake8", line: 1 } : "detector:python" });
  const mypy = findLine(toml, /^\[tool\.mypy\]/mu);
  if (mypy !== undefined || repo.paths.includes("mypy.ini")) checks.push({ value: { id: "typecheck", label: "Type check (mypy)", kind: "typecheck", command: cmd(cwd, "mypy", ["."], TIMEOUT.lint) }, source: mypy === undefined ? { path: "mypy.ini", line: 1 } : { path: "pyproject.toml", line: mypy } });
  const bandit = findLine(toml, /^\[tool\.bandit/mu);
  if (bandit !== undefined || repo.paths.includes(".bandit")) checks.push({ value: { id: "security", label: "Security scan (bandit)", kind: "security", command: cmd(cwd, "bandit", ["-r", ".", "-f", "sarif", "-o", "reports/bandit.sarif"], TIMEOUT.lint), sarifPath: "reports/bandit.sarif" }, source: bandit === undefined ? { path: ".bandit", line: 1 } : { path: "pyproject.toml", line: bandit } });
  return found;
};

// ---- dependencies (test services D4 manifests, D5 code)

/** Package name (lower case, `-` for `_` and `.`) to the family it is a driver or client for. */
const PY_PACKAGES: Readonly<Record<string, string>> = {
  psycopg2: "postgres", "psycopg2-binary": "postgres", psycopg: "postgres", "psycopg-binary": "postgres", asyncpg: "postgres", pg8000: "postgres",
  mysqlclient: "mysql", pymysql: "mysql", "mysql-connector-python": "mysql", aiomysql: "mysql", asyncmy: "mysql",
  pymongo: "mongodb", motor: "mongodb", mongoengine: "mongodb",
  redis: "redis", aioredis: "redis", "redis-py-cluster": "redis", "django-redis": "redis", valkey: "redis",
  "kafka-python": "kafka", "confluent-kafka": "kafka", aiokafka: "kafka",
  pika: "rabbitmq", "aio-pika": "rabbitmq",
  elasticsearch: "elasticsearch", "elasticsearch-dsl": "elasticsearch", "opensearch-py": "opensearch",
  pymemcache: "memcached", "python-memcached": "memcached",
};
const PY_STUBS = /^(?:mypy-boto3|types-boto3|types-aiobotocore|boto3-stubs|types-aioboto3)-([a-z0-9-]+)$/u;
const PY_DEPENDENCY_SECTION = /dependenc|dependency-groups/u;

const pyName = (raw: string): string => raw.toLowerCase().replace(/[_.]/gu, "-");

/** Candidates for the drivers and client libraries a Python project lists in requirements*.txt, pyproject.toml (dependency tables and arrays only) or a Pipfile. Strength `mentioned`. */
export async function pythonManifestCandidates(repo: DetectorContext["repo"]): Promise<DependencyCandidate[]> {
  const found: DependencyCandidate[] = [];
  const files = repo.paths.filter((path) => /(?:^|\/)requirements[^/]*\.txt$/u.test(path) || path === "pyproject.toml" || path === "Pipfile").slice(0, 12);
  for (const path of files) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    const plain = path.endsWith(".txt");
    let section = "";
    let inArray = false;
    text.split("\n").slice(0, 2_000).forEach((raw, index) => {
      const line = raw.trim();
      if (line.startsWith("#") || line === "" || line.length > 1_000) return;
      const header = /^\[([^\]]+)\]/u.exec(line);
      if (!plain && header !== null) { section = header[1]!.toLowerCase(); inArray = false; return; }
      let active = plain;
      if (!plain && path === "Pipfile") active = section === "packages" || section === "dev-packages";
      if (!plain && path === "pyproject.toml") {
        if (/^(?:dependencies|requires|dev|test|tests)\s{0,40}=\s{0,40}\[/u.test(line)) inArray = true;
        active = PY_DEPENDENCY_SECTION.test(section) || inArray;
        if (inArray && /\]\s{0,40}(?:#.*)?$/u.test(line)) inArray = false;
      }
      if (!active || (plain && /^-/u.test(line))) return;
      for (const token of line.matchAll(/(?:^|["'\s,])([A-Za-z0-9][A-Za-z0-9._-]{0,100})(?:\[([^\]\s]{0,200})\])?(?=[\s<>=!~;,"'\]#]|$)/gu)) {
        const name = pyName(token[1]!);
        const evidence = { path, line: index + 1 };
        const family = PY_PACKAGES[name];
        if (family !== undefined) found.push(candidate(family, "mentioned", evidence, { seenBy: ["driver"] }));
        const stub = PY_STUBS.exec(name)?.[1];
        const services = name === "boto3-stubs" || name === "types-boto3" ? (token[2] ?? "").split(",") : stub !== undefined ? [stub] : [];
        for (const service of services) {
          const id = normalizeAwsService(service.trim());
          if (id !== undefined && !["essential", "full", "boto3", "lite"].includes(id) && !isOwnedElsewhere(`aws:${id}`)) found.push(candidate(`aws:${id}`, "mentioned", evidence, { seenBy: ["driver"] }));
        }
      }
    });
  }
  return mergeCandidates(found);
}

const IMPORT = (names: string): RegExp => new RegExp(`^[ \\t]*(?:import|from)\\s{1,40}(?:${names})\\b`, "mu");
export const PY_DRIVERS: readonly DriverRule[] = [
  { family: "postgres", uses: IMPORT("psycopg2|psycopg|asyncpg|pg8000"), call: /\b(?:psycopg2|psycopg|asyncpg|pg8000)\.(?:connect|create_pool|create_connection)\s{0,120}\(/u },
  { family: "mysql", uses: IMPORT("pymysql|MySQLdb|mysql\\.connector|aiomysql|asyncmy"), call: /\b(?:pymysql|MySQLdb|aiomysql|asyncmy|mysql\.connector)\.(?:connect|create_pool)\s{0,120}\(/u },
  { family: "redis", uses: IMPORT("redis|aioredis|valkey"), call: /\b(?:redis|aioredis|valkey)\.(?:Redis|StrictRedis|from_url|ConnectionPool|asyncio\.Redis)\s{0,120}\(|\b(?:Redis|StrictRedis)\s{0,120}\(/u },
  { family: "mongodb", uses: IMPORT("pymongo|motor|mongoengine"), call: /\b(?:MongoClient|AsyncIOMotorClient)\s{0,120}\(|\bmongoengine\.connect\s{0,120}\(/u },
  { family: "kafka", uses: IMPORT("kafka|confluent_kafka|aiokafka"), call: /\b(?:KafkaProducer|KafkaConsumer|AIOKafkaProducer|AIOKafkaConsumer|Producer|Consumer)\s{0,120}\(/u },
  { family: "rabbitmq", uses: IMPORT("pika|aio_pika"), call: /\b(?:pika\.ConnectionParameters|pika\.URLParameters|connect_robust)\s{0,120}\(/u },
  { family: "elasticsearch", uses: IMPORT("elasticsearch"), call: /\bElasticsearch\s{0,120}\(/u },
  { family: "opensearch", uses: IMPORT("opensearchpy"), call: /\bOpenSearch\s{0,120}\(/u },
  { family: "memcached", uses: IMPORT("pymemcache|memcache"), call: /\b(?:HashClient|Client)\s{0,120}\(/u },
];

/** AWS clients (`boto3.client("s3")`) and drivers a Python source file uses (test services D5). An `endpoint_url` written as a string is flagged: it bypasses the endpoint variables. */
export function pythonCodeCandidates(path: string, text: string): DependencyCandidate[] {
  const found = scanDrivers(path, text, PY_DRIVERS);
  if (/boto3|botocore|aioboto3|aiobotocore/u.test(text)) {
    for (const match of text.matchAll(/\.(?:client|resource)\(\s{0,120}(?:service_name\s{0,40}=\s{0,40})?["']([A-Za-z0-9_-]+)["']/gu)) {
      const open = text.indexOf("(", match.index);
      const args = callArguments(text, open);
      const item = awsClientCandidate(path, text, match.index, match[1]!, /\bendpoint_url\s{0,40}=\s{0,40}[fFrb]?["']/u.test(args));
      if (item !== undefined) found.push(item);
    }
  }
  return found;
}

export const detectPython: Detector = async (context) => {
  const found = await detectPythonBuild(context);
  const dependencies = await pythonManifestCandidates(context.repo);
  return dependencies.length === 0 ? found : { ...found, dependencies };
};
