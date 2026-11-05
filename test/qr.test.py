"""Decode QR codes made by public/js/qr.js with OpenCV, so the encoder is proven by a real scanner.
OpenCV's detector is scale-sensitive, so each code is rendered at several scales and must decode at one of them.
Run: python3 test/qr.test.py   (needs node, python3, opencv-python). Not part of `npm test`."""
import json, subprocess, sys, os, random
from pathlib import Path
import numpy as np
import cv2

ROOT = Path(__file__).resolve().parents[1]
random.seed(11)
alpha = "abcdefghijklmnopqrstuvwxyz0123456789/:.-_?=&"
samples = [
    "hi",
    "https://ledgertrue.example/verify/m_0123456789abcdef01234567?h=ab12cd34&n=17&g=0123456789abcdef",
    "Proof of Intent: " + "é₹✓ " * 20,  # multi-byte UTF-8
    "z" * 213,  # maximum capacity
] + ["".join(random.choice(alpha) for _ in range(n)) for n in range(1, 214, 5)]

js = """
import { qrMatrix } from %s;
console.log(JSON.stringify(JSON.parse(process.argv[1]).map((t) => qrMatrix(t).map((r) => r.map((v) => (v ? 1 : 0))))));
""" % json.dumps((ROOT / "public" / "js" / "qr.js").as_uri())
res = subprocess.run(["node", "--input-type=module", "-e", js, json.dumps(samples)], capture_output=True, text=True)
if res.returncode:
    print(res.stderr); sys.exit(1)

det = cv2.QRCodeDetector()
aru = cv2.QRCodeDetectorAruco()  # second algorithm: the first one misreads some valid mask-2 codes
versions, bad = {}, 0
for text, mat in zip(samples, json.loads(res.stdout)):
    a = np.array(mat, dtype=np.uint8)
    ok = False
    for scale in (6, 8, 10, 12, 14):
        img = np.pad(np.kron(1 - a, np.ones((scale, scale), dtype=np.uint8)) * 255, 4 * scale, constant_values=255)
        if text in (det.detectAndDecode(img)[0], aru.detectAndDecode(img)[0]):
            ok = True
            break
    v = (len(mat) - 17) // 4
    versions[v] = versions.get(v, 0) + 1
    if not ok:
        bad += 1
        print("FAIL", f"v{v}", len(text.encode()), "bytes")
print(f"{len(samples) - bad}/{len(samples)} decoded; versions covered: {sorted(versions)}")
sys.exit(1 if bad else 0)
