// L4-EVW2 (DEC 254zzz20 D2): the wrapper file Rovara proposes as a pull request when the customer's eval writes something Rovara cannot read as it is. Made by CODE from the setup run's description of the output
// (`EvalOutputShape`): no model writes it for a `rows` shape, and no model runs at task time for any shape. Pure: no store, no host, no clock.
//
// WHAT THE FILE DOES (and says in its own first lines, so the person who reviews it knows):
//   - it runs the customer's command UNCHANGED (an argv, no shell, in the folder the setup run named);
//   - it reads the rows the command wrote (JSONL, JSON or CSV), and for each question writes one JUnit test case (a failure when the row did not pass) at a fixed path in the repository;
//   - it reads the settings Rovara hands an eval: ROVARA_EVAL_IDS (comma separated; only those questions are written), and passes the environment through untouched. It calls no network and reads no secret;
//   - it exits with the command's own code when the command wrote no results, and 0 when it wrote results (an eval that exits non-zero because some cases failed is a measured result, not a broken run).
//
// The configuration is data (a JSON literal the file loads), never text spliced into code: a command, field or id can only ever be a string in that literal, which is encoded so that it cannot end the literal.
import {
  EVAL_WRAPPER_REPORT_PATH, evalWrapperPathOf, type EvalOutputShape, type EvalWrapperLanguage, type EvalCommand, type EvalReportPath,
} from "@agentx/contracts";

export interface EvalWrapperFile { path: string; content: string; language: EvalWrapperLanguage }

/** The data the template loads. `results` is the file the customer's command writes (repository-relative). */
interface WrapperConfig {
  command: string[];
  cwd: string;
  results: string;
  format: "jsonl" | "json" | "csv";
  rowsKey: string | null;
  idField: string;
  pass: { field: string; equals?: boolean | string | number; atLeast?: number };
  output: string;
}

/** A JSON text that holds no apostrophe, backslash-run or line break outside the escapes JSON itself defines, so it sits safely inside a raw Python string or as a JavaScript literal. */
function configJson(config: WrapperConfig): string {
  return JSON.stringify(config, null, 2)
    .replace(/'/gu, "\\u0027")
    .replace(new RegExp("\\u2028", "gu"), "\\u2028").replace(new RegExp("\\u2029", "gu"), "\\u2029");
}

const REVIEW_NOTE = [
  "Proposed by Rovara so it can read the results of your eval. It is a small file you own: read it, run it, change it, or close the pull request that added it.",
  "It runs your eval command unchanged, reads the rows the command wrote, and writes a JUnit report (one test case per question) that Rovara reads.",
  "It reads ROVARA_EVAL_IDS (comma separated question ids; empty means all), calls no network and reads no secret. Rovara never merges it.",
];

function pythonSource(config: WrapperConfig): string {
  return `#!/usr/bin/env python3
${REVIEW_NOTE.map(line => `# ${line}`).join("\n")}
import csv
import json
import os
import subprocess
import sys

CONFIG = json.loads(r'''${configJson(config)}''')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def at(path):
    return os.path.join(ROOT, *path.split("/"))


def dig(row, dotted):
    value = row
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def word(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip().lower()


def passed(row):
    rule = CONFIG["pass"]
    value = dig(row, rule["field"])
    if "atLeast" in rule:
        try:
            return float(value) >= rule["atLeast"]
        except (TypeError, ValueError):
            return False
    if word(value) == word(rule["equals"]):
        return True
    try:
        return float(value) == float(rule["equals"])
    except (TypeError, ValueError):
        return False


def read_rows():
    with open(at(CONFIG["results"]), encoding="utf-8-sig", newline="") as handle:
        if CONFIG["format"] == "csv":
            return list(csv.DictReader(handle))
        if CONFIG["format"] == "jsonl":
            return [json.loads(line) for line in handle if line.strip()]
        data = json.load(handle)
        if CONFIG["rowsKey"] is not None:
            data = dig(data, CONFIG["rowsKey"])
        return data if isinstance(data, list) else []


def clean(text):
    return "".join(ch for ch in str(text) if ch in "\\t\\n\\r" or ord(ch) >= 32)


def attr(text):
    return clean(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def main():
    wanted = [item for item in os.environ.get("ROVARA_EVAL_IDS", "").split(",") if item]
    for stale in (CONFIG["results"], CONFIG["output"]):
        if os.path.exists(at(stale)):
            os.remove(at(stale))
    done = subprocess.run(CONFIG["command"], cwd=at(CONFIG["cwd"]) if CONFIG["cwd"] != "." else ROOT, env=os.environ.copy())
    if not os.path.exists(at(CONFIG["results"])):
        sys.stderr.write("rovara eval wrapper: the eval command wrote no results file\\n")
        return done.returncode or 1
    cases = []
    for row in read_rows():
        identity = dig(row, CONFIG["idField"]) if isinstance(row, dict) else None
        if identity is None or str(identity) == "" or (wanted and str(identity) not in wanted):
            continue
        cases.append((str(identity), passed(row)))
    failures = sum(1 for _, ok in cases if not ok)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuite name="rovara-eval" tests="%d" failures="%d">' % (len(cases), failures)]
    for identity, ok in cases:
        if ok:
            lines.append('  <testcase classname="eval" name="%s"/>' % attr(identity))
        else:
            lines.append('  <testcase classname="eval" name="%s"><failure message="did not pass"/></testcase>' % attr(identity))
    lines.append("</testsuite>")
    os.makedirs(os.path.dirname(at(CONFIG["output"])), exist_ok=True)
    with open(at(CONFIG["output"]), "w", encoding="utf-8") as out:
        out.write("\\n".join(lines) + "\\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
}

function nodeSource(config: WrapperConfig): string {
  return `#!/usr/bin/env node
${REVIEW_NOTE.map(line => `// ${line}`).join("\n")}
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = ${configJson(config)};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = (path) => join(ROOT, ...path.split("/"));

function dig(row, dotted) {
  let value = row;
  for (const part of dotted.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !(part in value)) return undefined;
    value = value[part];
  }
  return value;
}
const word = (value) => (typeof value === "boolean" ? String(value) : String(value ?? "").trim().toLowerCase());

function passed(row) {
  const rule = CONFIG.pass;
  const value = dig(row, rule.field);
  if ("atLeast" in rule) { const number = Number(value); return value !== "" && value !== null && Number.isFinite(number) && number >= rule.atLeast; }
  if (word(value) === word(rule.equals)) return true;
  const a = Number(value); const b = Number(rule.equals);
  return value !== "" && value !== null && Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\\n" || ch === "\\r") { if (ch === "\\r" && text[i + 1] === "\\n") i += 1; row.push(cell); cell = ""; rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((line) => line.length > 1 || line[0] !== "");
  return head === undefined ? [] : body.map((line) => Object.fromEntries(head.map((name, index) => [name, line[index] ?? ""])));
}

function readRows() {
  const text = readFileSync(at(CONFIG.results), "utf8").replace(/^\\uFEFF/u, "");
  if (CONFIG.format === "csv") return parseCsv(text);
  if (CONFIG.format === "jsonl") return text.split(/\\r?\\n/u).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  let data = JSON.parse(text);
  if (CONFIG.rowsKey !== null) data = dig(data, CONFIG.rowsKey);
  return Array.isArray(data) ? data : [];
}

// eslint-disable-next-line no-control-regex
const clean = (text) => String(text).replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]/gu, "");
const attr = (text) => clean(text).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

function main() {
  const wanted = (process.env.ROVARA_EVAL_IDS ?? "").split(",").filter((item) => item !== "");
  for (const stale of [CONFIG.results, CONFIG.output]) if (existsSync(at(stale))) rmSync(at(stale));
  const done = spawnSync(CONFIG.command[0], CONFIG.command.slice(1), { cwd: CONFIG.cwd === "." ? ROOT : at(CONFIG.cwd), env: process.env, stdio: "inherit" });
  if (!existsSync(at(CONFIG.results))) {
    process.stderr.write("rovara eval wrapper: the eval command wrote no results file\\n");
    return done.status || 1;
  }
  const cases = [];
  for (const row of readRows()) {
    const identity = row !== null && typeof row === "object" ? dig(row, CONFIG.idField) : undefined;
    if (identity === undefined || identity === null || String(identity) === "" || (wanted.length > 0 && !wanted.includes(String(identity)))) continue;
    cases.push([String(identity), passed(row)]);
  }
  const failures = cases.filter(([, ok]) => !ok).length;
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', \`<testsuite name="rovara-eval" tests="\${cases.length}" failures="\${failures}">\`];
  for (const [identity, ok] of cases) lines.push(ok ? \`  <testcase classname="eval" name="\${attr(identity)}"/>\` : \`  <testcase classname="eval" name="\${attr(identity)}"><failure message="did not pass"/></testcase>\`);
  lines.push("</testsuite>");
  mkdirSync(dirname(at(CONFIG.output)), { recursive: true });
  writeFileSync(at(CONFIG.output), \`\${lines.join("\\n")}\\n\`);
  return 0;
}

process.exit(main());
`;
}

const customHeader = (language: EvalWrapperLanguage, summary: string): string => {
  const comment = language === "python" ? "#" : "//";
  return [`${comment} Written by Rovara's setup agent so Rovara can read the results of your eval: ${summary.replace(/[\r\n]+/gu, " ")}`,
    `${comment} It is a small file you own: read it, run it, change it, or close the pull request that added it. Rovara never merges it.`].join("\n");
};

/**
 * The wrapper for a suite whose output needs one, or undefined for an output Rovara reads as it is. A `rows` wrapper is made here from the suite's own command, report and row description; a `custom` one is the
 * setup agent's text, as written, under a header that says so.
 */
export function evalWrapperFor(suite: { command: EvalCommand; report: EvalReportPath; output?: EvalOutputShape | undefined }): EvalWrapperFile | undefined {
  const output = suite.output;
  if (output === undefined || (output.kind !== "rows" && output.kind !== "custom")) return undefined;
  const path = evalWrapperPathOf(output.language);
  if (output.kind === "custom") {
    const body = output.source.endsWith("\n") ? output.source : `${output.source}\n`;
    // A script keeps its first line (`#!`) first.
    const shebang = body.startsWith("#!") ? body.slice(0, body.indexOf("\n") + 1) : "";
    return { path, language: output.language, content: `${shebang}${customHeader(output.language, output.summary)}\n${body.slice(shebang.length)}` };
  }
  const config: WrapperConfig = {
    command: [suite.command.executable, ...suite.command.args], cwd: suite.command.cwd,
    results: suite.report.cwd === "." ? suite.report.argument : `${suite.report.cwd}/${suite.report.argument}`,
    format: output.format, rowsKey: output.rowsKey ?? null, idField: output.idField, pass: { ...output.pass }, output: EVAL_WRAPPER_REPORT_PATH,
  };
  return { path, language: output.language, content: output.language === "python" ? pythonSource(config) : nodeSource(config) };
}
