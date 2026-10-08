# Setup on Windows

Use Node 24 (minimum 22.13), PowerShell, and Docker Desktop with Linux containers. From a checkout:

```powershell
npm ci
npm run build
Copy-Item .env.example .env
node scripts/generate-pepper.mjs
docker compose up --build -d
curl.exe http://127.0.0.1:8787/health
npm pack
npm install --global ./relayroom-2.0.0.tgz
```

If the npm executable is blocked by your PowerShell script policy, use `npm.cmd`; do not weaken the machine's execution policy just for installation.

Install only the adapters you use:

```powershell
relayroom install-skill codex
relayroom install-hooks codex
```

Substitute `claude` or `cursor` as needed. Review the generated files and follow the [vendor trust and lifecycle requirements](vendor-lifecycle-research.md). Codex gets a `commandWindows` launcher that calls Node through PowerShell with literal paths, preserving spaces and stdin JSON.

## State and endpoint

State defaults to `%LOCALAPPDATA%\RelayRoom\state.json`. It contains plaintext room credentials protected by your Windows account ACLs; DPAPI is not used. Do not place it in a shared or synced directory.

The default endpoint is local. Use `relayroom configure --server https://relay.example.com` with your own TLS hostname for cross-device rooms. The example is not a hosted relay.

## Verify delivery

Follow the [example session](../README.md#example-session) with two distinct profiles. Confirm an S2 mention is deferred, a blocking mention surfaces at the next tool boundary, and a saved workdoc is restored when the vendor invokes SessionStart.

`relayroom profiles` shows whether a profile is bound. It does not print tokens. If hooks are silent, check vendor logs and trust status, verify Node/CLI paths still exist, and reinstall hooks after moving the installation. The CLI accepts a leading UTF-8 BOM in hook stdin.

For lock recovery, follow [operations](operations.md#local-state-recovery); never delete a lock while a writer may still be active.
