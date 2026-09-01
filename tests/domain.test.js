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
  // hours without days are not a plan, so they do not enter the key
  assert.strictEqual(DOMAIN.cadenceKey({ every: 2, times: ["08:00"] }), "e:2");
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

  // hours with no weekday plan fall back to the plain interval
  assert.strictEqual(DOMAIN.doseCountdown(late, 3, late, null, T).everyDays, 3);
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

  // KLOW at 10 mg/ml, then at 20 mg/ml: the periods meet without a gap or overlap
  var two = Array.from(DOMAIN.vialSpans([{ id: "v2", date: "2026-09-01", mg: 20, ml: 1 },
                                         { id: "v1", date: "2026-06-01", mg: 10, ml: 1 }]));
  assert.deepStrictEqual(pluck(two, "id"), ["v1", "v2"]);          // sorted oldest first
  assert.deepStrictEqual(pluck(two, "until"), ["2026-08-31", null]);
  assert.deepStrictEqual(pluck(two, "mg"), [10, 20]);

  // three in a row, entered out of order
  var three = Array.from(DOMAIN.vialSpans([{ id: "b", date: "2026-02-10", mg: 5, ml: 1 },
                                           { id: "c", date: "2026-03-01", mg: 5, ml: 2 },
                                           { id: "a", date: "2026-01-01", mg: 5, ml: 3 }]));
  assert.deepStrictEqual(pluck(three, "id"), ["a", "b", "c"]);
  assert.deepStrictEqual(pluck(three, "until"), ["2026-02-09", "2026-02-28", null]);

  // a mix corrected on its own date covers no days, so it is not a period
  var same = Array.from(DOMAIN.vialSpans([{ id: "v1", date: "2026-06-01", mg: 10, ml: 2 },
                                          { id: "v2", date: "2026-06-01", mg: 10, ml: 1 }]));
  assert.deepStrictEqual(pluck(same, "id"), ["v2"]);
  assert.strictEqual(same[0].until, null);

  // a vial with no date is not a period either
  assert.deepStrictEqual(pluck(DOMAIN.vialSpans([{ id: "x", mg: 5, ml: 1 }]), "id"), []);
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
