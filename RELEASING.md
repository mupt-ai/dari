# Releasing

This repository is published from the private Dari monorepo, where it lives
under `dari/`. One tag releases everything at one version.

1. Merge the change into the monorepo's `main` branch.
2. Publish a normal Dari Mono release, `vX.Y.Z`. Its **Deploy Prod** workflow
   pushes the tag here, and **Mirror public packages** updates `main`.
3. The tag runs [`release.yml`](.github/workflows/release.yml):
   - **binaries** compiles the gateway for macOS and Linux (arm64, x86_64),
     smoke-tests the Linux build, and runs GoReleaser, which publishes one
     GitHub release with the `dari` CLI archives, the `dari-gateway` archives,
     one checksum file covering both, and `install.sh`. (CLIs from before the
     repository merge verify `dari update` with the release's only checksum
     file, so keep it single.)
   - **npm** publishes `@mupt-ai/dari-router`, then `@mupt-ai/dari-gateway`
     pinned to that exact router version. A version already on npm is
     skipped, so re-running a release is safe.
   - **image** pushes `ghcr.io/mupt-ai/dari-gateway:vX.Y.Z` and `:latest`.

`scripts/set-version.ts` applies the tag's version to both packages at release
time; the committed manifests stay at `0.0.0-dev` and depend on each other
through the workspace.

The CLI downloads the gateway from its own release, so a CLI and the gateway it
installs always share a version.

## One-time setup

- npm trusted publishing: each package's trusted publisher is repository
  `mupt-ai/dari`, workflow `release.yml`. No long-lived npm token is used.
- GitHub Container Registry: the `dari-gateway` package grants this
  repository write access (Package settings → Manage Actions access).

npm versions are immutable; consumers should adopt a version only after it is
published.
