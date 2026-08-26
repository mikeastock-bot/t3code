# Custom nightly builds

This fork rebuilds each upstream T3 Code nightly with our patches, then publishes
desktop installers and a CLI tarball to this repository's GitHub Releases.

The workflow is [`.github/workflows/custom-nightly-release.yml`](../../.github/workflows/custom-nightly-release.yml).
It is modeled on [Fenris159's custom Windows nightly](https://github.com/Fenris159/t3code/blob/main/.github/workflows/custom-nightly-release.yml),
with Linux, macOS, Windows, and the background-service daemon added.

## What it does

Every hour, and on manual dispatch:

1. Fast-forwards fork `main` from `pingdotgg/t3code`.
2. Resolves the latest upstream nightly tag, or the tag you pass in.
3. Merges `PATCH_BRANCHES` onto that tag and force-pushes `custom-release`.
4. Builds unsigned desktop artifacts:
   - macOS arm64 DMG
   - Linux x64 AppImage
   - Windows x64 NSIS
5. Packs the `t3` CLI as `t3-<version>.tgz`.
6. Publishes a GitHub prerelease. The custom version is
   `upstream_run * 100 + revision`, so it sorts newer than the upstream nightly
   it was built from.

If that custom tag already exists, the run stops. Dispatch again with a higher
`revision` to rebuild the same upstream nightly.

## Add a custom fix

Keep product fixes on their own branches. Do not commit them to fork `main`.
`main` only carries this workflow, this doc, and the upstream merge.

1. Branch from current `main` (or rebase an existing fix onto it).
2. Land the fix and push the branch to this fork.
3. Add the branch name to `PATCH_BRANCHES` in the workflow, in merge order.
4. Dispatch **Custom nightly**. Use `revision: 2` (or higher) if that upstream
   nightly was already published.

Keep patch branches small and rebase them when upstream moves. The workflow
merges each branch onto the upstream nightly tag; a branch that also contains
all of `main` will drag those extra commits into the custom build.

The default patch, `custom/github-release-cli`, is required. It packs the CLI
tarball and makes the daemon install that tarball from this fork's releases
instead of looking for `t3@version` on npm.

## Consume a build

### Desktop

Install the custom build once from
[this fork's Releases](https://github.com/mikeastock-bot/t3code/releases).
`T3CODE_DESKTOP_UPDATE_REPOSITORY` is baked in at package time, so later
nightlies come from this fork. Stay on the nightly update channel.

These artifacts are unsigned. Linux AppImage updates normally. Windows will
trip SmartScreen. macOS needs a right-click Open on first launch, and
electron-updater on Mac usually wants a signed build, so treat the Mac app as
a manual install.

### Daemon

The official `t3` package on npm does not contain these versions. First switch
from an official service install with the tarball URL from the release:

```sh
npx --yes t3@https://github.com/mikeastock-bot/t3code/releases/download/vVERSION/t3-VERSION.tgz service update
```

Replace `VERSION` with the custom version, for example
`0.0.34-nightly.20260826.118201`. That custom CLI bakes
`T3CODE_CLI_UPDATE_REPOSITORY`, so later in-app **Update server** actions
install the next tarball from this fork.

`npx t3@latest service update` goes back to official npm and should not be used
on a machine that should stay on this channel.
