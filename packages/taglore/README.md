# taglore

Core and CLI of [Taglore](https://github.com/d2k-klin/taglore): AI-written release notes from git tags.

```bash
npx --package=https://github.com/d2k-klin/taglore/releases/latest/download/taglore.tgz taglore generate --to v1.9.0 --dry-run
npx --package=https://github.com/d2k-klin/taglore/releases/latest/download/taglore.tgz taglore generate --from v1.7.0 --to v1.9.0 --out ./release-notes
npx --package=https://github.com/d2k-klin/taglore/releases/latest/download/taglore.tgz taglore --help
```

Programmatic use:

```ts
import { runTaglore } from "taglore";

const result = await runTaglore({ to: "v1.9.0", publishGithubRelease: false, outputDir: "release-notes" });
console.log(result.markdown);
```

Full documentation: https://github.com/d2k-klin/taglore
