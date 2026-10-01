// The Node version check the agentx executable runs first (issue #238). AWS CloudShell ships
// Node 20, and npm only warns (EBADENGINE) when a package's engines.node does not match, so
// without this the CLI would start on a Node it does not support and fail somewhere mid-install.
//
// bin.ts imports this file before anything else and loads the rest of the CLI only once the check
// passes. Keep this file to syntax an old Node can parse (ES2020: no `?.`, `??`, class fields or
// top-level await) and free of imports; tests/contract/node-version-check.test.ts parses it as
// ES2020.

/**
 * The Node versions the CLI supports. pack-cli writes it as the published package's engines.node,
 * and its lower bound matches the repository's own engines.node (a test checks both).
 */
export const NODE_ENGINE_RANGE = ">=22.19.0";

/**
 * The Node the CloudShell command installs: the newest Node 22 LTS ("Jod") release when this was
 * pinned (22.23.3, 2026-09-23), which is at or above NODE_ENGINE_RANGE.
 */
export const CLOUDSHELL_NODE_VERSION = "22.23.3";

/**
 * One line to paste in AWS CloudShell. It downloads the official Node binary for this machine
 * (x86_64 or aarch64) from nodejs.org into ~/.local/node22 (the home folder is the only storage
 * CloudShell keeps), checks it against nodejs.org's SHASUMS256.txt before unpacking it, unpacks it
 * into ~/.local/node22.new and only then swaps it in (so a failed or newer install never mixes with
 * the one already there), and puts it on PATH for this session and, through ~/.bashrc, for later
 * ones. It needs no sudo and changes nothing outside the home folder. It is Bash (CloudShell's
 * default shell). docs/install.md shows the same line (a test checks they match).
 */
export const CLOUDSHELL_NODE_INSTALL_COMMAND = String.raw`V=v${CLOUDSHELL_NODE_VERSION} A=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') && F=node-$V-linux-$A.tar.gz && D=$HOME/.local/node22 && rm -rf "$D.new" && mkdir -p "$D.new" && (cd "$D.new" && curl -fSL --progress-bar -O "https://nodejs.org/dist/$V/$F" && curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " $F\$" | sha256sum -c - && tar -xzf "$F" --strip-components=1 && rm "$F") && rm -rf "$D" && mv "$D.new" "$D" && (grep -qs 'local/node22/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/node22/bin:$PATH"' >> ~/.bashrc) && export PATH="$D/bin:$PATH" && node --version`;

function parseVersion(text: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isBelow(version: number[], floor: number[]): boolean {
  for (let index = 0; index < floor.length; index += 1) {
    const part = version[index] || 0;
    const floorPart = floor[index] || 0;
    if (part !== floorPart) return part < floorPart;
  }
  return false;
}

const FLOOR = parseVersion(NODE_ENGINE_RANGE.replace(/^>=/, "")) || [0, 0, 0];

/** "22.19" for 22.19.0, "22.19.1" otherwise. */
function floorText(): string {
  return FLOOR[2] === 0 ? `${FLOOR[0]}.${FLOOR[1]}` : FLOOR.join(".");
}

/**
 * The message to print when `nodeVersion` (process.versions.node) is older than the CLI supports,
 * or undefined when it is supported. In AWS CloudShell (AWS_EXECUTION_ENV=CloudShell) the message
 * carries the one-line Node 22 install.
 */
export function nodeVersionProblem(nodeVersion: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const version = parseVersion(nodeVersion);
  // A version string this cannot read is not a reason to refuse to start.
  if (version === undefined || !isBelow(version, FLOOR)) return undefined;
  const first = `AgentX needs Node ${floorText()} or newer; this is Node ${nodeVersion}.`;
  if (env.AWS_EXECUTION_ENV !== "CloudShell") {
    return `${first} Install Node 22 from https://nodejs.org, then run agentx again.`;
  }
  return [
    `${first} In AWS CloudShell, run this command in its default Bash shell, then run agentx again:`,
    "",
    `  ${CLOUDSHELL_NODE_INSTALL_COMMAND}`,
    "",
    "It installs Node 22 in your own CloudShell home folder only; nothing else in your AWS account is affected.",
  ].join("\n");
}

export interface CliStart {
  nodeVersion: string;
  env: Readonly<Record<string, string | undefined>>;
  writeError(text: string): void;
  /** Loads the rest of the CLI (main.ts). Called only once the Node version check passes. */
  loadCli(): Promise<{ executeCli(): Promise<number> }>;
}

/** Checks the Node version, then loads and runs the CLI; resolves to the process exit code. */
export function startCli(start: CliStart): Promise<number> {
  const problem = nodeVersionProblem(start.nodeVersion, start.env);
  if (problem !== undefined) {
    start.writeError(`${problem}\n`);
    return Promise.resolve(1);
  }
  return start.loadCli().then((cli) => cli.executeCli());
}
