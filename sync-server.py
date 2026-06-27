#!/usr/bin/env python3
"""Config sync server v3 for AIRI — defense-in-depth, no-config-loss. (rev3, post-review-2)

Backward compatible with legacy (v1/v2) wholesale pushes; forward compatible with the v3
changes-only client. Server side of the essential-core fix plan.

Design (all judged against the IMMUTABLE SEED baseline, not the erodable live/advancing state):
  - Per-key, DIRECTION-AWARE protection: a protected key is only reverted when its new value moves
    TOWARD a default/reset form (blank or a recorded default); a divergence to a fresh DISTINCT user
    value passes. No count thresholds gate appearance protection (fixes CE-1 under-protection AND the
    multi-edit false-positive at once).
  - Per-key SANITIZE (revert only regressing keys, keep legit edits in the same push); a detected
    whole-push clobber escalates to reverting every regressing protected key.
  - Protocol-INDEPENDENT protections: _protocol selects merge SHAPE only (wholesale vs changes/deletions),
    never a trust level. v3 gets the same per-key defenses as legacy.
  - Credential floor vs SEED: a single provider key may drop while >= seed_keyed-1 remain; dropping
    below that, wholesale-blanking the creds blob, or blanking a provider's baseUrl is a regression.
  - L4 IndexedDB: per-key server-wins-on-blank.
  - L6 durability: atomic write (unique tmp, unlink-on-fail), rotated backups, an ADVANCING known-good
    plus an IMMUTABLE SEED known-good (written once, never advanced by force/regressing saves), and a
    self-healing GET that requires a real keyed provider and prefers seed/known-good over backups.
  - ?force=1 bypasses sanitize but can NEVER advance the known-good or seed.
"""
import glob
import http.server
import json
import os
import re
import sys
import time
from itertools import count as _count
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE, "sync-data.json")
BACKUP_DIR = os.path.join(BASE, "sync-backups")
QUARANTINE_DIR = os.path.join(BASE, "sync-quarantine")
KNOWN_GOOD = os.path.join(BASE, "sync-known-good.json")
KNOWN_GOOD_SEED = os.path.join(BASE, "sync-known-good.seed.json")  # IMMUTABLE original recovery floor
META_FILE = os.path.join(BASE, "sync-meta.json")

MAX_BACKUPS = 50
MAX_QUARANTINE = 100
COUNT_DROP_RATIO = 0.7
BLANK_MASS_THRESHOLD = 6
RICH_RATIO = 0.9
CRED_RE = re.compile(r"credential|api[_-]?key|token|secret", re.I)
ALLOWLIST_EXACT = {
    "settings/theme/colors/hue", "settings/theme/background/sampled-color",
    "settings/theme/background/gallery-options", "vueuse-color-scheme",
    "airi-card-active-id", "settings/stage/model", "settings/providers/added",
    "settings/language", "settings/connection/websocket-url",
}
ALLOWLIST_RE = re.compile(r"^settings/.*/active-(provider|model|custom-model)$")
# Recorded non-blank default/reset forms per key (observed AIRI defaults / the May-13 clobber values).
# Symbolic sentinels are robust; numeric/id entries are a bonus — escalation backstops unknown defaults.
SENTINEL_FORMS = {
    "vueuse-color-scheme": {"auto", "system"},
    "airi-card-active-id": {"default"},
    "settings/theme/colors/hue": {"220.44"},
    "settings/stage/model": {"display-model-4mVjK5fhym7-O6KjzdacG"},
    "settings/providers/added": {'{"browser-web-speech-api":true}'},
}
EXCLUDED_KEYS = {"settings/live2d/position", "settings/live2d/scale"}
PROTOCOL = 3

_q_counter = [0]
_tmp_counter = _count()


def now_ms():
    return int(time.time() * 1000)


def is_allowlisted(k):
    return k in ALLOWLIST_EXACT or bool(ALLOWLIST_RE.match(k))


# ----------------------------- value helpers -----------------------------

def is_blank(v):
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip() in ("", "{}", "[]", "null", '""', "''")
    if isinstance(v, (dict, list)):
        return len(v) == 0
    return False


def parse_jsonish(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v
    return v


def canon(v):
    try:
        return json.dumps(parse_jsonish(v), sort_keys=True, separators=(",", ":"))
    except Exception:
        return str(v)


def is_default_form(key, val):
    """True if val is a default/reset form for an allowlisted key (blank, recorded sentinel, or a
    provider-selection reset)."""
    if is_blank(val):
        return True
    s = SENTINEL_FORMS.get(key)
    if s and (val in s or (isinstance(val, str) and val.strip().lower() in {x.lower() for x in s})):
        return True
    if ALLOWLIST_RE.match(key) and isinstance(val, str) and val.strip().lower() in ("speech-noop", "none"):
        return True
    return False


def providers_with_keys(v):
    obj = parse_jsonish(v)
    out = set()
    if isinstance(obj, dict):
        for name, d in obj.items():
            if isinstance(d, dict):
                for field in ("apiKey", "api_key", "key", "token", "secret"):
                    if not is_blank(d.get(field)):
                        out.add(name)
                        break
    return out


def _baseurl_blanked(seed_val, new_val):
    s, n = parse_jsonish(seed_val), parse_jsonish(new_val)
    if not isinstance(s, dict) or not isinstance(n, dict):
        return False
    for prov, sd in s.items():
        if isinstance(sd, dict) and not is_blank(sd.get("baseUrl")):
            nd = n.get(prov)
            if not isinstance(nd, dict) or is_blank(nd.get("baseUrl")):
                return True
    return False


# ----------------------------- merge -----------------------------

def _merge_cards(server_cards_json, client_cards_json):
    def load(j):
        try:
            v = json.loads(j) if isinstance(j, str) else (j or [])
            return v if isinstance(v, list) else []
        except Exception:
            return []
    merged = {}
    for card in load(server_cards_json):
        if isinstance(card, list) and len(card) >= 2:
            merged[card[0]] = card[1]
    for card in load(client_cards_json):
        if isinstance(card, list) and len(card) >= 2:
            merged[card[0]] = card[1]
    return json.dumps([[k, v] for k, v in merged.items()])


def merge_legacy(server, client):
    server_ls = server.get("localStorage", {}) or {}
    client_ls = client.get("localStorage", {}) or {}
    server_kt = dict(server.get("_keyTs", {}) or {})
    client_kt = client.get("_keyTs", {}) or {}
    if not server_kt and server_ls:
        server_kt = {k: server.get("_ts", 0) or 0 for k in server_ls}
    merged_ls, merged_kt = {}, {}
    for key in (set(server_ls) | set(client_ls)):
        if key in EXCLUDED_KEYS:
            if key in server_ls:
                merged_ls[key] = server_ls[key]
                merged_kt[key] = server_kt.get(key, 0)
            continue
        if key == "airi-cards":
            merged_ls[key] = _merge_cards(server_ls.get(key, "[]"), client_ls.get(key, "[]"))
            merged_kt[key] = max(server_kt.get(key, 0), client_kt.get(key, 0))
            continue
        s_ts = server_kt.get(key, 0)
        c_ts = client_kt.get(key, 0) if key in client_kt else 0
        in_s, in_c = key in server_ls, key in client_ls
        if in_s and in_c:
            if c_ts > s_ts:
                merged_ls[key], merged_kt[key] = client_ls[key], c_ts
            else:
                merged_ls[key], merged_kt[key] = server_ls[key], s_ts
        elif in_c:
            merged_ls[key], merged_kt[key] = client_ls[key], c_ts
        else:
            merged_ls[key], merged_kt[key] = server_ls[key], s_ts
    return merged_ls, merged_kt


def merge_v3(server, client):
    server_ls = dict(server.get("localStorage", {}) or {})
    server_kt = dict(server.get("_keyTs", {}) or {})
    changes = client.get("changes", {}) or {}
    deletions = client.get("deletions", {}) or {}
    for key, ch in changes.items():
        if key in EXCLUDED_KEYS or not isinstance(ch, dict):
            continue
        c_ts = ch.get("keyTs", 0) or 0
        if key == "airi-cards":
            server_ls[key] = _merge_cards(server_ls.get(key, "[]"), ch.get("value", "[]"))
            server_kt[key] = max(server_kt.get(key, 0), c_ts)
            continue
        if c_ts > server_kt.get(key, 0):
            server_ls[key] = ch.get("value")
            server_kt[key] = c_ts
    if isinstance(deletions, dict):
        for key, kt in deletions.items():
            if key in EXCLUDED_KEYS:  # bc-2: never delete device-local excluded keys via v3
                continue
            if key in server_ls and (kt or 0) > server_kt.get(key, 0):
                server_ls.pop(key, None)
                server_kt.pop(key, None)
    return server_ls, server_kt


def merge_idb(server_idb, client_idb):
    merged = dict(server_idb or {})
    for k, v in (client_idb or {}).items():
        if is_blank(v) and not is_blank(merged.get(k)):
            continue
        merged[k] = v
    return merged


# ----------------------------- sanitize (L5, seed-baseline, per-key, direction-aware) -----------------------------

def sanitize_push(server_ls, merged_ls, seed_ls, hwm):
    """Revert regressing keys to the current server value so config is never lost, while letting
    legitimate distinct edits through. Judged against the immutable SEED. Returns (final, reverted, escalated)."""
    reverted = set()
    out = dict(merged_ls)

    def revert(k):
        if k in server_ls:
            out[k] = server_ls[k]
        else:
            out.pop(k, None)
        reverted.add(k)

    # 1) credential floor vs SEED
    cred_regress = False
    for k in set(server_ls) | set(seed_ls):
        if not CRED_RE.search(k):
            continue
        base = seed_ls.get(k) if not is_blank(seed_ls.get(k)) else server_ls.get(k)
        seed_keyed = providers_with_keys(base)
        new_keyed = providers_with_keys(out.get(k))
        bad = False
        if not is_blank(base) and is_blank(out.get(k)):
            bad = True
        elif seed_keyed and len(new_keyed) < max(len(seed_keyed) - 1, (len(seed_keyed) + 1) // 2):
            bad = True
        elif _baseurl_blanked(base, out.get(k)):
            bad = True
        if bad:
            revert(k)
            cred_regress = True

    # 2) per-key blank-transition suppression vs SEED anchor
    blank_regress = [k for k in seed_ls
                     if k not in EXCLUDED_KEYS and not is_blank(seed_ls[k])
                     and is_blank(out.get(k)) and not is_blank(server_ls.get(k))]

    # 3) per-key allowlisted default-form revert vs SEED (direction-aware)
    allow_regress = [k for k in out
                     if is_allowlisted(k) and k in seed_ls and not is_blank(seed_ls[k])
                     and not is_default_form(k, seed_ls[k])
                     and canon(out.get(k)) != canon(server_ls.get(k))
                     and is_default_form(k, out.get(k))]

    nonempty_merged = sum(1 for v in out.values() if not is_blank(v))
    nonempty_seed = sum(1 for v in seed_ls.values() if not is_blank(v))
    escalate = (len(allow_regress) >= 2
                or len(blank_regress) >= BLANK_MASS_THRESHOLD
                or (cred_regress and (blank_regress or allow_regress))
                or (hwm and len(out) < hwm * COUNT_DROP_RATIO)
                or (nonempty_seed and nonempty_merged < nonempty_seed * COUNT_DROP_RATIO))

    for k in blank_regress:
        revert(k)
    for k in allow_regress:
        revert(k)

    if escalate:
        # whole-push clobber: revert every protected key regressing vs seed (incl unregistered defaults)
        for k in seed_ls:
            if (is_allowlisted(k) and not is_blank(seed_ls[k]) and not is_default_form(k, seed_ls[k])
                    and canon(out.get(k)) != canon(seed_ls[k])
                    and (is_default_form(k, out.get(k)) or is_blank(out.get(k)))):
                revert(k)
    return out, sorted(reverted), escalate


# ----------------------------- durability (L6) -----------------------------

def atomic_write(path, obj):
    tmp = "%s.%d.%d.%d.tmp" % (path, os.getpid(), now_ms(), next(_tmp_counter))
    try:
        with open(tmp, "w") as f:
            json.dump(obj, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _valid_blob(b):
    return isinstance(b, dict) and b.get("_ts") and isinstance(b.get("localStorage"), dict)


def _keyed_count(blob):
    ls = blob.get("localStorage", {}) or {}
    return max((len(providers_with_keys(ls[k])) for k in ls if CRED_RE.search(k)), default=0)


def _looks_good(b):
    """Valid AND has at least one real keyed provider (a non-blank credential STRING is not enough)."""
    return _valid_blob(b) and _keyed_count(b) >= 1


def rotate_backup(blob):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    gen = blob.get("generation") or 0
    atomic_write(os.path.join(BACKUP_DIR, "sync-data.%s.%d.json" % (gen, now_ms())), blob)
    files = sorted(glob.glob(os.path.join(BACKUP_DIR, "sync-data.*.json")), key=os.path.getmtime)
    for old in files[:-MAX_BACKUPS]:
        try:
            os.remove(old)
        except OSError:
            pass


def save_data(blob):
    if os.path.exists(DATA_FILE):
        try:
            rotate_backup(json.load(open(DATA_FILE)))
        except Exception:
            pass
    atomic_write(DATA_FILE, blob)


def _seed_keyed():
    for p in (KNOWN_GOOD_SEED, KNOWN_GOOD):
        if os.path.exists(p):
            try:
                b = json.load(open(p))
                if _valid_blob(b):
                    return _keyed_count(b)
            except Exception:
                pass
    return 0


def load_data():
    if os.path.exists(DATA_FILE):
        try:
            b = json.load(open(DATA_FILE))
            if _valid_blob(b):
                return b
        except Exception:
            pass
    # self-heal: known-good -> seed -> only seed-grade backups -> any valid backup
    for p in (KNOWN_GOOD, KNOWN_GOOD_SEED):
        if os.path.exists(p):
            try:
                b = json.load(open(p))
                if _looks_good(b):
                    return b
            except Exception:
                pass
    seed_keyed = _seed_keyed()
    baks = sorted(glob.glob(os.path.join(BACKUP_DIR, "sync-data.*.json")), key=os.path.getmtime, reverse=True)
    for bak in baks:
        try:
            b = json.load(open(bak))
            if _looks_good(b) and _keyed_count(b) >= max(seed_keyed, 1):
                return b
        except Exception:
            continue
    for p in (KNOWN_GOOD, KNOWN_GOOD_SEED):  # valid even if cred-poor, before raw backups
        if os.path.exists(p):
            try:
                b = json.load(open(p))
                if _valid_blob(b):
                    return b
            except Exception:
                pass
    for bak in baks:
        try:
            b = json.load(open(bak))
            if _valid_blob(b):
                return b
        except Exception:
            continue
    return {}


def load_known_good_seed():
    for p in (KNOWN_GOOD_SEED, KNOWN_GOOD):
        if os.path.exists(p):
            try:
                b = json.load(open(p))
                if _valid_blob(b):
                    return b
            except Exception:
                pass
    return None


def maybe_advance_known_good(blob, seed, hwm):
    """Advance the ADVANCING known-good for recovery freshness. Gated vs the SEED. Never frozen by a
    single legit clear (only mass-blank / credential-regress / allowlist default-revert block it)."""
    ls = blob.get("localStorage", {}) or {}
    seed_ls = (seed or {}).get("localStorage", {}) or {}
    if hwm and len(ls) < hwm * RICH_RATIO:
        return
    for k in seed_ls:
        if CRED_RE.search(k):
            sk = providers_with_keys(seed_ls.get(k))
            nk = providers_with_keys(ls.get(k))
            if sk and len(nk) < max(len(sk) - 1, (len(sk) + 1) // 2):
                return
    if sum(1 for k in seed_ls if not is_blank(seed_ls[k]) and is_blank(ls.get(k))) >= BLANK_MASS_THRESHOLD:
        return
    if any(is_allowlisted(k) and k in seed_ls and not is_blank(seed_ls[k])
           and not is_default_form(k, seed_ls[k]) and is_default_form(k, ls.get(k)) for k in ls):
        return
    atomic_write(KNOWN_GOOD, blob)


def load_meta():
    try:
        m = json.load(open(META_FILE))
        if isinstance(m, dict):
            return m
    except Exception:
        pass
    return {"hwm": 0}


def save_meta(m):
    atomic_write(META_FILE, m)


def quarantine(client_data, reverted):
    os.makedirs(QUARANTINE_DIR, exist_ok=True)
    _q_counter[0] += 1
    try:
        atomic_write(os.path.join(QUARANTINE_DIR, "rejected.%d.%d.json" % (now_ms(), _q_counter[0])),
                     {"reverted": reverted, "push": client_data})
    except Exception:
        return
    files = sorted(glob.glob(os.path.join(QUARANTINE_DIR, "rejected.*.json")), key=os.path.getmtime)
    for old in files[:-MAX_QUARANTINE]:
        try:
            os.remove(old)
        except OSError:
            pass


def _canon_state(blob):
    return json.dumps({"ls": blob.get("localStorage", {}), "idb": blob.get("indexedDB", {})}, sort_keys=True)


def seed_startup():
    blob = load_data()
    if not _valid_blob(blob):
        return
    meta = load_meta()
    if not meta.get("hwm"):
        meta["hwm"] = len(blob.get("localStorage", {}))
        save_meta(meta)
    if not os.path.exists(KNOWN_GOOD_SEED):
        atomic_write(KNOWN_GOOD_SEED, blob)
    if not os.path.exists(KNOWN_GOOD):
        atomic_write(KNOWN_GOOD, blob)


# ----------------------------- core POST logic (testable) -----------------------------

def _coerce_client(c):
    for k in ("localStorage", "indexedDB", "_keyTs", "changes", "deletions"):
        if k in c and not isinstance(c[k], dict):
            c[k] = {}
    return c


def process_push(client, force=False):
    client = _coerce_client(dict(client))
    server = load_data()
    server_ls = server.get("localStorage", {}) or {}
    seed = load_known_good_seed() or server
    seed_ls = seed.get("localStorage", {}) or {}
    meta = load_meta()
    hwm = meta.get("hwm", 0)
    try:
        proto = int(client.get("_protocol", 1) or 1)
    except (ValueError, TypeError):
        proto = 1

    # _protocol selects merge SHAPE only — never a trust level.
    if proto >= 3:
        merged_ls, merged_kt = merge_v3(server, client)
    else:
        merged_ls, merged_kt = merge_legacy(server, client)
    merged_idb = merge_idb(server.get("indexedDB", {}), client.get("indexedDB", {}))

    if force:
        final_ls, reverted, escalated = merged_ls, [], False
    else:
        final_ls, reverted, escalated = sanitize_push(server_ls, merged_ls, seed_ls, hwm)
        server_kt = server.get("_keyTs", {}) or {}
        for k in reverted:
            if k in server_kt:
                merged_kt[k] = server_kt[k]
            else:
                merged_kt.pop(k, None)

    final = {
        "localStorage": final_ls,
        "indexedDB": merged_idb,
        "_ts": now_ms(),
        "_keyTs": merged_kt,
        "generation": int(server.get("generation", 1) or 1),
        "_protocol": max(int(server.get("_protocol", 1) or 1), proto),
    }

    if server and _canon_state(final) == _canon_state(server):
        resp = dict(server)
        if reverted:
            resp["_sanitized"] = True
            resp["_revertedKeys"] = reverted
        return 200, resp

    final["generation"] += 1
    save_data(final)
    new_hwm = max(hwm, len(final_ls))
    if new_hwm != hwm:
        meta["hwm"] = new_hwm
        save_meta(meta)
    if not force:
        maybe_advance_known_good(final, seed, new_hwm)
    if reverted:
        quarantine(client, reverted)
    resp = dict(final)
    if reverted:
        resp["_sanitized"] = True
        resp["_revertedKeys"] = reverted
    return 200, resp


# ----------------------------- HTTP -----------------------------

class SyncHandler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, obj):
        try:
            body = json.dumps(obj).encode()
        except Exception:
            status, body = 500, b'{"error":"serialize"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/sync/config":
            blob = load_data()
            self._send_json(200, blob if blob else {"empty": True, "_ts": 0})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parts = urlparse(self.path)
        if parts.path != "/sync/config":
            self.send_response(404)
            self.end_headers()
            return
        force = parse_qs(parts.query).get("force", ["0"])[0] == "1"
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b"{}"
            client = json.loads(body)
            if not isinstance(client, dict):
                raise ValueError("payload not an object")
        except Exception:
            self._send_json(400, {"error": "invalid json"})
            return
        try:
            status, resp = process_push(client, force=force)
        except Exception as e:
            self._send_json(500, {"error": "merge failed", "detail": str(e)[:200]})
            return
        self._send_json(status, resp)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3031
    seed_startup()
    with http.server.HTTPServer(("0.0.0.0", port), SyncHandler) as s:
        print("Config sync server v3 (guarded+durable, rev3) on http://0.0.0.0:%d" % port)
        s.serve_forever()
