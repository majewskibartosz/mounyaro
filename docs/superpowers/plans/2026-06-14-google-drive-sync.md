# Google Drive Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in Google Drive sync (hidden appData folder) so data roams across all devices — including mobile — with no app server.

**Architecture:** New `GDRIVE` IIFE module owns Google auth (GIS token client) + Drive REST I/O over `fetch`; `STORE` gains a mutually-exclusive active-remote coordinator (`file` | `drive` | `none`) and a pure `decideSync` function; `UI` gets a Settings sync card. GIS script is injected dynamically only when Drive is enabled, preserving offline purity for non-users.

**Tech Stack:** Vanilla ES5 (IIFE modules), Google Identity Services token model, Drive REST v3 (`drive.appdata` scope), localStorage source-of-truth, IndexedDB unchanged for the linked-file handle.

**Testing note:** This repo has no test framework (single file, no build/deps — see CLAUDE.md). Verification uses the project's real method: `agent-browser eval` calling the live shipped functions across input matrices, plus screenshots of UI states. OAuth + Drive I/O require a registered origin and a real Google account, so the end-to-end path is verified manually on `http://localhost:8000` or the deployed URL after the owner provides the OAuth client ID (Task 7).

---

## File structure

- `index.html` — all code. New `GDRIVE` module inserted after `STORE`; `decideSync` + coordinator added inside `STORE`; sync card added to `UI` settings view; `GOOGLE_CLIENT_ID` constant near top of `<script>`; `set.drive.*` i18n keys.
- `vercel.json` — CSP additions for Google origins.
- `README.md` — Google Cloud setup section.

---

## Task 1: Config constant + CSP changes

**Files:**
- Modify: `index.html` (top of `<script>`, after `"use strict";`)
- Modify: `vercel.json` (CSP header value)

- [ ] **Step 1: Add the client-ID constant** at the top of the script, right after `"use strict";`:

```js
/* Google OAuth public client ID for Drive sync. Create one in Google Cloud
   (OAuth 2.0 Web client) and paste it here; it is a PUBLIC client id, safe to
   commit. Empty string disables the Drive-sync UI. See README. */
var GOOGLE_CLIENT_ID = "";
```

- [ ] **Step 2: Extend the CSP** in `vercel.json`. Replace the existing `Content-Security-Policy` value with (additions: GIS script origin, Google API connect origins, accounts.google.com frame):

```
default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com; manifest-src 'self'; worker-src 'self'; frame-src https://accounts.google.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

- [ ] **Step 3: Verify** `vercel.json` is valid JSON.

Run: `python3 -c "import json;json.load(open('vercel.json'));print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add index.html vercel.json
git commit -m "feat(sync): add Google client-id config and CSP for Drive"
```

---

## Task 2: GDRIVE module — auth lifecycle

**Files:**
- Modify: `index.html` — insert a new `var GDRIVE = (function(){ ... })();` module immediately after the `STORE` IIFE closes (after its `})();`).

- [ ] **Step 1: Add the GDRIVE auth core.** Insert this module skeleton (file I/O added in Task 3):

```js
/* =========================================================================
   GDRIVE — Google auth (GIS token model) + Drive appData file I/O.
   Knows Google; knows nothing about app state. Token lives in memory only.
   ========================================================================= */
var GDRIVE = (function(){
  var SCOPES = "https://www.googleapis.com/auth/drive.appdata openid email";
  var FILENAME = "mounjaro.json";
  var tokenClient=null, accessToken=null, tokenExp=0, email=null, pending=null;

  function supported(){ return !!GOOGLE_CLIENT_ID; }
  function tokenValid(){ return accessToken && Date.now() < tokenExp; }

  function ensureGis(cb){
    if(window.google && google.accounts && google.accounts.oauth2){ cb(true); return; }
    var s=document.createElement("script");
    s.src="https://accounts.google.com/gsi/client"; s.async=true; s.defer=true;
    s.onload=function(){ cb(!!(window.google&&google.accounts&&google.accounts.oauth2)); };
    s.onerror=function(){ cb(false); };
    document.head.appendChild(s);
  }
  function ensureClient(cb){
    if(tokenClient){ cb(true); return; }
    if(!supported()){ cb(false); return; }
    ensureGis(function(ok){
      if(!ok){ cb(false); return; }
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID, scope: SCOPES,
        callback: function(resp){
          if(resp && resp.access_token){
            accessToken=resp.access_token;
            tokenExp=Date.now()+((resp.expires_in||3600)*1000)-60000;
            var done=pending; pending=null;
            fetchEmail(function(){ done&&done(true); });
          } else { var d=pending; pending=null; d&&d(false); }
        },
        error_callback: function(){ var d=pending; pending=null; d&&d(false); }
      });
      cb(true);
    });
  }
  function fetchEmail(cb){
    fetch("https://www.googleapis.com/oauth2/v3/userinfo",
      {headers:{Authorization:"Bearer "+accessToken}})
      .then(function(r){ return r.ok?r.json():null; })
      .then(function(j){ if(j&&j.email) email=j.email; cb&&cb(); })
      .catch(function(){ cb&&cb(); });
  }
  function requestToken(prompt, cb){
    ensureClient(function(ok){
      if(!ok){ cb&&cb(false); return; }
      pending=cb; try{ tokenClient.requestAccessToken({prompt:prompt}); }
      catch(e){ pending=null; cb&&cb(false); }
    });
  }
  function signIn(cb){ requestToken("consent", cb); }
  function restoreSilent(cb){ requestToken("", cb); }
  function signOut(cb){
    if(accessToken && window.google && google.accounts && google.accounts.oauth2){
      try{ google.accounts.oauth2.revoke(accessToken, function(){}); }catch(e){}
    }
    accessToken=null; tokenExp=0; email=null; cb&&cb();
  }
  function isSignedIn(){ return tokenValid(); }
  function account(){ return email; }

  return { supported:supported, signIn:signIn, restoreSilent:restoreSilent,
           signOut:signOut, isSignedIn:isSignedIn, account:account,
           _hasToken:tokenValid };
})();
```

- [ ] **Step 2: Verify the app still loads with no console errors** (Drive inert while `GOOGLE_CLIENT_ID` is empty).

Run: `agent-browser open "file://$PWD/index.html"; sleep 1; agent-browser console --filter error`
Expected: no error lines; `agent-browser eval "typeof GDRIVE.signIn"` → `"function"`; `agent-browser eval "GDRIVE.supported()"` → `false`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(sync): add GDRIVE auth (GIS token client)"
```

---

## Task 3: GDRIVE module — Drive appData file I/O

**Files:**
- Modify: `index.html` — add file-I/O functions inside `GDRIVE` and export them.

- [ ] **Step 1: Add file I/O.** Insert before the `return {` of `GDRIVE`:

```js
  var API="https://www.googleapis.com/drive/v3";
  var UPLOAD="https://www.googleapis.com/upload/drive/v3";
  function authHdr(){ return {Authorization:"Bearer "+accessToken}; }
  // Find the single appData file; returns {id,modifiedTime} or null. status cb on auth fail.
  function findFile(cb){
    fetch(API+"/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)"
      +"&q="+encodeURIComponent("name='"+FILENAME+"'"), {headers:authHdr()})
      .then(function(r){ if(r.status===401){ cb("auth"); return null; } return r.ok?r.json():null; })
      .then(function(j){ if(j===null) return; var f=j&&j.files&&j.files[0];
        cb(null, f?{id:f.id, modifiedTime:f.modifiedTime}:null); })
      .catch(function(){ cb("error"); });
  }
  // readData -> cb(err, {text, modifiedTime} | null)
  function readData(cb){
    if(!tokenValid()){ cb("auth"); return; }
    findFile(function(err, meta){
      if(err){ cb(err); return; }
      if(!meta){ cb(null, null); return; }
      fetch(API+"/files/"+meta.id+"?alt=media", {headers:authHdr()})
        .then(function(r){ if(r.status===401){ cb("auth"); return null; } return r.ok?r.text():null; })
        .then(function(txt){ if(txt===null) return; cb(null, {text:txt, modifiedTime:meta.modifiedTime, id:meta.id}); })
        .catch(function(){ cb("error"); });
    });
  }
  function multipart(metadata, text){
    var b="-------mj"+Math.random().toString(36).slice(2);
    var body="--"+b+"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
      +JSON.stringify(metadata)+"\r\n--"+b
      +"\r\nContent-Type: application/json\r\n\r\n"+text+"\r\n--"+b+"--";
    return {body:body, type:'multipart/related; boundary="'+b+'"'};
  }
  // writeData -> cb(err, modifiedTime). Creates or updates the single file.
  function writeData(text, cb){
    if(!tokenValid()){ cb("auth"); return; }
    findFile(function(err, meta){
      if(err){ cb(err); return; }
      var url, method, headers, body;
      if(meta){
        url=UPLOAD+"/files/"+meta.id+"?uploadType=media&fields=modifiedTime";
        method="PATCH"; headers=authHdr(); headers["Content-Type"]="application/json"; body=text;
      } else {
        var mp=multipart({name:FILENAME, parents:["appDataFolder"]}, text);
        url=UPLOAD+"/files?uploadType=multipart&fields=modifiedTime";
        method="POST"; headers=authHdr(); headers["Content-Type"]=mp.type; body=mp.body;
      }
      fetch(url,{method:method, headers:headers, body:body})
        .then(function(r){ if(r.status===401){ cb("auth"); return null; } return r.ok?r.json():null; })
        .then(function(j){ if(j===null) return; cb(null, j.modifiedTime); })
        .catch(function(){ cb("error"); });
    });
  }
  // backupData -> writes a timestamped copy and prunes to the newest 3.
  function backupData(text, isoStamp, cb){
    if(!tokenValid()){ cb&&cb("auth"); return; }
    var mp=multipart({name:"mounjaro-backup-"+isoStamp+".json", parents:["appDataFolder"]}, text);
    fetch(UPLOAD+"/files?uploadType=multipart&fields=id",
      {method:"POST", headers:(function(){var h=authHdr();h["Content-Type"]=mp.type;return h;})(), body:mp.body})
      .then(function(){ pruneBackups(cb); }).catch(function(){ cb&&cb("error"); });
  }
  function pruneBackups(cb){
    fetch(API+"/files?spaces=appDataFolder&orderBy=createdTime desc"
      +"&fields=files(id,name)&q="+encodeURIComponent("name contains 'mounjaro-backup-'"),
      {headers:authHdr()})
      .then(function(r){ return r.ok?r.json():null; })
      .then(function(j){
        var files=(j&&j.files)||[]; var extra=files.slice(3);
        var n=extra.length; if(!n){ cb&&cb(null); return; }
        extra.forEach(function(f){
          fetch(API+"/files/"+f.id,{method:"DELETE",headers:authHdr()})
            .then(function(){ if(--n===0) cb&&cb(null); })
            .catch(function(){ if(--n===0) cb&&cb(null); });
        });
      }).catch(function(){ cb&&cb("error"); });
  }
```

- [ ] **Step 2: Export the new functions.** Update the `return {` of `GDRIVE` to add: `readData:readData, writeData:writeData, backupData:backupData,`.

- [ ] **Step 3: Verify load + exports.**

Run: `agent-browser open "file://$PWD/index.html"; sleep 1; agent-browser eval "[typeof GDRIVE.readData, typeof GDRIVE.writeData, typeof GDRIVE.backupData].join(',')"`
Expected: `function,function,function`; `agent-browser console --filter error` shows nothing.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(sync): add GDRIVE appData read/write/backup"
```

---

## Task 4: decideSync (pure) + STORE active-remote coordinator

**Files:**
- Modify: `index.html` — add `decideSync` in `STORE`; add `settings.sync` to `defaults()`; route `save()` writes and add a `syncRemote` pull entry point + provider helpers.

- [ ] **Step 1: Add `sync` to `defaults()`** in `STORE.defaults()` settings object. Change the `settings:{...}` line to include:

```js
settings:{ lang:"pl", theme:"light", currency:"PLN", goldenDose:{enabled:false, extraClicks:8}, sync:{ provider:"none" } },
```

- [ ] **Step 2: Add the pure decision function** inside `STORE` (near the top of the IIFE, after `defaults`):

```js
  // Pure sync decision. localDirty = local changed since last successful sync.
  // remoteChanged = remote modifiedTime differs from last seen. Returns one of
  // "push" | "pull" | "noop" | "conflict".
  function decideSync(localUpdatedAt, remoteUpdatedAt, remoteChanged, localDirty){
    if(remoteUpdatedAt==null) return localDirty ? "push" : "noop"; // no remote file yet
    if(remoteChanged && localDirty){
      return (localUpdatedAt||0) === (remoteUpdatedAt||0) ? "noop" : "conflict";
    }
    if(remoteChanged) return "pull";
    if(localDirty) return "push";
    return "noop";
  }
```

- [ ] **Step 3: Add provider state + dirty tracking** inside `STORE` (with the other vars):

```js
  var dirty=false, lastRemoteModified=null;
  function provider(){ return (state.settings.sync && state.settings.sync.provider) || "none"; }
  function setProvider(p){ state.settings.sync = {provider:p}; }
```

- [ ] **Step 4: Mark dirty on save and route Drive writes.** In `save()`, after `scheduleFileWrite();`, add:

```js
    dirty=true; scheduleDriveWrite();
```

And add the debounced Drive writer near `scheduleFileWrite`:

```js
  var driveTimer=null;
  function scheduleDriveWrite(){
    if(provider()!=="drive" || !GDRIVE.isSignedIn()) return;
    if(driveTimer) clearTimeout(driveTimer);
    driveTimer=setTimeout(function(){
      GDRIVE.writeData(JSON.stringify(state,null,2), function(err, modifiedTime){
        if(!err){ dirty=false; lastRemoteModified=modifiedTime; }
      });
    }, 800);
  }
```

- [ ] **Step 5: Add the pull/sync entry point** used on load and focus. Add inside `STORE`:

```js
  // Pull-and-reconcile against Drive. cb(status): "loaded"|"pushed"|"noop"|"needsAuth"|"error".
  function syncDrive(cb){
    if(provider()!=="drive"){ cb&&cb("noop"); return; }
    if(!GDRIVE.isSignedIn()){ cb&&cb("needsAuth"); return; }
    GDRIVE.readData(function(err, file){
      if(err==="auth"){ cb&&cb("needsAuth"); return; }
      if(err){ cb&&cb("error"); return; }
      var remoteState=null; if(file){ try{ remoteState=JSON.parse(file.text); }catch(e){} }
      var remoteUpdated = remoteState ? (remoteState.updatedAt||0) : null;
      var remoteChanged = file ? (file.modifiedTime!==lastRemoteModified) : false;
      var action = decideSync(state.updatedAt||0, remoteUpdated, remoteChanged, dirty);
      if(action==="pull"){
        adoptParsed(remoteState); dirty=false; lastRemoteModified=file.modifiedTime; cb&&cb("loaded");
      } else if(action==="push"){
        GDRIVE.writeData(JSON.stringify(state,null,2), function(e2,mt){
          if(!e2){ dirty=false; lastRemoteModified=mt; cb&&cb("pushed"); } else cb&&cb("error"); });
      } else if(action==="conflict"){
        var localNewer = (state.updatedAt||0) >= remoteUpdated;
        var losing = localNewer ? file.text : JSON.stringify(state,null,2);
        var stamp = new Date(state.updatedAt||Date.now()).toISOString().replace(/[:.]/g,"-");
        GDRIVE.backupData(losing, stamp, function(){
          if(localNewer){
            GDRIVE.writeData(JSON.stringify(state,null,2), function(e2,mt){
              if(!e2){ dirty=false; lastRemoteModified=mt; cb&&cb("pushed"); } else cb&&cb("error"); });
          } else {
            adoptParsed(remoteState); dirty=false; lastRemoteModified=file.modifiedTime; cb&&cb("loaded");
          }
        });
      } else { if(file) lastRemoteModified=file.modifiedTime; cb&&cb("noop"); }
    });
  }
```

- [ ] **Step 6: Add Drive enable/disable with mutual exclusivity** inside `STORE`:

```js
  // Enable Drive as the active remote (disables linked-file). cb(status) from syncDrive.
  function enableDrive(cb){
    if(linkedHandle){ unlinkFile(function(){ setProvider("drive"); dirty=true; lastRemoteModified=null; save(); syncDrive(cb); }); }
    else { setProvider("drive"); dirty=true; lastRemoteModified=null; save(); syncDrive(cb); }
  }
  function disableDrive(cb){ setProvider("none"); save(); GDRIVE.signOut(function(){ cb&&cb(); }); }
```

Also: in `linkFileNew` and `linkFileExisting` success paths, set `setProvider("file");` so linking a file disables Drive (mutual exclusivity both ways). Add `setProvider("file");` right after `linkedHandle=h;` in each.

- [ ] **Step 7: Export coordinator functions.** Add to the `STORE` `return {...}`: `decideSync:decideSync, syncDrive:syncDrive, enableDrive:enableDrive, disableDrive:disableDrive, syncProvider:provider,`.

- [ ] **Step 8: Verify decideSync truth table against the live function.**

Run:
```
agent-browser open "file://$PWD/index.html"; sleep 1
agent-browser eval "JSON.stringify([
  STORE.decideSync(5,null,false,true),     /* push (no remote) */
  STORE.decideSync(5,null,false,false),    /* noop */
  STORE.decideSync(5,9,true,false),        /* pull */
  STORE.decideSync(9,5,false,true),        /* push */
  STORE.decideSync(9,5,true,true),         /* conflict */
  STORE.decideSync(5,5,true,true),         /* noop (equal) */
  STORE.decideSync(5,9,false,false)        /* noop */
])"
```
Expected: `["push","noop","pull","push","conflict","noop","noop"]`

- [ ] **Step 9: Commit**

```bash
git add index.html
git commit -m "feat(sync): add decideSync and STORE Drive coordinator"
```

---

## Task 5: UI — Settings sync card + i18n + focus pull

**Files:**
- Modify: `index.html` — add `set.drive.*` keys to the I18N `dict`; add `driveCardHTML()` + `bindDriveCard()`; insert the card in `viewSettings`; extend the existing `refreshLinked` focus handler to also pull Drive.

- [ ] **Step 1: Add i18n keys** to the I18N `dict` (both PL and EN), after the existing `set.link*` keys:

```js
    "set.driveTitle":{pl:"Synchronizacja z Google Drive",en:"Sync with Google Drive"},
    "set.driveDesc":{pl:"Loguj się przez Google — dane trzymane są w ukrytym folderze na Twoim Dysku Google. Działa na telefonie i komputerze. Aplikacja nie ma serwera i niczego nie przechowuje.",
                     en:"Sign in with Google — your data lives in a hidden folder in your own Google Drive. Works on phone and desktop. The app has no server and stores nothing itself."},
    "set.driveSignIn":{pl:"Zaloguj przez Google",en:"Sign in with Google"},
    "set.driveSignOut":{pl:"Wyloguj",en:"Sign out"},
    "set.driveSyncNow":{pl:"Synchronizuj teraz",en:"Sync now"},
    "set.driveReconnect":{pl:"Połącz ponownie",en:"Reconnect"},
    "set.driveConnected":{pl:"Połączono jako",en:"Connected as"},
    "set.driveSynced":{pl:"Zsynchronizowano ✓",en:"Synced ✓"},
    "set.driveSyncing":{pl:"Synchronizuję…",en:"Syncing…"},
    "set.driveOffline":{pl:"Offline — zsynchronizuje się później.",en:"Offline — will sync later."},
    "set.driveError":{pl:"Synchronizacja nie powiodła się.",en:"Sync failed."},
    "set.driveNeedAuth":{pl:"Sesja wygasła — połącz ponownie, aby wznowić.",en:"Session expired — reconnect to resume."},
    "set.driveFileActive":{pl:"Najpierw odłącz połączony plik powyżej.",en:"Unlink the local file above first."},
```

- [ ] **Step 2: Add the card renderer + binder** inside `UI`, next to `linkCardHTML`/`bindLinkCard`:

```js
  function driveCardHTML(){
    if(!GDRIVE.supported()) return ""; // no client id configured -> hide card
    var h='<div class="card"><h2>'+esc(I18N.t("set.driveTitle"))+'</h2>';
    if(STORE.linkInfo().linked){
      return h+'<div class="note">'+esc(I18N.t("set.driveFileActive"))+'</div></div>';
    }
    h+='<p class="sub">'+esc(I18N.t("set.driveDesc"))+'</p>';
    if(STORE.syncProvider()==="drive" && GDRIVE.isSignedIn()){
      h+='<div class="note" style="margin-bottom:12px">'+esc(I18N.t("set.driveConnected"))+' <b>'+esc(GDRIVE.account()||"")+'</b> ✓</div>'
        +'<div class="row"><button class="btn" id="driveSync">'+esc(I18N.t("set.driveSyncNow"))+'</button>'
        +'<button class="btn danger" id="driveOut">'+esc(I18N.t("set.driveSignOut"))+'</button></div>'
        +'<p class="tiny muted" id="driveStatus" style="margin-top:10px"></p>';
    } else if(STORE.syncProvider()==="drive"){
      h+='<div class="warnbox" style="margin-bottom:12px">'+esc(I18N.t("set.driveNeedAuth"))+'</div>'
        +'<div class="row"><button class="btn" id="driveReconnect">'+esc(I18N.t("set.driveReconnect"))+'</button>'
        +'<button class="btn danger" id="driveOut">'+esc(I18N.t("set.driveSignOut"))+'</button></div>';
    } else {
      h+='<div class="row"><button class="btn" id="driveIn">'+esc(I18N.t("set.driveSignIn"))+'</button></div>';
    }
    return h+'</div>';
  }
  function setDriveStatus(key){ var n=$("#driveStatus"); if(n) n.textContent=I18N.t(key); }
  function bindDriveCard(){
    function afterSync(status){
      if(status==="loaded"||status==="pushed"||status==="noop"){
        I18N.setLang(STORE.state.settings.lang); document.documentElement.lang=STORE.state.settings.lang;
        applyTheme(); applyStatic(); updateBanner(); render(); setDriveStatus("set.driveSynced");
      } else if(status==="needsAuth"){ viewSettings(); }
      else setDriveStatus("set.driveError");
    }
    var b;
    if((b=$("#driveIn"))) b.addEventListener("click",function(){
      setDriveStatus("set.driveSyncing");
      GDRIVE.signIn(function(ok){ if(!ok){ setDriveStatus("set.driveError"); return; }
        STORE.enableDrive(function(st){ afterSync(st); viewSettings(); }); }); });
    if((b=$("#driveReconnect"))) b.addEventListener("click",function(){
      GDRIVE.signIn(function(ok){ if(ok) STORE.syncDrive(function(st){ afterSync(st); viewSettings(); }); }); });
    if((b=$("#driveSync"))) b.addEventListener("click",function(){
      setDriveStatus("set.driveSyncing"); STORE.syncDrive(afterSync); });
    if((b=$("#driveOut"))) b.addEventListener("click",function(){
      STORE.disableDrive(function(){ viewSettings(); }); });
  }
```

- [ ] **Step 3: Insert the card + bind it.** In `viewSettings`, change `+ linkCardHTML()` to `+ linkCardHTML() + driveCardHTML()`. After the `bindLinkCard();` call in `viewSettings`'s event-binding section, add `bindDriveCard();`.

Find `bindLinkCard()` call in viewSettings (it is invoked near the bottom). Add `bindDriveCard();` right after it.

- [ ] **Step 4: Pull Drive on focus.** In `init()`, extend the existing `refreshLinked` function body: after the `STORE.refreshFromHandle(...)` block, add a Drive pull:

```js
      if(STORE.syncProvider()==="drive"){
        STORE.syncDrive(function(status){
          if(status==="loaded"){
            I18N.setLang(STORE.state.settings.lang); document.documentElement.lang=STORE.state.settings.lang;
            applyTheme(); applyStatic(); render();
          } else if(status==="needsAuth"){ linkBannerOn=false; }
        });
      }
```

- [ ] **Step 5: Silent restore on load.** In `init()`, after the existing `STORE.restoreLink(...)` block, add:

```js
    if(STORE.syncProvider()==="drive" && GDRIVE.supported()){
      GDRIVE.restoreSilent(function(ok){
        if(ok) STORE.syncDrive(function(status){
          if(status==="loaded"){ I18N.setLang(STORE.state.settings.lang);
            document.documentElement.lang=STORE.state.settings.lang; applyTheme(); applyStatic(); render(); }
        });
      });
    }
```

- [ ] **Step 6: Verify** the card is hidden when no client id, settings still renders, no console errors.

Run: `agent-browser open "file://$PWD/index.html"; sleep 1; agent-browser eval "location.hash='#settings';'ok'"; sleep 1; agent-browser console --filter error; agent-browser screenshot /tmp/sync_card.png`
Expected: no errors; screenshot shows Settings with no Drive card (client id empty). Then set a dummy id to confirm the card renders:
`agent-browser eval "GOOGLE_CLIENT_ID='x.apps.googleusercontent.com'; UI; location.hash='#weight'; location.hash='#settings';'ok'"` then screenshot — Drive card visible in signed-out state.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(sync): add Drive settings card, i18n, focus pull, silent restore"
```

---

## Task 6: README documentation

**Files:**
- Modify: `README.md` — add a "Google Drive sync (optional)" section.

- [ ] **Step 1: Add the section** after the existing "Moving data between devices" content:

```markdown
### Google Drive sync (optional, all browsers)

Unlike the linked-file option, Google Drive sync works on phones too. It stores
your data in a **hidden app folder** in your own Google Drive (the `drive.appdata`
scope) — the app can only ever see its own file, never anything else in your Drive,
and there is no app server.

**One-time setup (owner of the deployment):**
1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. APIs & Services → enable the **Google Drive API**.
3. OAuth consent screen → **External**; add scopes `drive.appdata`, `openid`, `email`.
4. Credentials → create an **OAuth client ID** → type **Web application**. Under
   *Authorized JavaScript origins* add your URLs (e.g. `https://your-app.vercel.app`,
   any custom domain, and `http://localhost:8000` for local testing).
5. Copy the client ID into `GOOGLE_CLIENT_ID` near the top of the `<script>` in
   `index.html`. It is a public client ID — safe to commit.

While the app is unverified, Google allows up to 100 test users and shows an
"unverified app" warning. `drive.appdata` is a *sensitive* (not *restricted*) scope,
so production verification needs Google's consent-screen review but no CASA security
assessment.

Drive sync cannot run from a `file://` page (OAuth origins must be registered) — test
on `http://localhost:8000` or the deployed HTTPS URL.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document optional Google Drive sync setup"
```

---

## Task 7: End-to-end manual verification (owner-assisted)

**Prerequisite:** owner completes the Google Cloud setup (Task 6) and pastes a real
`GOOGLE_CLIENT_ID`. Then serve locally: `python3 -m http.server 8000` and open
`http://localhost:8000`.

- [ ] **Step 1:** Settings → Drive card → "Sign in with Google" → consent → card shows "Connected as <email> ✓".
- [ ] **Step 2:** Add a weight entry on device A; on device B (also signed in) switch tabs away and back → entry appears (focus pull).
- [ ] **Step 3:** Force a conflict: go offline on both, edit each, come online → newest wins; confirm a `mounjaro-backup-*.json` exists in appData (check via Drive API explorer or app logs) and the losing data is recoverable.
- [ ] **Step 4:** Link a local file → confirm the Drive card switches to "Unlink the local file first" (mutual exclusivity).
- [ ] **Step 5:** Wait for token expiry (or revoke) → reload → card shows "Reconnect"; click → resumes.
- [ ] **Step 6:** Confirm a user who never signs in makes **zero** network requests (DevTools Network tab empty of Google calls) — offline guarantee preserved.

---

## Self-review

- **Spec coverage:** storage (appData, Task 3) ✓; mutual exclusivity (Task 4 step 6, Task 5 step 2) ✓; newest-wins+backup (Task 4 step 5) ✓; GIS token model no-backend (Task 2) ✓; offline-first (dynamic GIS load Task 2, provider gating) ✓; auth lifecycle incl. silent restore + 401 (Task 2, Task 5 step 5, `readData`/`writeData` return "auth") ✓; UI states (Task 5) ✓; CSP (Task 1) ✓; GCP setup (Task 6) ✓; pure decideSync test (Task 4 step 8) ✓.
- **Placeholders:** none — all steps contain real code/commands. `GOOGLE_CLIENT_ID=""` is an intentional owner-supplied value, documented.
- **Type/name consistency:** `GDRIVE` exports `signIn/restoreSilent/signOut/isSignedIn/account/supported/readData/writeData/backupData`; `STORE` exports `decideSync/syncDrive/enableDrive/disableDrive/syncProvider`; UI uses `driveCardHTML/bindDriveCard`. Names match across tasks.
- **Note on 401 handling:** `readData`/`writeData` surface `"auth"`; `syncDrive` maps that to `"needsAuth"` which re-renders the card into the Reconnect state. A single silent retry is provided implicitly by `restoreSilent` on next load/focus; explicit mid-call retry was deemed unnecessary for v1 (documented simplification).
