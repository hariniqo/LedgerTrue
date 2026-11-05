"""Versioned model artifacts with an integrity check.

models/<name>/<version>/artifact.joblib + manifest.json, and models/<name>/CURRENT naming the live version.
joblib is pickle underneath, so a tampered file could run code on load. The manifest stores the file's SHA-256 and
load() refuses anything that does not match. Only load artifacts you trained yourself or received from a trusted copy.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
import os
import warnings

import sklearn

import joblib

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"


class ArtifactError(RuntimeError):
    pass


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def save(name: str, artifact: object, manifest: dict, root: Path = MODELS_DIR, promote: bool = True) -> str:
    version = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    d = root / name / version
    d.mkdir(parents=True, exist_ok=True)
    f = d / "artifact.joblib"
    joblib.dump(artifact, f, compress=3)
    m = {**manifest, "name": name, "version": version, "createdAt": int(time.time() * 1000), "sha256": _sha(f)}
    (d / "manifest.json").write_text(json.dumps(m, indent=2, sort_keys=True))
    if promote:
        (root / name / "CURRENT").write_text(version)
    return version


def current_version(name: str, root: Path = MODELS_DIR) -> str | None:
    p = root / name / "CURRENT"
    return p.read_text().strip() if p.exists() else None


def manifest(name: str, version: str | None = None, root: Path = MODELS_DIR) -> dict | None:
    version = version or current_version(name, root)
    if not version:
        return None
    p = root / name / version / "manifest.json"
    return json.loads(p.read_text()) if p.exists() else None


def load(name: str, version: str | None = None, root: Path = MODELS_DIR):
    version = version or current_version(name, root)
    if not version:
        raise ArtifactError(f"no trained version of {name}")
    d = root / name / version
    m = json.loads((d / "manifest.json").read_text())
    f = d / "artifact.joblib"
    if _sha(f) != m["sha256"]:
        raise ArtifactError(f"{name}/{version}: artifact hash does not match its manifest; refusing to load")

    trained = (m.get("environment") or {}).get("scikit-learn")
    if trained and trained.split(".")[:2] != sklearn.__version__.split(".")[:2]:
        msg = (f"{name}/{version}: trained with scikit-learn {trained}, running {sklearn.__version__}. "
               "Retrain with `npm run ml:train`.")
        if os.environ.get("LTML_ALLOW_SKLEARN_MISMATCH") != "1":
            raise ArtifactError(msg)
        warnings.warn(msg)
    return joblib.load(f), m