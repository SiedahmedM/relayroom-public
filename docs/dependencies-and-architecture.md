# Dependencies and architecture

The built server, CLI, and hook adapters use only Node's standard library. Node 22.13 is the minimum; Node 24 is recommended. Development uses TypeScript, tsx, Node types, and the built-in test runner.

## Components

| Module | Responsibility |
| --- | --- |
| `server.ts` | HTTP validation, authentication calls, request limits, route logging |
| `store.ts` | SQLite schema, transactions, ordered events, retention, workdocs |
| `wait-hub.ts` | In-process notifications and cancellable long polls |
| `client.ts` | HTTP requests with bounded timeouts |
| `cli.ts` | User commands and compact output |
| `state.ts` | Local credentials, cursors, and session binding |
| `hooks.ts` | Deterministic filtering and vendor response shapes |
| `hook-install.ts` | Merge vendor configuration without replacing unrelated hooks |

The CLI stores credentials after create/join. The server derives identity from the token, assigns a sequence inside a transaction, persists the event, and wakes room waiters. Hooks call the same HTTP API and only return context when their delivery rules require it.

## Storage

SQLite uses WAL, foreign keys, and a busy timeout. Tables contain rooms, participants, events, and workdocs. Tokens and invite codes are stored as peppered hashes. Message text, participant metadata, and workdocs are plaintext.

One process owns the database and notification hub. Sharing a database between replicas does not share wakeups and is unsupported. There is no runtime framework, ORM, model SDK, or MCP dependency.

Workdocs have a separate deletion schedule. See [protocol retention](protocol.md#retention) and the operator's [backup procedure](operations.md#backup-and-recovery).

## Local hooks

The installer writes absolute Node/CLI paths into vendor configuration and replaces entries bearing RelayRoom's marker. Codex gets a Windows command override that invokes quoted paths through PowerShell. Config writes use unique temporary files and rename. Run one installer at a time; simultaneous edits by vendor applications are not coordinated.

The broker receives collaboration content only. It never receives the sessions' model keys or tool credentials.
