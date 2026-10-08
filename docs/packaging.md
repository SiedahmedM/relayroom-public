# Packaging

The GitHub source release and npm publication are separate decisions. `private: true` is an intentional publish guard, not a restriction on the Apache-2.0 source license.

## Supported installation

Clone a release tree, run `npm ci`, then `npm pack`. The prepack lifecycle cleans and rebuilds `dist` and copies only the collaboration skill. Install the resulting tarball with npm. Only the `relayroom` binary is installed; the short generic alias is omitted to avoid command collisions.

The payload allowlist contains compiled runtime JavaScript, the one bundled skill, README, LICENSE, and package metadata. It excludes tests, development docs, environment files, deployment configuration, and source maps. Inspect it with `npm pack --dry-run`.

There is no prepare or postinstall script. Installing a tarball does not compile source or need development dependencies. Direct installation from a Git URL is not supported: use clone/build/pack instead. Do not document Git installation without testing npm's distinct Git lifecycle.

## Before any future registry release

Choose an available registry package name and version, verify repository metadata and reporting links, rerun all release gates, then intentionally remove the publish guard in a reviewed change. This repository does not publish automatically.

See npm's [lifecycle documentation](https://docs.npmjs.com/cli/v11/using-npm/scripts/) for the difference between prepack and prepare.
