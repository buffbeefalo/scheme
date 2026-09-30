# Publish a reviewed release

[Home](README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

This guide is for someone preparing a release. It is not needed to use Scheme. This repository is a standalone source tree; no other repository or personal service configuration is needed to reproduce it.

The runtime uses `server.js`, `lib/`, `public/`, and `bin/`. The remaining files are documentation, tests, and release checks. Historical `COMMAND_DECK_` names remain for compatibility. The browser client is based on the existing standalone source, with generic examples and a generic display fallback; the xterm bundle is unchanged. No other repository must remain in sync.

The separate `site/` directory presents Scheme and its films. It is a static website, not another installation of the runtime. Its build copies an explicit list of public presentation files; it never copies the Scheme server, runtime configuration, terminal history, or project folders.

## Software version and media provenance

`package.json` is the software-version authority. The current patch is **v1.1.1**. Keep current README/download links, setup folder examples, and the intended release tag consistent with it. The site renders its `softwareTag` template token from that package version, so its current source, guide, and ZIP links come from the same release. `check:release` rejects conflicting software links, labels, clone examples, or extracted-folder names.

The existing **v1.1.0** references have two separate historical purposes: the original manual setup/continuity validation, and the fixed provenance of the three narrated films with their captions/transcripts. Their tag and reviewed bytes remain unchanged. Those films demonstrate the earlier runtime and do not certify the later repaired code. The new silent preview assets are independently pinned to v1.1.1; that media pin is also provenance, not a setting to advance automatically for each software version. Regression-test fixtures may deliberately use older versions to prove that stale references or deployments are refused.

## Local checks

Run from a clean Scheme source directory with Node.js 22+ and tmux:

```bash
npm test
npm run check:release
```

The release check walks the actual filesystem, including hidden, ignored, and untracked entries. Only root Git metadata (`.git`) is excluded. It compares against the reviewed file list in `release-files.json`, rejects runtime files and symlinks, checks UTF-8 text, checks local Markdown links and software-version references, flags non-example home paths and a small set of credential shapes, and verifies the existing xterm bundle hash. Individually inspected demonstration PNGs under `docs/images/` are pinned by filename, signature, and exact hash; no other binary files are allowed. It does not read or print the contents of unexpected files.

A new or changed manifest entry needs a content review. Never regenerate the file list from everything currently on disk merely to make the check pass. Do not keep test output, scanner reports, agent state, or personal/live screenshots in the release folder. Store reports outside it. Approved demonstration screenshots use entirely fictional data and need a fresh visual and metadata review whenever their bytes change.

For extra **Shell-only** terminal verification on Linux, this keeps test state and the tmux server separate from normal sessions:

```bash
scheme_test_dir=$(mktemp -d)
mkdir -p "$scheme_test_dir/home" "$scheme_test_dir/tmux"
env -i PATH="$PATH" HOME="$scheme_test_dir/home" TMPDIR="$scheme_test_dir" TMUX_TMPDIR="$scheme_test_dir/tmux" \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 SYSMON_INTEGRATION=1 \
  node --test test/shelltab.test.js test/scrollmode.test.js
```

Keep the temporary directory until you have checked the result and ended any sessions the tests left behind. This command deliberately selects Shell and scroll tests; enabling every opt-in integration test can involve agent launch paths.

## Optional browser and fish checks

The browser regression suites use the shipped interface with fictional endpoints on a temporary loopback server. They do not connect to a real Scheme session or a signed-in AI tool. Use a separate Playwright installation with its compatible Chromium browser, kept outside the release folder:

```bash
SCHEME_BROWSER_TESTS=1 SCHEME_PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
  node --test test/frontend-regressions.test.js test/workspace-browser.test.js
```

If needed, set `SCHEME_CHROMIUM_EXECUTABLE` to an existing compatible Chromium executable. These are interface checks, not validation of physical phones, native Safari, or the public films' video codec support. Without `SCHEME_BROWSER_TESTS=1`, both browser suites report a skip.

The prompt-quoting regression always checks sh and Bash. Include an installed fish executable explicitly to check fish as well:

```bash
SCHEME_TEST_FISH=/path/to/fish node --test test/reported-server-regressions.test.js
```

Without that variable, the quoting test still passes or fails for sh and Bash; its result does not establish fish coverage. The same variables can be supplied to `npm test` to include these checks in the full suite. Keep test output and any `SCHEME_UI_SCREENSHOTS` directory outside the source tree.

## Scan both files and history

Install [Gitleaks](https://github.com/gitleaks/gitleaks#installing) separately; it is a maintainer tool, not a runtime dependency. The configuration uses rule-scoped allowlists supported by Gitleaks 8.21+. The release configuration is checked with 8.30.1.

Run a working-tree scan, then a scan of **all local Git history**:

```bash
gitleaks dir --redact --config .gitleaks.toml .
gitleaks git --redact --config .gitleaks.toml --log-opts=--all .
```

A ZIP download has no Git history. For the second command, use a full Git clone and fetch the branches and tags that will be released. The scan only covers refs and objects present locally; it cannot clear unknown forks, deleted remote objects, releases, uploads, or files outside the checkout. Review the Git diff and what you actually intend to publish too.

The Gitleaks configuration extends the default rules. It allows the exact known synthetic values or complete fixture lines in the redaction tests and the exact known xterm false positive, each restricted by file and rule. It does not skip either whole file. The Node check uses exact line-hash exceptions only for synthetic redaction examples and the redactor's literal replacement text. There are no whole-file text exemptions.

When changing an exception, inspect the matched content and show that another credential in the same file would still be reported. A secret is never made safe by adding an exclusion: revoke or rotate it and remove it from the material being published.

## What the checks do and do not cover

| Check | Evidence it provides | Limit |
|---|---|---|
| Default `npm test` | Deterministic module behavior and a local server with private test state. | Includes skipped cases; no proof of live AI sign-in, current provider compatibility, or real phone behavior. |
| Opt-in Chromium browser checks | Shipped interface behavior against fictional session endpoints, including the reported browser regressions. | Requires the browser flag and external test tools; does not validate native Safari, physical phones, or film playback. |
| Prompt quoting with fish enabled | Literal launch-prompt arguments survive the tested fish executable as well as sh and Bash. | Fish is exercised only when `SCHEME_TEST_FISH` supplies its executable. |
| Selected Shell/scroll integration | Real tmux session creation, reconnection-related state, and scroll behavior on the tested host. | Does not exercise a paid model or every supported host/browser combination. |
| `npm run check:release` | Reviewed file inventory, runtime-file rejection, known text hazards, local Markdown targets, current software-version references, and pinned xterm bytes. | A small hygiene check, not comprehensive secret detection, external-link testing, or a privacy guarantee. |
| Pages release guard tests | Published-release selection, exact commit/version matching, old or prerelease event refusal, and fresh checks after a simulated deployment wait. | Live GitHub permissions and environment rules still need a hosted run. |
| Working-tree Gitleaks | Known credential patterns in current files under the scanner's rules. | Heuristics can miss unknown formats or sensitive text that is not a credential. |
| Full-history Gitleaks | Those patterns in locally available Git history. | Unavailable refs and external artifacts need their own review. |
| Human content and setup review | Accurate guides, generic examples, understandable steps, and assessment of material the scanners do not understand. | Record which OS, browser, and tool versions were actually exercised. |

The tests and secret-scan workflows run on pushes, pull requests, manual dispatch, and a weekly Monday 09:17 UTC schedule. They use Ubuntu 24.04, immutable action pins, top-level `contents: read` permissions, and checkout with `persist-credentials: false`. The tests workflow uses Node 22 and runs the informational doctor, local release check, and default test suite after installing tmux.

CI installs the official Gitleaks 8.30.1 Linux x64 archive directly and verifies its pinned SHA-256 checksum before extracting or executing the binary. The scanner independently invokes that temporary binary from the checkout root with `git --redact=100 --config .gitleaks.toml --log-opts=--all .` and `dir --redact=100 --config .gitleaks.toml .`. Both scans are attempted after successful installation, even if the history scan fails; either scan failure fails the job. The scanner checkout uses `fetch-depth: 0` without an additional authenticated fetch. History coverage remains limited to locally available refs and objects.

Output from scanner installation and both scans is captured in private temporary runner files, which are removed on exit. It is never uploaded, published as summaries, or posted as comments; the installation-and-scan step prints only generic status messages.

The workflow badges show GitHub's latest reported main-branch results; they can lag and are not publication approval. Verify hosted workflow execution and badge rendering after publishing the reviewed source.

The default suite skips the unavailable `0.144.6 fixture` transcript case by name and leaves opt-in integration cases skipped unless requested.

The [capability guide](CAPABILITIES.md#validation-for-v111) separates the repaired-source baseline from historical Ubuntu ARM64 desktop coverage. Record new checks with their source revision, enabled options, counts, and date; never relabel the older manual tests as a new release validation. macOS and WSL host behavior remain unverified. Resume regression tests do not establish live provider recovery compatibility. A clean scan or passing helper test does not remove those limits.

## Review the three films

The historical v1.1.0 film collection retains exactly these assets:

| Asset | Source location | Published location |
|---|---|---|
| Product film | Reviewed external render directory: `scheme-product.mp4` | Release attachment and same-origin `media/scheme-product.mp4` |
| Setup film | Reviewed external render directory: `scheme-setup.mp4` | Release attachment and same-origin `media/scheme-setup.mp4` |
| Capabilities film | Reviewed external render directory: `scheme-capabilities.mp4` | Release attachment and same-origin `media/scheme-capabilities.mp4` |
| English captions | `site/captions/scheme-product.vtt`, `scheme-setup.vtt`, and `scheme-capabilities.vtt` | Same-origin `captions/` |
| Written transcripts | `site/transcripts/product-transcript.md`, `setup-transcript.md`, and `capabilities-transcript.md` | Inline readable text, standalone HTML pages, and downloadable text |

**Keep MP4s outside Git and outside the source tree.** Caption and transcript text belongs in source control. Use clean demonstration machines and fictional projects. Actual setup footage should show what was exercised; optional account setup must remain visibly unverified if it was not completed. Never film a personal working dashboard or publish raw test machines, accounts, logs, or recordings that have not been reviewed.

Review every final film's picture, narration, captions, and transcript for private content and accurate claims. Inspect the file metadata and confirm the intended video and audio streams with `ffprobe`. Use broadly playable H.264 video, AAC audio, a regular MP4 container, and fast-start metadata. Review representative playback, full narration, end-to-end timing, caption readability, and every visible command; sample images or a text scan alone are not enough. Inspect still images and their metadata too, then update their existing reviewed image hashes only after that review.

`site/media-manifest.json` records the fixed release, nine explicit assets, exact byte sizes and SHA-256 values, final duration/dimensions, and chapter starts. The current record contains the completed film reviews. For future assets, `reviewed: false`, empty hashes, or zero sizes are publication blockers; record final bytes and set `reviewed: true` only after review. Hashes detect later changes but cannot establish that the review happened. Do not rewrite the historical film record merely because the software version changes.

The media checker rejects unknown or missing assets, unexpected files in the media/caption/transcript directories, symlinks, unpinned release metadata, missing review facts, changed hashes or sizes, non-MP4 video headers, invalid WebVTT, and chapters or captions outside the reviewed duration. It streams hashes so large films need not be loaded into memory. It also caps the combined media at 900 MiB. Codec and visual checks remain a separate review step.

```bash
node --test test/media.test.js
node scripts/check-media.js --media-dir /path/to/reviewed-media
```

Changing an asset name, release tag, or asset set is a deliberate contract change: review and update the explicit sets in the manifest, checker, build, and workflow together. Do not replace the checks with a wildcard download or an automatic allowlist of everything found on disk.

## Review the silent website previews

Three short, view-only demonstrations use previously reviewed neutral captures: **Shell (6 seconds), sessions (8 seconds), and phone (15.625 seconds)**. Each has a silent WebM and MP4 copy, a still fallback, and its own pause control. They stop when offscreen or the page is hidden, and respect reduced-motion preferences. Narrated films keep their separate click-to-play controls and captions. The phone footage is browser touch emulation, not a physical-device test.

Keep exactly these six reviewed files in a **separate external preview directory**: `shell-preview-v1.mp4`, `shell-preview-v1.webm`, `sessions-preview-v1.mp4`, `sessions-preview-v1.webm`, `phone-preview-v1.mp4`, and `phone-preview-v1.webm`. `site/preview-manifest.json` pins their filenames, review facts, source provenance, sizes, hashes, and v1.1.1 release location independently of the narrated-film manifest. The checker rejects unexpected files or changed bytes; codec support, actual movement, privacy, and readable content still need playback review.

```bash
node --test test/previews.test.js
node scripts/check-previews.js --preview-dir /path/to/reviewed-previews
```

The website browser checks use an external Playwright installation as described above. Set `SCHEME_BROWSER_TESTS=1`, `SCHEME_PLAYWRIGHT_MODULE` to that installation, and `SCHEME_SITE_DIR` to the completed external static build, then run `node --test test/site-browser.test.js`. Without both the browser flag and a build directory, that suite skips itself. Record checks of all three clips, individual pause, film playback coordination, offscreen/background stopping, reduced motion, failed or blocked autoplay, narrow layouts, and keyboard use. Do not treat a browser without a film codec as proof that the reviewed film bytes are broken.

## Build and preview the public page

After the media check passes, choose a fresh empty output directory **outside the source and render directories**:

```bash
scheme_site_dir=$(mktemp -d)
node scripts/build-site.js --media-dir /path/to/reviewed-media --preview-dir /path/to/reviewed-previews --out "$scheme_site_dir"
python3 -m http.server 8080 --bind 127.0.0.1 --directory "$scheme_site_dir"
```

Open <http://localhost:8080>. The build creates three readable transcript pages and chapter links from reviewed text and timing. The video, captions, and poster files use relative URLs from the same origin, including when hosted at `/scheme/`. A visitor can use native player controls, captions, the chapter links, and transcript text. JavaScript adds seeking within the page and pauses the other films; it does not connect to Scheme or request account access. If JavaScript is unavailable, chapter links open the corresponding video time directly.

Check desktop and narrow screens, keyboard focus, reduced motion, all player error states, caption display, transcript expansion, standalone transcripts, and downloads. Use an HTTP preview: opening the page directly from disk is not the intended caption test. Python's basic server is useful for that page review but does not supply HTTP byte ranges; use a byte-range-capable server or the deployed Pages site for reliable video seeking checks. The browser must also support the reviewed H.264/AAC encoding. Confirm there are no requests to a Scheme API, no sign-in requirement, and no private data in the staged directory. Do not put the build output back into the Git checkout.

## Release and GitHub Pages

The Pages workflow follows [GitHub's custom-workflow deployment model](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). Set the repository's **Settings → Pages → Source** to **GitHub Actions**. The repository's Pages environment currently permits **main only**. After publishing a reviewed stable release, manually run **public-site** from **main**. The run keeps its main workflow identity for that environment, selects [GitHub's latest published full release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release), resolves its tag to a commit, and checks out that exact commit for the build. Main edits are not published until included in a new reviewed release.

Release events are handled explicitly: a **published current stable release** can run the source/media build, but its tag-origin run skips the deployment job because it does not satisfy the main-only environment rule. Old-release and prerelease events fail the guard. Manual runs from tags or other branches also fail. No environment policy is weakened and no release event is silently presented as a deployment.

For a new software release, complete source review, version/link checks, and the tests before creating its tag. Create the release as a draft. Upload only **new reviewed media** needed by its explicit media contracts, then publish it and make it the latest stable release. For v1.1.1 those new attachments are the six named preview files; the three narrated films continue to download from v1.1.0. Later software-only releases do not need copies of unchanged media. Never move a published tag or replace a reviewed attachment in place.

The build verifies package-version/tag agreement, source inventory, the three explicit v1.1.0 films, source-controlled captions/transcripts, and six explicit v1.1.1 preview assets. It stages **28 public files**. The upload action receives only that staging directory. All Pages runs share one serialized concurrency group. Inside the deployment job, **after concurrency and environment waits and immediately before deployment**, the guard asks GitHub again for the current published release and resolved tag commit. A newer release, moved tag, recreated release record, or changed checkout stops the stale build; start a fresh run from main. The final check narrows the publication race but does not lock GitHub releases against changes during the deployment action.

The deployment job alone receives `pages: write` and `id-token: write`; it also has `contents: read` for the exact-commit checkout and final release lookup. The source build has only read permissions. All actions are pinned to commit hashes, checkout does not retain credentials, and GitHub event values are passed as environment data rather than inserted into shell commands. No terminal server runs on Pages.

After deployment, verify the public page anonymously. Play the three previews and all three films, seek chapters, display captions, read the transcripts, follow source/setup links, and confirm current release downloads. Check the published archive against the reviewed inventory, install it in a fresh location, and repeat the doctor and Shell test. Exercise both [Git and ZIP updates](INSTALL-HOST.md#updating) on disposable installations, preserving external state, project data, settings, and the existing tmux session. For services, confirm whether the definition was retained or deliberately regenerated from the recorded environment. A successful local build does not establish public availability or upgrade behavior.

## Before changing visibility or uploading a release

Complete both the hosted-history review and the external-media review before changing visibility or uploading a release.

Confirm the reviewed source, final Git history, documentation links, dependency/vendor provenance, license, and test record. Check the archive's actual file inventory separately if you assemble it outside GitHub's source archive flow. Keep personal applications, projects, credentials, config files, conversation transcripts, logs, uploads, and personal/live screenshots out of the release. Only specifically reviewed demonstration stills and the public film captions/transcripts belong in the source archive; the large films remain release attachments.

Repository visibility, pushing commits, publishing archives, and deploying the application are separate actions. Completing these local checks does not perform any of them.
