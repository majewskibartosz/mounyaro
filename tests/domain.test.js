"use strict";
var test = require("node:test");
var assert = require("node:assert");
var DOMAIN = require("./extract.js").loadDomain();

var TODAY = "2026-08-07";

// DOMAIN is evaluated in a separate vm context, so arrays it returns have a
// foreign prototype; copy into this realm before deepStrictEqual.
function pluck(arr, key) {
  return Array.from(arr).map(function (e) { return e[key]; });
}

function trt(id, date, dose, pos, extra) {
  var e = { id: id, ts: date + "T10:00:00.000Z", date: date, substance: "trt", dose: dose, unit: "mg" };
  if (pos) { e.pos = pos; e.site = "belly_ul"; }
  return Object.assign(e, extra || {});
}

function mkState(sandbaggingOn, entries) {
  return { settings: { sandbagging: !!sandbaggingOn }, injLog: entries };
}

var LOG = [
  trt("a", "2026-08-01", 25, { x: -4, y: -4 }),
  trt("b", "2026-08-04", 25, { x: 4, y: -4 }),
  trt("c", "2026-08-06", 50, { x: 4, y: 4 }, { sandbag: true })
];

test("visibleInjLog: setting OFF filters flagged entries, keeps the rest", function () {
  var out = DOMAIN.visibleInjLog(mkState(false, LOG));
  assert.deepStrictEqual(pluck(out, "id"), ["a", "b"]);
});

test("visibleInjLog: setting ON returns everything", function () {
  var out = DOMAIN.visibleInjLog(mkState(true, LOG));
  assert.strictEqual(out.length, 3);
});

test("visibleInjLog: entries without the field are always visible (non-breaking)", function () {
  var out = DOMAIN.visibleInjLog(mkState(false, [trt("x", "2026-08-01", 25)]));
  assert.strictEqual(out.length, 1);
});

test("visibleInjLog: tolerates missing settings / missing injLog", function () {
  assert.deepStrictEqual(pluck(DOMAIN.visibleInjLog({ injLog: LOG }), "id"), ["a", "b"]);
  assert.strictEqual(DOMAIN.visibleInjLog({}).length, 0);
  assert.strictEqual(DOMAIN.visibleInjLog(null).length, 0);
});

test("recentInjPos: OFF drops sandbagged markers and recomputes order ranks", function () {
  var out = DOMAIN.recentInjPos(mkState(false, LOG), TODAY, 14, null);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(pluck(out, "date"), ["2026-08-04", "2026-08-01"]);
  assert.deepStrictEqual(pluck(out, "order"), [1, 2]);
  assert.ok(Array.from(out).every(function (r) { return r.sandbag === false; }));
});

test("recentInjPos: ON keeps sandbagged markers and flags them", function () {
  var out = DOMAIN.recentInjPos(mkState(true, LOG), TODAY, 14, null);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].date, "2026-08-06");
  assert.strictEqual(out[0].order, 1);
  assert.strictEqual(out[0].sandbag, true);
});

test("lastDoseAsOf: sandbagged latest dose only counts while ON", function () {
  assert.strictEqual(DOMAIN.lastDoseAsOf(mkState(false, LOG), "trt", TODAY).dose, 25);
  assert.strictEqual(DOMAIN.lastDoseAsOf(mkState(true, LOG), "trt", TODAY).dose, 50);
});

test("firstInjDateFor: sandbagged earliest entry only counts while ON", function () {
  var log = [trt("s", "2026-07-01", 25, null, { sandbag: true }), trt("n", "2026-07-10", 25)];
  assert.strictEqual(DOMAIN.firstInjDateFor(mkState(false, log), "trt"), "2026-07-10");
  assert.strictEqual(DOMAIN.firstInjDateFor(mkState(true, log), "trt"), "2026-07-01");
});

test("doseStreakAsOf: a sandbagged dose change is invisible while OFF", function () {
  var log = [
    trt("a", "2026-07-01", 25),
    trt("b", "2026-07-08", 25),
    trt("c", "2026-07-15", 50, null, { sandbag: true })
  ];
  var off = DOMAIN.doseStreakAsOf(mkState(false, log), "trt", "2026-07-20");
  assert.strictEqual(off.dose, 25);
  assert.strictEqual(off.sinceISO, "2026-07-01");
  var on = DOMAIN.doseStreakAsOf(mkState(true, log), "trt", "2026-07-20");
  assert.strictEqual(on.dose, 50);
});

test('seriesFor("inj:trt"): sandbagged points excluded while OFF', function () {
  assert.strictEqual(DOMAIN.seriesFor(mkState(false, LOG), "inj:trt").length, 2);
  assert.strictEqual(DOMAIN.seriesFor(mkState(true, LOG), "inj:trt").length, 3);
});

test("spotCheck via recentInjPos: a spot next to a hidden sandbagged shot is fine while OFF", function () {
  var log = [trt("c", "2026-08-06", 50, { x: 4, y: 4 }, { sandbag: true })];
  var near = { x: 4.5, y: 4.5 }; // ~0.7 cm from the sandbagged shot, far from navel
  var recOff = DOMAIN.recentInjPos(mkState(false, log), TODAY, 14, null);
  assert.strictEqual(DOMAIN.spotCheck(near, recOff).ok, true);
  var recOn = DOMAIN.recentInjPos(mkState(true, log), TODAY, 14, null);
  var chk = DOMAIN.spotCheck(near, recOn);
  assert.strictEqual(chk.ok, false);
  assert.strictEqual(chk.nearShot, true);
});

test("suggestSpot via recentInjPos: hidden sandbagged shots don't repel the suggestion", function () {
  var log = [trt("c", "2026-08-06", 50, { x: 8, y: 0 }, { sandbag: true })];
  var sugOff = DOMAIN.suggestSpot(DOMAIN.recentInjPos(mkState(false, log), TODAY, 14, null));
  var sugOn = DOMAIN.suggestSpot(DOMAIN.recentInjPos(mkState(true, log), TODAY, 14, null));
  assert.ok(sugOff && sugOn);
  // with the shot visible the suggestion must respect the 3 cm rule around it
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  assert.ok(dist(sugOn, { x: 8, y: 0 }) >= DOMAIN.SPOT_MIN_CM);
});
