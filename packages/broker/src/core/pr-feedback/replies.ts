// This port authorizes owner-selected fixes only. None of those decisions authorize a public reply.
// The existing post-push recovery hook therefore has no automatic reply work to deliver.
export async function sendPrFeedbackReplies(): Promise<void> {}
