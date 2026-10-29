const {HttpError} = require("./errors");

const MIN_SEASON = 2021; // 2021-22, first season with the current 32-team alignment

function easternParts() {
  const [year, month] = new Intl.DateTimeFormat("en-CA", {timeZone: "America/New_York", year: "numeric", month: "2-digit"})
    .format(new Date())
    .split("-")
    .map(Number);
  return {year, month};
}

// A season is named by its start year (2026 = 2026-27). New seasons begin in October;
// until then the last completed season is the current one.
function currentSeason() {
  const {year, month} = easternParts();
  return month >= 10 ? year : year - 1;
}

const seasonName = (start) => `${start}-${String(start + 1).slice(2)}`;

function parseSeason(input) {
  const current = currentSeason();
  if (input === undefined) return current;
  const n = typeof input === "string" && /^\d{4}$/.test(input) ? Number(input) : NaN;
  if (!(n >= MIN_SEASON && n <= current)) {
    throw new HttpError(400, "invalid_season", `season must be a start year from ${MIN_SEASON} to ${current}, e.g. ${current} for ${seasonName(current)}`);
  }
  return n;
}

function availableSeasons() {
  const out = [];
  for (let s = currentSeason(); s >= MIN_SEASON; s--) out.push({season: s, name: seasonName(s)});
  return out;
}

module.exports = {currentSeason, parseSeason, availableSeasons, seasonName};
