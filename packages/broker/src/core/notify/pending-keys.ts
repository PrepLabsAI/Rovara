// The attention queue's pending rows: the partition and the key of one row (company, person, session, kind), in a file of their own so the task flow can write a row (an admin's stop tells the owner) without importing the queue.
export const PENDING_PK = "NOTIFY_PENDING";
/** An admin stopped the task of its owner (F2-B): a notice to the owner, in plain words, with no "needs you". */
export const STOPPED_BY_ADMIN = "stopped_by_admin";
export const pendingRowKey = (orgId: string, developerId: string, sessionId: string, kind: string): { pk: string; sk: string } => ({ pk: PENDING_PK, sk: `${orgId}#${developerId}#${sessionId}#${kind}` });
