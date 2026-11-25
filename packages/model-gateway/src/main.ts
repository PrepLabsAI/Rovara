/** The gateway image's entry (environments/model-gateway/Dockerfile: node packages/model-gateway/dist/main.js). */
import { runGateway } from "./process.js";

void runGateway(process.env, {
  onSignal: (signal, handler) => { process.once(signal, handler); },
  exit: (code) => { process.exit(code); },
});
