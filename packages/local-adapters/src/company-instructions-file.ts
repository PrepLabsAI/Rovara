// Port lane P6 (item L1): Code's `company-instructions` adapter. It reads the company's rules from one Markdown file the machine's owner keeps outside every repository
// (`~/.rovara/company-instructions.md`); the owner is the approver (design INSTRUCTIONS-COMPANY-AND-TASK-DESIGN section 3, Code edition). The file is read fresh at every call, so an edit
// is picked up at the next step. The snapshot's version is the SHA-256 of the file's bytes: that hash is what a task record keeps.
//
// The file format is a list of bullets under optional `Required` and `Preferred` headings:
//
//     # Company rules          (any other heading is a title and is ignored)
//     ## Required
//     - Never push to the main branch.
//     - Keep a rule that runs past one line
//       by indenting the next line.
//     ## Preferred
//     - Small commits.
//
// A bullet before any heading is Required (the stricter reading). A line that is neither a heading, a bullet, an indented continuation nor blank is refused, naming its line number,
// because dropping it silently would drop a rule. The size limits are the shared ones (30 rules, 600 characters each, 12,000 in all); over them the call fails and nothing is cut.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  COMPANY_RULE_LIMITS,
  agentXError,
  assertCompanyRulesWithinBudget,
  type CompanyInstructionsSnapshot,
  type CompanyInstructionsSource,
  type CompanyRule,
  type CompanyRulePriority,
} from "@agentx/contracts";

/** A larger file is refused; the rules are at most 12,000 characters, so this leaves room for headings and layout. */
export const COMPANY_INSTRUCTIONS_FILE_MAX_BYTES = 64 * 1_024;

const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;
const hasModes = process.platform !== "win32";

/** Hidden and control characters out, runs of white space folded to one space, trimmed. */
function foldedText(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

/** The rules a file's text holds, in order. Throws `CONFIG_INVALID` for a line it cannot place. Does not check the size limits. */
export function parseCompanyInstructionsText(text: string): CompanyRule[] {
  const rules: CompanyRule[] = [];
  let priority: CompanyRulePriority = "required";
  let current: { priority: CompanyRulePriority; parts: string[] } | undefined;
  const finish = (): void => {
    if (current !== undefined) rules.push({ text: foldedText(current.parts.join(" ")), priority: current.priority });
    current = undefined;
  };
  const lines = text.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n|\u2028|\u2029/u);
  lines.forEach((line, index) => {
    const number = index + 1;
    if (line.trim() === "") {
      finish();
      return;
    }
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading !== null) {
      finish();
      const name = (heading[1] ?? "").trim().toLowerCase().replace(/[:\s]+$/u, "");
      if (name === "required") priority = "required";
      else if (name === "preferred") priority = "preferred";
      return;
    }
    const bullet = /^ {0,3}[-*+]\s+(.*)$/u.exec(line);
    if (bullet !== null) {
      finish();
      current = { priority, parts: [bullet[1] ?? ""] };
      return;
    }
    if (current !== undefined && /^\s+\S/u.test(line)) {
      current.parts.push(line.trim());
      return;
    }
    throw agentXError("CONFIG_INVALID", `The company rules file is not in a form Rovara can read: line ${String(number)} is not a heading, a bullet or an indented continuation of a bullet. Write each rule as a bullet under "Required" or "Preferred".`);
  });
  finish();
  return rules;
}

/** The snapshot for a file's text: `version` is the SHA-256 of the bytes. `undefined` when the file holds no rule. Throws when it is unreadable or over the limits; nothing is cut. */
export function companyInstructionsSnapshot(bytes: Uint8Array): CompanyInstructionsSnapshot | undefined {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const rules = parseCompanyInstructionsText(text);
  if (rules.length === 0) return undefined;
  assertCompanyRulesWithinBudget(rules);
  return { version: createHash("sha256").update(bytes).digest("hex"), rules };
}

export interface FileCompanyInstructionsOptions {
  /** The file, e.g. `~/.rovara/company-instructions.md`. */
  path: string;
  /** For tests only: opens the file (default `fs.promises.open`), so a test can hand back a handle whose size changed after `stat`. */
  open?: typeof open;
}

/**
 * Reads the company's rules from a file only the machine's owner can change: not a link, a plain file, owned by this user, and not writable by anyone else. A missing file is
 * "no rules". The `company` key is ignored: Code runs as one implicit company.
 */
export class FileCompanyInstructions implements CompanyInstructionsSource {
  readonly #path: string;
  readonly #open: typeof open;

  /**
   * The folder holding the file must be a real folder (not a link), belong to this user and not be writable by group or others: anyone who can write there can swap the file for another. A missing
   * folder is "no rules" (the file is missing too).
   */
  async #checkParentFolder(): Promise<void> {
    let details;
    try {
      details = await lstat(dirname(this.#path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw agentXError("CONFIG_INVALID", "The folder of the company rules file could not be checked.");
    }
    if (details.isSymbolicLink() || !details.isDirectory()) throw agentXError("CONFIG_INVALID", "The folder of the company rules file must be a plain folder, not a link.");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (hasModes && uid !== undefined && details.uid !== uid) throw agentXError("CONFIG_INVALID", "The folder of the company rules file must belong to you.");
    if (hasModes && (details.mode & 0o022) !== 0) throw agentXError("CONFIG_INVALID", "The folder of the company rules file must not be writable by other users (chmod 700).");
  }

  constructor(options: FileCompanyInstructionsOptions) {
    this.#path = options.path;
    this.#open = options.open ?? open;
  }

  async current(company: string): Promise<CompanyInstructionsSnapshot | undefined> {
    void company; // one implicit company: the key is not needed
    await this.#checkParentFolder();
    let handle;
    try {
      handle = await this.#open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw agentXError("CONFIG_INVALID", "The company rules file could not be opened. It must be a plain file, not a link.");
    }
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw agentXError("CONFIG_INVALID", "The company rules file must be a plain file.");
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (hasModes && uid !== undefined && details.uid !== uid) throw agentXError("CONFIG_INVALID", "The company rules file must belong to you.");
      // Anyone who can write the file can change the rules every task runs under.
      if (hasModes && (details.mode & 0o022) !== 0) throw agentXError("CONFIG_INVALID", "The company rules file must not be writable by other users (chmod 600).");
      if (details.size > COMPANY_INSTRUCTIONS_FILE_MAX_BYTES) throw agentXError("CONFIG_INVALID", `The company rules file is larger than ${String(COMPANY_INSTRUCTIONS_FILE_MAX_BYTES)} bytes; the rules are at most ${String(COMPANY_RULE_LIMITS.maxTotalCharacters)} characters.`);
      // Read at most one byte past the limit from the open file: the file may have grown since `stat`, and what is read is what is hashed and obeyed.
      const buffer = Buffer.alloc(COMPANY_INSTRUCTIONS_FILE_MAX_BYTES + 1);
      let filled = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
        if (filled > COMPANY_INSTRUCTIONS_FILE_MAX_BYTES) throw agentXError("CONFIG_INVALID", `The company rules file is larger than ${String(COMPANY_INSTRUCTIONS_FILE_MAX_BYTES)} bytes; the rules are at most ${String(COMPANY_RULE_LIMITS.maxTotalCharacters)} characters.`);
      }
      const bytes = buffer.subarray(0, filled);
      try {
        return companyInstructionsSnapshot(bytes);
      } catch (error) {
        if (error instanceof TypeError) throw agentXError("CONFIG_INVALID", "The company rules file is not valid UTF-8 text.");
        throw error;
      }
    } finally {
      await handle.close();
    }
  }
}
