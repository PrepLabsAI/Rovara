// A tracker account's own id as the lessons' ticket source accepts it: a Linear user id (a UUID) or a Jira account id (letters, digits, `:`, `-`, `_`). One short plain line; anything else is nobody (fail closed).
const TRACKER_ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/u;
export const isTrackerAccountId = (value: string): boolean => TRACKER_ACCOUNT_ID.test(value);
