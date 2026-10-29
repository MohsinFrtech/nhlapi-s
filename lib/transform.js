const {HttpError} = require("./errors");
const {alignment} = require("./conferences");

function record(competitor, type) {
  const r = (competitor.records || []).find((x) => x.type === type);
  return r ? r.summary : null;
}

function team(c) {
  const t = c.team || {};
  const goalie = (c.probables || []).find((p) => p.name === "probableStartingGoalie");
  return {
    id: t.id || c.id || null,
    name: t.displayName || null,
    shortName: t.shortDisplayName || null,
    abbreviation: t.abbreviation || null,
    logo: t.logo || null,
    logoDark: t.logoDark || null,
    color: t.color || null,
    score: c.score === undefined ? null : Number(c.score),
    record: record(c, "total"),
    startingGoalie: goalie && goalie.athlete ? goalie.athlete.displayName || null : null,
  };
}

function game(g) {
  const comp = (g.competitions || [])[0] || {};
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  const venue = comp.venue || {};
  const status = comp.status && comp.status.type ? comp.status.type : null;
  return {
    id: String(g.uid || "").split("~e:")[1] || null,
    name: g.name || null,
    date: g.date || comp.date || null,
    status: status ? {state: status.state || null, detail: status.detail || status.description || null} : null,
    venue: venue.fullName
      ? {name: venue.fullName, city: venue.address && venue.address.city || null, state: venue.address && venue.address.state || null}
      : null,
    broadcasts: (comp.broadcasts || []).map((b) => ({market: b.market, names: b.names})),
    home: home ? team(home) : null,
    away: away ? team(away) : null,
  };
}

// Upstream returns the requested day and the days after it, keyed by YYYYMMDD.
// Reduce each day to the fields the app needs, sorted by date.
function trimSchedule(raw) {
  const days = [];
  for (const [k, day] of Object.entries(raw)) {
    if (!/^\d{8}$/.test(k) || !day || !Array.isArray(day.games)) continue;
    const date = `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
    days.push({date, games: day.games.map(game)});
  }
  if (days.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function logo(t, ...rels) {
  const l = (t.logos || []).find((x) => rels.length === x.rel.filter((r) => r !== "full").length && rels.every((r) => x.rel.includes(r)));
  return l ? l.href : null;
}

function trimTeams(raw) {
  const league = raw && Array.isArray(raw.sports) && raw.sports[0] && (raw.sports[0].leagues || [])[0];
  if (!league || !Array.isArray(league.teams) || league.teams.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const teams = league.teams
    .map((x) => x.team)
    .filter((t) => t && t.id && t.isActive !== false)
    .map((t) => ({
      id: t.id,
      abbreviation: t.abbreviation || null,
      name: t.name || null,
      displayName: t.displayName || null,
      shortDisplayName: t.shortDisplayName || null,
      location: t.location || null,
      slug: t.slug || null,
      color: t.color || null,
      alternateColor: t.alternateColor || null,
      logo: logo(t, "default"),
      logoDark: logo(t, "dark"),
      logoScoreboard: logo(t, "scoreboard"),
      logoScoreboardDark: logo(t, "scoreboard", "dark"),
    }))
    .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
  return {season: league.season && league.season.displayName || null, teams};
}

const POSITION_ORDER = ["C", "LW", "RW", "D", "G"];

function player(a) {
  const pos = a.position || {};
  const birth = a.birthPlace || {};
  return {
    id: a.id,
    fullName: a.fullName || a.displayName || null,
    shortName: a.shortName || null,
    jersey: a.jersey || null,
    headshot: a.headshot || null,
    position: pos.abbreviation ? {abbreviation: pos.abbreviation, name: pos.displayName || pos.name || null} : null,
    age: typeof a.age === "number" ? a.age : null,
    dateOfBirth: a.dateOfBirth || null,
    birthPlace: birth.city || birth.country ? {city: birth.city || null, country: birth.country || null} : null,
    citizenship: a.citizenship || null,
    height: a.displayHeight || null,
    weight: a.displayWeight || null,
  };
}

function positionRank(p) {
  const i = POSITION_ORDER.indexOf(p.position && p.position.abbreviation);
  return i === -1 ? POSITION_ORDER.length : i;
}

function trimRoster(raw) {
  const t = raw && raw.team;
  if (!t || !t.id || !Array.isArray(t.athletes) || t.athletes.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const players = t.athletes
    .filter((a) => a && a.id)
    .map(player)
    .sort((a, b) => positionRank(a) - positionRank(b) || (Number(a.jersey) || 999) - (Number(b.jersey) || 999));
  return {
    team: {id: t.id, abbreviation: t.abbreviation || null, displayName: t.displayName || null},
    players,
  };
}

function newsType(link) {
  if (/\/preview\?/.test(link)) return "preview";
  if (/\/recap\?/.test(link)) return "recap";
  if (/\/video\//.test(link)) return "video";
  if (/\/story\//.test(link)) return "story";
  return "other";
}

// Real photos first (up to 3); previews/recaps without one fall back to a single generated graphic.
function newsImages(images) {
  const list = Array.isArray(images) ? images.filter((i) => typeof i === "string") : [];
  const photos = list.filter((i) => !i.includes("/stitcher/"));
  if (photos.length) return photos.slice(0, 3);
  const graphic = list.find((i) => i.includes("espn.all.awayhome.16x9.1")) || list[0];
  return graphic ? [graphic] : [];
}

// teamsByName: Map of team displayName -> {id, abbreviation, displayName} from /api/teams.
function trimNews(raw, teamsByName = new Map()) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const items = raw
    .filter((n) => n && n.headline && n.link && n.published && !n.premium)
    .map((n) => {
      const cats = Array.isArray(n.categories) ? n.categories : [];
      return {
        headline: n.headline,
        description: n.description || null,
        link: n.link.replace(/^http:\/\//, "https://"),
        type: newsType(n.link),
        published: n.published,
        images: newsImages(n.images),
        teams: cats
          .filter((c) => c.type === "team")
          .map((c) => teamsByName.get(c.description) || {id: null, abbreviation: null, displayName: c.description}),
        athletes: cats.filter((c) => c.type === "athlete").map((c) => c.description),
      };
    })
    .sort((a, b) => b.published.localeCompare(a.published));
  if (items.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return {fetchedAt: new Date().toISOString(), items};
}

function statMap(entry) {
  const m = {};
  for (const st of entry.stats || []) if (st && st.name && !(st.name in m)) m[st.name] = st;
  return m;
}

const num = (st) => (st && typeof st.value === "number" ? st.value : null);

// Same order the upstream seeds by: points, then fewer games played, then regulation wins, then goal differential.
function byStanding(a, b) {
  return (
    b.points - a.points ||
    a.gamesPlayed - b.gamesPlayed ||
    (b.regulationWins || 0) - (a.regulationWins || 0) ||
    (b.goalDifferential || 0) - (a.goalDifferential || 0)
  );
}

function rankWithin(rows, keyFn, field) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const list of groups.values()) list.sort(byStanding).forEach((r, i) => (r[field] = i + 1));
}

function trimStandings(raw) {
  const st = raw && raw.standings;
  if (!st || !Array.isArray(st.entries) || st.entries.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const rows = st.entries
    .filter((e) => e && e.team && e.team.id)
    .map((e) => {
      const t = e.team;
      const s = statMap(e);
      const logo = (t.logos || []).find((l) => (l.rel || []).includes("default"));
      const gp = num(s.gamesPlayed);
      const points = num(s.points);
      const clincher = s.clincher && s.clincher.displayValue ? {code: s.clincher.displayValue, description: s.clincher.description || null} : null;
      return {
        rank: null,
        conferenceRank: null,
        divisionRank: null,
        team: {id: t.id, abbreviation: t.abbreviation || null, displayName: t.displayName || null, logo: logo ? logo.href : null},
        ...alignment(t.id),
        gamesPlayed: gp,
        wins: num(s.wins),
        losses: num(s.losses),
        otLosses: num(s.otLosses),
        record: s.overall && s.overall.summary || null,
        points,
        pointsPct: gp ? Math.round((points / (2 * gp)) * 1000) / 1000 : null,
        regulationWins: num(s.regWins),
        overtimeWins: num(s.overtimeWins),
        goalDifferential: num(s.pointDifferential),
        powerPlayPct: s.powerPlayPct ? Math.round(s.powerPlayPct.value * 10) / 10 : null,
        penaltyKillPct: s.penaltyKillPct ? Math.round(s.penaltyKillPct.value * 10) / 10 : null,
        clinch: clincher,
      };
    })
    .filter((r) => r.points !== null && r.gamesPlayed !== null);
  if (rows.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  rows.sort(byStanding).forEach((r, i) => (r.rank = i + 1));
  rankWithin(rows, (r) => r.conference, "conferenceRank");
  rankWithin(rows, (r) => (r.division ? `${r.conference}/${r.division}` : null), "divisionRank");
  return rows;
}

function scheduleSide(c) {
  const t = c.team || {};
  const logo = (t.logos || []).find((l) => (l.rel || []).includes("default"));
  const ytd = (c.record || []).find((r) => r.type === "ytd");
  const goalie = (c.probables || []).find((p) => p.name === "probableStartingGoalie");
  return {
    id: t.id || c.id || null,
    abbreviation: t.abbreviation || null,
    displayName: t.displayName || null,
    logo: logo ? logo.href : null,
    score: c.score && typeof c.score.value === "number" ? c.score.value : null,
    winner: typeof c.winner === "boolean" ? c.winner : null,
    record: ytd && ytd.displayValue ? ytd.displayValue.split(",")[0] : null,
    startingGoalie: goalie && goalie.athlete ? goalie.athlete.displayName || null : null,
  };
}

function teamGame(ev, teamId) {
  const comp = (ev.competitions || [])[0] || {};
  const competitors = comp.competitors || [];
  const homeC = competitors.find((c) => c.homeAway === "home");
  const awayC = competitors.find((c) => c.homeAway === "away");
  const home = homeC ? scheduleSide(homeC) : null;
  const away = awayC ? scheduleSide(awayC) : null;
  const type = (comp.status && comp.status.type) || {};
  const completed = type.completed === true;
  const mine = home && home.id === teamId ? home : away && away.id === teamId ? away : null;
  let result = null;
  if (completed && mine && typeof mine.winner === "boolean") {
    result = mine.winner ? "W" : /\/(OT|SO)\b/.test(type.detail || "") ? "OTL" : "L";
  }
  const venue = comp.venue || {};
  return {
    id: ev.id,
    date: ev.date || comp.date || null,
    status: {state: type.state || null, detail: type.detail || null, completed},
    homeAway: home && home.id === teamId ? "home" : "away",
    result,
    home,
    away,
    venue: venue.fullName
      ? {name: venue.fullName, city: venue.address && venue.address.city || null, state: venue.address && venue.address.state || null}
      : null,
    broadcasts: (comp.broadcasts || [])
      .filter((b) => b.media && b.media.shortName)
      .map((b) => ({market: String(b.market && b.market.type || "").toLowerCase() || null, name: b.media.shortName, type: b.type && b.type.shortName || null})),
  };
}

function trimTeamSchedule(raw) {
  const t = raw && raw.team;
  if (!t || !t.id || !Array.isArray(raw.events) || raw.events.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const logo = typeof t.logo === "string" ? t.logo : null;
  return {
    team: {id: t.id, abbreviation: t.abbreviation || null, displayName: t.displayName || null, logo, color: t.color || null},
    games: raw.events
      .filter((e) => e && e.id)
      .map((e) => teamGame(e, t.id))
      .sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };
}

const round = (n, d) => (typeof n === "number" ? Math.round(n * 10 ** d) / 10 ** d : null);

// Upstream gives team totals only and no team identity; per-game values are computed
// here because the upstream's perGameValue fields are unreliable (e.g. goals/game rounded to an integer).
function trimTeamStats(raw) {
  const cats = raw && raw.stats && raw.stats.categories;
  if (!Array.isArray(cats)) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const st = {};
  for (const c of cats) for (const x of (c && c.stats) || []) if (x && x.name && !(x.name in st)) st[x.name] = x;
  const v = (name) => (st[name] && typeof st[name].value === "number" ? st[name].value : null);
  const gp = v("games");
  if (gp === null || v("wins") === null || v("goals") === null) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const perGame = (name) => (gp > 0 ? round(v(name) / gp, 2) : null);
  return {
    gamesPlayed: gp,
    record: {wins: v("wins"), losses: v("losses"), otLosses: v("overtimeLosses")},
    offense: {
      goals: v("goals"),
      assists: v("assists"),
      shots: v("shotsTotal"),
      shootingPct: round(v("shootingPct"), 1),
      powerPlayGoals: v("powerPlayGoals"),
      powerPlayAssists: v("powerPlayAssists"),
      shortHandedGoals: v("shortHandedGoals"),
      shortHandedAssists: v("shortHandedAssists"),
      faceoffsWon: v("faceoffsWon"),
      faceoffsLost: v("faceoffsLost"),
      faceoffPct: round(v("faceoffPercent"), 1),
    },
    defense: {
      goalsAgainst: v("goalsAgainst"),
      shotsAgainst: v("shotsAgainst"),
      saves: v("saves"),
      savePct: round(v("savePct"), 3),
    },
    penalties: {penaltyMinutes: v("penaltyMinutes")},
    perGame: {
      goals: perGame("goals"),
      goalsAgainst: perGame("goalsAgainst"),
      shots: perGame("shotsTotal"),
      shotsAgainst: perGame("shotsAgainst"),
      penaltyMinutes: perGame("penaltyMinutes"),
    },
  };
}

// Upstream returns totals across seasons (it ignores any season param) in categories
// that repeat some stat names; the first occurrence of a name is the real one.
function trimPlayerStats(raw, isGoalie) {
  const cats = raw && raw.categories;
  if (!Array.isArray(cats)) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const st = {};
  for (const c of cats) for (const x of (c && c.stats) || []) if (x && x.name && !(x.name in st)) st[x.name] = x;
  const v = (name) => (st[name] && typeof st[name].value === "number" ? st[name].value : null);
  const gp = v("games");
  if (gp === null) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  if (isGoalie) {
    return {
      gamesPlayed: gp,
      gamesStarted: v("gameStarted"),
      wins: v("wins"),
      losses: v("losses"),
      otLosses: v("overtimeLosses"),
      goalsAgainst: v("goalsAgainst"),
      goalsAgainstAverage: round(v("avgGoalsAgainst"), 2),
      shotsAgainst: v("shotsAgainst"),
      saves: v("saves"),
      savePct: round(v("savePct"), 3),
      shutouts: v("shutouts"),
    };
  }
  const faceoffs = (v("faceoffsWon") || 0) + (v("faceoffsLost") || 0);
  const points = v("points");
  return {
    gamesPlayed: gp,
    goals: v("goals"),
    assists: v("assists"),
    points,
    plusMinus: v("plusMinus"),
    shots: v("shotsTotal"),
    shootingPct: round(v("shootingPct"), 1),
    powerPlayGoals: v("powerPlayGoals"),
    powerPlayAssists: v("powerPlayAssists"),
    shortHandedGoals: v("shortHandedGoals"),
    shortHandedAssists: v("shortHandedAssists"),
    gameWinningGoals: v("gameWinningGoals"),
    hits: v("hits"),
    blockedShots: v("blockedShots"),
    penaltyMinutes: v("penaltyMinutes"),
    faceoffsWon: faceoffs ? v("faceoffsWon") : null,
    faceoffsLost: faceoffs ? v("faceoffsLost") : null,
    // Upstream's faceoffPercent doesn't match won/lost, so derive it.
    faceoffPct: faceoffs ? round(((v("faceoffsWon") || 0) / faceoffs) * 100, 1) : null,
    timeOnIcePerGame: st.timeOnIcePerGame && st.timeOnIcePerGame.displayValue || null,
    pointsPerGame: gp > 0 && points !== null ? round(points / gp, 2) : null,
  };
}

// The upstream gives no athlete id field, only the id inside the player card link
// (same id the roster endpoint uses).
function athleteId(a) {
  const link = (a.links || []).find((l) => (l.rel || []).includes("playercard") && (l.rel || []).includes("desktop"));
  const m = link && /\/id\/(\d+)/.exec(link.href || "");
  return m ? m[1] : null;
}

// Upstream lists every team with injuries (teams with none are omitted) in one payload.
function trimInjuries(raw) {
  if (!raw || !Array.isArray(raw.injuries) || (raw.status && raw.status !== "success")) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const injuries = [];
  for (const t of raw.injuries) {
    for (const i of (t && t.injuries) || []) {
      const a = i.athlete || {};
      const team = a.team || t;
      const details = i.details || {};
      injuries.push({
        player: {
          id: athleteId(a),
          fullName: a.displayName || null,
          shortName: a.shortName || null,
          position: a.position && a.position.abbreviation ? {abbreviation: a.position.abbreviation, name: a.position.displayName || a.position.name || null} : null,
          headshot: a.headshot && a.headshot.href || null,
        },
        team: {id: team.id || t.id || null, abbreviation: team.abbreviation || null, displayName: team.displayName || t.displayName || null},
        status: i.status || null,
        statusCode: i.type && i.type.abbreviation || null,
        injuryType: details.type || null,
        estimatedReturn: details.returnDate || null,
        date: i.date || null,
        summary: i.shortComment || null,
        details: i.longComment || null,
      });
    }
  }
  injuries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const season = raw.season && typeof raw.season.year === "number" ? {season: raw.season.year - 1, name: raw.season.displayName || null} : null;
  return {updated: raw.timestamp || null, season, injuries};
}

// Pick the stats the app shows from upstream's flat [{name, value}] list.
const TEAM_RECORD_STATS = ["gamesPlayed", "wins", "losses", "otLosses", "points", "pointsFor", "pointsAgainst", "pointsDiff", "streak", "playoffSeed", "powerPlayGoals", "powerPlayOpportunities", "powerPlayGoalsAgainst", "timesShortHanded"];

function trimTeamInfo(raw) {
  const t = raw && raw.team;
  if (!t || !t.id) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const overall = ((t.record && t.record.items) || []).find((r) => r.type === "total");
  const stats = {};
  for (const s of (overall && overall.stats) || []) {
    if (TEAM_RECORD_STATS.includes(s.name)) stats[s.name] = num(s);
  }
  const venue = t.franchise && t.franchise.venue;
  const img = venue && (venue.images || [])[0];
  const ev = (t.nextEvent || [])[0];
  const comp = ev && (ev.competitions || [])[0];
  const opponent = comp && (comp.competitors || []).find((c) => c.team && c.team.id !== t.id);
  const status = comp && comp.status && comp.status.type;
  return {
    id: t.id,
    abbreviation: t.abbreviation || null,
    name: t.name || null,
    displayName: t.displayName || null,
    shortDisplayName: t.shortDisplayName || null,
    location: t.location || null,
    slug: t.slug || null,
    color: t.color || null,
    alternateColor: t.alternateColor || null,
    logo: logo(t, "default"),
    logoDark: logo(t, "dark"),
    logoScoreboard: logo(t, "scoreboard"),
    logoScoreboardDark: logo(t, "scoreboard", "dark"),
    standingSummary: t.standingSummary || null,
    record: {summary: overall ? overall.summary || null : null, ...stats},
    venue: venue && venue.fullName
      ? {
          name: venue.fullName,
          city: venue.address && venue.address.city || null,
          state: venue.address && venue.address.state || null,
          image: img && img.href || null,
        }
      : null,
    nextGame: ev
      ? {
          id: ev.id || null,
          name: ev.name || null,
          date: ev.date || null,
          status: status ? {state: status.state || null, detail: status.detail || status.description || null} : null,
          homeAway: opponent ? (opponent.homeAway === "home" ? "away" : "home") : null,
          venue: comp.venue && comp.venue.fullName || null,
          broadcasts: (comp.broadcasts || []).map((b) => b.media && b.media.shortName).filter(Boolean),
          opponent: opponent
            ? {
                id: opponent.team.id,
                abbreviation: opponent.team.abbreviation || null,
                displayName: opponent.team.displayName || null,
                logo: logo(opponent.team, "default"),
                logoDark: logo(opponent.team, "dark"),
              }
            : null,
        }
      : null,
  };
}

module.exports = {trimSchedule, trimTeams, trimRoster, trimNews, trimStandings, trimTeamSchedule, trimTeamStats, trimPlayerStats, trimInjuries, trimTeamInfo};
