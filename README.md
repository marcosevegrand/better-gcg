# pretty-me

Generate a GitHub-dark themed SVG card with:
- Repos count
- Commit count
- PR count
- Total stars across owned repos
- Contribution grid (gray + 4 green tones) based on commits + PRs activity

## API

### Endpoint

`GET /api/svg/:username?months=12&thresholds=1,3,6,10&repo_visibility=all&branch_scope=all&repo_scope=all`

### Query params

- `months` (optional): integer between `1` and `24` (default `12`)
- `thresholds` (optional): 4 increasing integers for green tones, default `1,3,6,10`
- `repo_visibility` (optional): `public` or `all` (default `all`)
- `branch_scope` (optional): `default` or `all` (default `all`)
- `repo_scope` (optional): `owned`, `contributed`, or `all` (default `all`)

### Scope behavior

- `repo_visibility=public`: uses owned public repos of `:username`
- `repo_visibility=all`: includes private repos too, but only when `:username` matches the authenticated `GITHUB_TOKEN` user
- `branch_scope=default`: counts commits only on each repo default branch
- `branch_scope=all`: counts commits across all branches (de-duplicated by commit SHA per repo)
- `repo_scope=owned`: only repositories owned by `:username`
- `repo_scope=contributed`: repositories where `:username` contributed in the selected window (includes org/other-owner repos)
- `repo_scope=all`: union of owned + contributed repositories
- PR activity counts PRs authored by the user in the selected repos
- `months` uses a rolling trailing window (for `12`, this is the last 12 months up to today)
- GitHub profile "contributions" includes more event types (like issues/reviews); this card reports commits and PRs activity by design
- When `GITHUB_TOKEN` is set, the card also shows GitHub's official "Total contributions" for the same window (GraphQL), which should match your profile total for that period.

## Preview page

Open:

`/preview?username=marcosevegrand&months=12&thresholds=1,3,6,10&repo_visibility=all&branch_scope=all&repo_scope=all`

This page lets you tune username, months, thresholds, repo visibility, and branch scope, and preview the generated SVG live.
If `username` is omitted, preview defaults to `GITHUB_USERNAME` from `.env`.

## Local run

1. Install deps:

   ```bash
   npm install
   ```

2. Create env file:

   ```bash
   cp .env.example .env
   ```

3. Set `GITHUB_TOKEN` in `.env`.
   - Required for `repo_visibility=all`.
   - Required for `repo_scope=contributed` or `repo_scope=all`.
   - Recommended even for public mode to increase API limits.
   - Set `GITHUB_USERNAME` to your username to make preview/use defaults personal.
   - Fine-grained token permission: `Metadata: Read-only` is enough for this app; classic token with `repo` works too.

4. Run:

   ```bash
   npm run dev
   ```

5. Open:

   `http://localhost:3000/api/svg/marcosevegrand?months=12&thresholds=1,3,6,10&repo_visibility=all&branch_scope=all&repo_scope=all`

## Caching strategy

- **Server cache**: in-memory cache keyed by `username + months + thresholds + repo_visibility + branch_scope + repo_scope`
- **TTL**: controlled by `CACHE_TTL_HOURS` (default `6h`)
- **HTTP cache headers**:
  - `Cache-Control: public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400`
  - `ETag` support with `304 Not Modified`

## Deploy (always up-to-date in README)

Deploy this app to any Node host (Railway, Render, Fly.io, your VPS, etc.) and set env vars:

- `GITHUB_TOKEN`
- `CACHE_TTL_HOURS` (optional)

### Vercel setup

1. Push this repo to GitHub.
2. Import it in Vercel.
3. In Vercel project settings, add environment variable:
   - `GITHUB_TOKEN`
4. Deploy.

`vercel.json` is included and routes all paths to `src/server.js`.

Use the live endpoint URL directly in your GitHub README image markdown:

```md
![GitHub Activity](https://your-domain.com/api/svg/marcosevegrand?months=12&thresholds=1,3,6,10&repo_visibility=all&branch_scope=all&repo_scope=all)
```

If you need to force-refresh GitHub’s image cache occasionally, append a version parameter:

```md
![GitHub Activity](https://your-domain.com/api/svg/marcosevegrand?months=12&thresholds=1,3,6,10&repo_visibility=all&branch_scope=all&repo_scope=all&v=2)
```
