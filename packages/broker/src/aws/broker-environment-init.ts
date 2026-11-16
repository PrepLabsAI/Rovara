// broker.ts's first import (on its first line, so no line of broker.ts moves: the company inventory pins its sites by line), so it runs before any module of the broker can read the environment: puts back what the control plane passes packed or not at all (broker-environment.ts).
import { hydrateBrokerEnvironment } from "./broker-environment.js";

hydrateBrokerEnvironment(process.env);
