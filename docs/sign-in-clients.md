# Sign-in for other services

A service built on Rovara (a dashboard, or a scheduler that acts as a channel adapter) can let Rovara users sign in
with Rovara rather than with an identity system of its own. An administrator registers it as a **sign-in client**.
Its tokens carry its own audience, so Rovara's API refuses them.

Developer sign-in must be set up (`agentx signin enable`). Every change is an admin change: the CLI shows what it will
do and asks before applying it, and `agentx admin changes` records it.

## Register a service

```sh
agentx admin sign-in-client add scheduler \
  --name Scheduler \
  --audience scheduler \
  --redirect https://scheduler.example.com/callback \
  --loopback
```

- `--audience`: the audience its tokens carry. It can't be `agentx-developer` or another client's audience.
- `--redirect`: an exact `https` URL on a public host that its web page returns to, with no query or fragment.
  Repeat it for more URLs, up to 10.
- `--loopback`: the service may sign people in from a terminal with a loopback redirect, as `agentx login` does.
- `--confidential`: for a server-side service. The CLI makes a secret and shows it once, after the change applies.
  Only the secret's SHA-256 hash leaves your computer. Add `--secret-file <path>` to write the secret to a new file
  (mode 600) instead of printing it. Each `add --confidential` makes a new secret, so running it again rotates the
  secret.

Running `add` again for the same ID replaces the client.

## List and remove

```sh
agentx admin sign-in-client list
agentx admin sign-in-client remove scheduler
```

After a client is removed, nobody can sign in to it.

Status: phase 063a (the registry). The sign-in flows for registered clients and the access check come in 063b and
063c ([spec](../specs/063-sign-in-clients/spec.md)).
