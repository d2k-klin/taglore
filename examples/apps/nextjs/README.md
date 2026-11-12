# Next.js integration

1. In your tag workflow, run Taglore with `output-dir: public/release-notes` before `docker build` ([docker.yml](../../workflows/docker.yml)).
2. `npm install https://github.com/d2k-klin/taglore/releases/latest/download/taglore-whats-new.tgz`
3. Add [`whats-new.tsx`](whats-new.tsx) to `app/` and render it in [`layout.tsx`](layout.tsx).
4. Make sure the Dockerfile copies `public/` into the runtime image ([Dockerfile](Dockerfile)) and `.dockerignore` doesn't exclude `public/release-notes`.

The container then serves `GET /release-notes/latest.json`, and the dialog shows each major/minor announcement once per browser.

Add `public/release-notes/` to `.gitignore` so local builds don't ship stale notes:

```gitignore
public/release-notes/
```

## Build-time import instead of fetch

If you'd rather not fetch at runtime, import the file in a Server Component and pass it down. Add a placeholder `public/release-notes/latest.json` for local dev.

```tsx
import notes from "@/public/release-notes/latest.json";
import { WhatsNew, type ReleaseNotes } from "@taglore/whats-new";

<WhatsNew data={notes as ReleaseNotes} />;
```
