// The standings API has no conference/division data, so this maps ESPN team ids
// to the current NHL alignment (same since 2021-22; Arizona became Utah in 2024).
const E = "Eastern";
const W = "Western";

const TEAMS = {
  // Atlantic
  1: [E, "Atlantic"], 2: [E, "Atlantic"], 5: [E, "Atlantic"], 26: [E, "Atlantic"],
  10: [E, "Atlantic"], 14: [E, "Atlantic"], 20: [E, "Atlantic"], 21: [E, "Atlantic"],
  // Metropolitan
  7: [E, "Metropolitan"], 29: [E, "Metropolitan"], 11: [E, "Metropolitan"], 12: [E, "Metropolitan"],
  13: [E, "Metropolitan"], 15: [E, "Metropolitan"], 16: [E, "Metropolitan"], 23: [E, "Metropolitan"],
  // Central (24 = Arizona Coyotes, 129764 = Utah)
  4: [W, "Central"], 17: [W, "Central"], 9: [W, "Central"], 30: [W, "Central"],
  27: [W, "Central"], 19: [W, "Central"], 28: [W, "Central"], 24: [W, "Central"], 129764: [W, "Central"],
  // Pacific
  25: [W, "Pacific"], 3: [W, "Pacific"], 6: [W, "Pacific"], 8: [W, "Pacific"],
  18: [W, "Pacific"], 124292: [W, "Pacific"], 22: [W, "Pacific"], 37: [W, "Pacific"],
};

function alignment(teamId) {
  const t = TEAMS[teamId];
  return t ? {conference: t[0], division: t[1]} : {conference: null, division: null};
}

module.exports = {alignment};
