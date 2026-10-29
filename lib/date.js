const {HttpError} = require("./errors");

// NHL game days follow US Eastern time.
function todayEastern() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // YYYY-MM-DD
}

function parseDate(input) {
  const value = input === undefined ? todayEastern() : input;
  const match = typeof value === "string" && /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!match) {
    throw new HttpError(400, "invalid_date", "date must be in YYYY-MM-DD format");
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new HttpError(400, "invalid_date", "date is not a real calendar date");
  }
  const pad = (n) => String(n).padStart(2, "0");
  return {year: String(year), month: pad(month), day: pad(day), key: `${year}-${pad(month)}-${pad(day)}`};
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

// Each distinct date costs an upstream call, so only dates near today are accepted.
function assertDateInRange(date, daysBack, daysAhead) {
  const offset = dayNumber(date.key) - dayNumber(todayEastern());
  if (offset < -daysBack || offset > daysAhead) {
    throw new HttpError(400, "date_out_of_range", `date must be from ${daysBack} day ago to ${daysAhead} days ahead of today`);
  }
}

// Age in whole years on todayKey (YYYY-MM-DD), from an ISO birth date; null if it can't be read.
function ageOn(dateOfBirth, todayKey) {
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth || "");
  if (!b) return null;
  const [year, month, day] = todayKey.split("-").map(Number);
  const age = year - Number(b[1]) - (month < Number(b[2]) || (month === Number(b[2]) && day < Number(b[3])) ? 1 : 0);
  return age >= 0 ? age : null;
}

module.exports = {parseDate, todayEastern, assertDateInRange, ageOn};
