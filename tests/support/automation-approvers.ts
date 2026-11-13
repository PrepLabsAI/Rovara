import { createLocalOwnerApprovers } from "../../packages/core/src/ports/policy-defaults.js";

/** The owner's approvers: a proof is the owner's only when its token is a page session's (`owner-page:` here). */
export const approversOf = () => createLocalOwnerApprovers({ verifySession: (token) => token.startsWith("owner-page:") });
