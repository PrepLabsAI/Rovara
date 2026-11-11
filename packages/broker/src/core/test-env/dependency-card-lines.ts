// Test services the Dependencies section of the approve card, in plain sentences. One line per dependency: what it is, what backs it, why Rovara thinks the project
// needs it, and whether a second person must approve it. Built by the broker from the stored proposal, never from the asker's words; text that came from a repository (a path) goes through `shownLine` and the redactor.
import { formatCommandLine, redactText, type TestEnvDependency } from "@agentx/contracts";
import { shownLine } from "./shown-line.js";
import { SEED_COMMAND_DISPLAY_MAX, seedEnvWords } from "./refused-command.js";

const LINE_MAX = 300;

/** Where a fake's answers came from, by the digest of its set (the broker's fixture store, for the person's own company): shown so the card says "a recorded fake" or "a hand-written fake" as the evidence will. */
export type FakeOrigins = ReadonlyMap<string, { origin: "recorded" | "hand_written" }>;

/** How a backing is described to a person. Fixed words. */
export function backingWords(backing: TestEnvDependency["backing"], origins?: FakeOrigins): string {
  switch (backing.kind) {
    case "local": return backing.substituteImage === undefined ? "runs the real software from Rovara's image list" : "runs your company's own build of the image (a second person approves this)";
    case "project_image": return "runs your own image (a second person approves this)";
    case "emulated": return "runs against Rovara local AWS. Not checked here: AWS permissions and exact AWS behaviour";
    case "test_account": return "uses your test account in sealed checks (a second person approves this)";
    case "fake": {
      const kind = origins?.get(backing.fixtureSetRef)?.origin;
      const fake = kind === "recorded" ? "a recorded fake" : kind === "hand_written" ? "a hand-written fake" : "a fake";
      return backing.unmatched === "schema_synth" ? `answers from ${fake} that makes up answers for requests it has no recording for (a second person approves this)` : `answers from ${fake}`;
    }
    case "none": return backing.reason === "faked_by_tests" ? "is faked by your own tests, so Rovara starts nothing" : "has nothing behind it, so tests that need it do not run";
  }
}

const SETS_LISTED = 8;

/**
 * The card's Dependencies section: `Postgres: runs the real software from Rovara's image list. Found in docker-compose.yml, line 4.` and, for what the approver must see beyond that (design 9.1, "Test data:"), one line
 * each for the seed commands and files (a command runs with the dependency's network access, so it is shown in full), the init files the dependency starts with, and the variable names it sets. Every line is redacted and
 * made one plain line.
 */
export function dependencyCardLines(dependencies: readonly TestEnvDependency[], origins?: FakeOrigins): string[] {
  return dependencies.flatMap((dependency) => {
    const first = dependency.found[0];
    const source = first === undefined ? "" : typeof first === "string" ? (first === "model" ? " Found by Rovara's reading of the code." : first === "person" ? " Added by a person." : "") : "path" in first ? ` Found in ${first.path}, line ${String(first.line)}.` : "";
    const line = (text: string) => shownLine(redactText(text), LINE_MAX);
    const lines = [line(`${dependency.name}: ${backingWords(dependency.backing, origins)}.${source}`)];
    // Each seed is its own line and is shown IN FULL: a command is never cut (a proposal with one over the cap is refused when it is proposed). It is redacted and made one plain line, with a cap far above any real command.
    const full = (text: string) => shownLine(redactText(text), SEED_COMMAND_DISPLAY_MAX * 2);
    for (const seed of dependency.seeds) {
      if ("fixturePath" in seed) { lines.push(line(`${dependency.name} test data: loads ${seed.fixturePath}.`)); continue; }
      const env = seedEnvWords(seed.command);
      lines.push(full(`${dependency.name} test data: runs ${seed.command.cwd}: ${formatCommandLine(seed.command)}${env === undefined ? "" : ` with ${env}`}.`));
    }
    const initFiles = dependency.backing.kind === "local" ? (dependency.backing.config.initFiles ?? []) : [];
    if (initFiles.length > 0) lines.push(line(`${dependency.name} starts with: ${initFiles.join(", ")}.`));
    const names = dependency.connect.env.map((entry) => entry.name);
    if (names.length > 0) lines.push(line(`${dependency.name} sets: ${names.slice(0, SETS_LISTED).join(", ")}${names.length > SETS_LISTED ? ` and ${String(names.length - SETS_LISTED)} more` : ""}.`));
    return lines;
  });
}
