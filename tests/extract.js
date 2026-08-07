// Test harness: the whole app lives in index.html (no build, no modules),
// so tests cut a module's source out of the file and evaluate it in a bare
// V8 context. DOMAIN is pure; STORE only needs a fake localStorage.
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var SRC = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function extractModule(name, endMarker) {
  var startMarker = "var " + name + " = (function(){";
  var start = SRC.indexOf(startMarker);
  if (start < 0) throw new Error("module not found in index.html: " + name);
  var end = SRC.indexOf(endMarker, start);
  if (end < 0) throw new Error("end marker not found for " + name + ": " + endMarker);
  return SRC.slice(start, end);
}

function loadDomain() {
  var ctx = { console: console };
  vm.createContext(ctx);
  vm.runInContext(extractModule("DOMAIN", "var STORE = (function(){"), ctx, { filename: "index.html#DOMAIN" });
  return ctx.DOMAIN;
}

function fakeLocalStorage(initial) {
  var store = Object.assign({}, initial || {});
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    _dump: function () { return store; }
  };
}

function loadStore(ls) {
  var ctx = {
    console: console,
    localStorage: ls || fakeLocalStorage(),
    setTimeout: function () { return 0; },
    clearTimeout: function () {}
  };
  vm.createContext(ctx);
  vm.runInContext(extractModule("STORE", "function $(sel,root)"), ctx, { filename: "index.html#STORE" });
  return ctx.STORE;
}

module.exports = { loadDomain: loadDomain, loadStore: loadStore, fakeLocalStorage: fakeLocalStorage };
