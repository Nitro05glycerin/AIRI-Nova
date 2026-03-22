/**
 * AIRI Config Sync — merge-based
 * Syncs localStorage + IndexedDB to a server with per-key timestamps.
 * Server merges instead of overwriting. Cards merge by ID (union).
 */
(function () {
  const SYNC_URL = '/sync/config';
  const SYNC_INTERVAL = 30000;
  const INITIAL_PUSH_DELAY = 60000;
  const PUSH_COOLDOWN = 5000;
  const IDB_NAME = 'keyval-store';
  const IDB_STORE = 'keyval';
  const KEY_TS_STORAGE_KEY = '_sync_keyTs';

  // --- Per-key timestamp tracking ---
  // Intercept localStorage writes BEFORE anything else runs

  const _origSetItem = Storage.prototype.setItem;
  const _origRemoveItem = Storage.prototype.removeItem;

  function getKeyTimestamps() {
    try {
      return JSON.parse(_origSetItem === Storage.prototype.setItem
        ? localStorage.getItem(KEY_TS_STORAGE_KEY)
        : localStorage.getItem(KEY_TS_STORAGE_KEY)) || {};
    } catch { return {}; }
  }

  function saveKeyTimestamps(ts) {
    _origSetItem.call(localStorage, KEY_TS_STORAGE_KEY, JSON.stringify(ts));
  }

  Storage.prototype.setItem = function (key, value) {
    if (this === localStorage && key !== KEY_TS_STORAGE_KEY) {
      try {
        const ts = getKeyTimestamps();
        ts[key] = Date.now();
        _origSetItem.call(localStorage, KEY_TS_STORAGE_KEY, JSON.stringify(ts));
      } catch (e) { console.log('[sync] keyTs track error:', e); }
    }
    _origSetItem.call(this, key, value);
  };

  Storage.prototype.removeItem = function (key) {
    if (this === localStorage && key !== KEY_TS_STORAGE_KEY) {
      try {
        const ts = getKeyTimestamps();
        ts[key] = Date.now();
        _origSetItem.call(localStorage, KEY_TS_STORAGE_KEY, JSON.stringify(ts));
      } catch (e) { console.log('[sync] keyTs track error:', e); }
    }
    _origRemoveItem.call(this, key);
  };

  // --- Helper functions ---

  function getAllLocalStorage() {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key !== KEY_TS_STORAGE_KEY) result[key] = localStorage.getItem(key);
    }
    return result;
  }

  function setAllLocalStorage(data) {
    for (const [key, val] of Object.entries(data)) {
      if (val !== null && val !== undefined && key !== KEY_TS_STORAGE_KEY) {
        _origSetItem.call(localStorage, key, String(val));
      }
    }
  }

  function applyMergedState(data) {
    if (!data || !data.localStorage) return;
    // Write merged data without triggering timestamp updates (use _origSetItem)
    for (const [key, val] of Object.entries(data.localStorage)) {
      if (val !== null && val !== undefined && key !== KEY_TS_STORAGE_KEY) {
        _origSetItem.call(localStorage, key, String(val));
      }
    }
    if (data._keyTs) {
      saveKeyTimestamps(data._keyTs);
    }
  }

  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
    });
  }

  function idbGetAll(db) {
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(IDB_STORE)) { resolve({}); return; }
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const result = {};
      const cursorReq = store.openCursor();
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          try { result[cursor.key] = JSON.parse(JSON.stringify(cursor.value)); }
          catch { result[cursor.key] = cursor.value; }
          cursor.continue();
        } else { resolve(result); }
      };
    });
  }

  function idbSetAll(db, data) {
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(IDB_STORE)) { resolve(); return; }
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      for (const [key, val] of Object.entries(data)) { store.put(val, key); }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return h;
  }

  let lastPushedHash = 0;
  let lastPushTime = 0;

  async function pushConfig() {
    const now = Date.now();
    if (now - lastPushTime < PUSH_COOLDOWN) return;

    try {
      const ls = getAllLocalStorage();
      let idbData = {};
      try { const db = await openIDB(); idbData = await idbGetAll(db); db.close(); } catch (e) { console.log('[sync] IDB read error:', e); }

      const filteredIdb = {};
      for (const [k, v] of Object.entries(idbData)) {
        if (!k.includes('chat:sessions') && !k.includes('chat:index')) filteredIdb[k] = v;
      }

      const keyTs = getKeyTimestamps();
      const blob = { localStorage: ls, indexedDB: filteredIdb, _ts: Date.now(), _keyTs: keyTs };
      const json = JSON.stringify(blob);
      const hash = simpleHash(json);
      if (hash === lastPushedHash) return;

      const resp = await fetch(SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });

      lastPushTime = Date.now();

      if (resp.ok) {
        const merged = await resp.json();
        if (merged && merged.localStorage) {
          applyMergedState(merged);
          console.log('[sync] push+merge OK, cards:', Object.keys(JSON.parse(merged.localStorage['airi-cards'] || '[]')).length || 'N/A');
        }
        lastPushedHash = simpleHash(JSON.stringify(merged));
      }
    } catch (e) { console.log('[sync] push error:', e); }
  }

  async function pullConfig() {
    try {
      const resp = await fetch(SYNC_URL);
      if (!resp.ok) return false;
      const data = await resp.json();
      if (!data || !data._ts) return false;
      applyMergedState(data);
      lastPushedHash = simpleHash(JSON.stringify(data));
      console.log('[sync] pull OK');
      return true;
    } catch (e) { console.log('[sync] pull error:', e); return false; }
  }

  async function init() {
    const hadData = await pullConfig();

    if (hadData && !sessionStorage.getItem('config-sync-loaded')) {
      sessionStorage.setItem('config-sync-loaded', '1');
      setTimeout(() => location.reload(), 500);
      return;
    }

    setInterval(pushConfig, SYNC_INTERVAL);

    // beforeunload beacon with hash check
    window.addEventListener('beforeunload', () => {
      const ls = getAllLocalStorage();
      const keyTs = getKeyTimestamps();
      const blob = { localStorage: ls, indexedDB: {}, _ts: Date.now(), _keyTs: keyTs };
      const json = JSON.stringify(blob);
      const hash = simpleHash(json);
      if (hash === lastPushedHash) return;
      navigator.sendBeacon(SYNC_URL, new Blob([json], { type: 'application/json' }));
    });

    setTimeout(pushConfig, INITIAL_PUSH_DELAY);
    console.log('[sync] initialized, push in', INITIAL_PUSH_DELAY / 1000, 's');
  }

  // Synchronous pull before Vue mounts — sets localStorage with server data
  // so Vue hydrates with correct values. Proxy handles timeout (10s).
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', SYNC_URL, false);
    xhr.send();
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      if (data && data._ts && data.localStorage) {
        setAllLocalStorage(data.localStorage);
        if (data._keyTs) {
          saveKeyTimestamps(data._keyTs);
        }
        lastPushedHash = simpleHash(xhr.responseText);
        console.log('[sync] initial pull OK (sync XHR)');
      }
    }
  } catch (e) { console.log('[sync] initial pull error:', e); }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
  else { init(); }
})();
