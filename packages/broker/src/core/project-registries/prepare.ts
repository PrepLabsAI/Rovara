// The registries a PREPARE invocation carries (where they are, never a credential). Built where the invocation is built, so an install that cannot serve them refuses the start with a fixed sentence
// rather than letting setup run without the registry and fail on a 401 (and never falling back to a public mirror).
//   - only a PREPARE carries them: it is the run of the project's approved setup and readiness commands. A task, an agent step, a publication and a push never do (this function is not called for them);
//   - a preparation that only reads (`readOnly`: a wiki build, a saved-image build) runs none of the project's code, so it carries none;
//   - the registries are the project's CodeArtifact entries, and EVERY entry the project's COMPANY set (owner decision 254zzz434): each host's token covers the company's projects alike, so there is no
//     per-project choice to miss. The company's entries come from the company store, for the company of the run's own records.
import { AgentXError, PREPARE_COMPANY_REGISTRIES_FEATURE, PREPARE_REGISTRIES_FEATURE, isPrivateRegistryHost, REGISTRY_PROBLEM_MESSAGES, agentXError, prepareRegistriesOf, prepareRegistriesOfCompany, registryProblems, REGISTRIES_MAX, type BoundRegistryDomain, type Edition, type PrepareRegistries, type ProjectRegistry } from "@agentx/contracts";
import type { CodeArtifactMinter, CompanyRegistryStore } from "./mint.js";

/** The feature message: a worker that does not list `prepare.registries.v1` is refused at delivery with this, the same sentence as an old worker meeting any new field. */
export const REGISTRY_FEATURE_MISSING = "This project's package registries need a newer worker. Ask an admin to upgrade Rovara.";
/** An install with no way to serve a project's registry. */
export const REGISTRIES_NOT_AVAILABLE = "Package registries are not set up for this install.";
/** The company's package tokens could not be listed. */
export const COMPANY_REGISTRIES_UNREADABLE = "Rovara could not read the company's package token settings. Try again.";
export const REGISTRIES_TOO_MANY = "This project and company name more package registries than a setup can use.";

/** What an install can do for registries. Absent (`TaskFlowDeps.projectRegistries`): nothing, and a project that names a CodeArtifact registry is refused. */
export interface ProjectRegistriesInstall {
  /** The broker's own identity for CodeArtifact. */
  codeArtifact?: CodeArtifactMinter | undefined;
  /** The company's package tokens. */
  company?: CompanyRegistryStore | undefined;
  /** Only CodeArtifact reads the edition (an install-wide domain); absent reads as Public. */
  edition?: Edition | undefined;
  /** The CodeArtifact domains the install bound to a company (fail closed: absent binds nothing). */
  boundDomains?: readonly BoundRegistryDomain[] | undefined;
}

export async function registriesPrepareFor(input: {
  project: { registries?: readonly ProjectRegistry[] | undefined; network?: { allowedDomains: readonly string[] } | undefined };
  companyId: string;
  install: ProjectRegistriesInstall | undefined;
  readOnly?: boolean | undefined;
}): Promise<{ registries?: PrepareRegistries }> {
  if (input.readOnly === true) return {};
  const own = input.project.registries ?? [];
  if (own.length > 0) {
    if (input.install?.codeArtifact === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `${REGISTRIES_NOT_AVAILABLE} (registry: ${own[0]!.name})`);
    const problem = registryProblems({ edition: input.install.edition, registries: own, allowedDomains: input.project.network?.allowedDomains ?? [], orgId: input.companyId, boundDomains: input.install.boundDomains ?? [] })[0];
    if (problem !== undefined) throw agentXError("RUNTIME_UNAVAILABLE", `${REGISTRY_PROBLEM_MESSAGES[problem.code]} (registry: ${problem.registry})`);
  }
  let company: ReturnType<typeof prepareRegistriesOfCompany> = [];
  if (input.install?.company !== undefined) {
    try {
      company = prepareRegistriesOfCompany(await input.install.company.entries(input.companyId));
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", COMPANY_REGISTRIES_UNREADABLE);
    }
  }
  const registries = [...prepareRegistriesOf(own), ...company];
  if (registries.length === 0) return {};
  if (registries.length > REGISTRIES_MAX || new Set(registries.map((entry) => entry.name)).size !== registries.length) throw agentXError("RUNTIME_UNAVAILABLE", REGISTRIES_TOO_MANY);
  return { registries };
}

/**
 * What the dispatcher puts in a PREPARE payload: the registries, or the sentence that ends the preparation (the install cannot serve them, the company's settings cannot be read, or the worker cannot take the
 * field and setup would run without the registry and fail on a 401). The AgentXError's own words only; never what a store said.
 */
export async function registriesForPrepare(input: Parameters<typeof registriesPrepareFor>[0] & { features: readonly string[] }): Promise<{ registries?: PrepareRegistries } | string> {
  let answer: { registries?: PrepareRegistries };
  try {
    answer = await registriesPrepareFor(input);
  } catch (error) {
    if (error instanceof AgentXError) return error.message.replace(/^[A-Z_]+: /u, "");
    throw error;
  }
  if (answer.registries === undefined) return answer;
  if (!input.features.includes(PREPARE_REGISTRIES_FEATURE)) return REGISTRY_FEATURE_MISSING;
  // A company's package token goes only to a worker that installs it in its own step (P2), never to one that would hand it to the project's setup commands.
  if (answer.registries.some((entry) => isPrivateRegistryHost(new URL(entry.url).host)) && !input.features.includes(PREPARE_COMPANY_REGISTRIES_FEATURE)) return REGISTRY_FEATURE_MISSING;
  return answer;
}
