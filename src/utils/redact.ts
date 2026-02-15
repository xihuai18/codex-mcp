/**
 * Redaction helpers for user-facing text.
 *
 * Goal: avoid leaking full local file paths in errors/events (spawn failures often include them).
 */

export function redactPaths(message: string): string {
  const windowsPath = /\b[A-Za-z]:\\[^\s:]+/g;
  const posixPath = /(^|[\s'"(])\/[^\s:]+/g;
  return message
    .replace(windowsPath, "<path>")
    .replace(posixPath, (_m, prefix: string) => `${prefix}<path>`);
}

