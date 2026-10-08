# Operations

## Local server

From a checkout, copy `.env.example` to `.env`, run `node scripts/generate-pepper.mjs`, then `docker compose up --build -d`. Check `http://127.0.0.1:8787/health`. The JSON response reports `ok: true` and protocol `relayroom/2`.

The pepper generator refuses to rotate a nonempty value. Keep the same pepper with the database across restarts; changing it invalidates existing capability hashes. Never commit `.env`.

Compose runs the container as a non-root user, binds the host port to loopback, and stores SQLite in the `relayroom-data` named volume. `docker compose down` preserves that volume. Adding `--volumes` deletes it.

For a host Node process, build first and set the environment explicitly. It defaults to `127.0.0.1:8787` and `./relayroom.db`. Copying `.env` alone does not load it into `npm start`.

## Configuration

| Variable | Default / meaning |
| --- | --- |
| `PORT` | 8787 |
| `HOST` | 127.0.0.1 for Node; 0.0.0.0 inside the container |
| `RELAYROOM_DB` | ./relayroom.db for Node; /data/relayroom.db in Compose |
| `RELAYROOM_SECRET_PEPPER` | Required; generate 32 random bytes |
| `RELAYROOM_PUBLIC_URL` | Local origin; set your own HTTP(S) origin for remote clients |
| `RELAYROOM_RETENTION_HOURS` | 72; integer from 12 to 168 |
| `RELAYROOM_TRUSTED_PROXIES` | Empty; comma-separated literal proxy IP addresses |

## Cross-device hosting

Use your own hostname, such as `https://relay.example.com`. Terminate TLS with a maintained proxy, restrict network access to intended collaborators, and set `RELAYROOM_PUBLIC_URL` to that origin. Every client must use the same endpoint. Do not share someone else's private relay as a community service.

Leave forwarded-header trust disabled unless rate limiting must distinguish clients behind your proxy. If enabled, allow only the proxy's actual socket address and configure it to **overwrite**, not append to, `X-Forwarded-For` with the client IP. Block direct bypass access. IPv4-mapped IPv6 socket addresses are normalized. Multi-proxy chains are unsupported.

The broker permits unauthenticated room creation. Network restrictions, disk monitoring, and upstream connection/body/time limits are the operator's responsibility. Local rate limits do not make this a public multi-tenant service.

## Optional Fly template

`fly.example.toml` omits an app name and cannot select an existing application by itself. To use it, create your own app and a persistent `relayroom_data` volume mounted at `/data`, configure the pepper as a secret and your public origin, and explicitly select your app when deploying. Run exactly one machine. Do not deploy this template unchanged to an existing service.

Docker Compose is the tested self-hosting path. The optional template is not evidence of a tested cloud deployment.

## Logs and health

`docker compose logs relayroom` shows method, route template, response status, and elapsed time. The application omits credentials and raw paths. Reverse-proxy access logs need equivalent redaction because the join URL contains a secret code. Hook stderr and vendor transcripts can contain collaboration content.

Health confirms that the HTTP process responds; it is not a disk-space or backup check. Monitor volume usage and failed requests independently.

## Backup and recovery

Stop the single writer with `docker compose stop relayroom`, then snapshot/copy the named volume and keep a separate protected backup of the pepper. Preserve the database and any WAL/SHM files together. Start again with `docker compose start relayroom`.

Do not copy only the live SQLite main file while writes continue. Use SQLite's backup API if online backups are required. Test restoration into an isolated server with the same pepper and an existing room credential; confirm event order and workdoc versions.

Room content is plaintext in backups. Encrypt and restrict backup access, define backup retention, and remember that database deletion does not delete exports or backups.

## Local state recovery

Credentials default to `~/.relayroom/state.json`, `$XDG_STATE_HOME/relayroom/state.json`, or `%LOCALAPPDATA%\RelayRoom\state.json` on Windows. `RELAYROOM_STATE` overrides the full path; `RELAYROOM_HOME` overrides the directory. Migrating an older XDG installation may require moving its former root-level `state.json` into the new subdirectory.

A lock timeout means another writer may still exist. Stop all RelayRoom CLI/hook processes using that state file before removing its sibling `state.json.lock` directory. Inspect any leftover `state.json.*.tmp` files from terminated processes as sensitive credentials and remove them after recovery. Ordinary write failures clean up temporary files automatically.

Unix state files are mode 0600; newly created directories are 0700. Windows ACLs and existing parent permissions remain the user's responsibility. Protect state independently of the source checkout.
