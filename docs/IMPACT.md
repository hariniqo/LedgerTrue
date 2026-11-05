# Impact: who this helps, and how far it honestly goes

## The problem, in human terms
AI agents are starting to spend money on our behalf, and payments sometimes fail halfway (PayPal took the money, the checkout timed out). In both cases the same question has no good answer today: **what was allowed, what was asked, and what actually happened?** The usual answer is "trust the app's log", and the app's log is edited by the app.

## The scale (small businesses first)
- Small and medium enterprises are around 90% of all businesses and more than half of global employment (World Bank, SME Finance topic page).
- The World Bank cites a US$5.7 trillion SME finance gap across 119 emerging and developing economies.
- The FBI's Internet Crime Complaint Center logged 21,489 business email compromise complaints in 2023, with reported losses above US$2.9 billion. Fake supplier invoices and "change the bank account" emails are the classic pattern, and it is the pattern the demo reproduces.
- A small exporter cannot afford a finance team to review every agent or employee purchase. A signed mandate plus code-enforced rules gives it a limit it can prove to a bank, buyer or auditor.
- These are global figures about the problem. They are not claims about LedgerTrue's own reach or results.

## Who is hurt today
- **Families.** A parent lets a child's or relative's AI helper buy school supplies. The parent has no way to check afterwards, and no way to know whether the agent was tricked by text hidden in a web page.
- **Small businesses (the lead use case).** An owner gives an employee or an agent a monthly limit. Disputes become one person's word against another's screenshots.
- **Anyone hit by a ghost balance.** The money moved, the receipt says failed. Support has to guess.

## What LedgerTrue changes
- The **owner** signs the rules once, in their own browser. The signature travels with the proof.
- **Plain code** (not an AI) decides each request: approve, block, or ask the owner. Anyone can replay the rules.
- Every step is a block in a **hash-chained, signed ledger**. A Proof Card with a QR lets a third party re-check it with no login. Editing any record visibly breaks it.
- The **reconciler** asks PayPal when a reply is lost and settles once, so a ghost balance becomes a recorded, explained event instead of a mystery.

## Who benefits, in order of how soon
1. Anyone building or running agents that touch money (a spending limit they can prove, not just promise).
2. Families and small teams that want a budget the helper cannot quietly exceed.
3. Payment and support teams that need a clean audit trail for disputes.

## Honest limits
- It is a **sandbox prototype**. It has not been audited for real money.
- Anchors are only independent if copied somewhere the operator cannot edit.
- The PayPal evidence stored on a settlement is a hash of PayPal's reply, not a PayPal signature.
- Agent payments are early, so adoption depends on agent platforms and payment providers choosing to use something like this. Incumbents could build it themselves.
- We have not yet tested with non-technical users. That is the first thing to do next.

## Possible model (not validated)
Per-event pricing for agent platforms and payment providers, with the verification page and CLI staying free and open source so the proof is never locked in.

## What would prove the impact
A short test (script in `docs/USABILITY_TEST.md`) with two or three non-technical people reading a Proof Card and answering: "Was this agent tricked? Where did the money go?" If they can answer in under a minute without help, the claim holds.
