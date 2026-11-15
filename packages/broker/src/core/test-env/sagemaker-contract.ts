// SageMaker is the FIRST ADAPTER of the generic contract finder (service-contract.ts, plan lane TE-G6): it knows which
// repo files describe one SageMaker model's answer and how to read them. Everything else (shape, limits, provenance,
// validation, the labelled mock config) is generic. Offline and pure: callers supply file contents; no filesystem reads,
// Python execution, model calls, store or proof wiring.
// Supported inference: a sole literal return in output_fn (preferred), or predict_fn when output_fn is absent.
// Dynamic code is explicitly unsupported, never guessed.
import {
  CONTRACT_LIMITS, findServiceContract, isServiceContract,
  type AdapterRead, type AnswerShape, type ContractAdapter, type ContractFile, type ContractResult, type ContractSource, type ContractSourceKind, type ServiceContract,
} from "./service-contract.js";

export const SAGEMAKER_CONTRACT_LIMITS = CONTRACT_LIMITS;
export type SageMakerSourceKind = ContractSourceKind;
export type SageMakerSource = ContractSource;
export type SageMakerShape = AnswerShape;
export type SageMakerContract = ServiceContract;
export type SageMakerContractFile = ContractFile;
export type SageMakerContractResult = ContractResult;

function inferenceLiteral(text: string): { value: unknown; pointer: string } | null {
  if (text.includes('"""') || text.includes("'''") || /^\s*@/m.test(text)) return null;
  // Anchored top-level functions only. A selected output_fn must itself be understood;
  // predict_fn can describe an intermediate shape that output_fn changes.
  const functions = [...text.matchAll(/^def (output_fn|predict_fn)\([^\n]*\):[^\S\n]*\n((?:(?:[ \t]+[^\n]*|)[\n]|[ \t]+[^\n]*$)*)/gm)];
  const namedOutput = /^def output_fn\b/m.test(text);
  // Any other mention may import, replace or conditionally define the wire formatter.
  if (/\boutput_fn\b/.test(text.replace(/^def output_fn\b/m, ""))) return null;
  const name = namedOutput ? "output_fn" : "predict_fn";
  const selected = functions.filter((entry) => entry[1] === name);
  if (selected.length !== 1) return null;
  const body = selected[0]![2]!.trim();
  if (!body.startsWith("return ")) return null;
  const expression = body.slice(7).trim();
  // Tokenise, never evaluate. Single-quoted strings with escapes are not supported.
  const token = /\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\\\r\n]*'|True\b|False\b|None\b|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:])/y;
  const parts: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    token.lastIndex = offset;
    const match = token.exec(expression);
    if (match === null) return null;
    const word = match[1]!;
    parts.push(word.startsWith("'") ? JSON.stringify(word.slice(1, -1)) : word === "True" ? "true" : word === "False" ? "false" : word === "None" ? "null" : word);
    offset = token.lastIndex;
  }
  try { return { value: JSON.parse(parts.join("")) as unknown, pointer: `${name}/return` }; } catch { return null; }
}

export const sageMakerAdapter: ContractAdapter = {
  service: "sagemaker",
  kinds: ["fixture", "inference", "output_schema"],
  errorCases: [{ scenario: "model_error", status: 424 }, { scenario: "throttled", status: 429 }, { scenario: "timeout" }],
  read(file): AdapterRead {
    if (file.kind === "inference") {
      const literal = inferenceLiteral(file.content);
      return literal === null ? { status: "unsupported", reason: "unsupported_inference" } : { status: "ok", form: "example", value: literal.value, pointer: literal.pointer };
    }
    try { return { status: "ok", form: file.kind === "output_schema" ? "schema" : "example", value: JSON.parse(file.content) as unknown, pointer: "" }; } catch { return { status: "unsupported", reason: "invalid_json" }; }
  },
};

/** Inputs must be classified by the caller for one model. */
export const findSageMakerContract = (files: readonly SageMakerContractFile[]): SageMakerContractResult => findServiceContract(sageMakerAdapter, files);
/** Validate the normalized contract at the generator/config boundary too. */
export const isSageMakerContract = (value: unknown): value is SageMakerContract => isServiceContract(value);
