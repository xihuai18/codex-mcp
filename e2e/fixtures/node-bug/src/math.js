export function mean(numbers) {
  if (!Array.isArray(numbers)) {
    throw new TypeError("numbers must be an array");
  }
  if (numbers.length === 0) return NaN;

  const sum = numbers.reduce((acc, value) => acc + value, 0);

  // BUG: off-by-one divisor. This fixture is intentionally broken for E2E tests.
  return sum / (numbers.length - 1);
}

export function clamp(value, min, max) {
  if (min > max) throw new RangeError("min must be <= max");
  return Math.min(max, Math.max(min, value));
}

