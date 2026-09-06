/* Mounjaro Tracker service worker — offline app shell.
   Bump CACHE on each release so clients pick up the new version. */
var CACHE = "mj-v174";
var ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); }));
  self.skipWaiting();
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){ if(k!==CACHE) return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* The page asks two things of the worker: which build it is serving, so the
   footer can say whether the shell on screen is the current one, and — when a
   new worker installed but never took over — to step in now. */
self.addEventListener("message", function(e){
  var d = e.data || {};
  if(d.type === "SKIP_WAITING"){ self.skipWaiting(); return; }
  if(d.type === "VERSION" && e.ports && e.ports[0]) e.ports[0].postMessage({ version: CACHE });
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return; // only same-origin

  // Network-first: always try the latest, fall back to cache when offline.
  e.respondWith(
    fetch(req).then(function(res){
      if(res && res.status === 200 && res.type === "basic"){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(req, copy); });
      }
      return res;
    }).catch(function(){
      return caches.match(req).then(function(hit){
        return hit || caches.match("./index.html");
      });
    })
  );
});
