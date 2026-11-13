/** A route's answer with a status other than 200; the handler that mounts the route writes the status and the body. (Copied from the hosted product's broker, which the other port lanes share.) */
export class StatusReply {
  constructor(readonly statusCode: number, readonly body: object) {}
}
