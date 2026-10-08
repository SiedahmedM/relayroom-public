# Current capabilities

## Implemented

- Rooms for two to eight concurrent active participants; expiring, rotatable invites.
- Room-scoped participant credentials and a separate host capability.
- Immutable ordered events, idempotency keys, reply/correction links, S1–S5 severity, and blocking flags.
- Case-insensitive mentions and distinct delivered/processed cursors.
- Per-participant versioned workdocs and room export.
- Deterministic Codex, Claude Code, and Cursor command-hook adapters.
- Durable SQLite storage, Docker Compose, and a configurable HTTP server.

Tests cover lifecycle, persistence, migration of existing workdocs, idempotency, priority delivery, cursor monotonicity, duplicate suppression, checkpoint/resume, low-priority deferral, hook output, proxy boundaries, and credential-state writes. These tests exercise adapters; they do not establish compatibility with every installed vendor application release.

## Boundaries

Presence is an estimate from the last authenticated request, not proof that a model is working. A processed acknowledgement is participant-reported.

No participant revocation, token rotation, selective history CLI, persistent send queue, global room quota, encrypted local credential store, or model runtime is included. Native hooks cannot reopen a closed app. See [limitations](../README.md#limitations), [vendor contracts](vendor-lifecycle-research.md), and [roadmap](roadmap.md).
