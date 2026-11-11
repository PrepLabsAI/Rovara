// The company every contract-test broker harness serves: Code's one implicit company. E2E account rows and AI navigation day budgets sit under the project's company-scoped
// partition (`projectPk`), the layout the ports-based core uses too.
import { IMPLICIT_COMPANY_ID, OrgIdSchema, projectPk } from "../../packages/contracts/src/index.js";

export const TEST_ORG = OrgIdSchema.parse(IMPLICIT_COMPANY_ID);

/** The partition of a project of the harness's company (`projectPk`): where its E2E accounts and its AI navigation day budget live. */
export const testProjectPk = (name: string) => projectPk(TEST_ORG, name);
