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

/**
 * DynamoDB's reserved words (the developer guide's "Reserved words in DynamoDB" list). An expression that names one as an
 * attribute without an #alias is refused with a ValidationException.
 */
export const DYNAMODB_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "ABORT", "ABSOLUTE", "ACTION", "ADD", "AFTER", "AGENT", "AGGREGATE", "ALL", "ALLOCATE", "ALTER", "ANALYZE", "AND",
  "ANY", "ARCHIVE", "ARE", "ARRAY", "AS", "ASC", "ASCII", "ASENSITIVE", "ASSERTION", "ASYMMETRIC", "AT", "ATOMIC",
  "ATTACH", "ATTRIBUTE", "AUTH", "AUTHORIZATION", "AUTHORIZE", "AUTO", "AVG", "BACK", "BACKUP", "BASE", "BATCH",
  "BEFORE", "BEGIN", "BETWEEN", "BIGINT", "BINARY", "BIT", "BLOB", "BLOCK", "BOOLEAN", "BOTH", "BREADTH", "BUCKET",
  "BULK", "BY", "BYTE", "CALL", "CALLED", "CALLING", "CAPACITY", "CASCADE", "CASCADED", "CASE", "CAST", "CATALOG",
  "CHAR", "CHARACTER", "CHECK", "CLASS", "CLOB", "CLOSE", "CLUSTER", "CLUSTERED", "CLUSTERING", "CLUSTERS", "COALESCE",
  "COLLATE", "COLLATION", "COLLECTION", "COLUMN", "COLUMNS", "COMBINE", "COMMENT", "COMMIT", "COMPACT", "COMPILE",
  "COMPRESS", "CONDITION", "CONFLICT", "CONNECT", "CONNECTION", "CONSISTENCY", "CONSISTENT", "CONSTRAINT",
  "CONSTRAINTS", "CONSTRUCTOR", "CONSUMED", "CONTINUE", "CONVERT", "COPY", "CORRESPONDING", "COUNT", "COUNTER",
  "CREATE", "CROSS", "CUBE", "CURRENT", "CURSOR", "CYCLE", "DATA", "DATABASE", "DATE", "DATETIME", "DAY", "DEALLOCATE",
  "DEC", "DECIMAL", "DECLARE", "DEFAULT", "DEFERRABLE", "DEFERRED", "DEFINE", "DEFINED", "DEFINITION", "DELETE",
  "DELIMITED", "DEPTH", "DEREF", "DESC", "DESCRIBE", "DESCRIPTOR", "DETACH", "DETERMINISTIC", "DIAGNOSTICS",
  "DIRECTORIES", "DISABLE", "DISCONNECT", "DISTINCT", "DISTRIBUTE", "DO", "DOMAIN", "DOUBLE", "DROP", "DUMP",
  "DURATION", "DYNAMIC", "EACH", "ELEMENT", "ELSE", "ELSEIF", "EMPTY", "ENABLE", "END", "EQUAL", "EQUALS", "ERROR",
  "ESCAPE", "ESCAPED", "EVAL", "EVALUATE", "EXCEEDED", "EXCEPT", "EXCEPTION", "EXCEPTIONS", "EXCLUSIVE", "EXEC",
  "EXECUTE", "EXISTS", "EXIT", "EXPLAIN", "EXPLODE", "EXPORT", "EXPRESSION", "EXTENDED", "EXTERNAL", "EXTRACT", "FAIL",
  "FALSE", "FAMILY", "FETCH", "FIELDS", "FILE", "FILTER", "FILTERING", "FINAL", "FINISH", "FIRST", "FIXED", "FLATTERN",
  "FLOAT", "FOR", "FORCE", "FOREIGN", "FORMAT", "FORWARD", "FOUND", "FREE", "FROM", "FULL", "FUNCTION", "FUNCTIONS",
  "GENERAL", "GENERATE", "GET", "GLOB", "GLOBAL", "GO", "GOTO", "GRANT", "GREATER", "GROUP", "GROUPING", "HANDLER",
  "HASH", "HAVE", "HAVING", "HEAP", "HIDDEN", "HOLD", "HOUR", "IDENTIFIED", "IDENTITY", "IF", "IGNORE", "IMMEDIATE",
  "IMPORT", "IN", "INCLUDING", "INCLUSIVE", "INCREMENT", "INCREMENTAL", "INDEX", "INDEXED", "INDEXES", "INDICATOR",
  "INFINITE", "INITIALLY", "INLINE", "INNER", "INNTER", "INOUT", "INPUT", "INSENSITIVE", "INSERT", "INSTEAD", "INT",
  "INTEGER", "INTERSECT", "INTERVAL", "INTO", "INVALIDATE", "IS", "ISOLATION", "ITEM", "ITEMS", "ITERATE", "JOIN",
  "KEY", "KEYS", "LAG", "LANGUAGE", "LARGE", "LAST", "LATERAL", "LEAD", "LEADING", "LEAVE", "LEFT", "LENGTH", "LESS",
  "LEVEL", "LIKE", "LIMIT", "LIMITED", "LINES", "LIST", "LOAD", "LOCAL", "LOCALTIME", "LOCALTIMESTAMP", "LOCATION",
  "LOCATOR", "LOCK", "LOCKS", "LOG", "LOGED", "LONG", "LOOP", "LOWER", "MAP", "MATCH", "MATERIALIZED", "MAX", "MAXLEN",
  "MEMBER", "MERGE", "METHOD", "METRICS", "MIN", "MINUS", "MINUTE", "MISSING", "MOD", "MODE", "MODIFIES", "MODIFY",
  "MODULE", "MONTH", "MULTI", "MULTISET", "NAME", "NAMES", "NATIONAL", "NATURAL", "NCHAR", "NCLOB", "NEW", "NEXT",
  "NO", "NONE", "NOT", "NULL", "NULLIF", "NUMBER", "NUMERIC", "OBJECT", "OF", "OFFLINE", "OFFSET", "OLD", "ON",
  "ONLINE", "ONLY", "OPAQUE", "OPEN", "OPERATOR", "OPTION", "OR", "ORDER", "ORDINALITY", "OTHER", "OTHERS", "OUT",
  "OUTER", "OUTPUT", "OVER", "OVERLAPS", "OVERRIDE", "OWNER", "PAD", "PARALLEL", "PARAMETER", "PARAMETERS", "PARTIAL",
  "PARTITION", "PARTITIONED", "PARTITIONS", "PATH", "PERCENT", "PERCENTILE", "PERMISSION", "PERMISSIONS", "PIPE",
  "PIPELINED", "PLAN", "POOL", "POSITION", "PRECISION", "PREPARE", "PRESERVE", "PRIMARY", "PRIOR", "PRIVATE",
  "PRIVILEGES", "PROCEDURE", "PROCESSED", "PROJECT", "PROJECTION", "PROPERTY", "PROVISIONING", "PUBLIC", "PUT",
  "QUERY", "QUIT", "QUORUM", "RAISE", "RANDOM", "RANGE", "RANK", "RAW", "READ", "READS", "REAL", "REBUILD", "RECORD",
  "RECURSIVE", "REDUCE", "REF", "REFERENCE", "REFERENCES", "REFERENCING", "REGEXP", "REGION", "REINDEX", "RELATIVE",
  "RELEASE", "REMAINDER", "RENAME", "REPEAT", "REPLACE", "REQUEST", "RESET", "RESIGNAL", "RESOURCE", "RESPONSE",
  "RESTORE", "RESTRICT", "RESULT", "RETURN", "RETURNING", "RETURNS", "REVERSE", "REVOKE", "RIGHT", "ROLE", "ROLES",
  "ROLLBACK", "ROLLUP", "ROUTINE", "ROW", "ROWS", "RULE", "RULES", "SAMPLE", "SATISFIES", "SAVE", "SAVEPOINT", "SCAN",
  "SCHEMA", "SCOPE", "SCROLL", "SEARCH", "SECOND", "SECTION", "SEGMENT", "SEGMENTS", "SELECT", "SELF", "SEMI",
  "SENSITIVE", "SEPARATE", "SEQUENCE", "SERIALIZABLE", "SESSION", "SET", "SETS", "SHARD", "SHARE", "SHARED", "SHORT",
  "SHOW", "SIGNAL", "SIMILAR", "SIZE", "SKEWED", "SMALLINT", "SNAPSHOT", "SOME", "SOURCE", "SPACE", "SPACES", "SPARSE",
  "SPECIFIC", "SPECIFICTYPE", "SPLIT", "SQL", "SQLCODE", "SQLERROR", "SQLEXCEPTION", "SQLSTATE", "SQLWARNING", "START",
  "STATE", "STATIC", "STATUS", "STORAGE", "STORE", "STORED", "STREAM", "STRING", "STRUCT", "STYLE", "SUB",
  "SUBMULTISET", "SUBPARTITION", "SUBSTRING", "SUBTYPE", "SUM", "SUPER", "SYMMETRIC", "SYNONYM", "SYSTEM", "TABLE",
  "TABLESAMPLE", "TEMP", "TEMPORARY", "TERMINATED", "TEXT", "THAN", "THEN", "THROUGHPUT", "TIME", "TIMESTAMP",
  "TIMEZONE", "TINYINT", "TO", "TOKEN", "TOTAL", "TOUCH", "TRAILING", "TRANSACTION", "TRANSFORM", "TRANSLATE",
  "TRANSLATION", "TREAT", "TRIGGER", "TRIM", "TRUE", "TRUNCATE", "TTL", "TUPLE", "TYPE", "UNDER", "UNDO", "UNION",
  "UNIQUE", "UNIT", "UNKNOWN", "UNLOGGED", "UNNEST", "UNPROCESSED", "UNSIGNED", "UNTIL", "UPDATE", "UPPER", "URL",
  "USAGE", "USE", "USER", "USERS", "USING", "UUID", "VACUUM", "VALUE", "VALUED", "VALUES", "VARCHAR", "VARIABLE",
  "VARIANCE", "VARINT", "VARYING", "VIEW", "VIEWS", "VIRTUAL", "VOID", "WAIT", "WHEN", "WHENEVER", "WHERE", "WHILE",
  "WINDOW", "WITH", "WITHIN", "WITHOUT", "WORK", "WRAPPED", "WRITE", "YEAR", "ZONE",
]);
/** Words an expression's own grammar uses (operators and clauses), which are not attribute names. */
const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set(["AND", "OR", "NOT", "SET", "ADD", "REMOVE", "DELETE", "IN", "BETWEEN"]);

/** Throws as DynamoDB does when an expression names a reserved word without an #alias. */
export function assertNoReservedWords(expression: string | undefined): void {
  if (expression === undefined) return;
  // A document-path separator does not make the following attribute name safe: `workflow.state` still names `state`.
  // A function's name (`size(...)`, `attribute_exists(...)`) is not an attribute name.
  const words = expression.match(/(?<![#:\w])[A-Za-z_]\w*\b(?!\s*\()/g) ?? [];
  const reserved = words.find((word) => !EXPRESSION_KEYWORDS.has(word) && DYNAMODB_RESERVED_WORDS.has(word.toUpperCase()));
  if (reserved !== undefined) {
    throw Object.assign(new Error(`Invalid expression: Attribute name is a reserved keyword; reserved keyword: ${reserved}`), { name: "ValidationException", $metadata: {} });
  }
}

/** Throws a ValidationException when the request's value or name maps do not match its expressions exactly. */
export function assertDynamoExpressionAttributes(input: Record<string, unknown>): void {
  const expressions = EXPRESSION_FIELDS.flatMap((field) => (typeof input[field] === "string" ? [input[field]] : []));
  for (const expression of expressions) assertNoReservedWords(expression);
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
