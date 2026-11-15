/** Iterative lexical scanner, not an AST evaluator. Rules and precision signals are in prompt-change-rules.ts.
 * Strings include Python prefixes/triples and JS templates; interpolation holes are balanced but never evaluated.
 * Nonliteral SDK prompt expressions yield nonliteral_prompt. Malformed strings, containers, YAML aliases/merges and depth >64 fail closed
 * as unreadable_diff (the fixed v1 vocabulary also covers unreadable source). Config block scalars use indentation.
 */
import type { ModelFamily } from "./model-catalog.js";
import { builtinModelCatalog } from "./model-catalog-rows.js";
import { canonicalJson } from "./canonical-json.js";
import { MODEL_NAME_PATTERN } from "./model-family-common.js";
import { PROMPT_CHANGE_LIMITS, SETTING_ENUM_WORDS, type ModelSettingKey, type PromptChangeItem, type PromptChangeKind } from "./prompt-change.js";
import { fingerprint, hash, normalizePromptText, type Work } from "./prompt-change-internal.js";
import { CONFIG_MODEL_KEYS, knownSdk, MODEL_CALLS, MODEL_KEYS, modelFamily, promptConstantName, PROMPT_CALLS, PROMPT_KEYS, SDK_CALLS, SETTING_ALIASES, SYSTEM_KEYS, TOOL_KEYS } from "./prompt-change-rules.js";

export interface ScannedValue {
  kind: PromptChangeKind; basis: PromptChangeItem["basis"]; anchor: string; fingerprint: string;
  line: number; family: ModelFamily | null; settingKey?: ModelSettingKey; echo?: number | string;
}
interface Token { type: "string" | "word" | "number" | "punct"; value: string; start: number; end: number; line: number; parent: number; close: number; label: string; path: string; interpolated: boolean }
interface StringFrame { type: "string"; quote: string; triple: boolean; raw: boolean; holes: boolean; outer: boolean }
interface HoleFrame { type: "hole"; close: string }
const escapes = new Map([["n", "\n"], ["r", "\r"], ["t", "\t"], ["b", "\b"], ["f", "\f"], ["v", "\v"], ["0", "\0"]]);
function literal(text: string, start: number, raw: boolean, holes: boolean, work: Work, baseDepth = 0): { end: number; value: string; interpolated: boolean; complete: boolean } {
  const quote = text[start]!;
  const triple = quote !== "`" && text.slice(start, start + 3) === quote.repeat(3);
  const frames: Array<StringFrame | HoleFrame> = [{ type: "string", quote, triple, raw, holes: holes || quote === "`", outer: true }];
  let i = start + (triple ? 3 : 1);
  let value = "";
  let interpolated = false;
  while (i < text.length && frames.length > 0) {
    work.stats.steps += 1;
    if (frames.length + baseDepth > PROMPT_CHANGE_LIMITS.nesting) return { end: text.length, value: "", interpolated, complete: false };
    const frame = frames[frames.length - 1]!;
    const c = text[i]!;
    if (frame.type === "hole") {
      // Hole contents affect the fingerprint, but are never tokenized as model arguments or echoed.
      if (c === "'" || c === '"' || c === "`") {
        const nestedTriple = c !== "`" && text.slice(i, i + 3) === c.repeat(3);
        frames.push({ type: "string", quote: c, triple: nestedTriple, raw: false, holes: c === "`", outer: false });
        const n = nestedTriple ? 3 : 1; value += text.slice(i, i + n); i += n; continue;
      }
      if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
        const block = text[i + 1] === "*";
        const begin = i; i += 2;
        while (i < text.length && (block ? text.slice(i, i + 2) !== "*/" : text[i] !== "\n")) { i++; work.stats.steps++; }
        if (block) i = Math.min(text.length, i + 2);
        value += text.slice(begin, i); continue;
      }
      if (c === "{" || c === "[" || c === "(") frames.push({ type: "hole", close: c === "{" ? "}" : c === "[" ? "]" : ")" });
      else if (c === frame.close) frames.pop();
      value += c; i++; continue;
    }
    const closing = frame.triple ? frame.quote.repeat(3) : frame.quote;
    if (text.startsWith(closing, i)) {
      frames.pop(); if (!frame.outer) value += closing;
      i += closing.length; continue;
    }
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) { i++; break; }
      if (frame.raw || !frame.outer) { value += c + next; i += 2; continue; }
      if (next === "\n" || next === "\r") { i += next === "\r" && text[i + 2] === "\n" ? 3 : 2; continue; }
      const digits = next === "u" ? 4 : next === "x" ? 2 : 0;
      if (digits && /^[a-fA-F0-9]+$/u.test(text.slice(i + 2, i + 2 + digits)) && text.slice(i + 2, i + 2 + digits).length === digits) {
        value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 2 + digits), 16)); i += digits + 2; continue;
      }
      value += escapes.get(next) ?? next; i += 2; continue;
    }
    if (frame.holes && ((frame.quote === "`" && c === "$" && text[i + 1] === "{") || (frame.quote !== "`" && c === "{" && text[i + 1] !== "{"))) {
      interpolated = true; frames.push({ type: "hole", close: "}" });
      const n = frame.quote === "`" ? 2 : 1; value += text.slice(i, i + n); i += n; continue;
    }
    if (frame.holes && frame.quote !== "`" && ((c === "{" && text[i + 1] === "{") || (c === "}" && text[i + 1] === "}"))) { value += c; i += 2; continue; }
    value += c; i++;
  }
  return { end: i, value, interpolated, complete: frames.length === 0 };
}
function tokenize(text: string, config: boolean, work: Work): Token[] {
  const tokens: Token[] = [];
  const stack: number[] = [];
  let i = 0; let line = 1;
  const add = (type: Token["type"], value: string, start: number, end: number, atLine: number, interpolated = false) => {
    const parent = stack[stack.length - 1] ?? -1;
    const previous = tokens[tokens.length - 1];
    const before = tokens[tokens.length - 2];
    let label = "";
    if (value === "(" && previous?.type === "word") label = previous.value;
    else if ((value === "{" || value === "[") && (previous?.value === ":" || previous?.value === "=")) label = before?.value ?? "";
    const parentPath = tokens[parent]?.path ?? "$";
    const path = label ? hash(`${parentPath}/${label}`, work) : parentPath;
    work.stats.steps += path.length + 1;
    tokens.push({ type, value, start, end, line: atLine, parent, close: -1, label, path, interpolated });
    if (type === "punct" && (value === "{" || value === "[" || value === "(")) {
      stack.push(tokens.length - 1);
      if (stack.length > PROMPT_CHANGE_LIMITS.nesting) { work.reasons.add("unreadable_diff"); i = text.length; }
    } else if (type === "punct" && (value === "}" || value === "]" || value === ")")) {
      const open = stack.pop();
      if (open === undefined || tokens[open]!.value !== (value === "}" ? "{" : value === "]" ? "[" : "(")) work.reasons.add("unreadable_diff");
      else tokens[open]!.close = tokens.length - 1;
    }
  };
  while (i < text.length) {
    work.stats.steps++;
    const c = text[i]!;
    if (/\s/u.test(c)) { if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++; i++; continue; }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") { i++; work.stats.steps++; } continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && text.slice(i, i + 2) !== "*/") { if (text[i] === "\n") line++; i++; work.stats.steps++; }
      if (i === text.length) work.reasons.add("unreadable_diff"); else i += 2;
      continue;
    }
    const start = i; const atLine = line;
    let prefix = "";
    if (/[rRuUbBfF]/u.test(c)) {
      let p = i; while (p < i + 2 && /[rRuUbBfF]/u.test(text[p] ?? "")) p++;
      if (text[p] === "'" || text[p] === '"') { prefix = text.slice(i, p).toLowerCase(); i = p; }
    }
    if (text[i] === "'" || text[i] === '"' || text[i] === "`") {
      const found = literal(text, i, prefix.includes("r"), prefix.includes("f"), work, stack.length);
      for (let p = start; p < found.end; p++) { work.stats.steps++; if (text[p] === "\n" || (text[p] === "\r" && text[p + 1] !== "\n")) line++; }
      i = found.end;
      if (!found.complete) { work.reasons.add("unreadable_diff"); break; }
      add("string", found.value, start, i, atLine, found.interpolated); continue;
    }
    if (config && (tokens[tokens.length - 1]?.value === ":" || tokens[tokens.length - 1]?.value === "=") && /[A-Za-z_]/u.test(c)) {
      i++;
      while (i < text.length && !/[\r\n,}\]#;]/u.test(text[i]!)) { i++; work.stats.steps++; }
      add("word", text.slice(start, i).trim(), start, i, atLine); continue;
    }
    if (/[A-Za-z_$]/u.test(c)) {
      i++; while (i < text.length && /[A-Za-z0-9_$]/u.test(text[i]!)) { i++; work.stats.steps++; }
      add("word", text.slice(start, i), start, i, atLine); continue;
    }
    if (/[0-9]/u.test(c) || ((c === "-" || c === "+") && /[0-9]/u.test(text[i + 1] ?? ""))) {
      i++; while (i < text.length && /[0-9.eE+-]/u.test(text[i]!)) { i++; work.stats.steps++; }
      add("number", text.slice(start, i), start, i, atLine); continue;
    }
    // Indented YAML sequences/maps under schema or setting keys are opaque fingerprint values.
    if (config && c === ":" && (TOOL_KEYS.has(tokens[tokens.length - 1]?.value ?? "") || SETTING_ALIASES.has(tokens[tokens.length - 1]?.value ?? ""))) {
      let p = i + 1;
      while (text[p] === " " || text[p] === "\t") { p++; work.stats.steps++; }
      if (text[p] === "\n" || text[p] === "\r") {
        const lineStart = text.lastIndexOf("\n", i - 1) + 1;
        let indent = 0; while (text[lineStart + indent] === " ") { indent++; work.stats.steps++; }
        p += text[p] === "\r" && text[p + 1] === "\n" ? 2 : 1;
        const bodyStart = p; let bodyLines = 0;
        while (p < text.length) {
          const begin = p; let spaces = 0;
          while (text[p] === " ") { p++; spaces++; work.stats.steps++; }
          if (spaces <= indent && text[p] !== "\n" && text[p] !== "\r" && !(spaces === indent && text.slice(p, p + 2) === "- ")) { p = begin; break; }
          while (p < text.length && text[p] !== "\n" && text[p] !== "\r") { p++; work.stats.steps++; }
          if (p < text.length) p += text[p] === "\r" && text[p + 1] === "\n" ? 2 : 1;
          bodyLines++;
        }
        if (p > bodyStart) {
          add("punct", ":", i, i + 1, atLine);
          add("string", text.slice(bodyStart, p), bodyStart, p, atLine + 1);
          line += bodyLines + 1; i = p; continue;
        }
      }
    }
    // A YAML block scalar is one literal. Its indentation ends it; no YAML parsing or alias expansion.
    if (config && (c === "|" || c === ">") && tokens[tokens.length - 1]?.value === ":") {
      let end = i; while (end < text.length && text[end] !== "\n") { end++; work.stats.steps++; }
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      let indent = 0; while (text[lineStart + indent] === " ") indent++;
      let p = Math.min(end + 1, text.length); const contentStart = p;
      while (p < text.length) {
        const begin = p; let spaces = 0;
        while (text[p] === " ") { p++; spaces++; work.stats.steps++; }
        if (spaces <= indent && text[p] !== "\n" && text[p] !== "\r") { p = begin; break; }
        while (p < text.length && text[p] !== "\n") { p++; work.stats.steps++; }
        if (p < text.length) p++;
        line++;
      }
      i = p; add("string", text.slice(contentStart, p), start, i, atLine); continue;
    }
    if (config && (c === "&" || c === "*" || text.slice(i, i + 2) === "<<")) work.reasons.add("unreadable_diff");
    i++; add("punct", c, start, i, atLine);
  }
  if (stack.length > 0) work.reasons.add("unreadable_diff");
  return tokens;
}
// Read only built-in rows. A host is an exact DNS token; suffix lookalikes do not count.
function buildHostFamilies(): Map<string, ModelFamily | null> {
  const families = new Map<string, ModelFamily | null>();
  for (const row of builtinModelCatalog().rows) for (const host of row.hosts) {
    const existing = families.get(host);
    families.set(host, existing === undefined || existing === row.family ? row.family : null);
  }
  return families;
}
const hostFamilies = buildHostFamilies();
function endpointFamily(value: string, work: Work): ModelFamily | null | undefined {
  work.stats.steps += value.length + 1;
  for (const match of value.matchAll(/[A-Za-z0-9.-]+/gu)) {
    const family = hostFamilies.get(match[0].toLowerCase());
    if (family !== undefined) return family;
  }
  return undefined;
}
function importSignal(tokens: Token[], work: Work): boolean {
  // Inspect each import line once. Ordinary strings containing an SDK name are not signals.
  let importing = false; let importLine = -1; let google = false;
  for (let i = 0; i < tokens.length; i++) {
    work.stats.steps++;
    const token = tokens[i]!;
    if (token.line !== importLine || token.value === ";") { importing = false; google = false; }
    if (token.type === "word" && (token.value === "import" || token.value === "from")) { importing = true; importLine = token.line; }
    if (importing && token.value === "google") google = true;
    if (importing && (knownSdk(token.value) || (google && (token.value === "genai" || token.value === "generativeai")))) return true;
    if (token.type === "string" && knownSdk(token.value) && tokens[i - 1]?.value === "(" && tokens[i - 2]?.value === "require") return true;
  }
  return false;
}
export function scanPromptSource(info: { mode: "code" | "config" | "other"; ai: boolean }, text: string, work: Work): ScannedValue[] {
  const mode = info.mode;
  if (mode === "other") return [];
  const tokens = tokenize(text, mode === "config", work);
  const values: ScannedValue[] = [];
  const roles = new Map<number, string>();
  let signal = info.ai || importSignal(tokens, work);
  for (let i = 0; i < tokens.length; i++) {
    work.stats.steps++;
    const token = tokens[i]!;
    if (token.value === "role" && tokens[i + 1]?.value === ":" && tokens[i + 2]?.type === "string") roles.set(token.parent, tokens[i + 2]!.value);
    if ((token.type === "string" || (mode === "config" && token.type === "word")) && modelFamily(token.value) !== null) signal = true;
  }
  // Parent summaries are computed once, rather than walking up to 64 ancestors for every token.
  const rootContext = { system: false, sdk: false, tool: false, promptBlock: false, fromMessages: false, contents: false };
  const contexts: Array<typeof rootContext> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!; const parent = contexts[token.parent] ?? rootContext;
    work.stats.steps += 7;
    contexts.push({ system: parent.system || SYSTEM_KEYS.has(token.label) || roles.get(i) === "system",
      sdk: parent.sdk || SDK_CALLS.has(token.label), tool: parent.tool || TOOL_KEYS.has(token.label),
      promptBlock: parent.promptBlock || SYSTEM_KEYS.has(token.label) || ["messages", "content", "contents", "parts"].includes(token.label),
      fromMessages: parent.fromMessages || token.label === "from_messages", contents: parent.contents || token.label === "contents" });
  }
  const ordinals = new Map<string, number>();
  const add = (kind: PromptChangeKind, token: Token, value: string, key: string, basis: PromptChangeItem["basis"], family: ModelFamily | null = null, settingKey?: ModelSettingKey) => {
    const base = `${kind}/${token.path}/${key}`;
    const ordinal = ordinals.get(base) ?? 0; ordinals.set(base, ordinal + 1);
    work.stats.steps += base.length + 1;
    const item: ScannedValue = { kind, basis, anchor: `${base}/${ordinal}`, fingerprint: fingerprint(value, work), line: token.line, family };
    if (settingKey !== undefined) item.settingKey = settingKey;
    if (kind === "model_name" && !token.interpolated && value.length <= 128 && MODEL_NAME_PATTERN.test(value)) item.echo = value;
    if (kind === "model_setting" && !token.interpolated) {
      if (token.type === "number" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value) && Number.isFinite(Number(value))) item.echo = Number(value);
      else if ((SETTING_ENUM_WORDS as readonly string[]).includes(value)) item.echo = value;
    }
    values.push(item);
  };
  for (let i = 0; i < tokens.length; i++) {
    work.stats.steps++;
    const token = tokens[i]!;
    const parent = tokens[token.parent];
    const previous = tokens[i - 1];
    if (previous?.value === ":" && token.type === "word" && tokens[i + 1]?.value === "=" && tokens[i - 2]?.type === "word") continue;
    // A simple TS/Python annotation sits between the declaration name and '='.
    const typedAssignment = previous?.value === "=" && tokens[i - 3]?.value === ":" && tokens[i - 4]?.type === "word";
    const keyToken = tokens[i - (typedAssignment ? 4 : 2)];
    const isKey = previous?.value === ":" || previous?.value === "=";
    const key = isKey ? keyToken?.value ?? "" : "";
    if (isKey) work.stats.steps += key.length * 4 + 1;
    const namedPrompt = signal && isKey && promptConstantName(key);
    const modelKey = MODEL_KEYS.has(key) || (mode === "config" && CONFIG_MODEL_KEYS.has(key.toLowerCase()));
    const settingKey = SETTING_ALIASES.get(key) ?? (mode === "config" ? SETTING_ALIASES.get(key.toLowerCase()) : undefined);
    const next = tokens[i + 1];
    const expressionTail = next !== undefined && (next.line === token.line || ["+", "-", ".", "?", "*", "/", "&", "|"].includes(next.value)) && !new Set([",", ";", ")", "]", "}", ":"]).has(next.value);
    const isLiteral = (token.type === "string" || token.type === "number" || (mode === "config" && token.type === "word")) && !expressionTail;
    const isContainer = token.type === "punct" && (token.value === "{" || token.value === "[");
    const context = contexts[token.parent] ?? rootContext;
    const sdk = context.sdk;
    const tool = TOOL_KEYS.has(key) || (key === "parameters" && context.tool);
    const firstPromptArgument = parent?.value === "(" && PROMPT_CALLS.has(parent.label) && previous === parent;
    const tuplePrompt = context.fromMessages && (parent?.value === "(" || parent?.value === "[") && previous?.value === "," && tokens[i - 2]?.type === "string";
    const promptArgument = namedPrompt || tuplePrompt || (sdk && (SYSTEM_KEYS.has(key) || PROMPT_KEYS.has(key) || ["messages", "content", "contents", "input", "message"].includes(key) || (key === "text" && context.promptBlock))) || firstPromptArgument;
    const shorthand = sdk && parent?.value === "{" && token.type === "word" && (SYSTEM_KEYS.has(token.value) || PROMPT_KEYS.has(token.value) || token.value === "messages") && (previous?.value === "{" || previous?.value === ",") && (next?.value === "}" || next?.value === ",");
    const unresolvedBlock = sdk && context.promptBlock && parent?.value === "[" && token.type === "word";
    if (shorthand || unresolvedBlock) work.reasons.add("nonliteral_prompt");
    const containerNext = isContainer && token.close >= 0 ? tokens[token.close + 1] : undefined;
    const containerTail = containerNext !== undefined && ["+", ".", "?"].includes(containerNext.value);
    if (promptArgument && ((!isLiteral && !isContainer) || containerTail)) work.reasons.add("nonliteral_prompt");
    if ((tool || (settingKey !== undefined && signal)) && (isContainer || isLiteral)) {
      const end = isContainer ? token.close : i;
      if (end < i) continue;
      // Token joining removes only layout outside literals. Literal text is normalized independently.
      const pieces: string[] = [];
      for (let j = i; j <= end; j++) { work.stats.steps++; const t = tokens[j]!; pieces.push(t.type === "string" ? canonicalJson(normalizePromptText(t.value, work)) : t.value); }
      add(tool ? "tool_schema" : "model_setting", token, isContainer ? pieces.join("") : token.value, key, "key_name", null, tool ? undefined : settingKey);
      i = end; continue;
    }
    if (token.type === "string") {
      const family = endpointFamily(token.value, work);
      if (family !== undefined) add("model_endpoint", token, token.value, key || "endpoint", "catalog_host", family);
    }
    if (!isLiteral) continue;
    if ((signal && modelKey) || (parent?.value === "(" && MODEL_CALLS.has(parent.label) && previous === parent)) {
      if (token.type !== "number") add("model_name", token, token.value, key || parent?.label || "model", modelKey ? "key_name" : "model_table", modelFamily(token.value));
      continue;
    }
    if (token.type !== "string" && mode !== "config") continue;
    work.stats.steps += key.length + 1;
    let kind: "prompt_text" | "system_prompt" | undefined;
    if (SYSTEM_KEYS.has(key)) kind = "system_prompt";
    else if (PROMPT_KEYS.has(key) && (key !== "template" || signal)) kind = "prompt_text";
    else if (namedPrompt) kind = "prompt_text";
    else if (signal && key === "content" && roles.has(token.parent)) kind = roles.get(token.parent) === "system" ? "system_prompt" : "prompt_text";
    else if (sdk && key === "text" && context.promptBlock) kind = "prompt_text";
    else if (signal && sdk && (key === "input" || key === "contents" || key === "message")) kind = "prompt_text";
    else if (parent?.value === "(" && PROMPT_CALLS.has(parent.label) && previous === parent) kind = "prompt_text";
    else if (tuplePrompt) kind = tokens[i - 2]!.value === "system" ? "system_prompt" : "prompt_text";
    else if (signal && sdk && context.contents && token.type === "string" && !isKey && tokens[i + 1]?.value !== ":") kind = "prompt_text";
    if (kind === "prompt_text" && context.system) kind = "system_prompt";
    if (kind) add(kind, token, token.value, key || parent?.label || "argument", sdk ? "sdk_call" : "key_name");
  }
  return values;
}
