# Security policy

## Supported versions

Artiflow is pre-1.0 and self-hosted. Only the latest tagged release and the
`main` branch receive security fixes. There is no long-term support branch yet;
this policy will be revised when a stable release line exists.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

<https://github.com/guidobuilds/artiflow/security/advisories/new>

Do **not** open a public issue, discussion, or pull request for a suspected
vulnerability. If the advisory form is unavailable, contact the repository owner
on GitHub ([@guidobuilds](https://github.com/guidobuilds)) and ask for a private
channel before sharing details.

Please include:

- affected version or commit;
- the deployment mode (self-hosted, split API/MCP, plugin) and relevant config;
- impact and who could exploit it;
- reproduction steps or a proof of concept;
- any suggested fix, if you have one.

Reports must include a concrete reproduction. Automated scanner output without
an impact analysis will be closed with a pointer to this policy.

## Scope

In scope:

- authentication, authorization and session handling in the API;
- OAuth/OIDC and MCP token handling, scopes and audience checks;
- cross-tenant or cross-owner access to artifacts, revisions, comments,
  shares and public links;
- artifact byte handling: path traversal, digest substitution, storage-key
  confusion, signed-URL leakage;
- viewer sandbox escapes, XSS and content-type confusion in HTML/Markdown
  rendering and MCP Apps;
- token or secret leakage in logs, errors, plugins or build artifacts;
- dependency vulnerabilities that are reachable from Artiflow code.

Out of scope:

- vulnerabilities in PostgreSQL, S3 providers, reverse proxies, containers, or
  the host OS that are not caused by Artiflow code;
- misconfiguration of a self-hosted deployment, including exposed admin ports,
  weak operator secrets, or a database reachable from the internet;
- denial of service without a concrete, low-cost reproduction;
- social engineering, physical access, and spam;
- reports about missing headers or best practices with no demonstrated impact.

## Our process

- We acknowledge a complete report within 3 business days.
- We triage severity and affected versions within 7 business days.
- We aim to ship a fix or mitigation within 90 days, and we coordinate the
  disclosure date with the reporter.
- We credit reporters in the advisory unless they prefer to stay anonymous.

We do not operate a paid bug bounty.

## Safe harbor

We will not pursue legal action against researchers who:

- test only against their own deployment or a disposable test instance;
- avoid accessing, modifying, or exfiltrating data that is not theirs;
- stop as soon as they confirm a vulnerability and report it privately;
- give us reasonable time to fix the issue before public disclosure.

This policy does not authorize testing against third-party deployments or any
service you do not own.
