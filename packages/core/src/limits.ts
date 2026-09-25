/**
 * Checks for the numeric limits callers pass in. A limit that is not a number
 * (or is NaN) would make every `size > max` comparison false and so switch
 * the limit off without a word; these checks turn that into a TypeError.
 */

/**
 * Return `value` if it is a usable limit: a number no smaller than `min`
 * (`Infinity` meaning "no limit"), and a whole number when `integer` is set.
 * Throw a TypeError naming `owner` and `name` otherwise.
 */
export function checkLimit(
  owner: string,
  name: string,
  value: unknown,
  { min = 0, integer = false }: { min?: number; integer?: boolean } = {},
): number {
  const ok =
    typeof value === 'number' &&
    !Number.isNaN(value) &&
    value >= min &&
    (!integer || value === Infinity || Number.isInteger(value));
  if (!ok) {
    const kind = integer ? `a whole number of at least ${min}` : `a number of at least ${min}`;
    throw new TypeError(`${owner}: ${name} must be ${kind} or Infinity; got ${describe(value)}`);
  }
  return value as number;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || value === null || value === undefined) return String(value);
  return typeof value;
}
