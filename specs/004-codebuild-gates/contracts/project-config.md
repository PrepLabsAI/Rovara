# Project Configuration Contract

```json
{
  "name": "website",
  "url": "https://github.com/example/website.git",
  "path": "repo/website",
  "defaultBranch": "main",
  "credentialRef": "github-agentx-sdlc",
  "codeBuildGates": [
    {
      "name": "quality",
      "projectName": "agentx-website-quality",
      "timeoutMinutes": 30
    },
    {
      "name": "browser",
      "projectName": "agentx-website-playwright",
      "timeoutMinutes": 45
    }
  ]
}
```

`codeBuildGates` is optional and defaults to no external gates. Project names must begin with `agentx-`; each name and project is unique within the repository. Each timeout is 5–420 minutes and their repository total cannot exceed 420 minutes.
