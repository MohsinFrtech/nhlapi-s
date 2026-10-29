# nhl

NHL API proxy with in-memory caching (cache time depends on the endpoint, see below) and CDN cache headers.

## Setup
1. `npm install`
2. `cp .env.example .env` and set `NHL_API_TOKEN` (your RapidAPI key)
3. `node --env-file=.env server.js`

## Deploy (Vercel)
1. Push the repo to GitHub and import it as a project at vercel.com. Vercel detects the Express app in `app.js` (default export) with no extra config.
2. Add environment variables `NHL_API_URL`, `NHL_API_HOST` and `NHL_API_TOKEN` (same values as `.env.example`).
3. Deploy. Every response carries `Cache-Control: public, s-maxage=<time left on the cache entry, max 1h>` so Vercel's CDN serves repeat requests without running the function.

## Caching and the RapidAPI limit
Responses are cached per endpoint (times below). With Upstash Redis connected (Vercel project, Storage tab, Upstash for Redis, free plan), the cache is shared by all server instances and survives restarts, and two more protections turn on:
- **Lock:** when an entry expires, one instance fetches it while the others wait, so it costs one upstream call, not one per instance.
- **Monthly call counter:** every RapidAPI call is counted (`UPSTREAM_MONTHLY_LIMIT`, default 22000 per calendar month). Past the limit no upstream calls are made and cached data is served (`X-Cache: STALE`), or 503 `upstream_budget_exhausted` if nothing is cached.

Redis is optional: without it the app uses per-instance memory only and the limit is not enforced.

## Endpoints
- `GET /` health check
- `GET /api/schedule?date=YYYY-MM-DD` schedule from a date onward, as upstream returns it (defaults to today, US Eastern). Only yesterday to 7 days ahead is accepted (`date_out_of_range` otherwise). Response: `{from, days: [{date, games}]}`.
  Cache time follows game state: 10 min while a game is live, until puck drop (max 1h) before games, 30 days once every game is final, 24h for future dates.
  Response header `X-Cache` is `HIT`, `MISS` or `STALE`.
- `GET /api/teams` all NHL teams (cached 7 days). Response: `{season, teams}`.
- `GET /api/teams/:id` team profile: colors, logos, standing, record, venue and next game (cached until 6h after the next puck drop, max 24h).
- `GET /api/teams/:id/players` roster for a team id from `/api/teams` (cached 2 days; `age` is computed per request). Response: `{team, players}`.
- `GET /api/news` latest NHL news, previews, recaps and videos (cached 8h). Response: `{fetchedAt, items}`.
- `GET /api/standings?season=2026` standings for a season by start year (2026 = 2026-27, default current; 2021 onward). Current season cached 12h (30 days once every team has played 82 games); past seasons 1 year.
- `GET /api/teams/:id/schedule?season=2026` a team's full season schedule and results (2026 = 2026-27, default current; 2021 onward). Current season cached until 6h after the next puck drop (max 24h); past seasons 1 year.
- `GET /api/teams/:id/stats` a team's season totals and per-game numbers (current season only, cached 24h).
- `GET /api/teams/:id/players/:playerId/stats` a rostered player's stats (multi-season totals; skater or goalie set, cached 7 days; `updatedAt` says when it was fetched).
- `GET /api/injuries` league-wide injury report (cached 24h). `GET /api/teams/:id/injuries` one team's injuries (empty list if none).
