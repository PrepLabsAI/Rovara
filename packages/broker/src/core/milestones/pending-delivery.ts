// Internal delivery signal, deliberately absent from the milestone barrel and all
// published schemas: durable cleanup is still owed, rather than a failed send.
export class PendingMilestoneDelivery extends Error {}
