const {HttpError} = require("./errors");
const {reserveUpstreamCall} = require("./budget");
const {trimSchedule, trimTeams, trimRoster, trimNews, trimStandings, trimTeamSchedule, trimTeamStats, trimPlayerStats, trimInjuries, trimTeamInfo} = require("./transform");

const TIMEOUT_MS = 8000;
const LARGE_TIMEOUT_MS = 20000; // for multi-MB upstream payloads

function config() {
  const {NHL_API_URL, NHL_API_HOST, NHL_API_TOKEN} = process.env;
  if (!NHL_API_URL || !NHL_API_HOST || !NHL_API_TOKEN) {
    console.error("Missing NHL_API_URL, NHL_API_HOST or NHL_API_TOKEN");
    throw new HttpError(500, "server_misconfigured", "Server is not configured correctly");
  }
  return {NHL_API_URL, NHL_API_HOST, NHL_API_TOKEN};
}

async function request(path, params = {}, timeoutMs = TIMEOUT_MS) {
  const {NHL_API_URL, NHL_API_HOST, NHL_API_TOKEN} = config();
  await reserveUpstreamCall(); // counts the call against the monthly limit, or refuses once it is reached
  const url = new URL(path, NHL_API_URL);
  url.search = new URLSearchParams(params).toString();

  let res;
  try {
    res = await fetch(url, {
      headers: {"x-rapidapi-key": NHL_API_TOKEN, "x-rapidapi-host": NHL_API_HOST},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError";
    console.error("Upstream request failed:", err.message);
    throw new HttpError(
      timedOut ? 504 : 502,
      timedOut ? "upstream_timeout" : "upstream_unreachable",
      timedOut ? "Upstream API timed out" : "Could not reach upstream API"
    );
  }

  if (res.status === 429) {
    console.error("Upstream rate limit / quota exceeded");
    throw new HttpError(503, "upstream_rate_limited", "Upstream API limit reached, try again later", {"Retry-After": "300"});
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`Upstream rejected credentials (${res.status})`);
    throw new HttpError(502, "upstream_auth_failed", "Upstream API request failed");
  }
  if (!res.ok) {
    console.error(`Upstream returned ${res.status}`);
    throw new HttpError(502, "upstream_error", "Upstream API request failed");
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned invalid data");
  }
  if (!data || typeof data !== "object") {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return data;
}

const fetchSchedule = async (date) => trimSchedule(await request("/nhlschedule", {year: date.year, month: date.month, day: date.day}));
const fetchTeams = async () => trimTeams(await request("/nhlteamlist"));
const fetchRoster = async (teamId) => trimRoster(await request("/nhlteamplayers", {teamid: teamId}));
const fetchNews = async (teamsByName) => trimNews(await request("/news"), teamsByName);
const fetchStandings = async (season) => trimStandings(await request("/nhlstandings", {year: String(season + 1)}));
const fetchTeamSchedule = async (teamId, season) =>
  trimTeamSchedule(await request("/schedule-team", {season: String(season + 1), teamId}, LARGE_TIMEOUT_MS));
const fetchTeamStats = async (teamId) => trimTeamStats(await request("/team-statistic", {teamId}));
const fetchPlayerStats = async (playerId, isGoalie) => trimPlayerStats(await request("/player-statistic", {playerId}), isGoalie);
const fetchInjuries = async () => trimInjuries(await request("/injuries", {}, LARGE_TIMEOUT_MS));
const fetchTeamInfo = async (teamId) => trimTeamInfo(await request("/nhlteaminfo", {teamid: teamId}));

module.exports = {fetchTeamInfo, fetchSchedule, fetchTeams, fetchRoster, fetchNews, fetchStandings, fetchTeamSchedule, fetchTeamStats, fetchPlayerStats, fetchInjuries};
