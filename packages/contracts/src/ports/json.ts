// Port lane W0: the plain data every port carries. Nothing here knows a provider: a document, a queue message and a
// plug-in setting are all JSON, so any store or queue (a table, a file, a SQL row) can hold them.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** An integer amount of money in millionths of one unit of `currency` (an ISO 4217 code such as `USD`). Never a float. */
export interface Cost {
  micros: number;
  currency: string;
}
