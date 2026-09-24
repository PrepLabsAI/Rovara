# Contract: Task Usage Evidence

The worker appends this payload with event type `usage` and writes the same object to the private `usage.json` artifact:

```json
{
  "schemaVersion": 1,
  "outcome": "SUCCEEDED",
  "provider": "amazon-bedrock",
  "modelId": "model-id",
  "cacheRetention": "long",
  "tokens": {
    "input": 100,
    "output": 20,
    "cacheRead": 80,
    "cacheWrite": 10,
    "total": 210
  },
  "cacheReadRatio": 0.42105263157894735,
  "costUsd": 0.0012
}
```

The event callback remains open to string event types. Existing readers that do not interpret `usage` continue returning it as ordinary operation evidence.
