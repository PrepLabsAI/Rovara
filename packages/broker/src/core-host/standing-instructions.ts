// Standing instructions on the hosted broker (lead 4 L4-HW3, owner option A). The broker has the company's code host and its `company-instructions` point; the dispatcher has neither. So the broker
// reads the project's How we work (`.rovara/playbook.yaml` at the default branch's head, through the company's own code host) and the company's rules ONCE, when a task starts, and keeps the checked
// copy on the task's workspace record (`createStandingInstructions` with `pinsContent`, read by start.ts); the dispatcher builds every step's block from that record (dispatcher-core.ts), team rules
// after them, in the laptop's order. Nothing here reaches another company: the code host is the company's own (scope = this company), the rules source is asked for this company's id, and the
// project must be one of this company's own registered projects.
//
// Without a registered code host the file has nowhere to be read from and every project reads as having none (as on a laptop with no host); without a `company-instructions` point there are no company
// rules. An install that has neither starts every task exactly as before.
import type { AdapterRegistry, OrgId } from "@agentx/contracts";
import { createStandingInstructions } from "../core/instructions/step-block.js";
import { createPlaybookService } from "../core/playbook/service.js";
import { createCodeHostPlaybookSource } from "../core/playbook/source.js";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import type { StandingInstructionsSeam } from "../core/task-flow/deps.js";

export function hostedStandingInstructions(options: { registry: AdapterRegistry; companyId: OrgId; now: () => Date }): StandingInstructionsSeam {
  const { registry, companyId } = options;
  const store = registry.require("storage");
  const projects = createStoreProjectSource(store, companyId);
  const playbook = createPlaybookService({
    companyId, store, audit: registry.require("audit-sink"), projects, now: options.now,
    // The company's stored How we work item (its design review setting) is never written from a task start here: only the file's text is read.
    syncStored: false,
    source: createCodeHostPlaybookSource({ companyId, projects, codeHosts: registry.names("code-host").length > 0 ? registry : undefined, now: () => options.now().getTime() }),
  });
  return createStandingInstructions({
    companyId, playbook, pinsContent: true,
    ...(registry.names("company-instructions").length > 0 ? { company: registry.require("company-instructions") } : {}),
  });
}
