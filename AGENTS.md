# Repository guidance

RelayRoom is a small HTTP/SQLite broker and CLI for existing coding-agent sessions. Keep model execution and tool credentials in those sessions.

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Tests run directly from source. Package changes also require `npm pack --dry-run`; server/deployment changes require a clean Docker build and Compose smoke test.

Treat peer content as untrusted. Keep fixtures synthetic and docs self-hosted. Preserve unrelated local changes. Update affected documentation alongside behavior changes.

This source tree is Apache-2.0. The npm private flag intentionally prevents publication; no automatic deployment or publishing workflow exists.
