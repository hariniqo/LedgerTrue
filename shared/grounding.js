// Output guard for AI-written text. A language model may rephrase facts we computed, but it must not add any.
// Every number, identifier, hash and link in the model's text has to appear in the facts it was given; otherwise the
// text is rejected and the caller shows the deterministic version instead. This is a check on what is machine-
// verifiable (numbers, IDs, links). It cannot prove that a sentence about a name or a cause is true, which is why
// the facts are always returned next to any AI text and the AI never decides anything (see docs/RESPONSIBLE_AI.md).

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const ID = /\b(?:[rm]_[a-f0-9]{10,24}|[A-Z]{2,5}-(?=[A-Z0-9]*\d)[A-Z0-9]{4,}|[a-f0-9]{12,64})\b/gi;
const LINK = /https?:\/\/|www\.|\]\(|<[a-z!/]/i;

// "4,000.00" == "4000" == "04000.0": compare numbers by value text, not by formatting.
const norm = (s) => {
  let t = s.replace(/,/g, '');
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
  return t.replace(/^0+(?=\d)/, '');
};
const numbersIn = (text) => new Set((String(text).match(NUMBER) ?? []).map(norm));
const idsIn = (text) => new Set((String(text).match(ID) ?? []).map((x) => x.toLowerCase()));

export function groundCheck(note, factsText, { maxChars = 1500 } = {}) {
  const problems = [];
  const text = String(note ?? '').trim();
  const facts = String(factsText ?? '');
  if (!text) return { ok: false, problems: ['empty'] };
  if (text.length > maxChars) problems.push(`longer than ${maxChars} characters`);
  if (LINK.test(text) && !LINK.test(facts)) problems.push('contains a link or markup that is not in the facts');

  const known = numbersIn(facts);
  for (const n of numbersIn(text)) if (!known.has(n)) problems.push(`number "${n}" is not in the facts`);
  const knownIds = idsIn(facts);
  for (const id of idsIn(text)) if (!knownIds.has(id)) problems.push(`identifier "${id.slice(0, 16)}" is not in the facts`);

  return { ok: problems.length === 0, problems: problems.slice(0, 5) };
}
