import { CfnParameter, type Stack } from "aws-cdk-lib";

/** What must never reach the list joined without escaping: it ends a pair, starts a value, or escapes (the pairs are `code=value,code=value`). */
const SEPARATORS = ['"', "\\", ",", "=", "{", "}", "/", " ", "\n"];

function openEscape(pattern: string, index: number): boolean {
  return "SWD".includes(pattern[index + 1] ?? "");
}

/** True where the pattern has a construct that takes any character (`.`, `\S`, `\W`, `\D`, a negated class), outside a character class where `.` is literal. */
function patternIsOpen(pattern: string): boolean {
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "\\") {
      if (openEscape(pattern, index)) return true;
      index++;
    } else if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
      if (pattern[index + 1] === "^") return true;
    } else if (char === ".") return true;
  }
  return false;
}

/** Whether an AllowedPattern lets a separator through: no open construct, and no probe built from the pattern's own leading literal plus a separator matches. A guard, not a proof. */
function patternAdmitsSeparator(pattern: string, separators = SEPARATORS): boolean {
  if (patternIsOpen(pattern)) return true;
  let accepts: RegExp;
  try { accepts = new RegExp(pattern, "u"); } catch { return true; }
  const prefix = /^\^?((?:[A-Za-z0-9_:-]|\\\.)*)/u.exec(pattern)?.[1]?.replace(/\\\./gu, ".") ?? "";
  const bases = ["", "a", "0", "T0", "E0", prefix, `${prefix}0`, `${prefix}a`];
  return bases.some((base) => separators.some((separator) => [`${base}${separator}`, `${base}${separator}0`, `${base}0${separator}0`, `${base}a${separator}b`].some((probe) => accepts.test(probe))));
}

/**
 * Packing needs a value that cannot carry a separator. A literal is checked at once (by the caller). A token is checked when the variable is built, at synthesis: every Ref to a
 * parameter in it must be a Number, or have AllowedValues without a separator, or an AllowedPattern that admits none. Other tokens (a resource's name or id) are CloudFormation's
 * own generated values.
 */
export function refuseUnconstrainedParameters(scope: Stack, what: string, key: string, value: string): void {
  const parameters = new Map<string, CfnParameter>();
  for (const child of scope.node.findAll()) if (child instanceof CfnParameter) parameters.set(String(scope.resolve(child.logicalId)), child);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const ref = record.Ref;
    const parameter = typeof ref === "string" ? parameters.get(ref) : undefined;
    if (parameter !== undefined) {
      validateParameter(parameter, what, key, ref);
      return;
    }
    Object.values(record).forEach(walk);
  };
  walk(scope.resolve(value));
}

function validateParameter(parameter: CfnParameter, what: string, key: string, ref: unknown): void {
  if (parameter.type === "Number") return;
  // Slash is a literal model-id character, never a code=value packing delimiter.
  const separators = key === "coreAgentModel" ? SEPARATORS.filter(value => value !== "/") : SEPARATORS;
  const unsafe = (reason: string): never => { throw new Error(`${what} ${key} comes from the parameter ${String(ref)}, which ${reason}; it is joined into the broker's variable unescaped, so the parameter needs an AllowedPattern or AllowedValues that keeps out quotes, commas, equals signs, braces, slashes and spaces`); };
  if (parameter.allowedValues !== undefined) {
    if (parameter.allowedValues.some((allowed) => separators.some((separator) => allowed.includes(separator)))) unsafe("allows a value with a separator");
  } else if (parameter.allowedPattern === undefined) unsafe("has no AllowedPattern or AllowedValues");
  else if (patternAdmitsSeparator(parameter.allowedPattern, separators)) unsafe(`has an AllowedPattern (${parameter.allowedPattern}) that admits a separator`);
}
