const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const LIVE_MS = 10 * MINUTE_MS; // a game is in progress, scores change
const LATE_START_MS = 5 * MINUTE_MS; // start time passed but the game isn't live yet
const PRE_GAME_CAP_MS = HOUR_MS; // re-check for time changes and postponements
const UNSETTLED_MS = HOUR_MS; // no games, or a postponed/cancelled one
const FINAL_MS = 30 * DAY_MS; // every game is over, nothing will change
const FUTURE_MS = DAY_MS;

// How long to cache a schedule, based on the state of the requested day's games.
// `today` is the current Eastern date (YYYY-MM-DD), `now` is epoch ms.
function scheduleTtlMs(schedule, today, now = Date.now()) {
  if (schedule.from > today) return FUTURE_MS;

  const day = schedule.days.find((d) => d.date === schedule.from);
  const games = (day && day.games) || [];
  if (games.length === 0) return UNSETTLED_MS;

  const states = games.map((g) => g.status && g.status.state);
  if (states.includes("in")) return LIVE_MS;

  const odd = games.some((g) => !["pre", "post"].includes(g.status && g.status.state) || /postpone|cancel|suspend/i.test((g.status && g.status.detail) || ""));
  if (odd) return UNSETTLED_MS;

  if (states.every((s) => s === "post")) return FINAL_MS;

  // Some games haven't started: cache until the earliest puck drop (at most an hour).
  const starts = games.filter((g) => g.status.state === "pre").map((g) => Date.parse(g.date)).filter(Number.isFinite);
  if (starts.length === 0) return UNSETTLED_MS;
  const untilStart = Math.min(...starts) - now;
  if (untilStart <= 0) return LATE_START_MS;
  return Math.min(Math.max(untilStart, MINUTE_MS), PRE_GAME_CAP_MS);
}

const AFTER_GAME_MS = 6 * HOUR_MS; // by then the game is over and results are in
const MIN_REFRESH_MS = 30 * MINUTE_MS;

// For team pages: cache until 6 hours after the next puck drop, but no longer than capMs.
// `starts` are puck-drop times (epoch ms) of games not yet completed; ones whose window
// has already passed (postponed, unresolved) are ignored so they can't cause constant refreshes.
function untilAfterNextGameMs(starts, capMs, now = Date.now()) {
  const ends = starts.filter(Number.isFinite).map((s) => s + AFTER_GAME_MS).filter((e) => e > now);
  if (ends.length === 0) return capMs;
  return Math.min(Math.max(Math.min(...ends) - now, MIN_REFRESH_MS), capMs);
}

module.exports = {scheduleTtlMs, untilAfterNextGameMs};
