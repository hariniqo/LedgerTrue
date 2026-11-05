// Deterministic JSON: sorted keys, no whitespace, undefined dropped.
// Server and browser must produce byte-identical output, or hashes and signatures will not match.
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('non-finite number in canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonical(v === undefined ? null : v)).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
