# Responsible AI in LedgerTrue

This page says what the AI does, what it can never do, how its mistakes are contained, and where it is still weak. Every claim here points at code or a test.

## 1. Where AI is used (four assistant/explainer functions, all advisory)

| Use | File | What the model sees | What it can change |
|---|---|---|---|
| Goal-drift flag on a purchase request | `src/proof/goalCheck.js` | The mandate goal and the request's merchant, item, category, reason and amount | Nothing but a yes/no flag. A "mismatch" makes the owner sign; it never approves or blocks. |
| Plain-English summary of a mandate | `src/proof/chainExplainer.js` | Sentences already computed from the chain (`shared/narrate.js`) | Nothing. Text only. |
| Reconciliation note for a payment | `src/explainer.js` | Facts computed by the reconciler | Nothing. Text only. |
| Read-only LedgerTrue assistant | `src/assistant.js`, `src/nvidia.js`, `POST /api/assistant/chat` | The question, up to 6 recent conversation turns, a verified concept guide, and up to 3 relevant, bounded mandate/payment summaries; no private keys or signatures | Nothing. It only returns an explanation and references. Deterministic record facts remain separate from the model-written explanation. |

An external AI agent can also *use* LedgerTrue through `examples/mcp-server.mjs`. That agent is the thing being governed, not part of the guard.

## 2. What the AI can never do

- **It cannot approve a payment, raise a limit, or move money.** Budget, per-payment cap, merchants, agents, expiry, restricted purchase types and instruction-hijacking text are hard checks in plain code (`shared/rules.js`). The AI goal check is a *soft* check: it can only add "ask the owner".
- **It cannot edit the chain.** Blocks are written by the engine after the rules decided.
- **The assistant cannot call payment actions.** Its endpoint accepts a question and returns an answer; it has no tools for approval, capture, void, or revocation. In authenticated deployments it requires the existing agent or operator bearer token.
- **Anyone can re-check the rules.** The verifier replays them in the browser, so the AI cannot quietly change what the rules were.
- Tested: "a lying AI cannot raise a limit" (`test/proof.test.js`).

## 3. Hallucination controls

1. **Facts only.** Summary prompts say: use only the given facts, add no amounts, names or causes.
2. **Output check.** `shared/grounding.js` rejects model text that contains any number, identifier, hash or link that is not in the facts it was given. A rejected text is replaced by the deterministic version and the response says why (`rejected`). Tested in `test/responsible-ai.test.js`.
3. **Always a fallback.** No key, timeout, HTTP error, bad JSON shape or rejected text all lead to the deterministic result. The product never depends on a model being right or available.
4. **Facts travel with the text.** The summary response includes the facts it came from, and the UI labels AI-written text and says its numbers were checked. Assistant answers are constrained to the selected record context, checked for unsupported numbers and IDs, and returned with validated source references.
5. **Structured output for decisions.** The goal check must return JSON with a boolean `mismatch`; anything else is discarded.

**What this does not prove:** the check covers numbers, IDs and links. It cannot prove that a sentence about a name or a cause is true. That is why the AI text never drives a decision and the plain facts are shown beside it.

## 4. Untrusted input (prompt injection)

Everything an agent writes is untrusted. First, deterministic screening runs *before* any model is asked (`shared/heuristics.js`): known hijacking phrases and restricted purchase types are blocked from the goal-check model call. The assistant also screens known instruction-hijacking or restricted text and returns a deterministic safety response. Prompts tell the model that questions and record text are data, not instructions. The phrase list is not exhaustive; assistant output remains informational, while payment limits and decisions remain code and owner signatures.

## 5. Human oversight

- The owner signs the mandate, every approval (bound to the exact decision hash) and any revocation, in their own browser.
- Anything above the owner threshold, or flagged by the goal check, waits for a human.
- The owner can revoke at any time; no new spending is possible after that.

## 6. Transparency and records

- The AI flag and its source (`llm` or `heuristic`) are stored in the REQUEST block, so a later reader can see whether a model was involved.
- The UI says when text was written by a model.
- The chain, the rules and the anchors are public to anyone holding the proof file.

## 7. Privacy and data minimization

- **With no `NVIDIA_API_KEY`, or with `AI_DISABLED=true`, nothing is sent to any model provider.** The whole product runs offline on deterministic code.
- The NIM base URL is server-side configuration (`NVIDIA_BASE_URL`, default `https://integrate.api.nvidia.com/v1`). Requests use an eight-second timeout and at most one retry. The key is never returned by `/api/config` or sent from browser code.
- With a key, the data in the table above is sent to NVIDIA NIM. Assistant questions, up to 6 recent turns and only the selected, bounded record summaries are included; the transcript is kept in page memory only and is not persisted by LedgerTrue. Owner keys, signatures and block hashes are not part of what is sent. Do not type personal data into mandate goals, requests, or assistant questions; they may be stored on the chain or sent to the model.
- LedgerTrue does not train or fine-tune any model. The provider's own terms apply to what you send them.
- Chains are append-only by design, so text written into a mandate cannot be deleted from its chain. This is a real tension with erasure requests; say so before using real personal data.

## 8. Known limits and failure modes

- The offline goal check is vocabulary overlap, English-centric, and can escalate harmless purchases. The cost of a false positive is one extra approval click.
- A model can misjudge a goal either way. A missed drift does not bypass any hard limit.
- Model availability and latency are outside our control; the goal check has a 4 s timeout and falls back.
- The injection phrase list can be bypassed by new wording. Hard limits still hold.
- This is a hackathon prototype tested against the **PayPal sandbox** and a simulator. It is not audited for real money and is not financial or legal advice.

## 9. Intended and unintended use

Intended: giving an agent, a child or an employee a bounded budget and being able to prove afterwards what happened. Not intended: concealing spending from the people it affects, or replacing the checks a regulated payment provider must do.

## 10. How we test it

`npm test` includes: the AI cannot raise a limit; injection and restricted types are blocked before any model call; the goal-check falls back on bad output and network failure; invented numbers, IDs and links in model text are rejected; the kill switch removes model calls. Run `node tools/preflight.mjs` before publishing.
