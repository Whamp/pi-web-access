## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues, and external PRs are a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels without overrides. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

## Cursor Cloud specific instructions

This is a Pi coding-agent extension (a TypeScript library loaded by the `pi` CLI), not a standalone server/GUI app. Standard dev commands live in the README "Development" section.

- Commands: `npm run typecheck` is the lint/static check (there is no ESLint). `npm test` runs `typecheck` + `node --test`. There is no build step — the extension is loaded directly as `.ts`. Run it in the real CLI with `pi -e .` (interactive TUI; needs model credentials). Tests mock the network, so provider API keys are not required.
- Node version (important): the tests `import` `.ts` source directly and rely on Node's unflagged type-stripping (Node ≥ 22.18), and the pi peer deps require Node ≥ 22.19. The default `node` on PATH (`/exec-daemon/node`) is v22.14, which is too old and makes the tests fail to import. Use nvm's Node 22.22.2. Because `/exec-daemon` is hard-prepended to PATH, `nvm use 22` alone is NOT enough — prepend the nvm bin explicitly, e.g.: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; export PATH="$(dirname "$(nvm which 22)"):$PATH"; hash -r`. `npm install` itself works on any of these Node versions.
- Curator tests need a headless environment: the three `/websearch` curator tests in `test/agent-search-workflow.test.mjs` assert the "Open manually:" fallback that only appears when opening a browser fails. This Cloud VM has `DISPLAY=:1` and a working `/usr/bin/xdg-open` (exit 0), so the curator "opens a browser" and those 3 tests fail here even though the code is correct. To get a fully green suite, force the browser opener to fail, e.g. run with `env -u DISPLAY node --test` or shim a failing `xdg-open` earlier on PATH.
