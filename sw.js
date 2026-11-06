/* Mounjaro Tracker service worker — offline app shell.
   Bump CACHE on each release so clients pick up the new version. */
var CACHE = "mj-v211";
var ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

/* The string that says a response really is the app and not something else the
   network handed back wearing a 200: a captive portal's login page, an ISP
   interception, a host error page, or half a download. Storing one of those
   over the shell is what turns a bad minute of wifi into an app that is blank
   online, blank offline and blank after a reload. */
var SHELL_MARK = '<div id="app"';

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

/* Store a document only once it has proved to be the app. A body that dies
   mid-stream rejects here and stores nothing, which is the point: a truncated
   shell cached under this key would outlive the bad connection that caused it. */
function keepIfShell(res){
  if(!res || !res.ok || res.type !== "basic") return Promise.resolve(false);
  return res.clone().text().then(function(body){
    if(body.indexOf(SHELL_MARK) < 0) return false;
    return caches.open(CACHE).then(function(c){ return c.put("./index.html", res.clone()); })
      .then(function(){ return true; });
  })["catch"](function(){ return false; });
}
function refreshShell(req){
  return fetch(req, { cache: "no-store" }).then(keepIfShell)["catch"](function(){ return false; });
}

/* Last resort for an install that did get poisoned before this worker shipped,
   and for anything we cannot foresee: ?sw-reset=1 empties the caches and steps
   aside. It has to live here rather than in the page — when the document on
   screen is garbage, no page code runs to offer a way out. */
function resetEverything(){
  return caches.keys()
    .then(function(keys){ return Promise.all(keys.map(function(k){ return caches.delete(k); })); })
    .then(function(){ return self.registration.unregister(); })
    ["catch"](function(){})
    .then(function(){ return Response.redirect("./", 302); });
}

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return; // only same-origin

  if(url.searchParams.get("sw-reset")){ e.respondWith(resetEverything()); return; }

  // The document itself is served from the copy we know draws, and refreshed in
  // the background. Network-first put the user one bad response away from a
  // white rectangle — and a white rectangle has no header, no tabs and no way
  // back, while a shell a few seconds old has all three. A new build still
  // arrives the way it always did: the page re-checks the worker on focus and
  // hourly, and reloads itself once the new one takes over.
  if(req.mode === "navigate"){
    e.respondWith(
      caches.match("./index.html").then(function(hit){
        if(hit){ e.waitUntil(refreshShell(req)); return hit; }
        return fetch(req).then(function(res){ keepIfShell(res); return res; });
      })
    );
    return;
  }

  // Everything else: network-first, falling back to cache when offline. The
  // write is no longer blind — a failed response never replaces a good one, and
  // the shell is only ever written through keepIfShell, never from here: the
  // page is free to fetch its own document (an export, a version check) and
  // that must not be the path by which a bad copy lands on top of the app.
  var isShell = /\/(index\.html)?$/.test(url.pathname);
  e.respondWith(
    fetch(req).then(function(res){
      if(res && res.ok && res.type === "basic" && !isShell){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ return c.put(req, copy); })["catch"](function(){});
      }
      return res;
    })["catch"](function(){
      return caches.match(req).then(function(hit){
        return hit || caches.match("./index.html");
      });
    })
  );
});
