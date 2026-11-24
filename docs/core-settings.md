# Core engine settings

Every new task of a member company starts on the core engine. Two deployment settings tell the control plane how the core reaches its model. Both are needed: while either is empty, the core refuses work by name.

| Setting | What it is |
|---|---|
| `coreEngine.modelGatewayUrl` | The model gateway's origin. An https origin with no user name, password, path, query or fragment; the host is at most 56 characters. Stored as the host in the `CoreModelGatewayHost` stack parameter. |
| `coreEngine.agentModel` | The model the core's agents use (`CoreAgentModel`). Either an Anthropic id the release's model catalog knows (`claude-...`, never the Bedrock `us.anthropic....` id), or any model the gateway offers, by its exact id. |

Both values are set on the broker and the dispatcher together, and `agentx upgrade` keeps them.

```sh
agentx --env <name> config set coreEngine.modelGatewayUrl "https://<gateway host>"
agentx --env <name> config set coreEngine.agentModel "<model id>"
agentx --env <name> config get coreEngine.modelGatewayUrl
agentx --env <name> config get coreEngine.agentModel
```

Checks before a deploy: a non-Claude model id is checked against the gateway's live offered-models answer for your company, so sign in as an administrator first (`agentx --env <name> login --admin`) and set the gateway URL before the model. An id the gateway does not offer, an unreachable gateway or no administrator sign-in refuses the change. Each `config set` shows its change set and asks before it deploys.

To clear either setting, set it to `none`.

Optional models, both kept across upgrades: `coreEngine.answersModel` (a Claude id for the hosted answers and the start-box classifier; empty means the agent model) and `coreEngine.learningModel` (the install default for lessons learning; empty means `claude-haiku-5-5`).
