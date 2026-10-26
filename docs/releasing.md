# Releasing

Depos is published by the Release workflow, never from a laptop. Merging a pull
request publishes nothing; a release is a button. The run raises the version,
names the CHANGELOG's "Unreleased" section, runs the whole test suite, builds one
VS Code VSIX, one JetBrains plugin zip and one Visual Studio VSIX, pushes the
version commit and its tag to `main`, sends the VS Code VSIX to the VS Code area
of the Visual Studio Marketplace and to Open VSX, submits the zip to the
JetBrains Marketplace, sends the Visual Studio VSIX to the Visual Studio area of
the same Marketplace, and attaches all three to a GitHub Release.

The JetBrains plugin takes its version from `package.json` and its change notes
from the CHANGELOG section of that version (`jetbrains/build.gradle.kts`); the
Visual Studio extension takes the same version (`Depos.VisualStudio.csproj`)
and links to the CHANGELOG. One version number and one set of notes serve every
registry. The JetBrains Marketplace lists a version only after its own review,
normally within two business days; the run does not wait for that.

The Visual Studio VSIX, `depos-visualstudio.vsix` for Visual Studio 2022 and
newer, builds and publishes only on Windows, so the workflow is four jobs:
`version` decides the version and the notes; `visualstudio` builds and tests the
Visual Studio VSIX from them and checks it with `visualstudio/verify-vsix.ps1`;
`release` tests and builds the rest, pushes the commit and the tag and publishes;
`visualstudio-publish` then sends the VSIX with VsixPublisher. Its listing,
`kontra.depos-visualstudio`, is an item of its own under the same publisher as
the VS Code extension, `kontra.pacmon`; the listing page and its categories are
in `visualstudio/marketplace/`. The workflow publishes every version, the first
included: unlike JetBrains, the Visual Studio Marketplace creates the listing on
the first upload. The VSIX identity is `dev.depos.visualstudio`, and its
publisher must stay `Kontra`, the display name of the Marketplace publisher —
VsixPublisher refuses anything else, and `verify-vsix.ps1` checks it on every
CI run.

## One-time setup

Repository → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Where it comes from |
|---|---|
| `VSCE_PAT` | Azure DevOps personal access token for the `kontra` publisher: https://dev.azure.com → User settings → Personal access tokens. Organization "All accessible organizations", scope Marketplace → **Manage**. It publishes both the VS Code extension and the Visual Studio extension. Azure DevOps caps the lifetime at one year, so note the expiry — and it retires these global tokens on 1 December 2026, whatever their expiry, after which the Marketplace needs Microsoft Entra ID instead. |
| `OVSX_PAT` | Open VSX access token: https://open-vsx.org/user-settings/tokens. Publishing also needs the `kontra` namespace, created once with `pnpm exec ovsx create-namespace kontra -p <token>`. It already exists. |
| `JETBRAINS_TOKEN` | JetBrains Marketplace permanent token: https://plugins.jetbrains.com → your profile → **My Tokens** → Generate Token. The plugin is `dev.pacmon.jetbrains`, Marketplace id 34295, under the `Kontra` vendor, and its first version was uploaded by hand, as the Marketplace requires; the workflow only ever uploads the next ones. |

Who may release is an allowlist in the workflow's first step — currently
`yavuzatlas` and `yavuzatlas-kontra`. Anyone else with write access can press the
button, but the run stops there, before anything is built or published. Add an
account by editing that line.

The `kontra` namespace on Open VSX is **unverified**: the account that created it
holds contributor access, not ownership, and the extension page carries no
publisher badge. Ownership is granted on request — open a namespace claim at
https://github.com/EclipseFdn/open-vsx.org/issues. Worth doing for a name the
trademark policy reserves.

## Every release

1. **As work lands:** put anything a user would notice under `## Unreleased` in
   `CHANGELOG.md`, in the same pull request. That text becomes the release notes.
2. **To release:** Actions → Release → Run workflow → pick `patch`, `minor` or
   `major` → Run.

That is the whole ritual. The run refuses to publish if the "Unreleased" section
is empty, and every test runs against the tree that actually ships.

## When something goes wrong

- **A test fails.** Nothing was published and nothing was committed. Fix it on
  `main` and press the button again.
- **A publish step fails** (an expired token, a registry outage). Replace the
  secret, then **Re-run failed jobs** on that run. The version is not raised a
  second time: the run checks out the same commit, sees its tag already on the
  remote, and skips the commit. A registry that already has the version skips it,
  so only the missing one goes out.
- **The push is rejected** because `main` moved after the button was pressed.
  Nothing was published. Press the button again.
- **A mistake is found after publishing.** A version number is spent the moment a
  registry accepts it. It ships as the next patch version; nothing is re-published.
- **A registry did not get the version** — it joined after the release, or its
  step never ran. Actions → Release → Run workflow → `none`. The run publishes
  the version already in `package.json` to whichever registry lacks it, skips
  the ones that have it, commits nothing, and refuses a version that was never
  released.
- **JetBrains has not listed the version yet.** That is the review, not a
  failure: the run ends when the upload is accepted, and the Marketplace lists
  the version once a person at JetBrains has approved it, normally within two
  business days. The vendor's e-mail gets the verdict; a rejection names what
  to change, and the fix ships as the next patch version.

## Releasing without the button

A tag pushed by hand releases the version already in `package.json`, whose
CHANGELOG section must already exist. This path skips the version bump entirely:

```sh
git tag -a v0.1.1 -m v0.1.1 && git push origin v0.1.1
```

## Publishing by hand

Every published version is a release; there is no pre-release channel. To
publish from a machine, build with `pnpm run package` and then, with
`VSCE_PAT` and `OVSX_PAT` set in the environment:

```sh
pnpm exec vsce publish --packagePath pacmon-X.Y.Z.vsix
pnpm exec ovsx publish --packagePath pacmon-X.Y.Z.vsix
```

The JetBrains plugin, from `jetbrains/`, with `JETBRAINS_TOKEN` set: the version
and the change notes come from `package.json` and `CHANGELOG.md`, so they must
already say what is being published.

```sh
./gradlew publishPlugin
```

The Visual Studio extension, on Windows, with the same token as `VSCE_PAT`.
VsixPublisher is `tools\vssdk\bin\VsixPublisher.exe` in the
`Microsoft.VSSDK.BuildTools` NuGet package, 18.9 or newer, or
`VSSDK\VisualStudioIntegration\Tools\Bin\VsixPublisher.exe` in a Visual Studio
installation. Unlike the other registries, the Visual Studio Marketplace
replaces a version it already has instead of refusing it, so check the listing
first.

```sh
msbuild visualstudio/Depos.VisualStudio/Depos.VisualStudio.csproj /restore /t:Build /p:Configuration=Release /p:DeployExtension=false /p:CreateVsixContainer=true
VsixPublisher.exe publish -payload visualstudio/Depos.VisualStudio/bin/Release/net472/depos-visualstudio.vsix -publishManifest visualstudio/marketplace/publishManifest.json -personalAccessToken <token>
```
