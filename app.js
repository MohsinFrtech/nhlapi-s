const express = require("express");
const {cached} = require("./lib/cached");
const {fetchSchedule, fetchTeams, fetchRoster, fetchNews, fetchStandings, fetchTeamSchedule, fetchTeamStats, fetchPlayerStats, fetchInjuries, fetchTeamInfo} = require("./lib/nhlClient");
const {parseDate, todayEastern, assertDateInRange, ageOn} = require("./lib/date");
const {scheduleTtlMs, untilAfterNextGameMs} = require("./lib/scheduleTtl");
const {currentSeason, parseSeason, availableSeasons, seasonName} = require("./lib/season");
const {HttpError} = require("./lib/errors");

const app = express();
app.use(express.json());

const HOUR_MS = 60 * 60 * 1000;
const SCHEDULE_DAYS_BACK = 1;
const SCHEDULE_DAYS_AHEAD = 7;
const TEAMS_TTL_MS = 7 * 24 * HOUR_MS; // team list only changes between seasons
const ROSTER_TTL_MS = 48 * HOUR_MS; // rosters change with trades and call-ups

const NEWS_TTL_MS = 8 * HOUR_MS; // feed only covers ~25h, so don't go much past 12h or items are missed
const PLAYER_STATS_TTL_MS = 7 * 24 * HOUR_MS; // multi-season totals, one game barely moves them
// Team pages change after each of the team's games, so they expire 6h after the next puck drop (see untilAfterNextGameMs).
const TEAM_INFO_MAX_TTL_MS = 24 * HOUR_MS;
const TEAM_SCHEDULE_MAX_TTL_MS = 24 * HOUR_MS;
const PAST_SCHEDULE_TTL_MS = 365 * 24 * HOUR_MS; // finished seasons never change
const TEAM_STATS_TTL_MS = 24 * HOUR_MS; // season totals, one game barely moves them
const INJURIES_TTL_MS = 24 * HOUR_MS;

// One upstream call covers every team; per-team views filter this cached list.
const getInjuries = () => cached("injuries", INJURIES_TTL_MS, fetchInjuries);
const STANDINGS_TTL_MS = 12 * HOUR_MS; // current season, while games are being played
const FROZEN_STANDINGS_TTL_MS = 30 * 24 * HOUR_MS; // regular season over, the table can't change
const PAST_STANDINGS_TTL_MS = 365 * 24 * HOUR_MS; // finished seasons never change
const REGULAR_SEASON_GAMES = 82;

// A CDN copy lives only as long as the cache entry has left, so it is never staler than the entry.
// Capped at an hour so per-request fields (roster age, availableSeasons) stay current.
const CDN_MAX_AGE_S = 60 * 60;
const STALE_CDN_AGE_S = 60; // old data served because upstream failed: retry soon
const cacheHeaders = (status, ttlLeftMs) => ({
  "X-Cache": status,
  "Cache-Control": `public, max-age=0, s-maxage=${status === "STALE" ? STALE_CDN_AGE_S : Math.min(Math.floor(ttlLeftMs / 1000), CDN_MAX_AGE_S)}`,
});

const getTeams = () => cached("teams", TEAMS_TTL_MS, fetchTeams);

app.get("/", (req, res) => {
  res.json({message: "NHL API is running"});
});

app.get("/api/schedule", async (req, res, next) => {
  try {
    const date = parseDate(req.query.date);
    assertDateInRange(date, SCHEDULE_DAYS_BACK, SCHEDULE_DAYS_AHEAD);
    const {data, status, ttlLeftMs} = await cached(
      `schedule:${date.key}`,
      (schedule) => scheduleTtlMs(schedule, todayEastern()),
      async () => ({
        from: date.key,
        days: await fetchSchedule(date),
      })
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams", async (req, res, next) => {
  try {
    const {data, status, ttlLeftMs} = await getTeams();
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/news", async (req, res, next) => {
  try {
    const {data, status, ttlLeftMs} = await cached("news", NEWS_TTL_MS, async () => {
      // Tag news items with our team ids; news still works if the team list is unavailable.
      let teamsByName = new Map();
      try {
        const {data: league} = await getTeams();
        teamsByName = new Map(league.teams.map((t) => [t.displayName, {id: t.id, abbreviation: t.abbreviation, displayName: t.displayName}]));
      } catch (err) {
        console.error("News: team list unavailable, teams will have no ids");
      }
      return fetchNews(teamsByName);
    });
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/standings", async (req, res, next) => {
  try {
    const season = parseSeason(req.query.season);
    const ttl =
      season === currentSeason()
        ? (result) => (result.standings.every((r) => r.gamesPlayed >= REGULAR_SEASON_GAMES) ? FROZEN_STANDINGS_TTL_MS : STANDINGS_TTL_MS)
        : PAST_STANDINGS_TTL_MS;
    const {data, status, ttlLeftMs} = await cached(`standings:${season}`, ttl, async () => ({
      season: {season, name: seasonName(season)},
      standings: await fetchStandings(season),
    }));
    res.set(cacheHeaders(status, ttlLeftMs)).json({...data, availableSeasons: availableSeasons()});
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    // Only real team ids reach the upstream API, so random ids can't burn quota.
    const {data: league} = await getTeams();
    if (!league.teams.some((t) => t.id === id)) {
      throw new HttpError(404, "team_not_found", "No NHL team with that id");
    }
    const {data, status, ttlLeftMs} = await cached(
      `teaminfo:${id}`,
      (info) => untilAfterNextGameMs(info.nextGame ? [Date.parse(info.nextGame.date)] : [], TEAM_INFO_MAX_TTL_MS),
      () => fetchTeamInfo(id)
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/schedule", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    const season = parseSeason(req.query.season);
    // Only real team ids reach the upstream API (it returns a 500 for unknown ids).
    const {data: league} = await getTeams();
    if (!league.teams.some((t) => t.id === id)) {
      throw new HttpError(404, "team_not_found", "No NHL team with that id");
    }
    const ttl =
      season === currentSeason()
        ? (schedule) => untilAfterNextGameMs(schedule.games.filter((g) => !g.status.completed).map((g) => Date.parse(g.date)), TEAM_SCHEDULE_MAX_TTL_MS)
        : PAST_SCHEDULE_TTL_MS;
    const {data, status, ttlLeftMs} = await cached(`teamschedule:${id}:${season}`, ttl, async () => ({
      season: {season, name: seasonName(season)},
      ...(await fetchTeamSchedule(id, season)),
    }));
    res.set(cacheHeaders(status, ttlLeftMs)).json({...data, availableSeasons: availableSeasons()});
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/stats", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    // Only real team ids reach the upstream API (it returns a 500 for unknown ids).
    const {data: league} = await getTeams();
    const team = league.teams.find((t) => t.id === id);
    if (!team) {
      throw new HttpError(404, "team_not_found", "No NHL team with that id");
    }
    // Upstream only serves the current season's stats.
    const {data, status, ttlLeftMs} = await cached(`teamstats:${id}`, TEAM_STATS_TTL_MS, async () => {
      const season = currentSeason();
      return {
        season: {season, name: seasonName(season)},
        team: {id: team.id, abbreviation: team.abbreviation, displayName: team.displayName, logo: team.logo},
        ...(await fetchTeamStats(id)),
      };
    });
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/players/:playerId/stats", async (req, res, next) => {
  try {
    const {id, playerId} = req.params;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    if (!/^\d{1,10}$/.test(playerId)) {
      throw new HttpError(400, "invalid_player_id", "player id must be a number");
    }
    const {data: league} = await getTeams();
    const team = league.teams.find((t) => t.id === id);
    if (!team) {
      throw new HttpError(404, "team_not_found", "No NHL team with that id");
    }
    // Only players on this team's roster reach the upstream API (it errors on unknown ids).
    const {data: roster} = await cached(`roster:${id}`, ROSTER_TTL_MS, () => fetchRoster(id));
    const player = roster.players.find((p) => p.id === playerId);
    if (!player) {
      throw new HttpError(404, "player_not_found", "No player with that id on this team's roster");
    }
    const isGoalie = Boolean(player.position && player.position.abbreviation === "G");
    const {data: cachedStats, status, ttlLeftMs} = await cached(`playerstats:${playerId}:${isGoalie ? "g" : "s"}`, PLAYER_STATS_TTL_MS, async () => ({
      updatedAt: new Date().toISOString(),
      stats: await fetchPlayerStats(playerId, isGoalie),
    }));
    res.set(cacheHeaders(status, ttlLeftMs)).json({
      player: {id: player.id, fullName: player.fullName, jersey: player.jersey, headshot: player.headshot, position: player.position},
      team: {id: team.id, abbreviation: team.abbreviation, displayName: team.displayName},
      scope: "totals", // upstream returns multi-season totals, not a single season
      updatedAt: cachedStats.updatedAt,
      stats: cachedStats.stats,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/injuries", async (req, res, next) => {
  try {
    const {data, status, ttlLeftMs} = await getInjuries();
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/injuries", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    const {data: league} = await getTeams();
    const team = league.teams.find((t) => t.id === id);
    if (!team) {
      throw new HttpError(404, "team_not_found", "No NHL team with that id");
    }
    // Teams with no injuries are absent upstream, so an empty list is a normal answer.
    const {data, status, ttlLeftMs} = await getInjuries();
    res.set(cacheHeaders(status, ttlLeftMs)).json({
      updated: data.updated,
      season: data.season,
      team: {id: team.id, abbreviation: team.abbreviation, displayName: team.displayName, logo: team.logo},
      injuries: data.injuries.filter((i) => i.team.id === id).map(({team: _team, ...rest}) => rest),
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/players", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    // Only real team ids reach the upstream API, so random ids can't burn quota.
    const {data: league} = await getTeams();
    if (!league.teams.some((t) => t.id === id)) {
      throw new HttpError(404, "team_not_found", "No NHL team with that id");
    }
    const {data, status, ttlLeftMs} = await cached(`roster:${id}`, ROSTER_TTL_MS, () => fetchRoster(id));
    // Age is derived per request so it stays right however long the roster is cached.
    const today = todayEastern();
    const players = data.players.map((p) => {
      const age = ageOn(p.dateOfBirth, today);
      return {...p, age: age === null ? p.age : age};
    });
    res.set(cacheHeaders(status, ttlLeftMs)).json({...data, players});
  } catch (err) {
    next(err);
  }
});

app.use((req, res, next) => {
  next(new HttpError(404, "not_found", "Route not found"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    err = new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!(err instanceof HttpError)) {
    console.error(err);
    err = new HttpError(500, "internal_error", "Something went wrong");
  }
  res.set(err.headers).status(err.status).json({error: {code: err.code, message: err.message}});
});

module.exports = app;
