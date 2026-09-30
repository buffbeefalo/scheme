# Publish a reviewed release

[Home](README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

This guide is for someone preparing a release. It is not needed to use Scheme. This repository is a standalone source tree; no other repository or personal service configuration is needed to reproduce it.

The runtime uses `server.js`, `lib/`, `public/`, and `bin/`. The remaining files are documentation, tests, and release checks. Historical `COMMAND_DECK_` names remain for compatibility. The browser client is based on the existing standalone source, with generic examples and a generic display fallback; the xterm bundle is unchanged. No other repository must remain in sync.

The separate `site/` directory presents Scheme and its films. It is a static website, not another installation of the runtime. Its build copies an explicit list of public presentation files; it never copies the Scheme server, runtime configuration, terminal history, or project folders.

## Local checks

Run from a clean Scheme source directory with Node.js 22+ and tmux:

```bash
npm test
npm run check:release
```

The release check walks the actual filesystem, including hidden, ignored, and untracked entries. Only root Git metadata (`.git`) is excluded. It compares against the reviewed file list in `release-files.json`, rejects runtime files and symlinks, checks UTF-8 text, checks local Markdown links, flags non-example home paths and a small set of credential shapes, and verifies the existing xterm bundle hash. Individually inspected demonstration PNGs under `docs/images/` are pinned by filename, signature, and exact hash; no other binary files are allowed. It does not read or print the contents of unexpected files.

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
| Selected Shell/scroll integration | Real tmux session creation, reconnection-related state, and scroll behavior on the tested host. | Does not exercise a paid model or every supported host/browser combination. |
| `npm run check:release` | Reviewed file inventory, runtime-file rejection, known text hazards, local Markdown targets, and pinned xterm bytes. | A small hygiene check, not comprehensive secret detection, external-link testing, or a privacy guarantee. |
| Working-tree Gitleaks | Known credential patterns in current files under the scanner's rules. | Heuristics can miss unknown formats or sensitive text that is not a credential. |
| Full-history Gitleaks | Those patterns in locally available Git history. | Unavailable refs and external artifacts need their own review. |
| Human content and setup review | Accurate guides, generic examples, understandable steps, and assessment of material the scanners do not understand. | Record which OS, browser, and tool versions were actually exercised. |

The tests and secret-scan workflows run on pushes, pull requests, manual dispatch, and a weekly Monday 09:17 UTC schedule. They use Ubuntu 24.04, immutable action pins, top-level `contents: read` permissions, and checkout with `persist-credentials: false`. The tests workflow uses Node 22 and runs the informational doctor, local release check, and default test suite after installing tmux.

CI installs the official Gitleaks 8.30.1 Linux x64 archive directly and verifies its pinned SHA-256 checksum before extracting or executing the binary. The scanner independently invokes that temporary binary from the checkout root with `git --redact=100 --config .gitleaks.toml --log-opts=--all .` and `dir --redact=100 --config .gitleaks.toml .`. Both scans are attempted after successful installation, even if the history scan fails; either scan failure fails the job. The scanner checkout uses `fetch-depth: 0` without an additional authenticated fetch. History coverage remains limited to locally available refs and objects.

Output from scanner installation and both scans is captured in private temporary runner files, which are removed on exit. It is never uploaded, published as summaries, or posted as comments; the installation-and-scan step prints only generic status messages.

The workflow badges show GitHub's latest reported main-branch results; they can lag and are not publication approval. Verify hosted workflow execution and badge rendering after publishing the reviewed source.

The default suite skips the unavailable `0.144.6 fixture` transcript case by name and leaves opt-in integration cases skipped unless requested.

The [capability guide](CAPABILITIES.md#validation-for-v110) records actual Ubuntu ARM64 desktop coverage. macOS and WSL host behavior remain unverified. Resume regression tests do not establish live provider recovery compatibility. A clean scan or passing helper test does not remove those limits.

## Review the two films

The v1.1.0 presentation requires exactly these assets:

| Asset | Source location | Published location |
|---|---|---|
| Product film | Reviewed external render directory: `scheme-product.mp4` | Release attachment and same-origin `media/scheme-product.mp4` |
| Setup film | Reviewed external render directory: `scheme-setup.mp4` | Release attachment and same-origin `media/scheme-setup.mp4` |
| English captions | `site/captions/scheme-product.vtt` and `scheme-setup.vtt` | Same-origin `captions/` |
| Written transcripts | `site/transcripts/product-transcript.md` and `setup-transcript.md` | Inline readable text, standalone HTML pages, and downloadable text |

**Keep MP4s outside Git and outside the source tree.** Caption and transcript text belongs in source control. Use clean demonstration machines and fictional projects. Actual setup footage should show what was exercised; optional account setup must remain visibly unverified if it was not completed. Never film a personal working dashboard or publish raw test machines, accounts, logs, or recordings that have not been reviewed.

Review every final film's picture, narration, captions, and transcript for private content and accurate claims. Inspect the file metadata and confirm the intended video and audio streams with `ffprobe`. Use broadly playable H.264 video, AAC audio, a regular MP4 container, and fast-start metadata. Review representative playback, full narration, end-to-end timing, caption readability, and every visible command; sample images or a text scan alone are not enough. Inspect still images and their metadata too, then update their existing reviewed image hashes only after that review.

`site/media-manifest.json` records the fixed release, six explicit assets, exact byte sizes and SHA-256 values, final duration/dimensions, and chapter starts. Its initial `reviewed: false`, empty hashes, and zero sizes are intentional publication blockers. Fill the record from the final reviewed files and set `reviewed: true` only when that review is complete. The hashes detect changes after review; they cannot establish that the review happened.

The media checker rejects unknown or missing assets, unexpected files in the media/caption/transcript directories, symlinks, unpinned release metadata, missing review facts, changed hashes or sizes, non-MP4 video headers, invalid WebVTT, and chapters or captions outside the reviewed duration. It streams hashes so large films need not be loaded into memory. It also caps the combined media at 900 MiB. Codec and visual checks remain a separate review step.

```bash
node --test test/media.test.js
node scripts/check-media.js --media-dir /path/to/reviewed-media
```

Changing an asset name, release tag, or asset set is a deliberate contract change: review and update the explicit sets in the manifest, checker, build, and workflow together. Do not replace the checks with a wildcard download or an automatic allowlist of everything found on disk.

## Build and preview the public page

After the media check passes, choose a fresh empty output directory **outside the source and render directories**:

```bash
scheme_site_dir=$(mktemp -d)
node scripts/build-site.js --media-dir /path/to/reviewed-media --out "$scheme_site_dir"
python3 -m http.server 8080 --bind 127.0.0.1 --directory "$scheme_site_dir"
```

Open <http://localhost:8080>. The build creates the two readable transcript pages and chapter links from reviewed text and timing. The video, captions, and poster files use relative URLs from the same origin, including when hosted at `/scheme/`. A visitor can use native player controls, captions, the chapter links, and transcript text. JavaScript adds seeking within the page and pauses the other film; it does not connect to Scheme or request account access. If JavaScript is unavailable, chapter links open the corresponding video time directly.

Check desktop and narrow screens, keyboard focus, reduced motion, both player error states, caption display, transcript expansion, standalone transcripts, and downloads. Use an HTTP preview: opening the page directly from disk is not the intended caption test. Python's basic server is useful for that page review but does not supply HTTP byte ranges; use a byte-range-capable server or the deployed Pages site for reliable video seeking checks. The browser must also support the reviewed H.264/AAC encoding. Confirm there are no requests to a Scheme API, no sign-in requirement, and no private data in the staged directory. Do not put the build output back into the Git checkout.

## Release and GitHub Pages

The Pages workflow follows [GitHub's custom-workflow deployment model](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). Set the repository's **Settings → Pages → Source** to **GitHub Actions**. The workflow checks out the exact commit that triggered the run; its film downloads remain pinned to the reviewed v1.1.0 release. To publish a page correction, commit it to main and manually run the public-site workflow from main. This also works with the GitHub Pages environment's main-only deployment rule. The matching published-release event can deploy where environment rules permit that tag; publishing another tag does not deploy this version by accident.

Complete the source and media review before creating the release tag, so the tag already contains the final media hashes and transcripts. Create the release as a draft, upload the two reviewed MP4 attachments with the exact names above, then publish it. This avoids starting the Pages job before the attachments exist. Do not replace reviewed release attachments in place; different bytes must receive a new reviewed release and matching contract.

The build job downloads only those two explicit assets from the v1.1.0 release, verifies their SHA-256 values and the source-controlled caption/transcript bytes, and stages the static page. The upload action receives only that explicit staging directory. The deployment job alone receives `pages: write` and `id-token: write`; the source build has read permissions. All actions are pinned to commit hashes. No terminal server runs on Pages.

After deployment, verify the public page anonymously. Play both films, seek chapters, display captions, read both transcripts, follow source/setup links, and confirm the release downloads. Also install the published source ZIP in a fresh location and repeat the doctor and Shell test. A successful local build does not establish public availability.

## Before changing visibility or uploading a release

Complete both the hosted-history review and the external-media review before changing visibility or uploading a release.

Confirm the reviewed source, final Git history, documentation links, dependency/vendor provenance, license, and test record. Check the archive's actual file inventory separately if you assemble it outside GitHub's source archive flow. Keep personal applications, projects, credentials, config files, conversation transcripts, logs, uploads, and personal/live screenshots out of the release. Only specifically reviewed demonstration stills and the public film captions/transcripts belong in the source archive; the large films remain release attachments.

Repository visibility, pushing commits, publishing archives, and deploying the application are separate actions. Completing these local checks does not perform any of them.
