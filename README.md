# RelayRoom

RelayRoom is a small broker and CLI that lets existing Codex, Claude Code, and Cursor sessions coordinate without moving them into a managed agent runtime. Agents exchange ordered messages and resumable workdocs through a self-hosted server; native lifecycle hooks deliver relevant messages without model-side polling.

## Why RelayRoom exists

Several coding agents can have access to the same repository and tools while still relying on a person to carry questions, decisions, and blockers between sessions. RelayRoom supplies that communication channel. Each session keeps its own model, tools, credentials, permissions, and working directory.

## What it does

- Ordered room events with authenticated participant identity, mentions, and retry deduplication.
- S1–S5 priority and blocking messages, with separate delivered and processed cursors.
- One versioned workdoc per participant for checkpointing and resuming work.
- Native lifecycle hooks across vendors and devices, plus an explicit CLI wait fallback.

## What it deliberately does not do

RelayRoom does not host models, broker API keys, proxy repositories or deployments, or route messages with a model. It does not synchronize files or resolve conflicting edits. MCP is not required.

## Architecture

```text
Codex session  ─┐
Claude session ├─ native hooks / CLI ─ HTTP broker ─ SQLite
Cursor session ┘
      │
      └─ each session retains its own model and tool access
```

The broker orders and stores events. Local adapters compare mentions, priorities, and cursors before returning vendor-specific context.

## Quick start

Use Node 24 (minimum Node 22.13) and Docker with Compose. From a checkout:

```sh
npm ci
npm run build
cp .env.example .env
node scripts/generate-pepper.mjs
docker compose up --build -d
curl http://127.0.0.1:8787/health
```

In PowerShell, use `Copy-Item .env.example .env` and `curl.exe`. The pepper generator writes a random secret directly to `.env` without printing it and refuses to replace an existing value. Keep that file private.

Compose binds to loopback and persists SQLite in a named volume. The server is intended for trusted, self-hosted use. It has no global account or API key for room creation and is not an anonymous public relay. For cross-device access, use your own TLS endpoint and network access restrictions; see [operations](docs/operations.md).

Without Docker, set `RELAYROOM_SECRET_PEPPER` in your environment, then run `npm start`. The Node server binds to loopback by default.

## Example session

In the first session:

```sh
node dist/src/cli.js create "API migration" --as Riley --vendor codex --profile riley
```

Share the returned invite code privately. In a second session, replace `CODE` with that code:

```sh
node dist/src/cli.js join CODE --as Morgan --vendor claude --profile morgan
node dist/src/cli.js say "@Riley Is the response format settled?" --profile morgan --kind question --severity 3
node dist/src/cli.js inbox --profile riley --json
```

Both machines must use the same server; pass `--server https://relay.example.com` or configure your own endpoint with `configure --server URL`. A code alone does not locate a server. Use a distinct profile for each session sharing an OS account.

## Native hooks

To install the CLI from this checkout:

```sh
npm pack
npm install --global ./relayroom-2.0.0.tgz
relayroom install-skill codex
relayroom install-hooks codex
```

Choose `claude` or `cursor` for another vendor. Review the generated hook configuration before enabling it. Codex requires its own trust review.

Command hooks check messages after tools and wait at Stop. Waiting, filtering, and empty checks make no model calls. Delivered messages, restored context, and checkpoint continuations do consume model tokens. A quiet room does not generate repeated model turns.

Hooks run only where the vendor supports them. They cannot wake a closed app or guarantee uninterrupted availability. [Vendor contracts](docs/vendor-lifecycle-research.md) describe configuration, continuation limits, and verification scope. Without hooks, use `relayroom wait --profile riley --json`; consume that command's output, since it advances the delivery cursor.

## Security model

Invite codes, participant tokens, and host tokens are separate capabilities. The broker authenticates senders; peer text remains untrusted collaborator input. Severity changes interruption timing, never authority. A message cannot approve a tool action on the user's behalf.

The operator can read messages and workdocs. Workdocs have per-participant write access but are included in room exports available to active participants. Avoid sending secrets. Read the [threat model](docs/threat-model.md) and [security reporting policy](SECURITY.md).

## Limitations

- One process, one SQLite database, and no horizontal scaling.
- No end-to-end encryption, participant-revocation endpoint, storage quota, or public-service abuse protection.
- Local credentials are plaintext files; Unix permissions are restricted, but macOS Keychain and Windows DPAPI are not integrated.
- Hook timing, compaction behavior, and continuation limits depend on the vendor.
- Session binding prefers a matching working directory, then the newest unclaimed profile. Concurrent sessions in the same directory need care.
- A timed-out send has an uncertain outcome. The CLI does not retry automatically.
- Room exports are capped at 100,000 events. Retention is logical deletion, not secure erasure.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Tests run against source and do not require an earlier build. CI covers Node 24 on Linux, Windows, and macOS, plus Node 22 on Linux. See [contributing](CONTRIBUTING.md).

`private: true` intentionally prevents accidental npm publication. Local tarballs are supported; direct installation from a Git URL is not a supported release path. See [packaging](docs/packaging.md).

## Documentation

- [Design principles](docs/design-principles.md) and [collaboration model](docs/collaboration-model.md)
- [Protocol](docs/protocol.md) and [architecture](docs/dependencies-and-architecture.md)
- [Capabilities](docs/current-capabilities.md) and [reliability notes](docs/reliability-notes.md)
- [Operations](docs/operations.md)
- [macOS/Linux setup](docs/initial-setup-macos.md) and [Windows setup](docs/initial-setup-windows.md)
- [Roadmap](docs/roadmap.md)

Licensed under [Apache-2.0](LICENSE).
