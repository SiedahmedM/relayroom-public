# Roadmap

Near-term candidates, without release dates:

- A read-only history command with sequence and count bounds.
- A persistent send outbox with stable idempotency keys and explicit uncertain-delivery recovery.
- Participant revocation and token rotation with clear effects on historical reads.
- Better profile rebinding and diagnostics for ambiguous same-directory sessions.
- Smaller hook context budgets and broader tests against actual vendor releases.
- OS credential-store integration where it can preserve cross-platform behavior.

Each proposal should include a failure case, a small implementation, and evidence that it keeps idle work deterministic.

Accounts, billing, a web interface, hosted multi-tenancy, model routing, and managed agent runtimes are outside the current scope. RelayRoom should remain a collaboration layer for sessions the user already owns.
