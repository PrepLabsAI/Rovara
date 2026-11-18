# Rovara's outbound addresses

If a system of yours only accepts connections from known addresses (a firewall, an IP allow-list), allow Rovara's outbound addresses. A company owner or admin sees them in Company settings, under "Rovara's outbound addresses". Operators read them from the foundation stack's `NatEgressAddresses` output.

## What to know

- **There are two addresses per Rovara install**, one for each of the two availability zones the machines run in. Allow both. They are IPv4 only: Rovara's network has no IPv6, so nothing leaves from an IPv6 address.
- **Every company on the same Rovara shares them.** The addresses belong to the install, not to a company. Treat your allow-list as a second lock: your own credentials stay the main lock.
- **We give 30 days' notice before any of them changes.** The addresses are kept (never released) when Rovara's network stack is updated or deleted, so they do not change by accident. If an install is deleted and built again, it gets new addresses unless the kept ones are imported, so operators must not rebuild one without telling its companies first.
- Each Rovara install (staging, production, another company's own) has its own addresses. Use the ones shown by the install you use.
- The addresses are public. They are not a secret.

## What leaves from these addresses

- The worker machines that run tasks: git operations, package installs, tests, calls to model providers and your own systems from a task.
- Project setup checks and test runs, which run on those machines.
- Rovara's session functions and Slack service, which run in the same private network.

## What does NOT leave from these addresses today

Rovara's control-plane API function (the "Broker") runs outside the private network, so its calls come from the shared AWS Lambda address pool, which cannot be given to a customer. A code check on 2026-11-17 found these Broker calls to hosts a customer can choose:

- A project's own MCP connector URL, the connector's registration check, and its OAuth token URL.
- The hosted policy hook's address and key URL, where one is configured.
- The company admin identity provider's discovery and userinfo address, where it is the company's own.

Two more functions outside the private network call customer-chosen hosts: the sign-in function (a company's own identity provider) and the channel event sender (a registered adapter's callback URL).

If one of your systems is called by those, an address allow-list cannot cover it yet. Tell us; we would send those calls through the private network.

## Also allow the website name

Rovara's network resolves only allowed names. Besides allowing our addresses at your end, add your host to the project's allowed websites in Rovara, or the lookup returns no answer.
