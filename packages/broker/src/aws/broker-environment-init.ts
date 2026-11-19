// broker.ts's first import (on its first line, so no line of broker.ts moves: the company inventory pins its sites by line), so it runs before any module of the broker can read the environment: puts back what the control plane passes packed or not at all (broker-environment.ts).
import { hydrateBrokerEnvironment } from "./broker-environment.js";
import { markHostedTestServices } from "./hosted-test-services.js";

hydrateBrokerEnvironment(process.env);
// DEC 254z-amend3: test services are switched on by default, and Code's workers cannot run them yet, so the host says so before anything reads the switch (hosted-test-services.ts).
markHostedTestServices(process.env);
