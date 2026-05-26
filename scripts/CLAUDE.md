# scripts/ — Deploy and build utilities

| File | Purpose |
|------|---------|
| **bump-version.js** | Increments patch version in `public/version.json`. Stages + commits. Runs as part of `npm run deploy:all`. |
| **deploy-ui.js** | Stamps build timestamp into sw.js (replaces `__BUILD_TIME__`), builds Tailwind CSS, git push, deploys to Cloudflare Pages via wrangler. Restores sw.js template in `finally`. |
| **test-segmentation.js** | Standalone test harness for segmentation algorithm tuning. Not part of deploy pipeline. |
