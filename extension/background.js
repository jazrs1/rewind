// Service worker: routes messages from the Rewind web app (externally_connectable) and
// forwards Zoom playback state from the content script to the app's open ports.
importScripts('allowed-origins.js', 'bridge.js');

// externally_connectable already limits who can connect; the router checks the sender's
// origin again in code (ALLOWED_APP_ORIGINS) so a manifest mistake alone can't open the bridge.
// Exported transcripts live in the extension's own IndexedDB (no manifest permission), keyed by recording.
function idbTranscripts() {
  var STORE = 'transcripts';
  function open() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open('rewind', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: 'recordingUrl' }); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function run(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var req = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { db.close(); resolve(req && req.result); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }
  return {
    all: function () { return run('readonly', function (s) { return s.getAll(); }).then(function (x) { return x || []; }); },
    put: function (t) { return run('readwrite', function (s) { s.put(t); }); },
    remove: function (url) { return run('readwrite', function (s) { s.delete(url); }); }
  };
}

var bridge = RewindBridge.createRouter(chrome, {
  version: chrome.runtime.getManifest().version,
  allowedOrigins: ALLOWED_APP_ORIGINS,
  transcripts: idbTranscripts()
});

chrome.runtime.onMessageExternal.addListener(function (msg, sender, sendResponse) {
  bridge.route(msg, sender).then(sendResponse);
  return true;
});

chrome.runtime.onConnectExternal.addListener(bridge.connect);

chrome.runtime.onMessage.addListener(function (msg, sender) {
  bridge.onTabMessage(msg, sender);
  return false;
});

chrome.tabs.onRemoved.addListener(bridge.onTabRemoved);
