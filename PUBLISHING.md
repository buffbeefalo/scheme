# Release checks

[Home](README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

This guide is for someone preparing a release. It is not needed to use Scheme. This repository is a standalone source tree; no private dashboard, export script, bot, course, or service configuration is needed to reproduce it.

The runtime uses `server.js`, `lib/`, `public/`, and `bin/`. The remaining files are documentation, tests, and release checks. Historical `COMMAND_DECK_` names remain for compatibility. The browser client is based on the existing standalone source, with generic examples and a generic display fallback; the xterm bundle is unchanged. No other repository must remain in sync.

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

Both workflows are configured to run on unrestricted pushes, pull requests, manual dispatch, and a weekly Monday 09:17 UTC schedule. They use Ubuntu 24.04, immutable action pins, top-level `contents: read` permissions, and checkout with `persist-credentials: false`. The tests workflow uses Node 22 and runs the informational doctor, local release check, and default test suite after installing tmux.

CI installs the official Gitleaks 8.30.1 Linux x64 archive directly and verifies its pinned SHA-256 checksum before extracting or executing the binary. The scanner independently invokes that temporary binary from the checkout root with `git --redact=100 --config .gitleaks.toml --log-opts=--all .` and `dir --redact=100 --config .gitleaks.toml .`. Both scans are attempted after successful installation, even if the history scan fails; either scan failure fails the job. The scanner checkout uses `fetch-depth: 0` without an additional authenticated fetch. History coverage remains limited to locally available refs and objects.

Output from scanner installation and both scans is captured in private temporary runner files, which are removed on exit. It is never uploaded, published as summaries, or posted as comments; the installation-and-scan step prints only generic status messages.

The workflow badges show GitHub's latest reported main-branch results; they can lag and are not publication approval. Hosted workflow execution and badge rendering require validation after delivery under separate authorization.

The default suite skips the unavailable `0.144.6 fixture` transcript case by name and leaves opt-in integration cases skipped unless requested.

Linux is verified. macOS and WSL host behavior remain unverified. The resume regression checks actual constructed launch arguments with tmux replaced; it makes no provider call and does not establish live provider recovery compatibility. A clean scan or passing helper test does not remove those limits.

## Before changing visibility or uploading a release

Publication remains blocked until the separate hosted-history and external-artifact review is complete.

Confirm the reviewed source, final Git history, documentation links, dependency/vendor provenance, license, and test record. Check the archive's actual file inventory separately if you assemble it outside GitHub's source archive flow. Keep personal applications, projects, credentials, config files, transcripts, logs, uploads, and personal/live screenshots out of the release. Only the specifically reviewed synthetic demonstration images belong in the source archive.

Repository visibility, pushing commits, publishing archives, and deploying the application are separate actions. Completing these local checks does not perform any of them.
