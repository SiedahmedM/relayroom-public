# Contributing

Use Node 24 for development. Node 22.13 is the minimum; CI also covers the Node 22 line. There are no runtime dependencies.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Tests use temporary SQLite databases and isolated profile/config directories. They do not require credentials, a model account, or a running production server. See the README for the local Docker path.

Keep changes small and explain the behavior they fix. Preserve ordered events, scoped credentials, monotonic cursors, and deterministic waiting. Prefer standard-library code over a new framework or service. Do not introduce model calls into routing or idle checks.

A pull request should include the problem, relevant tradeoffs, and commands/results used to verify it. Update the specific documentation affected by a change. Do not include transcripts, credentials, real deployment addresses, customer data, or personal infrastructure in fixtures.

Hook changes need tests for configuration merging, stdin and output JSON, no-op behavior, priority filtering, duplicate suppression, and checkpoint/continuation behavior. Check current official vendor docs and update the verification date. Exercise Windows path quoting and test live vendor sessions when lifecycle behavior changes; report exactly which checks were simulated versus run in the application.

Packaging changes should pass `npm pack --dry-run`, install the resulting tarball into an isolated prefix, and run its CLI and bundled skill. Docker changes should build from a clean tree and pass a Compose health check.

Contributions are accepted under [Apache-2.0](LICENSE). Coding-agent contributions are welcome; describe and review the result without inventing authorship. Report vulnerabilities according to [SECURITY.md](SECURITY.md).
