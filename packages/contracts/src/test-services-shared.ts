// Test services: the small pieces the dependency, catalog and test-account contracts all use, in one place so they cannot drift apart: the host rule, the variable names Rovara and the system
// own, and the "does this text look like a secret" check. Pure; nothing here imports a Node module.
import { z } from "zod";

// ---- hosts

/** One DNS label: lower case letters, digits and hyphens, not starting or ending with a hyphen. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/** A label an address parser could read as a number: all digits (decimal or octal) or `0x` and hex digits. `127.1`, `0177.0.0.1`, `0x7f.0.0.1` and `169.254.43518` all end in one. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/u;

export type HostProblem = "shape" | "single_label" | "numeric_label" | "address_shaped";

/**
 * Why a text is not an acceptable host name, or undefined when it is. A host is a plain lower-case name of at least two labels (no wildcard, port, path, credentials or trailing dot) that can never be
 * read as an IP address: its last label must start with a letter (every real top-level name does, and `127.1`, `0x7f.1`, `0177.0.0.1` and `169.254.43518` do not), and not every label may be numeric
 * or `0x` hex. Short and hex spellings of an address are refused here, not left to whatever resolves the name.
 */
export function hostProblem(host: string): HostProblem | undefined {
  if (host.length < 1 || host.length > 253) return "shape";
  const labels = host.split(".");
  if (!labels.every((label) => HOST_LABEL.test(label))) return "shape";
  if (labels.length < 2) return "single_label";
  if (labels.every((label) => NUMERIC_LABEL.test(label))) return "address_shaped";
  const last = labels[labels.length - 1] ?? "";
  if (NUMERIC_LABEL.test(last) || !/^[a-z]/u.test(last)) return "numeric_label";
  return undefined;
}

/** The one host schema for a dependency's `http:` family and a test account's hosts. */
export const TestServiceHostSchema = z.string().superRefine((host, context) => {
  const problem = hostProblem(host);
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem === "shape" || problem === "single_label" ? "a lower-case host name of at least two labels" : "a name, not an address" });
});

// ---- variable names Rovara and the system own

/**
 * Names a dependency or a test account may not set: the ones the worker, the system or Rovara's own channel set or relies on (AWS access and endpoints, the proxy and certificate variables, Git, the loader,
 * the interpreters' and package managers' option and path variables, TLS and shell hooks, cloud and model-provider credentials). Rovara's channel builds its own from fixed templates (4.0.5).
 */
const RESERVED_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "IFS", "ENV", "BASH_ENV", "CLASSPATH", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP",
  "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "DOCKER_HOST",
  "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE", "HOSTALIASES", "TMPDIR", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "FTP_PROXY", "MAVEN_OPTS",
  "JAVA_OPTS", "GRADLE_OPTS", "SBT_OPTS", "EDITOR", "VISUAL", "PAGER", "BROWSER", "LESSOPEN", "LESSCLOSE", "HISTFILE", "LANG", "LANGUAGE", "NLSPATH", "LOCPATH", "TERMINFO", "TZDIR",
]);
const RESERVED_ENV_PREFIXES = [
  "AGENTX_", "ROVARA_", "AWS_", "GIT_", "LD_", "DYLD_", "PI_", "DOCKER_",
  "PYTHON", "NPM_CONFIG_", "PIP_", "UV_", "YARN_", "GO", "CARGO_", "XDG_", "SSL", "OPENSSL_", "GLIBC_", "GCONV_", "BASH", "KUBE", "GOOGLE_", "AZURE_", "ANTHROPIC_", "OPENAI_", "ECS_", "SSH_", "DOTNET_", "COREHOST_", "CORECLR_", "COMPLUS_", "LC_", "MALLOC_",
] as const;

/** Whether Rovara or the system owns a variable name (compared in upper case). */
export function reservedDependencyEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_ENV_NAMES.has(upper) || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

// ---- secret-shaped text

/** A long-lived AWS access key id (and the ids of other long-lived principals). An AWS account is reached by assuming a role, so no stored AWS key is ever a test account's value. */
export const AWS_KEY_ID = /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA|AIDA|AROA|ABIA|ACCA)[A-Z2-7]{16}(?:[^A-Za-z0-9]|$)/u;

/** Whether a piece of text looks like a secret value (a key, a token or a private key) and so must not sit in a label, a template or any other plain field of a record. Any known shape, live or test. */
export function looksLikeSecretValue(text: string): boolean {
  return (
    /(?:^|[^A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/u.test(text) ||
    AWS_KEY_ID.test(text) ||
    text.includes("-----BEGIN") ||
    /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u.test(text) ||
    /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/u.test(text) ||
    /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/u.test(text) ||
    /(?:^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/u.test(text) ||
    /(?:^|[^A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?:[^A-Za-z0-9+/=_-]|$)/u.test(text)
  );
}
