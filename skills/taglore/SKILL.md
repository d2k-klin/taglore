---
name: taglore
description: Set up, configure or troubleshoot Taglore (d2k-klin/taglore), the GitHub Action and CLI that writes AI release notes from git tags and publishes them to GitHub Releases, a Docker build folder, artifacts, S3 and an in-app What's New dialog. Works with apps in any language. Use when asked to add release notes automation, a What's New dialog, or Taglore to a repository.
---

# Taglore: AI release notes from git tags

Taglore runs on a tag push (`v1.9.0`), picks the right base version, asks GitHub Copilot (or GitHub Models) for user-facing notes, validates and sanitizes them, and publishes them. Patch releases reuse the last major/minor announcement, so the app only announces meaningful releases.

Source and full docs: https://github.com/d2k-klin/taglore

## 1. Inspect the target repository first

Before writing anything, find out:

1. **Tag style.** Run `git tag --list | tail -20`. Taglore expects SemVer tags with a prefix (default `v`). For prefixes like `web-v1.2.3`, set `tag-prefix: web-v`. If there are no tags, tell the user Taglore needs releases tagged `vX.Y.Z`.
2. **Existing release workflow.** If it uses Release Please, go straight to the Release Please row in step 2. Look in `.github/workflows/` for a workflow triggered by `push: tags`. If one exists (Docker build, deploy), add Taglore as a step **before** the Docker build in that workflow. Do not create a second tag-triggered workflow that races it.
3. **Account type.** Personal repo or organization repo. This decides Copilot auth (step 3).
4. **Stack.** Find the language and how the app serves static files: `Dockerfile`, `package.json`, `pyproject.toml`/`requirements.txt`, `go.mod`, `pom.xml`/`build.gradle`, `*.csproj`, `composer.json`, `nginx.conf`. Taglore works with any of them; the stack only decides where `output-dir` points and how the JSON is served (step 4).
5. **Where the notes should go.** Ask only if unclear: GitHub Release only (default), into the Docker image, as an artifact, and/or S3.

## 2. Add the workflow step

Always use `fetch-depth: 0`; Taglore fails on shallow clones because it needs tags and history.

Minimal (GitHub Release only):

```yaml
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  release-notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: d2k-klin/taglore@v1
        with:
          copilot-token: ${{ secrets.COPILOT_TOKEN }}
```

Pick the extra inputs from what the user needs:

| Need | Inputs |
|---|---|
| Notes inside the Docker image | `output-dir: release-notes` (or the app's static folder, see step 4); the step runs before `docker build` |
| Hand files to another job | `upload-artifact: release-notes`, then `actions/download-artifact` in that job |
| Upload to S3 | `aws-actions/configure-aws-credentials` with an OIDC role first, `permissions: id-token: write`, then `s3-uri: s3://bucket/prefix/` |
| Compare specific versions | `from: v1.7.0` and `to: v1.9.0` (any refs; switches to explicit compare) |
| Notes only, no GitHub Release | `publish-github-release: false` |
| Review before publishing | `release-draft: true`, or run the job in an Environment with required reviewers |
| Different language or voice | `language`, `tone`, `audience`, `product-name`, `instructions` |
| Image scan (OS packages) | Second step after `docker build`: `notes-from` + `security-image: <image>:{version}` |
| Security notes + SBOM per release | `security-scan: true` (Syft + Grype, installed automatically); add `security-fail-on: high` to block releases that introduce high/critical findings |
| Repository uses Release Please (`release-please-config.json`, `.release-please-manifest.json` or `googleapis/release-please-action`) | Add Taglore as steps in the **same job** after Release Please, gated on `steps.release.outputs.release_created`, with `to: ${{ steps.release.outputs.tag_name }}` and `release-body: prepend`. Never a separate tag-triggered workflow: tags made with `GITHUB_TOKEN` don't trigger it. Copy `examples/workflows/release-please.yml` |
| Monorepo (several apps in one repo) | `paths: apps/<app>` (plus shared packages it ships) and `tag-prefix: <app>-v`; with Release Please manifests use `outputs['apps/<app>--tag_name']`. Copy `examples/workflows/monorepo.yml` |
| Human review before publishing | Two jobs: `preview` (`evidence: strict`, `publish-github-release: false`, `output-dir`, `preview-file`) and `publish` in an Environment with required reviewers using `notes-from`; copy `examples/workflows/review.yml` |
| Changelog page | Serve `history.json` (written by default) and add `<taglore-changelog src="/release-notes/history.json">` or React `<Changelog />` |
| Keep paths away from the AI | `exclude: "infra/**, **/*.sql"` (lockfiles, build output, images, `.env*`, keys are always excluded) |

Ready-made workflows to copy and adapt live in `examples/workflows/` of the Taglore repo: `basic.yml`, `docker.yml`, `artifact.yml`, `s3.yml`, `compare-explicit.yml`, `major-review.yml`.

## 3. Copilot authentication

- **Personal repository:** the workflow token cannot pay for Copilot. Tell the user to create a fine-grained personal access token with the **Copilot Requests** permission, store it as the repo secret `COPILOT_TOKEN`, and keep `copilot-token: ${{ secrets.COPILOT_TOKEN }}`. You cannot create the token for them.
- **Organization repository:** add `copilot-requests: write` to the workflow `permissions:` and drop `copilot-token`. This works when the org policy "Allow use of Copilot CLI billed to the organization" is enabled.
- **No Copilot:** use `ai-provider: github-models` with `permissions: models: read`, or `ai-provider: none` for notes from Conventional Commits.

Never put tokens in the workflow file. If generation fails, Taglore falls back to commit-based notes and the release continues (`on-ai-failure: fail` to stop instead).

## 4. Ship and show the notes in the app (any language)

Only when the user wants notes inside the app. Taglore writes plain files; the app just needs to serve or read them.

**a) Get the files into the image.** Pick `output-dir` from the stack, and make sure the Dockerfile copies it into the final stage and `.dockerignore` doesn't exclude it.

| Stack | `output-dir` | Dockerfile / serving |
|---|---|---|
| nginx / static SPA | `release-notes` | `COPY release-notes/ /usr/share/nginx/html/release-notes/` |
| Node.js (Express, Fastify, Nest) | `release-notes` | `COPY release-notes/ ./release-notes/` + static middleware |
| Python (FastAPI, Flask, Django) | `release-notes` | `COPY release-notes/ ./release-notes/` + static mount or `json.load` |
| Go | `release-notes` (next to `main.go`) | `//go:embed release-notes`, serve with `http.FileServer` |
| Java / Spring Boot | `src/main/resources/static/release-notes` | served automatically, nothing to copy |
| .NET / ASP.NET Core | `release-notes` | `COPY release-notes/ ./wwwroot/release-notes/` + `UseStaticFiles()` |
| PHP / Laravel | `public/release-notes` | served from `public/` |
| Next.js | `public/release-notes` | standalone Dockerfiles already copy `public/` |

Target URL in all cases: `GET /release-notes/latest.json`. Copy the matching example from `examples/apps/<stack>/` in the Taglore repo. If notes go to S3/CDN instead, use that URL.

**b) Show the dialog.** Pick by frontend:

- **Any HTML frontend** (server templates, Vue, Angular, Svelte, plain HTML): set `web-components: true` on the Taglore step so `taglore-whats-new.js` is written to `output-dir` and served by the app itself, then add once to the main layout/template:

  ```html
  <script type="module" src="/release-notes/taglore-whats-new.js"></script>
  <taglore-whats-new src="/release-notes/latest.json" storage-key="<app-name>:whats-new"></taglore-whats-new>
  ```

  Attributes: `show-on-first-visit`, `no-auto-open`, `compact`, `unstyled`, `label-heading`, `label-close` etc. `element.show()` reopens it from a menu item.

- **React / Next.js:** `npm install https://github.com/d2k-klin/taglore/releases/latest/download/taglore-whats-new.tgz`, then render once in the root layout (client component):

  ```tsx
  "use client";
  import { WhatsNew } from "@taglore/whats-new";
  import "@taglore/whats-new/styles.css";
  export default function AppWhatsNew() {
    return <WhatsNew url="/release-notes/latest.json" storageKey="<app-name>:whats-new" />;
  }
  ```

  For a design system (shadcn/ui, MUI), use the render prop: `<WhatsNew>{({ notes, open, dismiss }) => ...}</WhatsNew>`.

- **Mobile, desktop or anything else:** fetch `latest.json`; show it when `announce` is true and `version` is newer than the version stored as last seen; store `version` when the user dismisses it. Render all fields as plain text. Generate types from `schema/release.schema.json`.

Behaviour to explain to the user: each major/minor announcement shows once per browser/device; first-time users are marked up to date silently unless `show-on-first-visit` is set; patch releases don't re-announce unless `patch-notes: announce` (or `announce-on` lists `patch` explicitly; `patch-notes` only adds to it). The popup is always optional: `no-auto-open` (web component) or `autoOpen={false}` (React) never pops up; the app reads `unseen` (attribute/property, or the hook's `unseen`, plus the `taglore:unseen` event) for a badge and calls `show()` from a menu item. Ask the user which they want.

## 5. Verify

- Preview locally without publishing: `npx --package=https://github.com/d2k-klin/taglore/releases/latest/download/taglore.tgz taglore generate --to <existing-tag> --provider none --dry-run`
- With Copilot locally (needs `npm i -g @github/copilot` and a logged-in Copilot CLI or `COPILOT_GITHUB_TOKEN`): `npx --package=https://github.com/d2k-klin/taglore/releases/latest/download/taglore.tgz taglore generate --to <tag> --dry-run`
- After the first tag push, check the run summary, the GitHub Release body, and that the release has a `taglore.json` asset (patch releases need it on the previous minor).

## Version rules (for answering questions)

- `compare: auto`: patch compares with the previous tag; minor and major compare with the previous `X.Y.0`, which covers all patches in between. First release compares from the root commit. Prereleases are never used as a base.
- `backfill` (default `0`): onboarding. Writes notes for up to N earlier tags (oldest first, max 50) into their GitHub Releases and `history.json`. Existing release text is kept (Taglore's notes prepended), older releases never become "Latest" or pop up, tags with notes are skipped (safe to leave on). Suggest `backfill: 20` when a project adopts Taglore with existing tags, run once via workflow_dispatch on the latest tag. Each written tag is one AI request.
- `patch-notes` (default `ai`): `ai` = AI notes for patches, the app keeps the last major/minor announcement; `announce` = AI notes and a What's New of their own; `commits` = commit messages (pre-1.4.0 behaviour). Adds to `ai-for`/`announce-on`, never removes.
- `ai-for` (default `major,minor`): which release types get AI notes; others use commit messages. Patches follow `patch-notes`.
- `announce-on` (default `major,minor`): which release types write a new `latest.json`. Other releases copy the last announced `taglore.json` from GitHub Releases (or from `baseline-file`).

## Evidence, preview and history

- Every statement in the notes lists the commits behind it. Taglore keeps only hashes that are real commits in the compared range. `evidence: warn` (default) reports statements with none; `evidence: strict` removes them. The run summary shows the table; `unverified-statements` is an output.
- `preview-file` writes a review page (the dialog users will see plus the evidence). It contains commit subjects: never put it in `output-dir` or the image.
- `history.json` holds every release, newest first (`history-limit`, default 20, `0` = off), built from earlier GitHub Releases. Without a GitHub token, pass `history-file`; backfill then skips the tags in it and patches find their announcement in it.
- Immutable releases: Taglore always creates a draft, attaches its files, then publishes, so they work out of the box. A release that is already published and immutable gets its notes but no files; recommend `history-branch: taglore-data` (needs `permissions: contents: write`) so the history never depends on release files. The same option works with `publish-github-release: false` for projects without GitHub Releases. Monorepos: one folder per tag prefix (`history-branch-dir`).
- Per-release context: `facts-file: docs/release-facts/{version}.md` (missing file = none) or `facts-command` (gets `TAGLORE_VERSION`, `TAGLORE_FROM`, `TAGLORE_TO`, `TAGLORE_RELEASE_TYPE`; a failing command stops the run). `{version}`, `{from}`, `{to}`, `{releaseType}` also work in `instructions`. Use this for feature flags or rollout facts the commits don't show, instead of one huge instructions block.
- Style rules in code: an invalid answer gets one corrective retry; a length-only problem is trimmed without a retry. Commit hashes in the text are always flagged. `forbidden-terms` (words or `/regex/`) for environment names and codenames; `style-check: strict` fails instead of warning.
- Unreleased: `unreleased: true` (+ `unreleased-label: Upcoming`) writes notes from the last tag to HEAD for a dev/staging "Upcoming" entry. No GitHub Release, never stored in the history.
- Big releases: diffs fill the `max-diff-kb` budget user-facing code first (tests, CI, docs last); `focus-paths` puts globs first. The log, preview and `context-truncated` output say what was left out.
- Evidence proves a statement points at real changes, not that its wording is right. Recommend the review workflow for major releases.

## Security scanning (optional)

With `security-scan: true`, Taglore scans the released tag and the base version in separate git worktrees with Syft and Grype, using one frozen vulnerability database for both. It adds a "🔒 Security" section (fixed, introduced, open findings; dependency and license changes), `security.json` and `sbom.cdx.json`. These facts never pass through the AI.

- Recommend it for products sold in the EU (Cyber Resilience Act evidence: SBOM per release, vulnerability handling), but don't call it CRA compliance on its own.
- If the app ships as a container, add the image scan: keep the first Taglore step before `docker build` (notes into the image, `publish-github-release: false`), add a second step after the build with `notes-from: <output-dir>/release.json` and `security-image: <registry>/<app>:{version}` (or `{semver}` when image tags have no "v"). The second step publishes the release. The image must exist locally or be pullable; the previous release's image comes from the same template.
- False positives or accepted risks go in a `.grype.yaml` at the repository root.
- `security-fail-on` runs before anything is published, so a tripped gate leaves no release behind.

## Installing without npm

Taglore is not on the npm registry. Use the Action for CI. The web components come from `web-components: true` (or jsDelivr: `https://cdn.jsdelivr.net/gh/d2k-klin/taglore@1/dist/whats-new.js`). The React package and the CLI install from the release tarballs: `https://github.com/d2k-klin/taglore/releases/latest/download/taglore-whats-new.tgz` and `https://github.com/d2k-klin/taglore/releases/latest/download/taglore.tgz`. For locked-down environments (action not allowed, no installs per run), recommend the self-contained `taglore.mjs` from the release: verify with `sha256sum --check --ignore-missing SHA256SUMS` and `gh attestation verify taglore.mjs -R d2k-klin/taglore`, then `node taglore.mjs generate ...` (Node 20+). Never tell the user to run `npm install taglore` or `npm install @taglore/whats-new`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Cannot upload assets to an immutable release" (Taglore before 1.6) | Upgrade; 1.6 creates a draft, attaches, then publishes. For releases already published, add `history-branch` |
| "remaining diff truncated" / `context-truncated: true` | Raise `max-diff-kb`, or set `focus-paths` to the user-facing folders |
| A title or field "too long" stopped a run | 1.6 retries with the reason or shortens it; set `on-ai-failure: fail` only if you want to stop instead |
| "Shallow clone detected" | `actions/checkout` with `fetch-depth: 0` |
| "No release tag found" | Workflow not triggered by a tag; pass `to:` |
| "is not a semver tag" | Set `tag-prefix`, or use `from`/`to` (explicit compare) |
| Copilot 401/403, or fallback notes every time | Personal repo without `copilot-token`, PAT missing Copilot Requests, or org policy off. Check the run log warning |
| A patch's `latest.json` shows the patch, not the last minor | The previous minor release has no announced `taglore.json` asset (released before Taglore), so the patch's own notes are used with `announce: false`. Re-run Taglore for that minor once, or pass `baseline-file` |
| "Syft not found" / "Grype not found" (CLI) | Install them, or use the Action, which installs them automatically |
| "Could not scan image" | The image for this tag isn't built/pushed yet, or the template doesn't match the tag format (`{version}` vs `{semver}`) |
| "notes-from: … is for vX, but this release is vY" | The first step wrote notes for a different tag; both steps must use the same `to` |
| Security gate failed | The error lists the findings; upgrade the dependency, or record an accepted risk in `.grype.yaml` |
| GitHub Models 413 or token limit | Lower `max-diff-kb` (default 20 for github-models); it caps commits, file list and diff together |
| Notes on a big release miss changes ("remaining diff truncated" in the log) | Raise `max-diff-kb` (default 300 for Copilot, about 75-90k tokens; up to ~400 fits any 128k-token model, more with a 1M-context `model`, max 4096) |
| Statements removed or flagged as unverified | The model cited no real commit for them; check the run summary, improve commit messages, or use `evidence: warn` |
| Notes mention internal work | Add guidance in `instructions`, or `exclude` the paths |
