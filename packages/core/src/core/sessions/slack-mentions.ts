// A text with every Slack mention (`<@U123>`, `<@U123|name>`) replaced by the neutral word, so no Slack id is kept in anything stored or sent to a model. Kept apart from the Ask context so
// that the modules the person-erasure walk loads stay small.
const SLACK_MENTION = /<@[UW][A-Z0-9]{2,}(?:\|[^>]{0,80})?>/gu;

export const neutralizeSlackMentions = (text: string): string => text.replace(SLACK_MENTION, "@member");
