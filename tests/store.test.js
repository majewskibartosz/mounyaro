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
