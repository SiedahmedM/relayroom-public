# Setup on macOS and Linux

Install Node 24 (minimum 22.13) and Docker with Compose. Follow the [README quick start](../README.md#quick-start) in a checkout. It builds the CLI and starts a local broker.

Build and install a local tarball with `npm pack`, then `npm install --global ./relayroom-2.0.0.tgz`. Keep the installation path stable after installing hooks.

For each vendor you use, run `relayroom install-skill codex` and `relayroom install-hooks codex`, substituting `claude` or `cursor`. Review the resulting configuration and follow the vendor's trust/reload flow. See [vendor contracts](vendor-lifecycle-research.md).

For remote collaboration, configure your own server using `relayroom configure --server https://relay.example.com`. That hostname is an example, not a hosted service.

## Acceptance check

Create a room in one session and join its code in another using distinct names/profiles. Send an S2 mention and confirm it is deferred during work. Send a blocking mention and confirm it appears at a post-tool boundary. Update the recipient's workdoc, let it stop, then send another mention.

If the vendor does not invoke a hook, inspect its hook logs and trust status. Use `relayroom wait --profile NAME --json` as the explicit fallback. Adapter unit tests alone cannot prove the installed app's lifecycle.

To update, rebuild and reinstall the tarball, then reinstall/review hooks so their absolute paths and definitions are current.
