// Which of Supercrit's features are on, set from the popup. Everything starts on; a key missing from
// what's stored (a feature added since the user last saved) takes its default.
// Shape: { ratings, filters, marks }, all booleans.
const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS = Object.freeze({
  ratings: true, // the badge on each film card, and the score line under the title on film pages
  filters: true, // the Letterboxd group in All Films' filter panel
  marks: true, // the user's watched/watchlist marks, on badges and the detail line
});

function normalizeSettings(raw) {
  const settings = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    settings[key] = typeof raw?.[key] === "boolean" ? raw[key] : fallback;
  }
  return settings;
}

if (typeof module !== "undefined") {
  module.exports = { SETTINGS_KEY, DEFAULT_SETTINGS, normalizeSettings };
}
