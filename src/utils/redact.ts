/**
 * Redaction helpers for user-facing text.
 *
 * Goal: avoid leaking full local file paths in errors/events (spawn failures often include them).
 */

export function redactPaths(message: string): string {
  const uncPath = /(^|[\s'"(])\\\\[^\s\\/:]+\\[^\s:]+(?:\\[^\s:]+)*/g;
  const windowsPath = /\b[A-Za-z]:\\[^\s:]+/g;
  const posixPath = /(^|[\s'"(])\/[^\s:'")]+/g;
  return message
    .replace(uncPath, (_m, prefix: string) => `${prefix}<path>`)
    .replace(windowsPath, "<path>")
    .replace(posixPath, (_m, prefix: string) => `${prefix}<path>`);
}
