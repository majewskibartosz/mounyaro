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

test("doseStreakAsOf: same mg but a new injection interval breaks the streak", function () {
  var log = [
    trt("a", "2026-07-01", 25, null, { every: 2 }),
    trt("b", "2026-07-03", 25, null, { every: 2 }),
    trt("c", "2026-07-10", 25, null, { every: 1 }),
    trt("d", "2026-07-11", 25, null, { every: 1 })
  ];
  var s = DOMAIN.doseStreakAsOf(mkState(false, log), "trt", "2026-07-20");
  assert.strictEqual(s.dose, 25);
  assert.strictEqual(s.every, 1);
  assert.strictEqual(s.sinceISO, "2026-07-10");
  assert.strictEqual(s.weeks, 2);
});

// Supersedes "first stamped entry after legacy unstamped ones starts a new
// streak". A stamp used to appear only where a schedule change had been marked
// by hand, so the first one ended the previous run. Intervals are now frozen
// onto past shots automatically, with the value that was already in force, so
// an unstamped -> stamped step says nothing about the schedule any more.
test("doseStreakAsOf: an unrecorded interval is unknown, not a change", function () {
  var log = [
    trt("a", "2026-07-01", 25),
    trt("b", "2026-07-03", 25),
    trt("c", "2026-07-10", 25, null, { every: 1 })
  ];
  var s = DOMAIN.doseStreakAsOf(mkState(false, log), "trt", "2026-07-12");
  assert.strictEqual(s.sinceISO, "2026-07-01");
  assert.strictEqual(s.every, 1);
});

// A weigh-in that recorded a dose joins the Mounjaro dose sequence but can
// never carry an interval, so its null must not read as a schedule change —
// otherwise the counter restarts at every weigh-in.
test("doseStreakAsOf: a dose logged on a weigh-in does not break the streak", function () {
  function mj(id, date, dose, every) {
    return { id: id, ts: date + "T09:00:00.000Z", date: date, substance: "mounjaro",
             dose: dose, unit: "mg", every: every };
  }
  var st = {
    settings: { sandbagging: false },
    injLog: [mj("a", "2026-07-29", 5, 7), mj("b", "2026-08-05", 5, 7), mj("c", "2026-08-12", 5, 7)],
    weightLog: [{ id: "w", date: "2026-08-08", doseMg: 5 }]
  };
  var s = DOMAIN.doseStreakAsOf(st, "mounjaro", "2026-08-12");
  assert.strictEqual(s.sinceISO, "2026-07-29");
  assert.strictEqual(s.every, 7);
  assert.strictEqual(s.weeks, 3);
});

// The user-facing rule, both halves of it: a different mg or a different
// cadence each start a new regimen.
test("doseStreakAsOf: a real cadence change still ends the run", function () {
  var log = [
    trt("a", "2026-07-01", 25, null, { every: 7 }),
    trt("b", "2026-07-08", 25, null, { every: 7 }),
    trt("c", "2026-07-15", 25, null, { every: 3.5 })
  ];
  var s = DOMAIN.doseStreakAsOf(mkState(false, log), "trt", "2026-07-15");
  assert.strictEqual(s.sinceISO, "2026-07-15");
  assert.strictEqual(s.every, 3.5);
});

test("doseStreakAsOf: unchanged interval keeps the streak running", function () {
  var log = [
    trt("a", "2026-07-01", 25, null, { every: 2 }),
    trt("b", "2026-07-03", 25, null, { every: 2 }),
    trt("c", "2026-07-05", 25, null, { every: 2 })
  ];
  var s = DOMAIN.doseStreakAsOf(mkState(false, log), "trt", "2026-07-10");
  assert.strictEqual(s.sinceISO, "2026-07-01");
  assert.strictEqual(s.every, 2);
});

test("lastDoseAsOf: carries the stamped interval, null when the entry lacks one", function () {
  var log = [trt("a", "2026-07-01", 25), trt("b", "2026-07-10", 25, null, { every: 1 })];
  assert.strictEqual(DOMAIN.lastDoseAsOf(mkState(false, log), "trt", "2026-07-12").every, 1);
  assert.strictEqual(DOMAIN.lastDoseAsOf(mkState(false, log), "trt", "2026-07-05").every, null);
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

// ---- flanks: their own patch of skin, their own landmarks ----
test("spotArea: missing or unknown reads as the front", function () {
  assert.strictEqual(DOMAIN.spotArea({}), "front");
  assert.strictEqual(DOMAIN.spotArea(null), "front");
  assert.strictEqual(DOMAIN.spotArea({ area: "left" }), "left");
  assert.strictEqual(DOMAIN.spotArea({ area: "thigh" }), "front");
  assert.deepStrictEqual(Object.keys(DOMAIN.SPOT_AREAS).sort(), ["front", "left", "right"]);
});

test("SPOT_AREAS: the flanks share the abdomen's belt", function () {
  var f = DOMAIN.SPOT_AREAS.front, l = DOMAIN.SPOT_AREAS.left, r = DOMAIN.SPOT_AREAS.right;
  // one navel line round the body: 3 cm above the navel is 3 cm above it on
  // either map, so the two are drawn over the same vertical stretch
  assert.ok(l.yMin <= f.yMin && l.yMax >= f.yMax, "the flank covers at least the front's belt");
  assert.deepStrictEqual([l.yMin, l.yMax], [r.yMin, r.yMax], "and both flanks the same");
  // a flank starts at the nipple line and runs backwards -- never negative
  assert.strictEqual(l.xMin, 0);
  assert.ok(l.xMax >= 16, "far enough back to reach the love handle");
  assert.strictEqual(l.navel, false, "no navel zone where there is no navel");
});

test("spotCheck: only shots on the same patch of skin count", function () {
  var recent = [{ pos: { x: 6, y: -2 }, area: "left" }, { pos: { x: 6, y: -2 }, area: "front" }];
  // the same numbers on the left flank: the left shot is 0 cm away
  assert.strictEqual(DOMAIN.spotCheck({ x: 6, y: -2 }, recent, null, null, "left").nearShot, true);
  // on the right flank the same numbers are a different place entirely
  var r = DOMAIN.spotCheck({ x: 6, y: -2 }, recent, null, null, "right");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.nearestCm, null);
  // no area = front, as every caller before flanks existed
  assert.strictEqual(DOMAIN.spotCheck({ x: 6, y: -2 }, recent).nearShot, true);
});

test("spotCheck: the navel zone exists only where the navel is", function () {
  // (1, 1) is 1.4 cm from the origin: inside the 5 cm zone on the front...
  assert.strictEqual(DOMAIN.spotCheck({ x: 1, y: 1 }, []).nearNavel, true);
  // ...but on a flank the origin is the nipple line at the navel's level -- skin
  assert.strictEqual(DOMAIN.spotCheck({ x: 1, y: 1 }, [], null, null, "left").nearNavel, false);
  assert.strictEqual(DOMAIN.spotCheck({ x: 1, y: 1 }, [], null, null, "left").ok, true);
});

test("suggestSpot: a flank suggestion stays on the flank and keeps its distance", function () {
  var A = DOMAIN.SPOT_AREAS.left;
  var recent = [{ pos: { x: 6, y: -2 }, area: "left" }, { pos: { x: 8, y: 0 }, area: "front" }];
  var l = DOMAIN.suggestSpot(recent, null, null, "left");
  assert.ok(l.x >= A.xMin && l.x <= A.xMax && l.y >= A.yMin && l.y <= A.yMax, "inside the flank");
  assert.ok(Math.hypot(l.x - 6, l.y + 2) >= DOMAIN.SPOT_MIN_CM, "3 cm from the flank shot");
  // and not driven into a corner: farther than the cap is no better
  assert.ok(l.x > A.xMin && l.x < A.xMax, "not on the edge: " + JSON.stringify(l));
  // the front suggestion is the same with or without the flank shot in the list
  var withFlank = DOMAIN.suggestSpot(recent), frontOnly = DOMAIN.suggestSpot([recent[1]]);
  assert.deepStrictEqual(withFlank, frontOnly);
  // empty flank: the middle-ish, never the nipple line itself
  var empty = DOMAIN.suggestSpot([], null, null, "right");
  assert.ok(empty.x >= 6 && empty.x <= 12, "middle of the flank: " + JSON.stringify(empty));
});

test("recentInjPos: carries the area, and puts an old flank site on its flank", function () {
  var legacy = { love_l1: { area: "left", x: 6, y: -2 }, belly_ll: { x: -4, y: 4 } };
  var log = [trt("f", "2026-08-06", 25, { x: 6, y: -2 }, { area: "left" }),
             trt("g", "2026-08-05", 25, { x: -4, y: 4 }),
             trt("h", "2026-08-04", 25, null, { site: "love_l1" }),
             trt("i", "2026-08-03", 25, null, { site: "belly_ll" })];
  var out = Array.from(DOMAIN.recentInjPos(mkState(false, log), TODAY, 14, legacy));
  assert.deepStrictEqual(pluck(out, "date"), ["2026-08-06", "2026-08-05", "2026-08-04", "2026-08-03"]);
  assert.deepStrictEqual(pluck(out, "area"), ["left", "front", "left", "front"]);
  assert.deepStrictEqual([out[2].pos.x, out[2].pos.y], [6, -2]);   // cross-realm object: compare the numbers
  // a bad area on a record is read as the front rather than dropped
  var odd = DOMAIN.recentInjPos(mkState(false, [trt("z", "2026-08-06", 25, { x: 1, y: 1 }, { area: "nowhere" })]), TODAY, 14, null);
  assert.strictEqual(odd[0].area, "front");
});

test("describe: the legend explains area and both meanings of pos", function () {
  var out = DOMAIN.describe({ injLog: [] }, function (k) { return k; });
  assert.ok(out.legend.conventions["injLog[].area"], "area is in the legend");
  assert.ok(/nipple/.test(out.legend.conventions["injLog[].pos"]), "pos explains the flank frame");
  assert.ok(/navel/.test(out.legend.conventions["injLog[].pos"]), "pos explains the front frame");
});

test("dowIndex: ISO numbering, 1=Monday..7=Sunday", function () {
  assert.strictEqual(DOMAIN.dowIndex("2026-08-03"), 1); // Monday
  assert.strictEqual(DOMAIN.dowIndex("2026-08-05"), 3); // Wednesday
  assert.strictEqual(DOMAIN.dowIndex("2026-08-07"), 5); // Friday
  assert.strictEqual(DOMAIN.dowIndex("2026-08-08"), 6); // Saturday
  assert.strictEqual(DOMAIN.dowIndex("2026-08-02"), 7); // Sunday
});

test("dowIndex: noon anchor keeps the date stable across timezones", function () {
  // consecutive days always advance by exactly one weekday slot (7 wraps to 1)
  for (var d = 1; d <= 6; d++) {
    var a = DOMAIN.dowIndex("2026-08-0" + d), b = DOMAIN.dowIndex("2026-08-0" + (d + 1));
    assert.strictEqual(a % 7 + 1, b);
  }
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

// ---- illness / infection episodes ----
function ill(id, start, end, extra) {
  return Object.assign({ id: id, type: "illness", start: start, end: end || null, label: "", severity: null }, extra || {});
}
function illState(episodes) {
  return { conditions: episodes };
}

test("openIllness: returns the episode without an end date", function () {
  var st = illState([ill("a", "2026-07-01", "2026-07-05"), ill("b", "2026-08-01", null)]);
  assert.strictEqual(DOMAIN.openIllness(st).id, "b");
});

test("openIllness: null when every episode is closed, and on empty state", function () {
  assert.strictEqual(DOMAIN.openIllness(illState([ill("a", "2026-07-01", "2026-07-05")])), null);
  assert.strictEqual(DOMAIN.openIllness({}), null);
});

test("illnessAsOf: the start day is day 1 and carries the total length", function () {
  var st = illState([ill("a", "2026-08-01", "2026-08-06", { label: "angina", severity: 2 })]);
  var r = DOMAIN.illnessAsOf(st, "2026-08-01");
  assert.strictEqual(r.dayN, 1);
  assert.strictEqual(r.total, 6);
  assert.strictEqual(r.label, "angina");
  assert.strictEqual(r.severity, 2);
  assert.strictEqual(r.ongoing, false);
  assert.strictEqual(DOMAIN.illnessAsOf(st, "2026-08-04").dayN, 4);
  assert.strictEqual(DOMAIN.illnessAsOf(st, "2026-08-06").dayN, 6);
});

test("illnessAsOf: null before the start and after the end", function () {
  var st = illState([ill("a", "2026-08-01", "2026-08-06")]);
  assert.strictEqual(DOMAIN.illnessAsOf(st, "2026-07-31"), null);
  assert.strictEqual(DOMAIN.illnessAsOf(st, "2026-08-07"), null);
  assert.strictEqual(DOMAIN.illnessAsOf(st, null), null);
});

test("illnessAsOf: an open episode covers every later date and keeps counting", function () {
  var st = illState([ill("a", "2026-08-01", null)]);
  var r = DOMAIN.illnessAsOf(st, "2026-09-10");
  assert.strictEqual(r.ongoing, true);
  assert.strictEqual(r.total, null);
  assert.strictEqual(r.dayN, 41);
});

test("illnessAsOf: on overlap the later start wins", function () {
  var st = illState([ill("a", "2026-08-01", "2026-08-20"), ill("b", "2026-08-10", "2026-08-14")]);
  var r = DOMAIN.illnessAsOf(st, "2026-08-12");
  assert.strictEqual(r.id, "b");
  assert.strictEqual(r.dayN, 3);
  // outside the nested one we fall back to the outer episode
  assert.strictEqual(DOMAIN.illnessAsOf(st, "2026-08-18").id, "a");
});

test("illnessAsOf: day counts survive a DST change (noon anchor)", function () {
  // 2026-03-29 is the EU spring-forward; the span must still be exactly 12 days
  var st = illState([ill("a", "2026-03-25", "2026-04-05")]);
  assert.strictEqual(DOMAIN.illnessAsOf(st, "2026-04-05").dayN, 12);
  assert.strictEqual(DOMAIN.illnessAsOf(st, "2026-04-05").total, 12);
});

test("illnessSpans: clips to the window and clamps an open episode to its end", function () {
  var st = illState([ill("a", "2026-07-20", "2026-08-03"), ill("b", "2026-08-20", null)]);
  var out = Array.from(DOMAIN.illnessSpans(st, "2026-08-01", "2026-08-31"));
  assert.deepStrictEqual(pluck(out, "id"), ["a", "b"]);
  assert.strictEqual(out[0].from, "2026-08-01");   // clipped to the window start
  assert.strictEqual(out[0].to, "2026-08-03");
  assert.strictEqual(out[1].from, "2026-08-20");
  assert.strictEqual(out[1].to, "2026-08-31");     // ongoing -> clamped to the window end
  assert.strictEqual(out[1].ongoing, true);
});

test("illnessSpans: episodes outside the window are dropped; empty state gives []", function () {
  var st = illState([ill("a", "2026-05-01", "2026-05-04"), ill("b", "2026-12-01", "2026-12-04")]);
  assert.deepStrictEqual(pluck(DOMAIN.illnessSpans(st, "2026-08-01", "2026-08-31"), "id"), []);
  assert.deepStrictEqual(pluck(DOMAIN.illnessSpans({}, "2026-08-01", "2026-08-31"), "id"), []);
});

test("illnessSpans: an end before the start collapses to a single day", function () {
  var st = illState([ill("a", "2026-08-10", "2026-08-04")]);
  var out = Array.from(DOMAIN.illnessSpans(st, null, null));
  assert.strictEqual(out[0].from, "2026-08-10");
  assert.strictEqual(out[0].to, "2026-08-10");
});

function cond(id, type, start, end, extra) {
  return Object.assign({ id: id, type: type, start: start, end: end || null, label: "", severity: null, symptoms: [] }, extra || {});
}

test("openConditions: several chronic conditions can be open the same day, illness cannot", function () {
  var st = { conditions: [
    cond("a", "chronic", "2026-07-01", null, { label: "Łokieć tenisisty" }),
    cond("b", "chronic", "2026-07-15", null, { label: "Bóle pleców" }),
    cond("c", "illness", "2026-08-01", null)
  ] };
  var chronic = Array.from(DOMAIN.openConditions(st, "2026-08-10", "chronic"));
  assert.strictEqual(chronic.length, 2);
  assert.deepStrictEqual(chronic.map(function (c) { return c.id; }).sort(), ["a", "b"]);
  var all = Array.from(DOMAIN.openConditions(st, "2026-08-10"));
  assert.strictEqual(all.length, 3);
});

test("openConditions: a closed condition does not cover a date after its end", function () {
  var st = { conditions: [cond("a", "chronic", "2026-07-01", "2026-07-10")] };
  assert.strictEqual(DOMAIN.openConditions(st, "2026-07-05").length, 1);
  assert.strictEqual(DOMAIN.openConditions(st, "2026-07-11").length, 0);
});

test("openConditions: dayN counts per condition independently", function () {
  var st = { conditions: [cond("a", "chronic", "2026-08-01", null), cond("b", "chronic", "2026-08-09", null)] };
  var out = Array.from(DOMAIN.openConditions(st, "2026-08-10"));
  var byId = {}; out.forEach(function (c) { byId[c.id] = c.dayN; });
  assert.strictEqual(byId.a, 10);
  assert.strictEqual(byId.b, 2);
});

test("openConditions: empty state and no date give an empty list", function () {
  assert.deepStrictEqual(Array.from(DOMAIN.openConditions({ conditions: [] }, "2026-08-10")), []);
  assert.deepStrictEqual(Array.from(DOMAIN.openConditions({ conditions: [cond("a", "chronic", "2026-08-01", null)] }, null)), []);
});

test("conditionSpans: filters by type the same way illnessSpans filters to illness", function () {
  var st = { conditions: [cond("a", "chronic", "2026-08-01", "2026-08-05"), cond("b", "illness", "2026-08-03", "2026-08-06")] };
  var chronicOnly = Array.from(DOMAIN.conditionSpans(st, null, null, "chronic"));
  assert.strictEqual(chronicOnly.length, 1);
  assert.strictEqual(chronicOnly[0].id, "a");
  var illnessOnly = Array.from(DOMAIN.illnessSpans(st, null, null));
  assert.strictEqual(illnessOnly.length, 1);
  assert.strictEqual(illnessOnly[0].id, "b");
});

test("seriesFor: symptom severity averages per day, namespaced by condition", function () {
  var st = { journal: [
    { id: "j1", ts: "2026-08-01T09:00:00.000Z", symptoms: { "cond1:fever": 4, "cond2:pain": 2 } },
    { id: "j2", ts: "2026-08-01T20:00:00.000Z", symptoms: { "cond1:fever": 2 } },
    { id: "j3", ts: "2026-08-02T09:00:00.000Z", symptoms: { "cond1:fever": 3 } }
  ] };
  var fever = Array.from(DOMAIN.seriesFor(st, "symptom:cond1:fever")).map(function (p) { return { date: p.date, value: p.value }; });
  assert.deepStrictEqual(fever, [{ date: "2026-08-01", value: 3 }, { date: "2026-08-02", value: 3 }]);
  var pain = Array.from(DOMAIN.seriesFor(st, "symptom:cond2:pain")).map(function (p) { return { date: p.date, value: p.value }; });
  assert.deepStrictEqual(pain, [{ date: "2026-08-01", value: 2 }]);
  assert.deepStrictEqual(Array.from(DOMAIN.seriesFor(st, "symptom:cond1:nonexistent")), []);
});

// ---- chart windows & window stats ----

function wEntry(date, kg) { return { date: date, weightKg: kg }; }

test("chartWindow: offset 0 covers the last N days ending today", function () {
  var log = [wEntry("2026-08-07", 90), wEntry("2026-08-01", 91), wEntry("2026-07-31", 92)];
  var w = DOMAIN.chartWindow(log, "date", 7, 0, "2026-08-07");
  assert.strictEqual(w.from, "2026-08-01");
  assert.strictEqual(w.to, "2026-08-07");
  assert.deepStrictEqual(Array.from(w.entries).map(function (e) { return e.date; }),
    ["2026-08-07", "2026-08-01"]);   // order preserved, out-of-window dropped
  assert.strictEqual(w.atNewest, true);
});

test("chartWindow: paging shifts by whole windows and keeps boundary entries once", function () {
  var log = [wEntry("2026-08-07", 90), wEntry("2026-07-31", 92)];
  var w1 = DOMAIN.chartWindow(log, "date", 7, 1, "2026-08-07");
  assert.strictEqual(w1.from, "2026-07-25");
  assert.strictEqual(w1.to, "2026-07-31");
  assert.deepStrictEqual(Array.from(w1.entries).map(function (e) { return e.date; }), ["2026-07-31"]);
  var w0 = DOMAIN.chartWindow(log, "date", 7, 0, "2026-08-07");
  assert.deepStrictEqual(Array.from(w0.entries).map(function (e) { return e.date; }), ["2026-08-07"]);
});

test("chartWindow: offset clamps to the oldest entry and reports the ends", function () {
  var log = [wEntry("2026-08-07", 90), wEntry("2026-07-28", 92)];   // 10 days back
  var w = DOMAIN.chartWindow(log, "date", 7, 5, "2026-08-07");
  assert.strictEqual(w.offset, 1);
  assert.strictEqual(w.atOldest, true);
  assert.strictEqual(w.atNewest, false);
  var w0 = DOMAIN.chartWindow(log, "date", 7, 0, "2026-08-07");
  assert.strictEqual(w0.atNewest, true);
  assert.strictEqual(w0.atOldest, false);
});

test("chartWindow: days null returns everything; empty log never throws", function () {
  var log = [wEntry("2026-08-07", 90), wEntry("2026-01-01", 99)];
  var w = DOMAIN.chartWindow(log, "date", null, 3, "2026-08-07");
  assert.strictEqual(w.from, null);
  assert.strictEqual(Array.from(w.entries).length, 2);
  assert.strictEqual(w.atNewest, true);
  assert.strictEqual(w.atOldest, true);
  var e = DOMAIN.chartWindow([], "date", 7, 0, "2026-08-07");
  assert.strictEqual(e.offset, 0);
  assert.deepStrictEqual(Array.from(e.entries), []);
});

test("chartWindow: an empty mid-history window still carries its bounds", function () {
  var log = [wEntry("2026-08-07", 90), wEntry("2026-07-18", 92)];   // 20 days back
  var w = DOMAIN.chartWindow(log, "date", 7, 1, "2026-08-07");
  assert.deepStrictEqual(Array.from(w.entries), []);
  assert.strictEqual(w.from, "2026-07-25");
  assert.strictEqual(w.to, "2026-07-31");
  assert.strictEqual(w.atOldest, false);
});

test("chartWindow: full ISO timestamps filter by their date part", function () {
  var log = [{ ts: "2026-08-05T22:30:00.000Z", sys: 120, dia: 80 },
             { ts: "2026-07-01T08:00:00.000Z", sys: 118, dia: 78 }];
  var w = DOMAIN.chartWindow(log, "ts", 7, 0, "2026-08-07");
  assert.deepStrictEqual(Array.from(w.entries).map(function (e) { return e.ts; }),
    ["2026-08-05T22:30:00.000Z"]);
});

test("chartWindow: noon anchor keeps day arithmetic exact across DST", function () {
  var w = DOMAIN.chartWindow([wEntry("2026-03-25", 90)], "date", 7, 0, "2026-03-31");
  assert.strictEqual(w.from, "2026-03-25");   // spans the EU spring-forward weekend
  assert.strictEqual(Array.from(w.entries).length, 1);
});

test("bpWindowStats: averages and extremes; pulse only over the readings that have one", function () {
  var s = DOMAIN.bpWindowStats([
    { sys: 120, dia: 80, pulse: 70 },
    { sys: 130, dia: 90, pulse: null },
    { sys: 110, dia: 70, pulse: 80 },
  ]);
  assert.strictEqual(s.n, 3);
  assert.strictEqual(s.sys.avg, 120); assert.strictEqual(s.sys.min, 110); assert.strictEqual(s.sys.max, 130);
  assert.strictEqual(s.dia.avg, 80);
  assert.strictEqual(s.pulse.avg, 75); assert.strictEqual(s.pulse.min, 70); assert.strictEqual(s.pulse.max, 80);
  assert.strictEqual(DOMAIN.bpWindowStats([{ sys: 120, dia: 80, pulse: null }]).pulse, null);
  assert.strictEqual(DOMAIN.bpWindowStats([]), null);
});

test("weightWindowStats: change runs oldest to newest regardless of input order", function () {
  var s = DOMAIN.weightWindowStats([wEntry("2026-08-07", 90), wEntry("2026-08-01", 93)]);
  assert.strictEqual(s.n, 2);
  assert.strictEqual(s.change, -3);
  assert.strictEqual(s.min, 90); assert.strictEqual(s.max, 93); assert.strictEqual(s.avg, 91.5);
  var up = DOMAIN.weightWindowStats([wEntry("2026-08-01", 90), wEntry("2026-08-07", 93)]);
  assert.strictEqual(up.change, 3);
  assert.strictEqual(DOMAIN.weightWindowStats([wEntry("2026-08-07", 90)]).change, 0);
  assert.strictEqual(DOMAIN.weightWindowStats([]), null);
});

// ---- fractional dosing intervals ----

var SAT_8AM = Date.parse("2026-08-01T08:00:00.000Z");   // reference shot
var H = 3600000, D = 86400000;

test("doseCountdown: 3.5 days lands 84 h later, not on the next whole day", function () {
  var cd = DOMAIN.doseCountdown(SAT_8AM, 3.5, SAT_8AM);
  assert.strictEqual(cd.nextMs, SAT_8AM + 84 * H);
  assert.strictEqual(new Date(cd.nextMs).toISOString(), "2026-08-04T20:00:00.000Z");  // Tue 20:00
  assert.strictEqual(cd.everyDays, 3.5);
  assert.strictEqual(cd.days, 3);
  assert.strictEqual(cd.hours, 12);
  assert.strictEqual(cd.overdue, false);
  assert.strictEqual(cd.frac, 0);
});

test("doseCountdown: exactly due reads zero remaining, full ring, not overdue", function () {
  var cd = DOMAIN.doseCountdown(SAT_8AM, 3.5, SAT_8AM + 84 * H);
  assert.strictEqual(cd.remainingMs, 0);
  assert.strictEqual(cd.frac, 1);
  assert.strictEqual(cd.overdue, false);
  assert.strictEqual(cd.days, 0);
  assert.strictEqual(cd.hours, 0);
});

test("doseCountdown: sub-day precision survives — 12 h before due", function () {
  var cd = DOMAIN.doseCountdown(SAT_8AM, 3.5, SAT_8AM + 72 * H);
  assert.strictEqual(cd.days, 0);
  assert.strictEqual(cd.hours, 12);
  assert.strictEqual(cd.overdue, false);
});

test("doseCountdown: overdue splits into days and hours and clamps the ring", function () {
  var cd = DOMAIN.doseCountdown(SAT_8AM, 3.5, SAT_8AM + 114 * H);   // 30 h past due
  assert.strictEqual(cd.overdue, true);
  assert.strictEqual(cd.days, 1);
  assert.strictEqual(cd.hours, 6);
  assert.strictEqual(cd.frac, 1);
  assert.strictEqual(cd.remainingMs, -30 * H);
});

test("doseCountdown: hours floor so the label holds until the hour turns", function () {
  var cd = DOMAIN.doseCountdown(SAT_8AM, 3.5, SAT_8AM + 84 * H - (7 * H + 59 * 60000));
  assert.strictEqual(cd.days, 0);
  assert.strictEqual(cd.hours, 7);
});

test("doseCountdown: whole-day intervals still behave as before", function () {
  var cd = DOMAIN.doseCountdown(SAT_8AM, 7, SAT_8AM + 5 * D);
  assert.strictEqual(cd.days, 2);
  assert.strictEqual(cd.hours, 0);
  assert.strictEqual(cd.frac, 5 / 7);
  assert.strictEqual(cd.nextMs, SAT_8AM + 7 * D);
});

test("frac: the wave runs its own cycle, and empties at every shot", function () {
  // The two rows off the report. Thymosin Alpha-1: every 2 days, 13 h to go.
  // KPV: twice a day (a 12 h span), 11 h to go.
  var ta1 = DOMAIN.doseCountdown(SAT_8AM, 2, SAT_8AM + 35 * H);
  var kpv = DOMAIN.doseCountdown(SAT_8AM, 0.5, SAT_8AM + 1 * H);
  assert.strictEqual(ta1.hours, 13);
  assert.strictEqual(kpv.hours, 11);
  // Length is progress through one's own rhythm, so the longer wait does draw
  // further along, and rows are not comparable by it. Accepted on purpose: what
  // the bar is for is watching one run fill, and it moves the whole time.
  assert.strictEqual(ta1.frac, 35 / 48);
  assert.ok(ta1.frac > kpv.frac);
  assert.ok(kpv.frac < 0.1);                       // just injected: near-empty, not half
});

test("doseCountdown: no last shot, or no interval, gives null", function () {
  assert.strictEqual(DOMAIN.doseCountdown(null, 3.5, SAT_8AM), null);
  assert.strictEqual(DOMAIN.doseCountdown(SAT_8AM, 0, SAT_8AM), null);
});

test("doseCountdown: intervals below half a day are floored to 0.5", function () {
  var cd = DOMAIN.doseCountdown(SAT_8AM, 0.1, SAT_8AM);
  assert.strictEqual(cd.everyDays, 0.5);
  assert.strictEqual(cd.nextMs, SAT_8AM + 12 * H);
});

test("doseCountdown: 3.5 days stays 84 elapsed hours across a DST change", function () {
  // 2026-03-27 12:00 UTC, three days before the EU spring-forward weekend
  var before = Date.parse("2026-03-27T12:00:00.000Z");
  var cd = DOMAIN.doseCountdown(before, 3.5, before);
  assert.strictEqual(cd.nextMs - before, 84 * H);
  assert.strictEqual(DOMAIN.doseCountdown(before, 3.5, before + 84 * H).remainingMs, 0);
});

// ---- peptide cycles ----

test("cycleProgress: the start date is day 1", function () {
  var r = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 56 }, "2026-08-01");
  assert.strictEqual(r.dayN, 1);
  assert.strictEqual(r.total, 56);
  assert.strictEqual(r.done, false);
  assert.ok(r.frac > 0 && r.frac < 0.05);
});

test("cycleProgress: past the end it clamps and reports done", function () {
  var r = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 10 }, "2026-08-20");
  assert.strictEqual(r.dayN, 10);
  assert.strictEqual(r.frac, 1);
  assert.strictEqual(r.done, true);
});

test("cycleProgress: no cycle without both a start and a length", function () {
  assert.strictEqual(DOMAIN.cycleProgress(null, "2026-08-01"), null);
  assert.strictEqual(DOMAIN.cycleProgress({ cycleDays: 56, cycleStart: null }, "2026-08-01"), null);
  assert.strictEqual(DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: null }, "2026-08-01"), null);
});

test("cycleProgress: a whole peptide record is a valid config", function () {
  var pep = { id: "pep1", name: "TB-500", color: "#fb7185", unit: "mg",
              intervalDays: 7, cycleDays: 56, cycleStart: "2026-08-01", archived: false };
  var r = DOMAIN.cycleProgress(pep, "2026-08-11");
  assert.strictEqual(r.dayN, 11);
  assert.strictEqual(r.total, 56);
});

test("cycleProgress: weeks count the week you are in, day 1-7 being the first", function () {
  function wk(day) {
    return DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 112 }, day).weekN;
  }
  assert.strictEqual(wk("2026-08-01"), 1, "day 1");
  assert.strictEqual(wk("2026-08-07"), 1, "day 7 is still week 1");
  assert.strictEqual(wk("2026-08-08"), 2, "day 8 opens week 2");
  assert.strictEqual(wk("2026-08-14"), 2, "day 14 closes week 2");
  assert.strictEqual(wk("2026-08-15"), 3, "day 15 opens week 3");
  assert.strictEqual(DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 112 }, "2026-11-20").weeks, 16);
});

test("cycleProgress: a part-week at the end still counts as a week", function () {
  // 100 days is fourteen weeks and two days -- the tail is week fifteen, not a
  // rounding error, or the last two days would belong to no week at all
  var r = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 100 }, "2026-11-08");
  assert.strictEqual(r.weeks, 15);
  assert.strictEqual(r.dayN, 100, "day 100 is the last one");
  assert.strictEqual(r.weekN, 15);
});

test("cycleProgress: a cycle shorter than a week is one week long", function () {
  var r = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 3 }, "2026-08-02");
  assert.strictEqual(r.weeks, 1);
  assert.strictEqual(r.weekN, 1);
});

test("cycleProgress: past the end the week clamps with the day", function () {
  var r = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 14 }, "2026-09-30");
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.dayN, 14);
  assert.strictEqual(r.weekN, 2, "never past the last week");
  assert.strictEqual(r.weeks, 2);
});

test("cycleProgress: weeksDone counts full weeks behind you, not the one you are in", function () {
  function done(day) {
    return DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 112 }, day).weeksDone;
  }
  assert.strictEqual(done("2026-08-01"), 0, "day 1: nothing is behind you yet");
  assert.strictEqual(done("2026-08-07"), 0, "day 7: the first week is not over");
  assert.strictEqual(done("2026-08-08"), 1, "day 8: the first week is behind you");
  assert.strictEqual(done("2026-08-14"), 1, "day 14: still one");
  assert.strictEqual(done("2026-08-15"), 2, "day 15: two");
  assert.strictEqual(done("2026-08-29"), 4, "day 29: four, the first group closes");
});

test("cycleProgress: a finished cycle has every week behind it", function () {
  // day 112 is the last one and its week has not run out, so 15 -- but once the
  // cycle is over the last week has closed too, or it would read 15 of 16
  var last = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 112 }, "2026-11-20");
  assert.strictEqual(last.dayN, 112);
  assert.strictEqual(last.done, false);
  assert.strictEqual(last.weeksDone, 15);
  var over = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 112 }, "2026-11-21");
  assert.strictEqual(over.done, true);
  assert.strictEqual(over.weeksDone, 16);
  assert.strictEqual(over.weeksDone, over.weeks, "never more marks than the cycle has weeks");
});

test("cycleProgress: a cycle shorter than a week never earns a mark until it ends", function () {
  var r = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 3 }, "2026-08-03");
  assert.strictEqual(r.weeksDone, 0);
  var over = DOMAIN.cycleProgress({ cycleStart: "2026-08-01", cycleDays: 3 }, "2026-08-09");
  assert.strictEqual(over.weeksDone, 1, "one week, because that is what the cycle rounds to");
});

// A stub translator: real labels come from I18N, and DOMAIN must never reach
// for it. Returning the key back is exactly what I18N.t does for a missing one,
// which is also how describe() decides to fall back to the raw code.
function tStub(map) {
  return function (k) { return Object.prototype.hasOwnProperty.call(map || {}, k) ? map[k] : k; };
}
var DESC_T = tStub({
  "cond.typeIllness": "Infekcja", "cond.typeChronic": "Schorzenie / kontuzja",
  "ill.sev1": "łagodne", "ill.sev2": "umiarkowane", "ill.sev3": "ciężkie",
  "site.belly_ll": "Brzuch — dół lewy", "inj.seg.trt": "TRT", "inj.seg.mounjaro": "Mounjaro",
  "glu.tagFasting": "na czczo", "glu.tagPre": "przed posiłkiem",
  "glu.tagPost": "po posiłku", "glu.tagBed": "przed snem",
  "inj.cycleUnitWeeks": "tygodnie", "inj.cycleUnitDays": "dni"
});

function descState() {
  return {
    conditions: [
      { id: "c1", type: "chronic", label: "GI issues / IBS", severity: 2,
        symptoms: [{ key: "sym_a", label: "biegunka" }, { key: "sym_b", label: "wzdęcia", archived: true }] }
    ],
    journal: [
      { id: "j1", ts: "2026-09-07T09:38:00.000Z", text: "note",
        symptoms: { "c1:sym_a": 4, "c1:sym_b": 1, "ghost:sym_x": 3, "c1:sym_gone": 2 } }
    ],
    injLog: [
      { id: "i1", ts: "2026-09-07T06:00:00.000Z", substance: "pep_1", dose: 400, unit: "mcg", site: "belly_ll" },
      { id: "i2", ts: "2026-09-06T06:00:00.000Z", substance: "trt", dose: 25, unit: "mg", site: "nowhere_odd" }
    ],
    glu: { log: [{ id: "g1", ts: "2026-09-07T05:00:00.000Z", mgdl: 92, tag: "fasting" }] },
    inj: { peptides: [{ id: "pep_1", name: "KPV", unit: "mcg", cycleUnit: "weeks", archived: true }] },
    profile: { sex: "m" }
  };
}

test("describe: a symptom key becomes the condition and symptom in words", function () {
  var out = DOMAIN.describe(descState(), DESC_T);
  var r = Array.from(out.journal[0].symptomsReadable);
  assert.deepStrictEqual(r.map(function (x) { return x.condition + "/" + x.symptom + "/" + x.severity; }),
    ["GI issues / IBS/biegunka/4", "GI issues / IBS/wzdęcia/1"]);
});

test("describe: a deleted condition or symptom is skipped, not guessed at", function () {
  // "ghost:sym_x" names a condition that no longer exists, "c1:sym_gone" a
  // symptom that was deleted outright -- the diary already says nothing about
  // either, and a file that invented a label would be worse than a quiet gap.
  var out = DOMAIN.describe(descState(), DESC_T);
  assert.strictEqual(out.journal[0].symptomsReadable.length, 2);
  assert.ok(out.journal[0].symptoms["ghost:sym_x"], "the raw key still stands, untouched");
});

test("describe: an archived peptide still gives its shots a name", function () {
  var out = DOMAIN.describe(descState(), DESC_T);
  assert.strictEqual(out.injLog[0].substanceName, "KPV");
  assert.strictEqual(out.injLog[1].substanceName, "TRT");
});

test("describe: an unknown code falls back to itself, never to a lookup key", function () {
  var out = DOMAIN.describe(descState(), DESC_T);
  assert.strictEqual(out.injLog[0].siteName, "Brzuch — dół lewy");
  assert.strictEqual(out.injLog[1].siteName, "nowhere_odd", "not \"site.nowhere_odd\"");
});

test("describe: every code the app can write has an entry in the legend", function () {
  // The point of this test is the next code someone adds: if it is not in the
  // legend, the file stops explaining itself and nobody notices.
  var out = DOMAIN.describe(descState(), DESC_T);
  DOMAIN.SITE_CODES.forEach(function (c) {
    assert.ok(out.legend.sites[c], "site " + c + " is in the legend");
  });
  DOMAIN.GLU_TAGS.forEach(function (c) {
    assert.ok(out.legend.glucoseTags[c], "glucose tag " + c + " is in the legend");
  });
  ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "brand", "accent"].forEach(function (c) {
    assert.ok(out.legend.tones[c], "tone " + c + " is in the legend");
  });
  ["mcg", "mg", "j", "IU"].forEach(function (c) {
    assert.ok(out.legend.units[c], "unit " + c + " is in the legend");
  });
  ["illness", "chronic"].forEach(function (c) {
    assert.ok(out.legend.conditionTypes[c], "condition type " + c + " is in the legend");
  });
  ["1", "2", "3"].forEach(function (c) {
    assert.ok(out.legend.severity[c], "severity " + c + " is in the legend");
  });
  assert.ok(out.legend.joins["journal[].symptoms"], "the compound key is explained");
  assert.ok(/HIGHER IS WORSE/.test(out.legend.scales["journal[].symptoms values"]),
    "the direction of the symptom scale is stated, because it runs opposite to wellbeing");
  assert.ok(/HIGHER IS BETTER/.test(out.legend.scales["journal[].energy / mood / clarity, stateLog[]"]));
  assert.ok(out.legend.conventions["injLog[].pos"], "cm-from-navel is stated");
  assert.ok(out.legend.conventions["glu.log[].mgdl"], "always-mg/dL is stated");
  assert.ok(out.readme, "and the file says what it is");
});

test("describe: the live state is left exactly as it was", function () {
  var st = descState(), before = JSON.stringify(st);
  DOMAIN.describe(st, DESC_T);
  assert.strictEqual(JSON.stringify(st), before);
});

test("stripDescribed: reading an enriched file back leaves no derived field behind", function () {
  var st = descState();
  var stripped = DOMAIN.stripDescribed(DOMAIN.describe(st, DESC_T));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(stripped)), JSON.parse(JSON.stringify(st)));
  assert.ok(!/"(readme|legend|symptomsReadable|substanceName|siteName|tagName|typeName|severityName|cycleUnitName|sexName|gluUnitName|tripUnitName)"/
    .test(JSON.stringify(stripped)), "not one of them survives anywhere in the tree");
});

test("describe: nothing to describe is not an error", function () {
  var out = DOMAIN.describe({}, DESC_T);
  assert.ok(out.legend && out.readme);
  assert.strictEqual(DOMAIN.describe(null, DESC_T).journal, undefined);
  assert.deepStrictEqual(DOMAIN.stripDescribed(null), null);
});

test("convertDose: mcg and mg are the same scale, read either way", function () {
  assert.strictEqual(DOMAIN.convertDose(833, "mcg", "mg"), 0.833);
  assert.strictEqual(DOMAIN.convertDose(0.833, "mg", "mcg"), 833);
  assert.strictEqual(DOMAIN.convertDose(400, "mcg", "mcg"), 400, "same unit passes through");
  assert.strictEqual(DOMAIN.convertDose(2.5, "mg", "mg"), 2.5);
});

test("convertDose: syringe and international units convert to nothing", function () {
  // "j" is syringe units and "IU" international units -- neither is a weight,
  // so there is no factor. null tells the caller to keep the original unit
  // rather than print a number that now means something else.
  assert.strictEqual(DOMAIN.convertDose(10, "j", "mg"), null);
  assert.strictEqual(DOMAIN.convertDose(5000, "IU", "mcg"), null);
  assert.strictEqual(DOMAIN.convertDose(10, "mg", "j"), null);
  assert.strictEqual(DOMAIN.convertDose(10, "j", "j"), 10, "but the same unit still passes");
});

test("convertDose: a missing unit means no conversion is being asked for", function () {
  assert.strictEqual(DOMAIN.convertDose(400, null, "mg"), 400);
  assert.strictEqual(DOMAIN.convertDose(400, "mcg", null), 400);
  assert.strictEqual(DOMAIN.convertDose("nope", "mcg", "mg"), null);
});

test("unitsForDose: the same shot draws the same amount whichever unit names it", function () {
  // 833 mcg at 3.33 mg/ml is the thing that was wrong on screen: read as 833 mg
  // it came out as 24990 syringe units instead of 25.
  var conc = 3.33;
  var fromMcg = DOMAIN.unitsForDose(833, "mcg", conc);
  var fromMg = DOMAIN.unitsForDose(0.833, "mg", conc);
  assert.ok(Math.abs(fromMcg - fromMg) < 1e-9, "same draw either way");
  assert.ok(Math.abs(fromMcg - 25) < 0.1, "about 25 units, not 24990");
  assert.ok(DOMAIN.unitsForDose(833, "mg", conc) > 24000, "and that is what reading it as mg gave");
});

test("vialSpans: mixing the same concentration again is still a second vial", function () {
  // Two 10 mg / 3 ml vials dissolved three weeks apart are two batches, not one
  // long one -- the second has to close the first, or the list shows a single
  // row and the day the new one was mixed is lost.
  var spans = Array.from(DOMAIN.vialSpans([
    { id: "v1", date: "2026-08-25", mg: 10, ml: 3 },
    { id: "v2", date: "2026-09-11", mg: 10, ml: 3 }
  ]));
  assert.strictEqual(spans.length, 2);
  assert.strictEqual(spans[0].until, "2026-09-11", "the first one ends the day the second was mixed");
  assert.strictEqual(spans[1].until, null, "and the new one runs to now");
});

test("vialSpans: two rows on the same day are one correction, not two vials", function () {
  var spans = Array.from(DOMAIN.vialSpans([
    { id: "v1", date: "2026-09-11", mg: 10, ml: 3 },
    { id: "v2", date: "2026-09-11", mg: 10, ml: 2 }
  ]));
  assert.strictEqual(spans.length, 1, "the later row wins the day");
  assert.strictEqual(spans[0].ml, 2);
});

test("seriesFor: a peptide id reads only that peptide's shots", function () {
  var log = [
    { id: "a", date: "2026-08-01", substance: "pep1", dose: 250, unit: "mcg" },
    { id: "b", date: "2026-08-02", substance: "pep2", dose: 2, unit: "mg" },
    { id: "c", date: "2026-08-03", substance: "pep1", dose: 300, unit: "mcg" }
  ];
  var st = { settings: {}, injLog: log };
  var out = Array.from(DOMAIN.seriesFor(st, "inj:pep1"));
  assert.deepStrictEqual(out.map(function (p) { return p.value; }), [250, 300]);
  assert.strictEqual(Array.from(DOMAIN.seriesFor(st, "inj:pep2")).length, 1);
});

test("lastDoseAsOf and doseStreakAsOf work per peptide id", function () {
  var log = [
    { id: "a", date: "2026-08-01", substance: "pep1", dose: 250, unit: "mcg", every: 1 },
    { id: "b", date: "2026-08-02", substance: "pep1", dose: 250, unit: "mcg", every: 1 },
    { id: "c", date: "2026-08-03", substance: "pep2", dose: 2, unit: "mg", every: 7 }
  ];
  var st = { settings: {}, injLog: log };
  var ld = DOMAIN.lastDoseAsOf(st, "pep1", "2026-08-05");
  assert.strictEqual(ld.dose, 250);
  assert.strictEqual(ld.unit, "mcg");
  assert.strictEqual(ld.every, 1);
  assert.strictEqual(DOMAIN.lastDoseAsOf(st, "pep2", "2026-08-05").dose, 2);
  assert.strictEqual(DOMAIN.doseStreakAsOf(st, "pep1", "2026-08-05").sinceISO, "2026-08-01");
});

// ---- peptide reconstitution ----

test("vialConc: mg of powder over ml of water", function () {
  assert.strictEqual(DOMAIN.vialConc(10, 2), 5);
  assert.strictEqual(DOMAIN.vialConc(5, 2), 2.5);
  assert.strictEqual(DOMAIN.vialConc(10, 0), null);   // no water, no solution
  assert.strictEqual(DOMAIN.vialConc(0, 2), null);
  assert.strictEqual(DOMAIN.vialConc(null, 2), null);
});

test("unitsForDose: a U-100 syringe reads 100 units per ml", function () {
  // 10 mg in 2 ml = 5 mg/ml; 2.5 mg is half a ml
  assert.strictEqual(DOMAIN.unitsForDose(2.5, "mg", 5), 50);
  assert.strictEqual(DOMAIN.unitsForDose(2.5, "mg", 10), 25);
  assert.strictEqual(DOMAIN.unitsForDose(250, "mcg", 5), 5);
  assert.strictEqual(DOMAIN.unitsForDose(1, "mg", 8), 12.5);
});

test("unitsForDose: an IU vial reconstitutes like any other", function () {
  // 5000 IU vial in 2 ml = 2500 IU/ml; 250 IU is 0.1 ml
  assert.strictEqual(DOMAIN.unitsForDose(250, "IU", 2500), 10);
  assert.strictEqual(DOMAIN.unitsForDose(30, "j", 300), 10);
  assert.strictEqual(DOMAIN.vialUnitFor("IU"), "IU");
  assert.strictEqual(DOMAIN.vialUnitFor("mcg"), "mg");   // mcg doses measure against a mg vial
  assert.strictEqual(DOMAIN.vialUnitFor("mg"), "mg");
});

test("unitsForDose: nothing to compute without a dose or a concentration", function () {
  assert.strictEqual(DOMAIN.unitsForDose(2.5, "mg", null), null); // no vial yet
  assert.strictEqual(DOMAIN.unitsForDose(2.5, "mg", 0), null);
  assert.strictEqual(DOMAIN.unitsForDose(0, "mg", 5), null);
});

test("doseToMg: mcg scales down, IU has no mg equivalent", function () {
  assert.strictEqual(DOMAIN.doseToMg(250, "mcg"), 0.25);
  assert.strictEqual(DOMAIN.doseToMg(2.5, "mg"), 2.5);
  assert.strictEqual(DOMAIN.doseToMg(30, "j"), null);
});

test("normDays: a weekday set is cleaned, sorted and deduped", function () {
  assert.deepStrictEqual(Array.from(DOMAIN.normDays([4, 2, 2])), [2, 4]);
  assert.deepStrictEqual(Array.from(DOMAIN.normDays(["2", "4"])), [2, 4]);   // form values are strings
  assert.strictEqual(DOMAIN.normDays([]), null);
  assert.strictEqual(DOMAIN.normDays(null), null);
  assert.strictEqual(DOMAIN.normDays([0, 8, 3.5, "x"]), null);               // nothing valid left
  assert.deepStrictEqual(Array.from(DOMAIN.normDays([9, 3])), [3]);          // the valid half survives
});

test("cadenceKey: the two rhythms share one key space", function () {
  assert.strictEqual(DOMAIN.cadenceKey({ days: [2, 4] }), "d:2,4");
  assert.strictEqual(DOMAIN.cadenceKey({ days: [4, 2] }), "d:2,4");          // order does not matter
  assert.strictEqual(DOMAIN.cadenceKey({ every: 3.5 }), "e:3.5");
  assert.strictEqual(DOMAIN.cadenceKey({}), null);                           // unknown, not a change
  // days win: an entry carrying both is on a weekday plan
  assert.strictEqual(DOMAIN.cadenceKey({ every: 3.5, days: [2, 4] }), "d:2,4");
});

test("daysToNextDow: always looks forward, 1..7", function () {
  // Tue/Thu plan: Tue -> Thu is 2 days, Thu -> Tue is 5
  assert.strictEqual(DOMAIN.daysToNextDow(2, [2, 4]), 2);
  assert.strictEqual(DOMAIN.daysToNextDow(4, [2, 4]), 5);
  // a shot taken off-plan still points at the next planned day
  assert.strictEqual(DOMAIN.daysToNextDow(3, [2, 4]), 1);   // Wed -> Thu
  assert.strictEqual(DOMAIN.daysToNextDow(5, [2, 4]), 4);   // Fri -> Tue
  // one day a week is a weekly rhythm, never "today again"
  assert.strictEqual(DOMAIN.daysToNextDow(1, [1]), 7);
  // every day
  assert.strictEqual(DOMAIN.daysToNextDow(7, [1, 2, 3, 4, 5, 6, 7]), 1);
  assert.strictEqual(DOMAIN.daysToNextDow(2, []), null);
  assert.strictEqual(DOMAIN.daysToNextDow(null, [2, 4]), null);
});

test("doseCountdown: a weekday plan counts to the next planned day", function () {
  // Tue 2026-08-04 08:00 local, plan Tue+Thu -> due Thu, i.e. 2 days on
  var tue = new Date(2026, 7, 4, 8, 0, 0).getTime();
  var cd = DOMAIN.doseCountdown(tue, 3.5, tue + 3600000, [2, 4]);
  assert.strictEqual(cd.everyDays, 2);                       // the plan overrides the number
  assert.strictEqual(cd.nextMs, tue + 2 * 86400000);
  assert.strictEqual(cd.overdue, false);

  // the same plan from Thursday is a five-day wait, not another two
  var thu = new Date(2026, 7, 6, 8, 0, 0).getTime();
  var cd2 = DOMAIN.doseCountdown(thu, 3.5, thu + 3600000, [2, 4]);
  assert.strictEqual(cd2.everyDays, 5);
  assert.strictEqual(cd2.nextMs, thu + 5 * 86400000);

  // no plan -> the plain interval, exactly as before
  var cd3 = DOMAIN.doseCountdown(tue, 3.5, tue, null);
  assert.strictEqual(cd3.everyDays, 3.5);
  assert.strictEqual(cd3.nextMs, tue + 3.5 * 86400000);
  // an empty set is not a plan
  assert.strictEqual(DOMAIN.doseCountdown(tue, 3.5, tue, []).everyDays, 3.5);
  // a plan with no interval at all still counts down
  assert.strictEqual(DOMAIN.doseCountdown(tue, null, tue, [2, 4]).everyDays, 2);
  assert.strictEqual(DOMAIN.doseCountdown(null, 3.5, tue, [2, 4]), null);
});

test("doseStreakAsOf: switching rhythm ends the dose period", function () {
  function shot(date, dose, extra) {
    return Object.assign({ id: date, ts: date + "T10:00:00.000Z", date: date,
                           substance: "trt", dose: dose, unit: "mg" }, extra || {});
  }
  // 25 mg every 2 days, then the same 25 mg on a Tue/Thu plan from 20.07
  var st = mkState(false, [
    shot("2026-07-06", 25, { every: 2 }),
    shot("2026-07-08", 25, { every: 2 }),
    shot("2026-07-21", 25, { days: [2, 4] }),
    shot("2026-07-23", 25, { days: [2, 4] })
  ]);
  var s1 = DOMAIN.doseStreakAsOf(st, "trt", "2026-07-23");
  assert.strictEqual(s1.sinceISO, "2026-07-21");            // the rhythm change starts a new period
  assert.deepStrictEqual(Array.from(s1.days), [2, 4]);
  assert.strictEqual(s1.every, null);

  // changing WHICH days is a change too
  var st2 = mkState(false, [
    shot("2026-07-21", 25, { days: [2, 4] }),
    shot("2026-07-27", 25, { days: [1, 4] })
  ]);
  assert.strictEqual(DOMAIN.doseStreakAsOf(st2, "trt", "2026-07-27").sinceISO, "2026-07-27");

  // the same plan written in a different order is the same plan
  var st3 = mkState(false, [
    shot("2026-07-21", 25, { days: [2, 4] }),
    shot("2026-07-23", 25, { days: [4, 2] })
  ]);
  assert.strictEqual(DOMAIN.doseStreakAsOf(st3, "trt", "2026-07-23").sinceISO, "2026-07-21");

  // an unstamped shot is still unknown, not a change
  var st4 = mkState(false, [
    shot("2026-07-21", 25, { days: [2, 4] }),
    shot("2026-07-23", 25)
  ]);
  assert.strictEqual(DOMAIN.doseStreakAsOf(st4, "trt", "2026-07-23").sinceISO, "2026-07-21");
});

test("lastDoseAsOf: carries the weekday plan the shot was stamped with", function () {
  var st = mkState(false, [
    { id: "a", ts: "2026-07-21T10:00:00.000Z", date: "2026-07-21", substance: "trt",
      dose: 25, unit: "mg", days: [4, 2] }
  ]);
  var ld = DOMAIN.lastDoseAsOf(st, "trt", "2026-07-25");
  assert.deepStrictEqual(Array.from(ld.days), [2, 4]);
  assert.strictEqual(ld.every, null);
});

test("normPerDay: a count, floored at one and capped", function () {
  assert.strictEqual(DOMAIN.normPerDay(undefined), 1);
  assert.strictEqual(DOMAIN.normPerDay(null), 1);
  assert.strictEqual(DOMAIN.normPerDay(0), 1);
  assert.strictEqual(DOMAIN.normPerDay(-3), 1);
  assert.strictEqual(DOMAIN.normPerDay("2"), 2);
  assert.strictEqual(DOMAIN.normPerDay(2.7), 2);
  assert.strictEqual(DOMAIN.normPerDay(99), DOMAIN.PER_DAY_MAX);
});

test("nextRollingMs: N a day, then on to the next injection day", function () {
  var H = 3600000;
  // Daily, twice a day, first dose at 09:40 — the user's own example
  var first = new Date(2026, 8, 7, 9, 40, 0).getTime();
  var afterFirst = DOMAIN.nextRollingMs(first, { every: 1, days: null },
                                        { perDay: 2, dayCount: 1, firstMs: first });
  assert.strictEqual(afterFirst, first + 12 * H);                     // 21:40 the same day

  // the day's quota done -> next day at the time the day started, i.e. 09:40
  var second = first + 12 * H;
  var afterSecond = DOMAIN.nextRollingMs(second, { every: 1, days: null },
                                         { perDay: 2, dayCount: 2, firstMs: first });
  assert.strictEqual(afterSecond, new Date(2026, 8, 8, 9, 40, 0).getTime());
  // ... which is exactly "every 12 h" — the two are the same rule
  assert.strictEqual(afterSecond, second + 12 * H);

  // Every 2 days, twice a day: two doses, then a day off
  var e2 = DOMAIN.nextRollingMs(second, { every: 2, days: null },
                                { perDay: 2, dayCount: 2, firstMs: first });
  assert.strictEqual(e2, new Date(2026, 8, 9, 9, 40, 0).getTime());   // day 3, day 2 skipped

  // Mon/Wed/Fri, twice a day: Monday 08:00 -> 20:00 -> Wednesday 08:00
  var mon = new Date(2026, 8, 7, 8, 0, 0).getTime();                  // 07.09.2026 is a Monday
  assert.strictEqual(DOMAIN.nextRollingMs(mon, { every: 1, days: [1, 3, 5] },
                                          { perDay: 2, dayCount: 1, firstMs: mon }),
                     mon + 12 * H);
  assert.strictEqual(DOMAIN.nextRollingMs(mon + 12 * H, { every: 1, days: [1, 3, 5] },
                                          { perDay: 2, dayCount: 2, firstMs: mon }),
                     new Date(2026, 8, 9, 8, 0, 0).getTime());

  // three a day is eight hours apart
  assert.strictEqual(DOMAIN.nextRollingMs(first, { every: 1, days: null },
                                          { perDay: 3, dayCount: 1, firstMs: first }),
                     first + 8 * H);

  // one a day is not this rule's business at all
  assert.strictEqual(DOMAIN.nextRollingMs(first, { every: 1, days: null },
                                          { perDay: 1, dayCount: 1, firstMs: first }), null);
  assert.strictEqual(DOMAIN.nextRollingMs(null, { every: 1 }, { perDay: 2 }), null);
});

test("doseCountdown: named hours beat the count, and one a day is unchanged", function () {
  var H = 3600000, EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  var shot = new Date(2026, 8, 7, 9, 40, 0).getTime();

  // twice a day, no hours named -> 12 h on
  var cd = DOMAIN.doseCountdown(shot, 1, shot, EVERY_DAY, null,
                                { perDay: 2, dayCount: 1, firstMs: shot });
  assert.strictEqual(cd.nextMs, shot + 12 * H);

  // the same substance with hours named ignores the count and uses the clock
  var cd2 = DOMAIN.doseCountdown(shot, 1, shot, EVERY_DAY, ["08:00", "20:00"],
                                 { perDay: 2, dayCount: 1, firstMs: shot });
  assert.strictEqual(cd2.nextMs, new Date(2026, 8, 7, 20, 0, 0).getTime());

  // perDay 1, or no context at all, behaves exactly as before
  var plain = DOMAIN.doseCountdown(shot, 3, shot, null, null);
  assert.strictEqual(DOMAIN.doseCountdown(shot, 3, shot, null, null,
                                          { perDay: 1, dayCount: 1, firstMs: shot }).nextMs,
                     plain.nextMs);
});

test("cadenceKey: how many a day is part of the regimen", function () {
  assert.notStrictEqual(DOMAIN.cadenceKey({ every: 1, perDay: 2 }),
                        DOMAIN.cadenceKey({ every: 1, perDay: 1 }));
  assert.strictEqual(DOMAIN.cadenceKey({ every: 1, perDay: 2 }),
                     DOMAIN.cadenceKey({ every: 1, perDay: 2 }));
  // a cadence stamped before perDay existed keys exactly as it did
  assert.strictEqual(DOMAIN.cadenceKey({ every: 1 }), "e:1");
  assert.strictEqual(DOMAIN.cadenceKey({ every: 1, perDay: 1 }), "e:1");
  assert.strictEqual(DOMAIN.cadenceKey({ days: [1, 3] }), "d:1,3");
  assert.strictEqual(DOMAIN.cadenceKey({ days: [1, 3], perDay: 2 }), "d:1,3x2");
});

test("dueNow: two hours before the moment, and everything past it", function () {
  var cd = function (remainingMs) { return { remainingMs: remainingMs }; };
  assert.strictEqual(DOMAIN.DUE_SOON_MS, 7200000);
  assert.strictEqual(DOMAIN.dueNow(cd(119 * 60000)), true);
  assert.strictEqual(DOMAIN.dueNow(cd(7200000)), true);      // exactly on the edge
  assert.strictEqual(DOMAIN.dueNow(cd(121 * 60000)), false);
  assert.strictEqual(DOMAIN.dueNow(cd(5 * 3600000)), false);
  // past due stays "take it now" however long it has been — not an abs() window
  assert.strictEqual(DOMAIN.dueNow(cd(-60000)), true);
  assert.strictEqual(DOMAIN.dueNow(cd(-3 * 86400000)), true);
  // a substance with no shots has no countdown, so it is never due
  assert.strictEqual(DOMAIN.dueNow(null), false);
  assert.strictEqual(DOMAIN.dueNow(undefined), false);
});

test("dueNow: reads a real countdown, weekday plans included", function () {
  var T = ["08:00", "20:00"], EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  var shot = new Date(2026, 8, 7, 8, 0, 0).getTime();       // Mon 08:00, next slot 20:00
  // 19:30 the same day: half an hour to go
  var near = DOMAIN.doseCountdown(shot, 1, new Date(2026, 8, 7, 19, 30, 0).getTime(), EVERY_DAY, T);
  assert.strictEqual(DOMAIN.dueNow(near), true);
  // 18:30: an hour and a half to go -- inside the two-hour window
  var soon = DOMAIN.doseCountdown(shot, 1, new Date(2026, 8, 7, 18, 30, 0).getTime(), EVERY_DAY, T);
  assert.strictEqual(DOMAIN.dueNow(soon), true);
  // 17:00: three hours to go
  var far = DOMAIN.doseCountdown(shot, 1, new Date(2026, 8, 7, 17, 0, 0).getTime(), EVERY_DAY, T);
  assert.strictEqual(DOMAIN.dueNow(far), false);
  // 21:00: the slot has passed
  var past = DOMAIN.doseCountdown(shot, 1, new Date(2026, 8, 7, 21, 0, 0).getTime(), EVERY_DAY, T);
  assert.strictEqual(past.overdue, true);
  assert.strictEqual(DOMAIN.dueNow(past), true);
});

test("normTimes: hours of the day are cleaned, sorted and deduped", function () {
  assert.deepStrictEqual(Array.from(DOMAIN.normTimes(["20:00", "8:00"])), ["08:00", "20:00"]);
  assert.deepStrictEqual(Array.from(DOMAIN.normTimes(["08:00", "08:00"])), ["08:00"]);
  assert.strictEqual(DOMAIN.normTimes([]), null);
  assert.strictEqual(DOMAIN.normTimes(null), null);
  assert.strictEqual(DOMAIN.normTimes(["24:00", "8:60", "nope", ""]), null);
  assert.deepStrictEqual(Array.from(DOMAIN.normTimes(["23:59", "bad"])), ["23:59"]);
});

test("cadenceKey: the hours are part of the regimen", function () {
  assert.strictEqual(DOMAIN.cadenceKey({ days: [1, 3, 5], times: ["20:00", "08:00"] }), "d:1,3,5@08:00,20:00");
  // twice a day is not the same regimen as once a day
  assert.notStrictEqual(DOMAIN.cadenceKey({ days: [1], times: ["08:00", "20:00"] }),
                        DOMAIN.cadenceKey({ days: [1], times: ["08:00"] }));
  // a fixed gap names its hours too, and adding them is a change of regimen
  assert.strictEqual(DOMAIN.cadenceKey({ every: 2, times: ["08:00"] }), "e:2@08:00");
  // while a gap with no hours keys exactly as it always did, so nothing already
  // stamped re-keys and no history is re-stamped for it
  assert.strictEqual(DOMAIN.cadenceKey({ every: 2 }), "e:2");
});

test("nextSlotMs: twice a day lands on the evening, then on tomorrow morning", function () {
  var T = ["08:00", "20:00"], EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  // Monday 08:05 -> the same evening
  var monMorning = new Date(2026, 8, 7, 8, 5, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(monMorning, EVERY_DAY, T),
                     new Date(2026, 8, 7, 20, 0, 0).getTime());
  // Monday 20:05 -> Tuesday morning
  var monEvening = new Date(2026, 8, 7, 20, 5, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(monEvening, EVERY_DAY, T),
                     new Date(2026, 8, 8, 8, 0, 0).getTime());
  // exactly on the hour still moves on: the slot must be strictly ahead
  var onTheDot = new Date(2026, 8, 7, 8, 0, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(onTheDot, EVERY_DAY, T),
                     new Date(2026, 8, 7, 20, 0, 0).getTime());
  // twice a day but only Mon/Wed/Fri: Monday evening -> Wednesday morning
  assert.strictEqual(DOMAIN.nextSlotMs(monEvening, [1, 3, 5], T),
                     new Date(2026, 8, 9, 8, 0, 0).getTime());
  // no hours, or no days, is not a slot plan
  assert.strictEqual(DOMAIN.nextSlotMs(monMorning, EVERY_DAY, null), null);
  assert.strictEqual(DOMAIN.nextSlotMs(monMorning, null, T), null);
});

test("nextSlotMs: a shot taken early settles THAT dose, not the one before it", function () {
  var EVERY_DAY = [1, 2, 3, 4, 5, 6, 7], T = ["10:00", "22:00"];
  // The reported case: the 22:00 dose logged at 21:31. It used to leave 22:00
  // looking untaken, so by morning the row was seven hours overdue.
  var early = new Date(2026, 8, 1, 21, 31, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(early, EVERY_DAY, T),
                     new Date(2026, 8, 2, 10, 0, 0).getTime());
  // and the morning dose logged at 10:19 must NOT swallow the evening one
  var morning = new Date(2026, 8, 1, 10, 19, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(morning, EVERY_DAY, T),
                     new Date(2026, 8, 1, 22, 0, 0).getTime());

  // One dose a day at 22:00, taken at noon: that WAS today's dose, so the next
  // is tomorrow. Pointing at 22:00 today would send the user for a second one.
  var noon = new Date(2026, 8, 1, 12, 0, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(noon, EVERY_DAY, ["22:00"]),
                     new Date(2026, 8, 2, 22, 0, 0).getTime());

  // a tie goes to the earlier slot, so an ambiguous shot never swallows a dose
  // still ahead: 16:00 is exactly between 10:00 and 22:00
  var tie = new Date(2026, 8, 1, 16, 0, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(tie, EVERY_DAY, T),
                     new Date(2026, 8, 1, 22, 0, 0).getTime());

  // a genuinely missed dose is still missed: three days back, one a day
  var stale = new Date(2026, 7, 29, 22, 0, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(stale, EVERY_DAY, ["22:00"]),
                     new Date(2026, 7, 30, 22, 0, 0).getTime());
});

test("doseCountdown: the reported KPV morning is neither overdue nor shouting", function () {
  var EVERY_DAY = [1, 2, 3, 4, 5, 6, 7], T = ["10:00", "22:00"];
  var shot = new Date(2026, 8, 1, 21, 31, 0).getTime();   // Tue 21:31
  var now = new Date(2026, 8, 2, 5, 33, 0).getTime();     // Wed 05:33
  var cd = DOMAIN.doseCountdown(shot, 1, now, EVERY_DAY, T);
  assert.strictEqual(cd.nextMs, new Date(2026, 8, 2, 10, 0, 0).getTime());
  assert.strictEqual(cd.overdue, false);
  assert.strictEqual(DOMAIN.dueNow(cd), false);
});

test("doseCountdown: hours pin the next shot to the clock, not to an offset", function () {
  var T = ["08:00", "20:00"], EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  // a late morning shot (09:30) still points at 20:00 the same day, so being
  // late does not drag the evening along with it
  var late = new Date(2026, 8, 7, 9, 30, 0).getTime();
  var cd = DOMAIN.doseCountdown(late, 1, late + 60000, EVERY_DAY, T);
  assert.strictEqual(cd.nextMs, new Date(2026, 8, 7, 20, 0, 0).getTime());
  assert.strictEqual(cd.overdue, false);
  assert.strictEqual(cd.hours, 10);          // 10 h 29 min to go, floored

  // and the evening shot points at tomorrow morning, 12 h on
  var eve = new Date(2026, 8, 7, 20, 0, 0).getTime();
  var cd2 = DOMAIN.doseCountdown(eve, 1, eve, EVERY_DAY, T);
  assert.strictEqual(cd2.nextMs, new Date(2026, 8, 8, 8, 0, 0).getTime());
  assert.strictEqual(cd2.everyDays, 0.5);

  // a fixed gap honours the hours as readily: the same Monday morning shot on
  // "every 3 days at 08:00 and 20:00" still points at 20:00 that evening
  assert.strictEqual(DOMAIN.doseCountdown(late, 3, late, null, T).nextMs,
                     new Date(2026, 8, 7, 20, 0, 0).getTime());
  // with no hours at all it is the plain interval again
  assert.strictEqual(DOMAIN.doseCountdown(late, 3, late, null, null).everyDays, 3);
});

test("nextSlotMs: a fixed gap names its hours too", function () {
  // every 2 days at 20:00, taken three minutes late: Monday -> Wednesday 20:00.
  // Being late must not drag the rhythm three minutes along with it.
  var mon = new Date(2026, 8, 7, 20, 3, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(mon, null, ["20:00"], 2),
                     new Date(2026, 8, 9, 20, 0, 0).getTime());
  // daily at 09:00 and 21:00 — "every 12 h", said in hours instead of a count
  var morning = new Date(2026, 8, 7, 9, 5, 0).getTime();
  var evening = new Date(2026, 8, 7, 21, 5, 0).getTime();
  assert.strictEqual(DOMAIN.nextSlotMs(morning, null, ["09:00", "21:00"], 1),
                     new Date(2026, 8, 7, 21, 0, 0).getTime());
  assert.strictEqual(DOMAIN.nextSlotMs(evening, null, ["09:00", "21:00"], 1),
                     new Date(2026, 8, 8, 9, 0, 0).getTime());
  // every 2 days, twice a day: the day's last dose steps two days on, to the
  // first hour — counted from where the injection day began, not from the dose
  assert.strictEqual(DOMAIN.nextSlotMs(evening, null, ["09:00", "21:00"], 2, morning),
                     new Date(2026, 8, 9, 9, 0, 0).getTime());
  // an hour cannot be honoured half a day at a time, so the gap counts in whole
  // days: 3.5 is four days on, not three days and twelve hours
  assert.strictEqual(DOMAIN.nextSlotMs(mon, null, ["20:00"], 3.5),
                     new Date(2026, 8, 11, 20, 0, 0).getTime());
  // a weekday plan still wins outright over the gap
  assert.strictEqual(DOMAIN.nextSlotMs(mon, [1, 4], ["20:00"], 2),
                     new Date(2026, 8, 10, 20, 0, 0).getTime());
  // and neither half alone is a slot plan
  assert.strictEqual(DOMAIN.nextSlotMs(mon, null, null, 2), null);
  assert.strictEqual(DOMAIN.nextSlotMs(mon, null, ["20:00"], null), null);
});

test("doseCountdown: a fixed gap counts down to the named hour", function () {
  var shot = new Date(2026, 8, 7, 20, 3, 0).getTime();          // Mon 20:03
  var ctx = { perDay: 1, dayCount: 1, firstMs: shot };
  var cd = DOMAIN.doseCountdown(shot, 2, new Date(2026, 8, 9, 19, 30, 0).getTime(),
                                null, ["20:00"], ctx);
  assert.strictEqual(cd.nextMs, new Date(2026, 8, 9, 20, 0, 0).getTime());
  assert.strictEqual(cd.overdue, false);
  assert.strictEqual(DOMAIN.dueNow(cd), true);                  // half an hour out is "now"
  // the hours win over the plain count, here as on a weekday plan: twice a day
  // would have said "twelve hours from the shot"
  var cd2 = DOMAIN.doseCountdown(shot, 2, shot, null, ["20:00"],
                                 { perDay: 2, dayCount: 1, firstMs: shot });
  assert.strictEqual(cd2.nextMs, new Date(2026, 8, 9, 20, 0, 0).getTime());
});

test("doseStreakAsOf: dropping from twice a day to once starts a new period", function () {
  function shot(date, extra) {
    return Object.assign({ id: date, ts: date + "T10:00:00.000Z", date: date,
                           substance: "trt", dose: 25, unit: "mg" }, extra || {});
  }
  var EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  var st = mkState(false, [
    shot("2026-09-01", { days: EVERY_DAY, times: ["08:00", "20:00"] }),
    shot("2026-09-02", { days: EVERY_DAY, times: ["08:00", "20:00"] }),
    shot("2026-09-03", { days: EVERY_DAY, times: ["08:00"] })
  ]);
  var s1 = DOMAIN.doseStreakAsOf(st, "trt", "2026-09-03");
  assert.strictEqual(s1.sinceISO, "2026-09-03");
  assert.deepStrictEqual(Array.from(s1.times), ["08:00"]);

  // the same two hours written in the other order is the same regimen
  var st2 = mkState(false, [
    shot("2026-09-01", { days: EVERY_DAY, times: ["08:00", "20:00"] }),
    shot("2026-09-02", { days: EVERY_DAY, times: ["20:00", "08:00"] })
  ]);
  assert.strictEqual(DOMAIN.doseStreakAsOf(st2, "trt", "2026-09-02").sinceISO, "2026-09-01");
});

test("vialAsOf: a backdated shot uses the vial that was open then", function () {
  var vials = [{ id: "v1", date: "2026-07-01", mg: 10, ml: 2 },
               { id: "v2", date: "2026-08-10", mg: 10, ml: 1 }];
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-08-20").id, "v2");
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-08-10").id, "v2");   // the day it was mixed
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-08-09").id, "v1");
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-06-30"), null);      // before the first vial
  assert.strictEqual(DOMAIN.vialAsOf([], "2026-08-20"), null);
});

test("vialAsOf: a mix re-entered on a date already on file supersedes it", function () {
  var vials = [{ id: "v1", date: "2026-07-01", mg: 10, ml: 2 },
               { id: "v2", date: "2026-07-01", mg: 10, ml: 1 }];   // same day, corrected
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-07-05").id, "v2");
});

test("vialSpans: one record holds every mix with the days it covers", function () {
  assert.deepStrictEqual(Array.from(DOMAIN.vialSpans([])), []);
  assert.deepStrictEqual(Array.from(DOMAIN.vialSpans(null)), []);

  // a lone vial holds open
  var one = Array.from(DOMAIN.vialSpans([{ id: "v1", date: "2026-06-01", mg: 10, ml: 1 }]));
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].until, null);

  // KLOW at 10 mg/ml, then at 20 mg/ml: the periods meet on the changeover day,
  // which belongs to both -- the old one was drawn from before the new was mixed
  var two = Array.from(DOMAIN.vialSpans([{ id: "v2", date: "2026-09-01", mg: 20, ml: 1 },
                                         { id: "v1", date: "2026-06-01", mg: 10, ml: 1 }]));
  assert.deepStrictEqual(pluck(two, "id"), ["v1", "v2"]);          // sorted oldest first
  assert.deepStrictEqual(pluck(two, "until"), ["2026-09-01", null]);
  assert.deepStrictEqual(pluck(two, "mg"), [10, 20]);

  // three in a row, entered out of order
  var three = Array.from(DOMAIN.vialSpans([{ id: "b", date: "2026-02-10", mg: 5, ml: 1 },
                                           { id: "c", date: "2026-03-01", mg: 5, ml: 2 },
                                           { id: "a", date: "2026-01-01", mg: 5, ml: 3 }]));
  assert.deepStrictEqual(pluck(three, "id"), ["a", "b", "c"]);
  assert.deepStrictEqual(pluck(three, "until"), ["2026-02-10", "2026-03-01", null]);

  // a mix corrected on its own date covers no days, so it is not a period
  var same = Array.from(DOMAIN.vialSpans([{ id: "v1", date: "2026-06-01", mg: 10, ml: 2 },
                                          { id: "v2", date: "2026-06-01", mg: 10, ml: 1 }]));
  assert.deepStrictEqual(pluck(same, "id"), ["v2"]);
  assert.strictEqual(same[0].until, null);

  // a vial with no date is not a period either
  assert.deepStrictEqual(pluck(DOMAIN.vialSpans([{ id: "x", mg: 5, ml: 1 }]), "id"), []);
});

test("vialAsOf: a finished vial stops being a concentration after its last day", function () {
  var vials = [{ id: "v1", date: "2026-08-01", end: "2026-09-11", mg: 10, ml: 2 }];
  // the day it ran out still counts -- you drew from it that day
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-09-11").id, "v1");
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-09-10").id, "v1");
  // after it there is nothing to draw from until the next mix
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-09-12"), null);
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-10-01"), null);
});

test("vialAsOf: no end means still going, exactly as before", function () {
  var vials = [{ id: "v1", date: "2026-08-01", mg: 10, ml: 2 }];
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2027-05-01").id, "v1");
});

test("vialAsOf: after a gap the next vial takes over on its own day", function () {
  var vials = [{ id: "v1", date: "2026-08-01", end: "2026-09-01", mg: 10, ml: 2 },
               { id: "v2", date: "2026-09-08", mg: 20, ml: 2 }];
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-09-01").id, "v1");
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-09-04"), null);   // nothing to draw from
  assert.strictEqual(DOMAIN.vialAsOf(vials, "2026-09-08").id, "v2");
});

test("vialSpans: a recorded end beats a guessed one", function () {
  // ran out a week before the next was mixed: the gap is real, not papered over
  var gap = Array.from(DOMAIN.vialSpans([{ id: "v1", date: "2026-08-01", end: "2026-09-01", mg: 10, ml: 2 },
                                         { id: "v2", date: "2026-09-08", mg: 20, ml: 2 }]));
  assert.deepStrictEqual(pluck(gap, "id"), ["v1", "v2"]);
  assert.deepStrictEqual(pluck(gap, "until"), ["2026-09-01", null]);
  assert.deepStrictEqual(pluck(gap, "end"), ["2026-09-01", null]);

  // no end on file (old data, or a row written before mixing closed it): the
  // guess is the day the next one was mixed -- the same day a recorded end
  // would name, so both kinds of row read alike
  var guessed = Array.from(DOMAIN.vialSpans([{ id: "v1", date: "2026-08-01", mg: 10, ml: 2 },
                                             { id: "v2", date: "2026-09-08", mg: 20, ml: 2 }]));
  assert.deepStrictEqual(pluck(guessed, "until"), ["2026-09-08", null]);
  assert.deepStrictEqual(pluck(guessed, "end"), [null, null]);   // guessed, never written

  // the last vial holds open even when it is finished
  var done = Array.from(DOMAIN.vialSpans([{ id: "v1", date: "2026-08-01", end: "2026-09-01", mg: 10, ml: 2 }]));
  assert.deepStrictEqual(pluck(done, "until"), ["2026-09-01"]);
});

test("vialSpans: finishing one and mixing another the same day is two vials, not a correction", function () {
  var both = Array.from(DOMAIN.vialSpans([{ id: "v1", date: "2026-09-11", end: "2026-09-11", mg: 10, ml: 3 },
                                          { id: "v2", date: "2026-09-11", mg: 10, ml: 2 }]));
  assert.deepStrictEqual(pluck(both, "id"), ["v1", "v2"]);
  assert.deepStrictEqual(pluck(both, "until"), ["2026-09-11", null]);

  // without an end the same two rows are still one correction -- old data unchanged
  var corr = Array.from(DOMAIN.vialSpans([{ id: "v1", date: "2026-09-11", mg: 10, ml: 3 },
                                          { id: "v2", date: "2026-09-11", mg: 10, ml: 2 }]));
  assert.deepStrictEqual(pluck(corr, "id"), ["v2"]);
});

// ---- one dose, two ways of writing it ----
test("sameDose: 1.6 mg and 1600 mcg are the same dose", function () {
  assert.strictEqual(DOMAIN.sameDose(1.6, "mg", 1600, "mcg"), true);
  assert.strictEqual(DOMAIN.sameDose(1600, "mcg", 1.6, "mg"), true);
  assert.strictEqual(DOMAIN.sameDose(0.9, "mg", 900, "mcg"), true);
  assert.strictEqual(DOMAIN.sameDose(2.5, "mg", 2.5, "mg"), true);
  // a different dose is still a different dose
  assert.strictEqual(DOMAIN.sameDose(1.6, "mg", 1500, "mcg"), false);
  assert.strictEqual(DOMAIN.sameDose(1.6, "mg", 1.7, "mg"), false);
  // units on different scales have no conversion, so they are not the same
  assert.strictEqual(DOMAIN.sameDose(1.6, "mg", 1.6, "IU"), false);
  // nothing compares to nothing
  assert.strictEqual(DOMAIN.sameDose(null, "mg", 1, "mg"), false);
  assert.strictEqual(DOMAIN.sameDose(null, "mg", null, "mg"), true);
});

test("doseStreakAsOf: relabelling mg to mcg starts no new regimen", function () {
  var mixed = { settings: {}, inj: { peptides: [{ id: "kpv", unit: "mcg" }] }, injLog: [
    { id: "a", date: "2026-08-01", substance: "kpv", dose: 1.6, unit: "mg", every: 1 },
    { id: "b", date: "2026-08-08", substance: "kpv", dose: 1.6, unit: "mg", every: 1 },
    { id: "c", date: "2026-08-15", substance: "kpv", dose: 1600, unit: "mcg", every: 1 },
    { id: "d", date: "2026-08-22", substance: "kpv", dose: 1600, unit: "mcg", every: 1 }] };
  var s = DOMAIN.doseStreakAsOf(mixed, "kpv", "2026-08-22");
  assert.strictEqual(s.sinceISO, "2026-08-01", "one dose throughout, however it was written");
  assert.strictEqual(s.weeks, 4);
  // and a real change still ends the run
  mixed.injLog[3].dose = 800;
  var cut = DOMAIN.doseStreakAsOf(mixed, "kpv", "2026-08-22");
  assert.strictEqual(cut.sinceISO, "2026-08-22");
});

test("seriesFor: one unit for the whole injection series", function () {
  var mixed = { settings: {}, inj: { peptides: [{ id: "kpv", unit: "mcg" }] }, injLog: [
    { id: "a", date: "2026-08-01", substance: "kpv", dose: 1.6, unit: "mg" },
    { id: "b", date: "2026-08-15", substance: "kpv", dose: 1600, unit: "mcg" }] };
  // written two ways, plotted as one flat line rather than a thousandfold cliff
  assert.deepStrictEqual(pluck(DOMAIN.seriesFor(mixed, "inj:kpv"), "value"), [1600, 1600]);
  // the compound's own unit decides; switch it and the whole series follows
  mixed.inj.peptides[0].unit = "mg";
  assert.deepStrictEqual(pluck(DOMAIN.seriesFor(mixed, "inj:kpv"), "value"), [1.6, 1.6]);
  // no compound on file: the newest logged unit carries the series
  var loose = { settings: {}, injLog: mixed.injLog };
  assert.deepStrictEqual(pluck(DOMAIN.seriesFor(loose, "inj:kpv"), "value"), [1600, 1600]);
});

test("doseUnitFor: the compound's own unit, else the newest logged, else mg", function () {
  var st = { settings: {}, inj: { peptides: [{ id: "kpv", unit: "mcg" }], trt: { unit: "mg" } }, injLog: [
    { id: "a", date: "2026-08-01", substance: "other", dose: 1, unit: "IU" }] };
  assert.strictEqual(DOMAIN.doseUnitFor(st, "kpv"), "mcg");
  assert.strictEqual(DOMAIN.doseUnitFor(st, "trt"), "mg");
  assert.strictEqual(DOMAIN.doseUnitFor(st, "other"), "IU");
  assert.strictEqual(DOMAIN.doseUnitFor(st, "nothing"), "mg");
});

// ---- what is left in the vial, and how far it reaches ----
function shot(date, dose, unit, extra) {
  return Object.assign({ id: "s" + date, date: date, substance: "kpv", dose: dose, unit: unit || "mg" }, extra || {});
}

test("daysPerDose: the rhythm as one number, whatever shape it was written in", function () {
  assert.strictEqual(DOMAIN.daysPerDose(2, null, null, 1), 2);
  assert.strictEqual(DOMAIN.daysPerDose(1, null, null, 1), 1);
  assert.strictEqual(DOMAIN.daysPerDose(1, null, null, 2), 0.5);      // twice a day
  assert.strictEqual(DOMAIN.daysPerDose(3.5, null, null, 1), 3.5);    // Tirzepatyd
  assert.strictEqual(DOMAIN.daysPerDose(1, [1, 3, 5], null, 1), 7 / 3);  // Mon/Wed/Fri
  assert.strictEqual(DOMAIN.daysPerDose(2, [1, 3, 5], null, 1), 7 / 3);  // the plan wins over the gap
  // named hours say how many a day better than the count does -- same
  // precedence as doseCountdown, so one rhythm never reads two ways
  assert.strictEqual(DOMAIN.daysPerDose(1, null, ["08:00", "20:00"], 1), 0.5);
  assert.strictEqual(DOMAIN.daysPerDose(1, null, ["08:00", "20:00"], 5), 0.5);
  assert.strictEqual(DOMAIN.daysPerDose(null, null, null, 1), null);
  assert.strictEqual(DOMAIN.daysPerDose(0, null, null, 1), null);
});

test("vialStatus: what the log says has been drawn, subtracted from the vial", function () {
  var vials = [{ id: "v1", date: "2026-09-01", mg: 10, ml: 4 }];
  var log = [shot("2026-09-03", 0.9), shot("2026-09-05", 0.9), shot("2026-09-07", 0.9)];
  var vs = DOMAIN.vialStatus(vials, log, "2026-09-12", 0.9, "mg", 2, "2026-09-13");
  assert.strictEqual(vs.id, "v1");
  assert.strictEqual(vs.cap, 10);
  assert.strictEqual(vs.used, 2.7);
  assert.strictEqual(vs.left, 7.3);
  assert.strictEqual(vs.shots, 3);
  assert.strictEqual(vs.unknown, 0);
  assert.strictEqual(vs.doses, 8);            // 7.3 / 0.9 = 8.11 -- the part dose stays in the vial
  assert.strictEqual(vs.mlLeft, 2.92);        // the same fraction of the water
  // eight more doses every two days, counted from the day the next one is due
  assert.strictEqual(vs.runOutISO, "2026-09-27");
});

test("vialStatus: only the shots this vial was open for", function () {
  var vials = [{ id: "v1", date: "2026-08-01", end: "2026-09-01", mg: 10, ml: 2 },
               { id: "v2", date: "2026-09-01", mg: 10, ml: 2 }];
  var log = [shot("2026-08-20", 5), shot("2026-09-05", 1)];
  // the shot from the old vial does not touch the new one
  var now = DOMAIN.vialStatus(vials, log, "2026-09-12", 1, "mg", 1, "2026-09-13");
  assert.strictEqual(now.id, "v2");
  assert.strictEqual(now.used, 1);
  assert.strictEqual(now.shots, 1);
  // and asked about a day the old one was open, it answers for the old one
  var then = DOMAIN.vialStatus(vials, log, "2026-08-25", 5, "mg", 1, "2026-08-26");
  assert.strictEqual(then.id, "v1");
  assert.strictEqual(then.used, 5);
  assert.strictEqual(then.left, 5);
  assert.strictEqual(then.runOutISO, null, "a vial with a recorded end needs no estimate");
});

test("vialStatus: a shot with no dose subtracts nothing and says so", function () {
  var vials = [{ id: "v1", date: "2026-09-01", mg: 10, ml: 2 }];
  var log = [shot("2026-09-03", 1), shot("2026-09-05", null), shot("2026-09-07", 1)];
  var vs = DOMAIN.vialStatus(vials, log, "2026-09-12", 1, "mg", 1, "2026-09-13");
  assert.strictEqual(vs.used, 2);
  assert.strictEqual(vs.shots, 3);
  assert.strictEqual(vs.unknown, 1);   // so 8 left is the most it can be, not the least
  assert.strictEqual(vs.doses, 8);
});

test("vialStatus: micrograms come off a vial labelled in milligrams", function () {
  var vials = [{ id: "v1", date: "2026-09-01", mg: 10, ml: 2 }];
  var log = [shot("2026-09-03", 500, "mcg"), shot("2026-09-04", 500, "mcg")];
  var vs = DOMAIN.vialStatus(vials, log, "2026-09-12", 500, "mcg", 1, "2026-09-13");
  assert.strictEqual(vs.used, 1);      // 2 x 500 mcg = 1 mg
  assert.strictEqual(vs.left, 9);
  assert.strictEqual(vs.doses, 18);
  // an old shot logged in mcg keeps meaning mcg after the compound moves to mg
  var moved = DOMAIN.vialStatus(vials, log, "2026-09-12", 0.5, "mg", 1, "2026-09-13");
  assert.strictEqual(moved.used, 1, "the total does not move when the compound's unit does");
  assert.strictEqual(moved.doses, 18);
});

test("vialStatus: drawn dry, and nothing to be asked of it", function () {
  var vials = [{ id: "v1", date: "2026-09-01", mg: 2, ml: 1 }];
  var over = DOMAIN.vialStatus(vials, [shot("2026-09-03", 1.5), shot("2026-09-05", 1.5)],
                               "2026-09-12", 1, "mg", 1, "2026-09-13");
  assert.strictEqual(over.used, 2, "never more than the vial held");
  assert.strictEqual(over.left, 0);
  assert.strictEqual(over.doses, 0);
  assert.strictEqual(over.runOutISO, null);

  // not enough left for one more whole dose
  var short = DOMAIN.vialStatus(vials, [shot("2026-09-03", 1.5)], "2026-09-12", 1, "mg", 1, "2026-09-13");
  assert.strictEqual(short.doses, 0);

  // no vial, no capacity, no dose: nothing to report rather than a wrong number
  assert.strictEqual(DOMAIN.vialStatus([], [], "2026-09-12", 1, "mg", 1, "2026-09-13"), null);
  assert.strictEqual(DOMAIN.vialStatus([{ id: "x", date: "2026-09-01", mg: 0, ml: 2 }], [],
                                       "2026-09-12", 1, "mg", 1, "2026-09-13"), null);
  assert.strictEqual(DOMAIN.vialStatus(vials, [], "2026-09-12", null, "mg", 1, "2026-09-13").doses, null);
});

test("reconstitution end to end: 10 mg vial, 2 ml water, 2.5 mg dose", function () {
  var v = DOMAIN.vialAsOf([{ id: "v1", date: "2026-08-01", mg: 10, ml: 2 }], "2026-08-05");
  var conc = DOMAIN.vialConc(v.mg, v.ml);
  assert.strictEqual(conc, 5);
  assert.strictEqual(DOMAIN.unitsForDose(2.5, "mg", conc), 50);
});

test("parseRoute: bare tab, sub-state, empty and unknown hashes", function () {
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#inject")), { tab: "inject", sub: null });
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#inject/trt")), { tab: "inject", sub: "trt" });
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("")), { tab: "pulpit", sub: null });
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute(null)), { tab: "pulpit", sub: null });
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#")), { tab: "pulpit", sub: null });
  // an unknown tab is passed through verbatim — validating it is the router's job
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#bzdura")), { tab: "bzdura", sub: null });
});

test("parseRoute: legacy #jab alias still lands on injections", function () {
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#jab")), { tab: "inject", sub: null });
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#jab/trt")), { tab: "inject", sub: "trt" });
});

test("parseRoute: peptide ids and stray slashes", function () {
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#inject/pep3")), { tab: "inject", sub: "pep3" });
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#inject//trt")), { tab: "inject", sub: "trt" });
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#/inject/trt")), { tab: "inject", sub: "trt" });
  assert.deepStrictEqual(Object.assign({}, DOMAIN.parseRoute("#inject/trt/extra")), { tab: "inject", sub: "trt" });
});

test("buildRoute: with and without a sub-state", function () {
  assert.strictEqual(DOMAIN.buildRoute("inject", "trt"), "#inject/trt");
  assert.strictEqual(DOMAIN.buildRoute("inject"), "#inject");
  assert.strictEqual(DOMAIN.buildRoute("inject", null), "#inject");
  assert.strictEqual(DOMAIN.buildRoute("weight", ""), "#weight");
  assert.strictEqual(DOMAIN.buildRoute(""), "#pulpit");
});

test("parseRoute(buildRoute(t,s)) round-trips", function () {
  [["pulpit", null], ["weight", null], ["inject", "trt"], ["inject", "mounjaro"], ["inject", "pep12"]]
    .forEach(function (pair) {
      var r = DOMAIN.parseRoute(DOMAIN.buildRoute(pair[0], pair[1]));
      assert.strictEqual(r.tab, pair[0]);
      assert.strictEqual(r.sub, pair[1]);
    });
});

test("bmiCategory: names the band and leaves the colour to the UI", function () {
  var cases = [[17.2, 0, "bmi.cat.under"], [18.5, 1, "bmi.cat.normal"], [24.9, 1, "bmi.cat.normal"],
               [25, 2, "bmi.cat.over"], [30, 3, "bmi.cat.ob1"], [34.9, 3, "bmi.cat.ob1"],
               [35, 4, "bmi.cat.ob2"], [40, 5, "bmi.cat.ob3"], [61, 5, "bmi.cat.ob3"]];
  cases.forEach(function (c) {
    var r = DOMAIN.bmiCategory(c[0]);
    assert.strictEqual(r.band, c[1], "band for " + c[0]);
    assert.strictEqual(r.key, c[2]);
    assert.strictEqual(r.color, undefined);   // DOMAIN stays free of the palette
  });
});

test("BMI_BANDS are the boundaries bmiBand actually splits on", function () {
  assert.deepStrictEqual(Array.from(DOMAIN.BMI_BANDS), [0, 18.5, 25, 30, 35, 40]);
  Array.from(DOMAIN.BMI_BANDS).forEach(function (edge, i) {
    assert.strictEqual(DOMAIN.bmiBand(edge), i);
    if (i > 0) assert.strictEqual(DOMAIN.bmiBand(edge - 0.01), i - 1);
  });
});

test("bpAverage: three back-to-back readings collapse to one, rounded", function () {
  var r = DOMAIN.bpAverage([{ sys: 128, dia: 84, pulse: 70 },
                            { sys: 124, dia: 80, pulse: 66 },
                            { sys: 121, dia: 79, pulse: 65 }]);
  assert.strictEqual(r.sys, 124);          // 373/3 = 124.33
  assert.strictEqual(r.dia, 81);           // 243/3 = 81
  assert.strictEqual(r.pulse, 67);         // 201/3 = 67
  assert.strictEqual(r.n, 3);
});

test("bpAverage: a row needs both values to count", function () {
  var r = DOMAIN.bpAverage([{ sys: 130, dia: 80, pulse: 70 },
                            { sys: 120, dia: null, pulse: 60 },   // half-typed row is ignored
                            { sys: 140, dia: 90, pulse: 80 }]);
  assert.strictEqual(r.n, 2);
  assert.strictEqual(r.sys, 135);
  assert.strictEqual(r.dia, 85);
  assert.strictEqual(r.pulse, 75);         // the ignored row's pulse does not sneak in
});

test("bpAverage: pulse averages over the rows that have one", function () {
  var r = DOMAIN.bpAverage([{ sys: 120, dia: 80, pulse: 60 },
                            { sys: 130, dia: 90, pulse: null },
                            { sys: 128, dia: 82, pulse: 70 }]);
  assert.strictEqual(r.n, 3);
  assert.strictEqual(r.pulse, 65);
  assert.strictEqual(DOMAIN.bpAverage([{ sys: 120, dia: 80 }]).pulse, null);
});

test("bpAverage: nothing usable in, null out", function () {
  assert.strictEqual(DOMAIN.bpAverage([]), null);
  assert.strictEqual(DOMAIN.bpAverage(null), null);
  assert.strictEqual(DOMAIN.bpAverage([{ sys: 0, dia: 0 }, { sys: null, dia: 80 }]), null);
});

test("bpAverage: a single reading still averages to itself", function () {
  var r = DOMAIN.bpAverage([{ sys: 118, dia: 76, pulse: 61 }]);
  assert.deepStrictEqual([r.sys, r.dia, r.pulse, r.n], [118, 76, 61, 1]);
});

// ---- compound name matching ------------------------------------------------

test("normName: one compound stays one compound however it was typed", function () {
  ["KLOW", "klow", "K-LOW", "k low", " Klow ", "K_LOW", "(KLOW)"].forEach(function (v) {
    assert.strictEqual(DOMAIN.normName(v), "klow", v);
  });
});

test("normName: accents and the Polish l-stroke fold away", function () {
  assert.strictEqual(DOMAIN.normName("Głutation"), DOMAIN.normName("glutation"));
  assert.strictEqual(DOMAIN.normName("Tirzepatyd"), DOMAIN.normName("TIRZEPATYD"));
  assert.strictEqual(DOMAIN.normName("Sémaglutyd"), "semaglutyd");
});

test("normName: empty-ish input never throws and yields an empty key", function () {
  [null, undefined, "", "   ", "---", "()"].forEach(function (v) {
    assert.strictEqual(DOMAIN.normName(v), "");
  });
});

test("nameScore: exact beats prefix beats substring", function () {
  assert.strictEqual(DOMAIN.nameScore("klow", "KLOW"), 100);
  assert.ok(DOMAIN.nameScore("klo", "KLOW") > DOMAIN.nameScore("klow", "BPC-157 + TB-500 (KLOW)"));
  assert.ok(DOMAIN.nameScore("klow", "BPC-157 + TB-500 (KLOW)") > 0);
});

test("nameScore: a typo still matches, an unrelated name does not", function () {
  assert.ok(DOMAIN.nameScore("klov", "KLOW") > 0);
  assert.strictEqual(DOMAIN.nameScore("retatrutyd", "KLOW"), 0);
  assert.strictEqual(DOMAIN.nameScore("", "KLOW"), 0);
});

test("similarCompounds: ranks matches, drops the rest, keeps all on empty query", function () {
  var list = [
    { id: "a", name: "Retatrutyd" },
    { id: "b", name: "BPC-157 + TB-500 (KLOW)" },
    { id: "c", name: "KLOW" }
  ];
  assert.deepStrictEqual(pluck(DOMAIN.similarCompounds(list, "klow"), "id"), ["c", "b"]);
  assert.deepStrictEqual(pluck(DOMAIN.similarCompounds(list, "reta"), "id"), ["a"]);
  assert.strictEqual(DOMAIN.similarCompounds(list, "").length, 3);
  assert.strictEqual(DOMAIN.similarCompounds([], "klow").length, 0);
});

// ---- glucose ----
test("gluToMgdl / gluFromMgdl: one canonical unit, and the round trip holds", function () {
  assert.strictEqual(DOMAIN.gluToMgdl(99, "mgdl"), 99);
  assert.strictEqual(DOMAIN.gluToMgdl(5.5, "mmol"), 99);
  assert.strictEqual(DOMAIN.gluFromMgdl(99, "mgdl"), 99);
  assert.strictEqual(DOMAIN.gluFromMgdl(99, "mmol"), 5.5);
  // typed in mmol, read back in mmol: the reading must come back as itself
  [3.9, 5.5, 5.6, 7.8, 11.1].forEach(function (v) {
    assert.strictEqual(DOMAIN.gluFromMgdl(DOMAIN.gluToMgdl(v, "mmol"), "mmol"), v);
  });
  // and rubbish stays rubbish rather than becoming a reading
  assert.strictEqual(DOMAIN.gluToMgdl("", "mgdl"), null);
  assert.strictEqual(DOMAIN.gluToMgdl(0, "mgdl"), null);
  assert.strictEqual(DOMAIN.gluToMgdl(-4, "mmol"), null);
  assert.strictEqual(DOMAIN.gluToMgdl("nie liczba", "mgdl"), null);
  assert.strictEqual(DOMAIN.gluFromMgdl(null, "mgdl"), null);
});

test("gluTagFor: the clock guesses which reading this is", function () {
  assert.strictEqual(DOMAIN.gluTagFor(7), "fasting");
  assert.strictEqual(DOMAIN.gluTagFor(10), "fasting");
  assert.strictEqual(DOMAIN.gluTagFor(11), "post");     // the boundary belongs to "after a meal"
  assert.strictEqual(DOMAIN.gluTagFor(17), "post");
  assert.strictEqual(DOMAIN.gluTagFor(18), "bed");
  assert.strictEqual(DOMAIN.gluTagFor(23), "bed");
});

test("gluWindowStats: overall and per tag, because 95 fasting is not 95 after a meal", function () {
  var rows = [
    { mgdl: 90, tag: "fasting" },
    { mgdl: 100, tag: "fasting" },
    { mgdl: 140, tag: "post" },
    { mgdl: 110, tag: "bed" },
    { mgdl: null, tag: "fasting" }          // an empty row counts for nothing
  ];
  var st = DOMAIN.gluWindowStats(rows);
  assert.strictEqual(st.n, 4);
  assert.strictEqual(st.all.min, 90);
  assert.strictEqual(st.all.max, 140);
  assert.strictEqual(st.all.avg, 110);
  assert.strictEqual(st.byTag.fasting.avg, 95);
  assert.strictEqual(st.byTag.post.avg, 140);
  assert.strictEqual(st.byTag.bed.avg, 110);
  assert.strictEqual(DOMAIN.gluWindowStats([]), null);
  assert.strictEqual(DOMAIN.gluWindowStats(null), null);
});

test("seriesFor: glucose is correlatable like every other reading", function () {
  var state = { glu: { log: [
    { id: "g2", ts: "2026-09-06T20:00:00.000Z", mgdl: 105, tag: "bed" },
    { id: "g1", ts: "2026-09-05T07:00:00.000Z", mgdl: 92, tag: "fasting" }
  ] } };
  assert.deepStrictEqual(Array.from(DOMAIN.seriesFor(state, "glucose")).map(function (p) {
    return p.date + ":" + p.value;
  }), ["2026-09-05:92", "2026-09-06:105"]);
  assert.strictEqual(DOMAIN.seriesFor({}, "glucose").length, 0);
});

test("gluTypicalRange: your own middle half, and nothing until there is enough", function () {
  var now = Date.parse("2026-09-08T12:00:00.000Z");
  function r(daysAgo, mgdl) {
    return { id: "x" + daysAgo + "_" + mgdl, mgdl: mgdl, tag: "fasting",
             ts: new Date(now - daysAgo * 86400000).toISOString() };
  }
  // four readings is not yet a habit to describe
  assert.strictEqual(DOMAIN.gluTypicalRange([r(1, 90), r(2, 95), r(3, 100), r(4, 105)], now), null);
  var band = DOMAIN.gluTypicalRange([r(1, 80), r(2, 90), r(3, 100), r(4, 110), r(5, 120)], now);
  assert.deepStrictEqual({ lo: band.lo, hi: band.hi }, { lo: 90, hi: 110 });
  // older than a month is out of the baseline: with those dropped, too few remain
  assert.strictEqual(
    DOMAIN.gluTypicalRange([r(1, 80), r(2, 90), r(40, 100), r(50, 110), r(60, 120)], now), null);
  // a flat run has no spread to draw, so there is no band rather than a hairline
  assert.strictEqual(DOMAIN.gluTypicalRange([r(1, 95), r(2, 95), r(3, 95), r(4, 95), r(5, 95)], now), null);
  assert.strictEqual(DOMAIN.gluTypicalRange([], now), null);
});

test("GLU_TAGS: four readings a day can be told apart, in the order the day runs", function () {
  assert.deepStrictEqual(Array.from(DOMAIN.GLU_TAGS), ["fasting", "pre", "post", "bed"]);
});

test("gluWindowStats: before a meal is its own bucket, not folded into after", function () {
  var st = DOMAIN.gluWindowStats([
    { mgdl: 88, tag: "fasting" },
    { mgdl: 96, tag: "pre" },
    { mgdl: 104, tag: "pre" },
    { mgdl: 150, tag: "post" },
    { mgdl: 110, tag: "bed" }
  ]);
  assert.strictEqual(st.byTag.pre.avg, 100);
  assert.strictEqual(st.byTag.pre.min, 96);
  assert.strictEqual(st.byTag.pre.max, 104);
  assert.strictEqual(st.byTag.post.avg, 150);      // untouched by the new tag
  assert.strictEqual(st.n, 5);
});
