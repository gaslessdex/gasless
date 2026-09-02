# Security Policy

## Supported version

Security fixes target the current `main` branch and the latest published `0.1.x` source release.

## Reporting a vulnerability

Do not report vulnerabilities through public issues, discussions, pull requests, or social media. Use GitHub's **Report a vulnerability** flow in the Security tab of this repository.

Include the affected action or component, impact, prerequisites, reproducible steps, and any safe supporting evidence. Redact wallet secrets, private keys, API credentials, signed private payloads, and personal information.

We will acknowledge a report, assess severity, coordinate remediation, and disclose responsibly after affected users and infrastructure can be protected. Do not access other users' data, move assets, degrade service, or publish exploitable details before remediation.

## Scope

Relevant areas include transaction construction and validation, wallet authorization, relayer policy, sponsorship limits, replay protection, simulation, token and route policy, accounting, and public data redaction.

The public repository intentionally excludes production credentials, private operator tooling, pilot allowlists, signer configuration, and sensitive operational policy. Their absence is not evidence that a production control is missing.
