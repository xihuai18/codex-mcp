# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes

- `approvalPolicy`, `sandbox`, and `effort` are now **required** parameters in the `codex` tool — callers must explicitly set based on their own permission level and task complexity
- `effort` parameter promoted from `advanced.effort` to top-level parameter in the `codex` tool
- `codex_reply` parameter `sandboxPolicy` renamed to `sandbox`

### Changed

- All MCP-visible text (tool descriptions, parameter descriptions, resource descriptions) streamlined for conciseness
- `effort` description now suggests adjusting based on task complexity
- `replyToSession` now persists successful `model` / `approvalPolicy` / `sandbox` / `cwd` overrides to session metadata
- Process `exit` / `error` paths now emit terminal `result` payloads so `codex_check(action=\"poll\")` always includes a terminal `result` in error states
- `SessionManager` now deduplicates concurrent `cancelSession` calls and prevents terminal sessions from re-entering `waiting_approval` on late server requests
- Approval and user-input timeout timers now call `.unref()` to avoid blocking process exit
- Documentation aligned with implementation details for event eviction and e2e guidance

## [0.1.0] - 2026-02-15

### Added

- Initial release
- 4 MCP tools: `codex`, `codex_reply`, `codex_session`, `codex_check`
- Async non-blocking session management
- Three-layer permission model (approval policy, sandbox, async approval)
- Cursor-based event polling with pin-protected buffer
- Session lifecycle: create, reply, cancel, interrupt, fork
- Command execution and file change approval flow
- User input request handling
- Automatic session cleanup (idle/running/terminal timeouts)
- Zero-config startup via `~/.codex/config.toml` inheritance
