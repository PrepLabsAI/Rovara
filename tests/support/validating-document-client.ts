// Wraps a fake DynamoDB document client with DynamoDB's own refusal of unused or undefined expression
// attributes. The real service raises a ValidationException when an ExpressionAttributeValues or
// ExpressionAttributeNames key is not used by any expression of the request, or a value is undefined.
// Plain in-memory fakes accept both, so such a bug passes tests and fails only in production.

interface SendableCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

const EXPRESSION_FIELDS = ["UpdateExpression", "ConditionExpression", "KeyConditionExpression", "FilterExpression", "ProjectionExpression"] as const;

function validationError(message: string): Error {
  return Object.assign(new Error(message), { name: "ValidationException", $metadata: {} });
}

/** Throws a ValidationException when the request's value or name maps do not match its expressions exactly. */
export function assertDynamoExpressionAttributes(input: Record<string, unknown>): void {
  const expressions = EXPRESSION_FIELDS.flatMap((field) => (typeof input[field] === "string" ? [input[field]] : []));
  const text = expressions.join(" ");
  const usedValues = new Set(text.match(/:[A-Za-z0-9_]+/g) ?? []);
  const usedNames = new Set(text.match(/#[A-Za-z0-9_]+/g) ?? []);
  const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, unknown>;
  // DynamoDB refuses an empty map outright, before it compares keys.
  if (input.ExpressionAttributeValues !== undefined && Object.keys(values).length === 0) throw validationError("ExpressionAttributeValues must not be empty");
  if (input.ExpressionAttributeNames !== undefined && Object.keys(names).length === 0) throw validationError("ExpressionAttributeNames must not be empty");
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) throw validationError(`ExpressionAttributeValues contains an undefined value for ${key}`);
    if (!usedValues.has(key)) throw validationError(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${key}}`);
  }
  for (const key of Object.keys(names)) {
    if (!usedNames.has(key)) throw validationError(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${key}}`);
  }
  for (const key of usedValues) {
    if (!(key in values)) throw validationError(`An expression attribute value used in expression is not defined: ${key}`);
  }
  for (const key of usedNames) {
    if (!(key in names)) throw validationError(`An expression attribute name used in expression is not defined: ${key}`);
  }
}

/** A document client that validates every command's expression attributes, then forwards it to `inner`. */
export function validatingDocumentClient<T extends { send(command: never): Promise<unknown> }>(inner: T): { send(command: unknown): Promise<unknown> } {
  return {
    async send(command: unknown): Promise<unknown> {
      const typed = command as SendableCommand;
      if (typed.constructor.name === "TransactWriteCommand") {
        for (const entry of (typed.input.TransactItems ?? []) as Array<Record<string, Record<string, unknown>>>) {
          assertDynamoExpressionAttributes(Object.values(entry)[0] ?? {});
        }
      } else {
        assertDynamoExpressionAttributes(typed.input ?? {});
      }
      return (inner.send as (command: unknown) => Promise<unknown>)(command);
    },
  };
}
