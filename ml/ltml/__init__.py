"""LedgerTrue intelligence layer: advisory ML for mandates, agent spend and payment reconciliation.

Nothing in this package can approve, block, capture, release or edit anything. It reads chain blocks and payment
events and returns estimates with evidence. The deterministic rule engine and the hash-chained ledger stay the
only authority over money.
"""
__version__ = "1.0.0"
