// All money is integer minor units (cents/paise). Floats never touch the ledger.

/**
 * Parse a decimal amount into minor units without floating-point arithmetic.
 * The old Math.round(n * 100) turned "0.295" into 29 and "1.005" into 100.
 */
export function toCents(value, decimals = 2) {
  const s = typeof value === 'number' ? (Number.isFinite(value) ? value.toString() : 'x') : String(value).trim();
  if (/e/i.test(s)) {
    // Exponent notation (e.g. 1e-7 from a float): refuse rather than guess.
    throw new Error(`invalid amount: ${value}`);
  }
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`invalid amount: ${value}`);
  const frac = m[2] ?? '';
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`too many decimal places: ${value}`);
  const cents = BigInt(m[1] + frac.slice(0, decimals).padEnd(decimals, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`amount too large: ${value}`);
  return Number(cents);
}

export function fmt(cents, currency = 'USD') {
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency }).format(cents / 100);
}
