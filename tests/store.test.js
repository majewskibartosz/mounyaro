"use strict";
var test = require("node:test");
var assert = require("node:assert");
var harness = require("./extract.js");

var KEY = "mounjaro.v1";

test("migration: pre-sandbagging data loads unchanged, setting defaults to false", function () {
  var old = {
    schemaVersion: 1,
    settings: { lang: "en", currency: "EUR", showDoseWeeks: false },
    injLog: [
      { id: "a", date: "2026-08-01", substance: "trt", dose: 25, unit: "mg", site: "belly_ul" },
      { id: "b", date: "2026-08-04", substance: "mounjaro", dose: 5, unit: "mg", site: null }
    ]
  };
  var ls = harness.fakeLocalStorage();
  ls.setItem(KEY, JSON.stringify(old));
  var STORE = harness.loadStore(ls);
  STORE.load();
  assert.strictEqual(STORE.state.settings.sandbagging, false);
  // old values survive the merge
  assert.strictEqual(STORE.state.settings.lang, "en");
  assert.strictEqual(STORE.state.settings.currency, "EUR");
  assert.strictEqual(STORE.state.settings.showDoseWeeks, false);
  // entries untouched: no sandbag key invented on old data
  assert.strictEqual(STORE.state.injLog.length, 2);
  assert.ok(!("sandbag" in STORE.state.injLog[0]));
});

test("fresh state: sandbagging defaults to false", function () {
  var STORE = harness.loadStore();
  STORE.load();
  assert.strictEqual(STORE.state.settings.sandbagging, false);
  assert.strictEqual(STORE.state.injLog.length, 0);
});

test("round-trip: sandbag flag and setting survive load -> save", function () {
  var data = {
    schemaVersion: 1,
    settings: { sandbagging: true },
    injLog: [{ id: "c", date: "2026-08-06", substance: "trt", dose: 50, unit: "mg", site: "belly_lr", sandbag: true }]
  };
  var ls = harness.fakeLocalStorage();
  ls.setItem(KEY, JSON.stringify(data));
  var STORE = harness.loadStore(ls);
  STORE.load();
  assert.strictEqual(STORE.state.settings.sandbagging, true);
  assert.strictEqual(STORE.state.injLog[0].sandbag, true);
  STORE.save();
  var persisted = JSON.parse(ls.getItem(KEY));
  assert.strictEqual(persisted.settings.sandbagging, true);
  assert.strictEqual(persisted.injLog[0].sandbag, true);
});

test("migration: a backup without illness episodes gains an empty list", function () {
  var old = {
    schemaVersion: 1,
    settings: { lang: "pl" },
    journal: [{ id: "j1", ts: "2026-08-17T04:45:00.000Z", text: "note" }]
  };
  var ls = harness.fakeLocalStorage();
  ls.setItem(KEY, JSON.stringify(old));
  var STORE = harness.loadStore(ls);
  STORE.load();
  assert.deepStrictEqual(Array.from(STORE.state.illness), []);
  assert.strictEqual(STORE.state.journal.length, 1);
});

test("illness episodes survive a load/save round-trip, open one included", function () {
  var eps = [
    { id: "e1", start: "2026-07-01", end: "2026-07-06", label: "angina", severity: 3 },
    { id: "e2", start: "2026-08-17", end: null, label: "", severity: 1 }
  ];
  var ls = harness.fakeLocalStorage();
  ls.setItem(KEY, JSON.stringify({ schemaVersion: 1, illness: eps }));
  var STORE = harness.loadStore(ls);
  STORE.load();
  STORE.save();
  var out = JSON.parse(ls.getItem(KEY));
  assert.deepStrictEqual(out.illness, eps);
});

// ---- peptides: one record per blend ----

function pepRow(id, date, name, dose) {
  var e = { id: id, ts: date + "T09:00:00.000Z", date: date, substance: "peptide", dose: dose, unit: "j" };
  if (name) e.name = name;
  return e;
}

test("migration: a backup without a peptide list gains an empty one", function () {
  var ls = harness.fakeLocalStorage({ "mounjaro.v1": JSON.stringify({ schemaVersion: 1, weightLog: [] }) });
  var STORE = harness.loadStore(ls);
  STORE.load();
  assert.deepStrictEqual(Array.from(STORE.state.inj.peptides), []);
});

test("migration: the legacy single-peptide config becomes one peptide, its rows untouched", function () {
  var old = {
    schemaVersion: 1,
    inj: { peptide: { unit: "j", cycleDays: 56, cycleStart: "2026-07-01", name: "KLOW" } },
    injLog: [pepRow("a", "2026-08-01", null, 10), pepRow("b", "2026-08-02", null, 10)]
  };
  var STORE = harness.loadStore(harness.fakeLocalStorage({ "mounjaro.v1": JSON.stringify(old) }));
  STORE.load();
  var peps = Array.from(STORE.state.inj.peptides);
  assert.strictEqual(peps.length, 1);
  assert.strictEqual(peps[0].id, "peptide");          // so existing rows need no rewrite
  assert.strictEqual(peps[0].name, "KLOW");
  assert.strictEqual(peps[0].cycleDays, 56);
  assert.strictEqual(peps[0].cycleStart, "2026-07-01");
  assert.strictEqual(STORE.state.injLog[0].substance, "peptide");
});

test("migration: each distinct blend name becomes its own peptide and its rows are re-stamped", function () {
  var old = {
    schemaVersion: 1,
    inj: { peptide: { unit: "j", cycleDays: null, cycleStart: null, name: "" } },
    injLog: [
      pepRow("a", "2026-08-01", "BPC-157", 250),
      pepRow("b", "2026-08-02", "TB-500", 2),
      pepRow("c", "2026-08-03", "BPC-157", 250)
    ]
  };
  var STORE = harness.loadStore(harness.fakeLocalStorage({ "mounjaro.v1": JSON.stringify(old) }));
  STORE.load();
  var peps = Array.from(STORE.state.inj.peptides);
  var names = peps.map(function (p) { return p.name; }).sort();
  assert.deepStrictEqual(names, ["BPC-157", "TB-500"]);
  // every row now points at a peptide, and the two BPC rows share one
  var log = Array.from(STORE.state.injLog);
  assert.strictEqual(log[0].substance, log[2].substance);
  assert.notStrictEqual(log[0].substance, log[1].substance);
  assert.strictEqual(log.filter(function (e) { return e.substance === "peptide"; }).length, 0);
  // colours are distinct so the cards can be told apart
  assert.notStrictEqual(peps[0].color, peps[1].color);
});

test("migration: named and unnamed rows coexist — unnamed stay on the legacy id", function () {
  var old = {
    schemaVersion: 1,
    inj: { peptide: { unit: "j", cycleDays: null, cycleStart: null, name: "" } },
    injLog: [pepRow("a", "2026-08-01", "BPC-157", 250), pepRow("b", "2026-08-02", null, 10)]
  };
  var STORE = harness.loadStore(harness.fakeLocalStorage({ "mounjaro.v1": JSON.stringify(old) }));
  STORE.load();
  var peps = Array.from(STORE.state.inj.peptides);
  assert.strictEqual(peps.length, 2);
  assert.strictEqual(peps[0].id, "peptide");
  var log = Array.from(STORE.state.injLog);
  assert.strictEqual(log[1].substance, "peptide");     // the unnamed row never moved
  assert.notStrictEqual(log[0].substance, "peptide");
});

test("migration: runs once — a second load does not duplicate peptides", function () {
  var ls = harness.fakeLocalStorage({
    "mounjaro.v1": JSON.stringify({
      schemaVersion: 1,
      inj: { peptide: { unit: "j", cycleDays: null, cycleStart: null, name: "KLOW" } },
      injLog: [pepRow("a", "2026-08-01", null, 10)]
    })
  });
  var STORE = harness.loadStore(ls);
  STORE.load();
  STORE.save();
  var STORE2 = harness.loadStore(ls);
  STORE2.load();
  assert.strictEqual(Array.from(STORE2.state.inj.peptides).length, 1);
  assert.strictEqual(STORE2.state.inj.peptides[0].name, "KLOW");
});
