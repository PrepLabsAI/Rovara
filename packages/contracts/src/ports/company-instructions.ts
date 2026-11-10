// Port lane P6 (item L1, owner decisions 57 and 60): the company-instructions socket. A read-only source of the company's standing rules.
//
// One company's rules, one version, read at every step (decision 57.5: a running task uses the newest approved version at its next step). Code reads them from a local file
// (`~/.rovara/company-instructions.md`, hash as the version); Cloud reads its store (the approved version number as the version). The shape is Cloud's `CompanyInstructionsSource`
// so that Cloud's port is a copy of this one. Nothing here names a chat tool, a code host or a store.
//
// This is the whole interface. How a block of text is built from the snapshot (the order of the layers, the wording, the size budget the block is held to) is the core's
// (`standing-instructions.ts`); an adapter only answers with what the company has approved. There is no write method: changing the rules is an approval in the edition that has
// one (Cloud: a second admin), or an edit of the file by the machine's owner (Code).
import type { CompanyInstructionsSnapshot } from "../standing-instructions.js";

/** The file Code reads, inside the state folder (`~/.rovara`). It is outside every repository, so a repository's writers cannot edit it. */
export const COMPANY_INSTRUCTIONS_FILE_NAME = "company-instructions.md";

export interface CompanyInstructionsSource {
  /**
   * The company's latest approved rules and the version they are, or `undefined` when the company has none. `company` is an opaque key the adapter understands (Cloud: the organisation
   * id; Code: its one implicit company). The snapshot's `version` changes whenever the rules change (Code: the file's SHA-256, so it is also the hash the task record keeps).
   * A rejection fails the step closed: a step never runs without rules that exist.
   */
  current(company: string): Promise<CompanyInstructionsSnapshot | undefined>;
}
