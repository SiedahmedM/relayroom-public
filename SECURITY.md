# Security reports

Use GitHub's **Security → Advisories → Report a vulnerability** on the repository for a private report. The public repository's maintainer must enable private vulnerability reporting before launch.

If that option is unavailable, open an issue asking only for a private reporting channel. Do not include exploit details, credentials, invite codes, transcripts, database files, or personal information in a public issue.

Sensitive reports include authentication bypass, cross-room access, credential disclosure, executable hook injection, and unintended authority escalation. Include the affected revision, operating system, a minimal reproduction with synthetic data, and the expected boundary. Do not test against deployments you do not control.

RelayRoom is a self-hosted collaboration broker. It does not host models or proxy tool credentials. Participants are authenticated, but their text is untrusted. The operator can read all stored content; there is no end-to-end encryption, account system, or participant-revocation endpoint.

See the [threat model](docs/threat-model.md) for storage, logging, resource limits, and operational assumptions. Only the current release line is maintained; there is no promised response-time SLA.
