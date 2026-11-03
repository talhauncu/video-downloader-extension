# Contributing

Thanks for helping. The extension is small and has no build step, so getting
started is quick; the rules below keep it working on the sites people use.

## Setup

```bash
npm install
npx playwright install chromium --no-shell
npm test && npm run lint && npm run typecheck && npm run check:vendor && npm run e2e
```

Load the folder as an unpacked extension (`chrome://extensions`, Developer
mode) to try changes by hand; press **Reload** after editing.

## Working on a change

- One topic per branch and pull request. Write what changed and why in the PR,
  with the test counts and a short manual test list.
- **Tests come with the change.** Pure logic goes into `src/lib/` with unit
  tests (`node --test`); behaviour in the browser gets an e2e test against the
  local fixture server (`test/fixtures/`) — never against a real website.
  Every e2e spec ends with the "service worker logged no errors" test.
- No flaky tests: if a test fails only sometimes (often only in CI), find the
  timing it depends on and remove it.
- New settings go into `src/lib/settings.js` (`normalizeSettings`, with a unit
  test) and onto the options page.
- **Texts**: no user-facing strings in code. Add the key to both
  `_locales/en/messages.json` and `_locales/tr/messages.json` and use
  `t('key', …)` (`src/lib/i18n.js`) or `data-i18n` attributes in pages. A unit
  test checks that both files have the same keys, that every key is used and
  that placeholders match. Do not put placeholders next to each other (`$1$2`).
- Code, comments, commits and PRs are in English. Commits follow
  [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `test:`, `docs:`, `chore:`, `ci:`, `style:`), the body says why.
- ESLint, Prettier and `tsc --checkJs` must pass (`npm run lint`,
  `npm run typecheck`); the pre-commit hook formats staged files.
- `src/vendor/` changes only with a library upgrade: copy the files from
  `node_modules` unchanged and update `src/vendor/ffmpeg/VERSIONS` and
  `THIRD_PARTY_LICENSES.md`. `npm run check:vendor` (also in CI) verifies it.
- Note user-visible changes in `CHANGELOG.md` (Keep a Changelog); releases bump
  `manifest.json`'s `version` and are tagged `v<version>`.

## Adding a site

Site-specific code lives in `src/sites/<id>/`: a pure definition (`site.js`)
and an extractor running in the page's main world (`main.js`); the service
worker derives the rest. Prefer general fixes (capture, matching, resilience)
over site code. The step-by-step guide, with the rules that came from real
bugs and the test template, is [docs/sites.md](docs/sites.md).

## Reporting problems

Open an issue with the page (if public), what you expected and what happened,
and paste the popup's **Debug info** (no cookies or page title; addresses are
masked, but file names can contain a page title, so read it before posting).
DRM-protected services, YouTube and live streams are out of scope.
Security problems go through private reporting instead: see [SECURITY.md](SECURITY.md).
