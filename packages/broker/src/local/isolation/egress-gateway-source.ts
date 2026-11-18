// The egress gateway's program text lives in @agentx/contracts (egress-gateway-source.ts) since lane L4-NETG, because an EC2 worker runs the very same program from the worker image
// (packages/worker/ec2/sandbox-egress.sh). Edit it there; there is no other copy. This module keeps the laptop's import path.
export { EGRESS_GATEWAY_SOURCE } from "@agentx/contracts/egress-gateway-source";
