const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_SETTINGS, normalizeSettings } = require("../lib/settings.js");

test("normalizeSettings: everything is on when nothing is stored", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
});

test("normalizeSettings: keeps stored choices and defaults the rest", () => {
  assert.deepEqual(normalizeSettings({ ratings: false }), { ...DEFAULT_SETTINGS, ratings: false });
  assert.deepEqual(normalizeSettings({ filters: false, marks: false }), {
    ...DEFAULT_SETTINGS,
    filters: false,
    marks: false,
  });
});

test("normalizeSettings: ignores non-booleans and unknown keys", () => {
  assert.deepEqual(normalizeSettings({ filters: "no", ratings: 0, taste: false }), DEFAULT_SETTINGS);
});
