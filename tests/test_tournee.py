"""Test de bout en bout avec un faux service d'adresses local.

Lancer : python3 tests/test_tournee.py   (nécessite openpyxl ; ortools optionnel)
"""
import hashlib, http.server, json, os, subprocess, sys, tempfile, threading, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "skill", "tournee-pav", "tournee.py")


class FakeBAN(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)["q"][0]
        h = int(hashlib.md5(q.encode()).hexdigest(), 16)
        if "introuvable" in q:
            body = {"features": []}
        else:
            body = {"features": [{"geometry": {"coordinates": [-1.68 + (h % 1000) / 20000, 48.10 + ((h >> 10) % 1000) / 25000]},
                                  "properties": {"label": q + " (BAN)", "score": 0.4 if "flou" in q else 0.9, "type": "street"}}]}
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(data)

    def log_message(self, *a):
        pass


def main():
    srv = http.server.HTTPServer(("127.0.0.1", 0), FakeBAN)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = dict(os.environ, TOURNEE_GEOCODER_URL=f"http://127.0.0.1:{srv.server_port}/search")
    out = os.path.join(tempfile.mkdtemp(), "t.xlsx")
    r = subprocess.run([sys.executable, SCRIPT, os.path.join(HERE, "exemple_points.csv"),
                        "--depot", "Dépôt, Rennes", "-o", out, "--seconds", "2"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout[r.stdout.index("{"):])
    assert res["arrets"] == 17, res          # 19 lignes - 1 introuvable - 1 doublon fusionné
    assert res["a_verifier"] == 1, res
    assert res["peu_fiables"] == 1, res
    from openpyxl import load_workbook
    wb = load_workbook(out)
    assert wb.sheetnames == ["Tournée", "Itinéraire", "À vérifier"], wb.sheetnames
    print("OK", res["methode"], res["km_estimes"], "km")


if __name__ == "__main__":
    main()
