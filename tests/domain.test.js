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

test("doseStreakAsOf: first stamped entry after legacy unstamped ones starts a new streak", function () {
  var log = [
    trt("a", "2026-07-01", 25),
    trt("b", "2026-07-03", 25),
    trt("c", "2026-07-10", 25, null, { every: 1 })
  ];
  var s = DOMAIN.doseStreakAsOf(mkState(false, log), "trt", "2026-07-12");
  assert.strictEqual(s.sinceISO, "2026-07-10");
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
  return Object.assign({ id: id, start: start, end: end || null, label: "", severity: null }, extra || {});
}
function illState(episodes) {
  return { illness: episodes };
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
