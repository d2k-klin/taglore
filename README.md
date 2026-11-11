# Taglore

**AI-written release notes from git tags.** Push `v1.9.0`, and Taglore compares it with the right earlier version, has GitHub Copilot write user-friendly notes, and publishes them to:

- **GitHub Releases** (Markdown, by default)
- **a folder** in your Docker build context, so the image carries its own `latest.json`
- **a workflow artifact** for a later job
- **a Security section** (optional): vulnerabilities fixed and introduced since the last release, from Syft and Grype, plus a CycloneDX SBOM per release
- **S3** for apps or CDNs that fetch notes at runtime
- **your app's What's New dialog**, in any stack: a [web component](examples/apps/any-frontend) for any frontend, a [React component](packages/whats-new), or a few lines of code in your backend

It works with any language. Taglore writes plain JSON and Markdown files; Node, Python, Go, Java, .NET, PHP or a static nginx site can all serve or read them. No database, no SaaS, no AI calls at runtime. Notes ship with the image they describe.

```yaml
# .github/workflows/release-notes.yml
on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0 # Taglore needs tags and history
      - uses: d2k-klin/taglore@v1
        with:
          copilot-token: ${{ secrets.COPILOT_TOKEN }}
```

## How versions are compared

Taglore follows SemVer and treats user-facing releases differently from maintenance releases.

| Tag | Compared with (`compare: auto`) | Notes written by | GitHub Release | In-app announcement |
|---|---|---|---|---|
| `v2.0.0` major | last minor, `v1.9.0` | AI | yes | **new** |
| `v1.9.0` minor | previous minor, `v1.8.0` (covers all 1.8.x patches) | AI | yes | **new** |
| `v1.9.1` patch | previous tag, `v1.9.0` | commit messages | yes | keeps `v1.9.0`'s |
| `v2.0.0-rc.1` | previous tag | commit messages | prerelease | none |
| first release | root commit | AI | yes | new |

Other modes: `previous-tag`, `previous-minor`, `previous-major`, or `explicit` with your own `from`/`to` (any tags, SHAs or branches). `ai-for` and `announce-on` change which release types get AI notes and announcements.

**Patch releases keep the last announcement.** Every release gets a `taglore.json` asset. On a patch, Taglore downloads the announcement from the last minor's release and writes it as `latest.json`, so the image you build for `v1.9.1` still contains the `v1.9.0` What's New.

## GitHub Copilot setup

Taglore installs the Copilot CLI if it isn't on the runner and calls it **with no tools allowed**, in an empty temp folder. Taglore collects the commits and diff itself; Copilot only reads the prompt and returns JSON.

| Repository | What to do |
|---|---|
| **Personal account** | Create a fine-grained PAT with the **Copilot Requests** permission, save it as a secret (e.g. `COPILOT_TOKEN`) and pass `copilot-token: ${{ secrets.COPILOT_TOKEN }}`. |
| **Organization** | Add `copilot-requests: write` to `permissions:` and skip `copilot-token`. Works when the org policy "Allow use of Copilot CLI billed to the organization" is on. |

Prefer another model source? `ai-provider: github-models` uses the GitHub Models API with the workflow token (`permissions: models: read`). `ai-provider: none` writes notes from Conventional Commits only.

If the AI call fails, Taglore falls back to commit-based notes and keeps your release going (`on-ai-failure: fail` to stop instead).

## Recipes

### Docker, any language

```yaml
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - id: notes
        uses: d2k-klin/taglore@v1
        with:
          copilot-token: ${{ secrets.COPILOT_TOKEN }}
          output-dir: release-notes          # inside the build context
      - run: docker build -t ghcr.io/${{ github.repository }}:${{ github.ref_name }} .
```

```dockerfile
# In your Dockerfile: put the files where your app serves static files or reads config
COPY release-notes/ /app/release-notes/
```

The container then serves `GET /release-notes/latest.json` (or your code reads it from disk). Ready-made setups for **nginx, Node.js, Python, Go, Java/Spring, .NET and Next.js** are in [examples/apps](examples/apps).

### What's New dialog in the frontend

Any frontend (plain HTML, server templates, Vue, Angular, Svelte):

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@taglore/whats-new@1/dist/element.js"></script>
<taglore-whats-new src="/release-notes/latest.json" storage-key="myapp:whats-new"></taglore-whats-new>
```

React / Next.js:

```tsx
"use client";
import { WhatsNew } from "@taglore/whats-new";
import "@taglore/whats-new/styles.css";

export default function AppWhatsNew() {
  return <WhatsNew url="/release-notes/latest.json" storageKey="myapp:whats-new" />;
}
```

Both show each major/minor announcement once per browser; new visitors start up to date (`show-on-first-visit` / `showOnFirstVisit` to change that). For mobile, desktop or other clients: show the announcement when `announce` is `true` and `version` is newer than the one the user last saw.

### Security notes and SBOM per release

Add `security-scan: true` and Taglore scans **both versions** with [Syft](https://github.com/anchore/syft) (SBOM) and [Grype](https://github.com/anchore/grype) (vulnerabilities). Both are checked against the same vulnerability database, downloaded once and then frozen, so "fixed" and "introduced" reflect your code changes, not database updates.

```yaml
      - uses: d2k-klin/taglore@v1
        with:
          copilot-token: ${{ secrets.COPILOT_TOKEN }}
          security-scan: true
          security-fail-on: high      # block the release if it introduces high or critical findings
          output-dir: release-notes
```

You get:

- a **🔒 Security** section in the release notes: how many known vulnerabilities this release fixes and introduces, a table of them (with CVE ids, severity, package and fix version), what is still open, dependency and new-license changes;
- `security.json`: the full report (introduced, fixed, open, component changes);
- `sbom.cdx.json`: the CycloneDX SBOM of the released version, attached to the GitHub Release and written to `output-dir`/S3/artifact like the other files.

The security facts come from the scanners only. The AI never writes or edits them. Each version is checked out into its own git worktree, so the scan reflects the committed manifests and lockfiles at that tag. A `.grype.yaml` in the repository root (ignore rules, VEX) applies to both scans. Pin `syft-version` and `grype-version` for reproducible SBOMs.

#### Scan the built image too

Lockfiles don't show OS packages or anything installed during `docker build`. Add `security-image` to scan the image as well, and compare it with the previous release's image. Because the notes are baked into the image, this takes two Taglore steps: notes before the build, the image scan after it. The second step reuses the first step's notes (`notes-from`), so there is no second AI call and the text stays identical.

```yaml
      - uses: d2k-klin/taglore@v1            # 1. notes, baked into the image
        with:
          copilot-token: ${{ secrets.COPILOT_TOKEN }}
          publish-github-release: false
          output-dir: release-notes

      - run: docker build -t ghcr.io/acme/app:${{ github.ref_name }} . && docker push ghcr.io/acme/app:${{ github.ref_name }}

      - uses: d2k-klin/taglore@v1            # 2. security: repository + image, then publish
        with:
          notes-from: release-notes/release.json
          security-image: ghcr.io/acme/app:{version}   # {semver} for tags without the "v"
          security-fail-on: critical
```

The image can be local (`docker build` in the same job) or in a registry; Syft uses your `docker login`. The previous release's image comes from the same template. If it no longer exists, Taglore says so in the notes and lists the image findings as open rather than calling them all "introduced". The image's own SBOM is attached as `sbom-image.cdx.json`.

The gate in step 2 runs after the image is built, so when it trips, nothing is published to the GitHub Release, but the image already exists. Push it to a staging tag first, or keep the deploy behind this step, if a blocked release must never leave an image behind.

This is useful evidence for the EU Cyber Resilience Act's vulnerability-handling and SBOM duties, not a compliance programme on its own. Reachability is not analysed: a finding means a vulnerable version is present, not that it is exploitable in your app.

### S3

```yaml
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/release-notes
          aws-region: eu-central-1
      - uses: d2k-klin/taglore@v1
        with:
          s3-uri: s3://my-bucket/myapp/release-notes/
```

Needs `id-token: write` for OIDC. The role only needs `s3:PutObject` on that prefix. `latest.json` is uploaded with a 60-second cache and the other files with 5 minutes, since every release overwrites the same keys.

### Artifact for another job

```yaml
      - uses: d2k-klin/taglore@v1
        with:
          upload-artifact: release-notes
# later job:
      - uses: actions/download-artifact@v5
        with: { name: release-notes, path: release-notes }
```

### Compare any two versions

```yaml
on:
  workflow_dispatch:
    inputs:
      from: { required: true }
      to: { required: true }
# ...
      - uses: d2k-klin/taglore@v1
        with:
          from: ${{ inputs.from }}
          to: ${{ inputs.to }}
          publish-github-release: false
          upload-artifact: true
```

### Review majors before they go out

Use `release-draft: true` for major tags, or run the publishing job in a GitHub Environment with required reviewers. See [examples/workflows/major-review.yml](examples/workflows/major-review.yml).

More in [examples/workflows](examples/workflows).

## Inputs

| Input | Default | Description |
|---|---|---|
| `to` | triggering tag | Release tag |
| `from` | | Base ref; switches `compare` to `explicit` |
| `compare` | `auto` | `auto`, `previous-tag`, `previous-minor`, `previous-major`, `explicit` |
| `tag-prefix` | `v` | Tag prefix, e.g. `app-v` for monorepos |
| `ai-provider` | `copilot` | `copilot`, `github-models`, `none` |
| `model` | provider default | Model id |
| `copilot-token` | | Fine-grained PAT with Copilot Requests (personal repos) |
| `copilot-version` | `latest` | `@github/copilot` version to install |
| `ai-for` | `major,minor` | Release types that get AI notes |
| `on-ai-failure` | `fallback` | `fallback` or `fail` |
| `language` | `English` | Language of the notes |
| `tone` | `friendly and concise` | Writing tone |
| `audience` | `end users of the application` | Who reads the notes |
| `product-name` | repo name | Name used in the prompt |
| `instructions` | | Extra guidance for the AI |
| `exclude` | | Extra globs kept out of the AI context |
| `max-diff-kb` | `100` (`20` for github-models) | Diff size sent to the AI |
| `publish-github-release` | `true` | Create/update the GitHub Release and attach `taglore.json` |
| `release-draft` | `false` | Create new releases as drafts |
| `include-commits` | `true` | Collapsible commit list in the Markdown |
| `output-dir` | | Write `latest.json`, `release.json`, `RELEASE_NOTES.md` here |
| `upload-artifact` | `false` | `true` or an artifact name |
| `s3-uri` | | `s3://bucket/prefix/` |
| `s3-region` | AWS env | Region for S3 |
| `announce-on` | `major,minor` | Release types that create a new announcement |
| `baseline-file` | | Local `taglore.json` to reuse instead of downloading it |
| `security-scan` | `false` | Syft + Grype scan of both versions: Security section, `security.json`, `sbom.cdx.json` |
| `security-fail-on` | `none` | `critical`, `high`, `medium`, `low`: fail before publishing when the release introduces findings at or above it |
| `security-max-items` | `15` | Max rows in the Security table |
| `security-exclude` | | Extra Syft exclude patterns |
| `security-image` | | Also scan the built image, e.g. `ghcr.io/acme/app:{version}`; previous image from the same template |
| `notes-from` | | Reuse an earlier step's `release.json` instead of generating notes again |
| `syft-version` / `grype-version` | `latest` | Scanner versions to install (pin for reproducibility) |
| `dry-run` | `false` | Generate and print only |
| `github-token` | `github.token` | Token for Releases / GitHub Models |
| `working-directory` | workspace | Repository folder |

**Outputs:** `version`, `previous-version`, `release-type`, `announce`, `provider`, `release-url`, `markdown`, `json`, `latest-json-path`, `release-json-path`, `markdown-path`, `artifact-name`, and with `security-scan`: `security-open`, `security-introduced`, `security-fixed`, `security-open-critical`, `security-open-high`, `security-json-path`, `sbom-path`, `image-sbom-path`.

## CLI

Same engine, for local previews or other CI systems:

```bash
npx taglore generate --to v1.9.0 --dry-run                 # preview
npx taglore generate --from v1.7.0 --to v1.9.0 --out ./release-notes
npx taglore generate --github --repo owner/app              # publish (needs GITHUB_TOKEN)
npx taglore --help
```

## Files and format

| File | Content |
|---|---|
| `latest.json` | The announcement apps should show: this release if it announces, otherwise the last one that did |
| `release.json` | Structured notes for this exact release (also attached to the GitHub Release as `taglore.json`) |
| `RELEASE_NOTES.md` | Markdown, same as the GitHub Release body |
| `security.json` | With `security-scan`: introduced, fixed and open vulnerabilities, dependency and license changes |
| `sbom.cdx.json` | With `security-scan`: CycloneDX SBOM of the repository at the released tag |
| `sbom-image.cdx.json` | With `security-image`: CycloneDX SBOM of the released container image |

JSON follows [`schema/release.schema.json`](schema/release.schema.json): `version`, `previousVersion`, `releaseType`, `announce`, `date`, `title`, `summary`, `highlights[]`, `improvements[]`, `fixes[]`, `breaking[]`, `generator`. Generate types for your language from the schema with any JSON Schema tool.

## Security

- AI output is untrusted: Taglore validates it against the schema, enforces length limits and strips HTML, links, URLs and control characters before anything is published. Both What's New components render plain text only; do the same in your own UI (no `innerHTML`).
- The prompt tells the model to treat commits and code as data; Copilot runs without tools in an empty folder, so injected instructions can't run commands or read files.
- Lockfiles, build output, binaries, images, `.env*`, `*.pem` and `*.key` never reach the AI. Add more with `exclude`.
- Don't run Taglore on `pull_request_target` or fork-triggered workflows with secrets.
- S3 uses the job's AWS credentials (OIDC). Taglore never takes AWS keys as inputs.

## Use it with an AI coding agent

[`skills/taglore/SKILL.md`](skills/taglore/SKILL.md) teaches Claude Code, GitHub Copilot and other agents how to add Taglore to a project. Copy the folder into `.claude/skills/taglore/` or `.github/skills/taglore/` of your app repo, then ask: *"Set up Taglore release notes for this app."*

## Repository layout

```text
action.yml               GitHub Action (runs dist/index.js)
dist/                    Bundled action, committed
packages/taglore/         Core + CLI (npm: taglore)
packages/whats-new/      What's New: web component + React (npm: @taglore/whats-new)
schema/                  JSON schema
examples/                Workflows and app integrations (nginx, Node, Python, Go, Java, .NET, Next.js)
skills/taglore/           Agent skill
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `main` is protected; changes go through pull requests.

## License

[MIT](LICENSE)
