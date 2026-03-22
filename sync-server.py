#!/usr/bin/env python3
"""Config sync server for AIRI with merge support.
Stores/retrieves a JSON config blob. POST merges client data with server data
instead of overwriting. Returns merged result so client can reconcile."""
import http.server
import json
import os
import sys

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync-data.json")


def load_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    return {}


def save_data(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


def merge_cards(server_cards_json, client_cards_json):
    """Merge airi-cards by card ID. Union of both sides, client wins for same ID."""
    try:
        server_cards = json.loads(server_cards_json) if server_cards_json else []
    except (json.JSONDecodeError, TypeError):
        server_cards = []
    try:
        client_cards = json.loads(client_cards_json) if client_cards_json else []
    except (json.JSONDecodeError, TypeError):
        client_cards = []

    # Build ordered dict: server first, then client overwrites same IDs
    merged = {}
    for card in server_cards:
        if isinstance(card, list) and len(card) >= 2:
            merged[card[0]] = card[1]
    for card in client_cards:
        if isinstance(card, list) and len(card) >= 2:
            merged[card[0]] = card[1]

    return json.dumps([[k, v] for k, v in merged.items()])


def merge_data(server_data, client_data):
    """Merge client push with server state.
    - airi-cards: union merge by card ID
    - other keys: per-key timestamp, newer wins
    """
    server_ls = server_data.get("localStorage", {})
    client_ls = client_data.get("localStorage", {})
    server_key_ts = server_data.get("_keyTs", {})
    client_key_ts = client_data.get("_keyTs", {})
    server_ts = server_data.get("_ts", 0)
    client_ts = client_data.get("_ts", 0)

    # Auto-migrate: if no _keyTs, initialize all keys with the blob _ts
    if not server_key_ts and server_ls:
        server_key_ts = {k: server_ts for k in server_ls}
    if not client_key_ts and client_ls:
        client_key_ts = {k: client_ts for k in client_ls}

    merged_ls = {}
    merged_key_ts = {}
    # Keys that should not be synced (device-specific)
    EXCLUDED_KEYS = {
        'settings/live2d/position',
        'settings/live2d/scale',
    }

    all_keys = (set(server_ls.keys()) | set(client_ls.keys())) - EXCLUDED_KEYS

    for key in all_keys:
        if key == "airi-cards":
            # Special merge: union by card ID
            merged_ls[key] = merge_cards(
                server_ls.get(key, "[]"),
                client_ls.get(key, "[]")
            )
            merged_key_ts[key] = max(
                server_key_ts.get(key, 0),
                client_key_ts.get(key, 0)
            )
        else:
            s_ts = server_key_ts.get(key, 0)
            c_ts = client_key_ts.get(key, 0)

            if key in client_ls and key in server_ls:
                # Both have it: newer timestamp wins
                if c_ts >= s_ts:
                    merged_ls[key] = client_ls[key]
                    merged_key_ts[key] = c_ts
                else:
                    merged_ls[key] = server_ls[key]
                    merged_key_ts[key] = s_ts
            elif key in client_ls:
                merged_ls[key] = client_ls[key]
                merged_key_ts[key] = c_ts
            else:
                merged_ls[key] = server_ls[key]
                merged_key_ts[key] = s_ts

    return {
        "localStorage": merged_ls,
        "indexedDB": client_data.get("indexedDB", {}),
        "_ts": max(server_ts, client_ts),
        "_keyTs": merged_key_ts,
    }


class SyncHandler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/sync/config":
            data = load_data()
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/sync/config":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b"{}"
            try:
                client_data = json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self._cors()
                self.end_headers()
                self.wfile.write(b'{"error":"invalid json"}')
                return

            server_data = load_data()
            merged = merge_data(server_data, client_data)
            save_data(merged)

            result_body = json.dumps(merged).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(result_body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3031
    with http.server.HTTPServer(("0.0.0.0", port), SyncHandler) as s:
        print(f"Config sync server (merge) on http://0.0.0.0:{port}")
        s.serve_forever()
