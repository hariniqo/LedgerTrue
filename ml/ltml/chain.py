"""Replays chain blocks into budget state.

This mirrors shared/rules.js (emptyState / applyBlock). It exists only for analytics: the Node server is always
the authority, and the API cross-checks the committed total this code derives against the server's own number.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

BLOCK_TYPES = {"MANDATE", "REQUEST", "DECISION", "APPROVAL", "HOLD", "CAPTURE", "VOID", "RECON", "REVOKE"}


@dataclass
class ChainState:
    mandate: dict | None = None
    revoked: bool = False
    requests: dict[str, dict] = field(default_factory=dict)
    settled: int = 0
    held: int = 0
    reserved: int = 0
    blocks: int = 0

    @property
    def committed(self) -> int:
        return self.settled + self.held + self.reserved

    @property
    def available(self) -> int:
        return (self.mandate["budgetCents"] - self.committed) if self.mandate else 0


def apply_block(s: ChainState, b: dict) -> None:
    d = b.get("data") or {}
    rid = d.get("requestId")
    rq = s.requests.get(rid) if rid else None
    s.blocks += 1
    t = b["type"]
    if t == "MANDATE":
        s.mandate = d["mandate"]
    elif t == "REQUEST":
        s.requests[rid] = {
            "id": rid, "status": "NEW", "amountCents": d["amountCents"], "agentId": d.get("agentId"),
            "merchant": d.get("merchant"), "ts": b["ts"], "heldCents": 0, "capturedCents": 0, "data": d,
        }
    elif t == "DECISION" and rq is not None:
        if d.get("outcome") == "BLOCKED":
            rq["status"] = "BLOCKED"
        else:
            rq["status"] = "APPROVED" if d.get("outcome") == "APPROVED" else "PENDING_APPROVAL"
            s.reserved += rq["amountCents"]
        rq["outcome"] = d.get("outcome")
        rq["reasons"] = d.get("reasons", [])
        rq["decisionTs"] = b["ts"]
    elif t == "APPROVAL" and rq is not None:
        if d.get("decision") == "APPROVE":
            rq["status"] = "APPROVED"
        else:
            rq["status"] = "REJECTED"
            s.reserved -= rq["amountCents"]
        rq["approvalTs"] = b["ts"]
    elif t == "HOLD" and rq is not None:
        rq["status"] = "HELD"
        rq["heldCents"] = d["amountCents"]
        s.reserved -= rq["amountCents"]
        s.held += d["amountCents"]
    elif t == "CAPTURE" and rq is not None:
        s.held -= rq["heldCents"]
        s.settled += d["amountCents"]
        rq["capturedCents"] = d["amountCents"]
        rq["heldCents"] = 0
        rq["status"] = "SETTLED"
    elif t == "VOID" and rq is not None:
        if rq["status"] == "HELD":
            s.held -= rq["heldCents"]
            rq["heldCents"] = 0
        else:
            s.reserved -= rq["amountCents"]
        rq["status"] = "VOIDED"
    elif t == "REVOKE":
        s.revoked = True


def replay(blocks: Iterable[dict]) -> ChainState:
    s = ChainState()
    for b in blocks:
        apply_block(s, b)
    return s


def committed_series(blocks: Iterable[dict]) -> list[tuple[int, int]]:
    """[(ts, committed_cents_after_block)] at every block that changed the committed total."""
    s = ChainState()
    out: list[tuple[int, int]] = []
    last = 0
    for b in blocks:
        apply_block(s, b)
        c = s.committed
        if c != last:
            out.append((int(b["ts"]), c))
            last = c
    return out


def validate_blocks(blocks: list[dict]) -> list[str]:
    """Cheap structural checks. The server already verified the hash chain; this guards the analytics."""
    problems: list[str] = []
    if not blocks:
        return ["no blocks"]
    if blocks[0].get("type") != "MANDATE":
        problems.append("block 0 must be the MANDATE")
    prev_ts = -1
    for i, b in enumerate(blocks):
        if b.get("type") not in BLOCK_TYPES:
            problems.append(f"block {i}: unknown type")
        ts = b.get("ts")
        if not isinstance(ts, (int, float)):
            problems.append(f"block {i}: ts missing")
            continue
        if ts < prev_ts:
            problems.append(f"block {i}: time goes backwards")
        prev_ts = ts
        if len(problems) >= 5:
            break
    return problems
