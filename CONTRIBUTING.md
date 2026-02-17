# Contributing to codex-mcp

Thanks for your interest in contributing!

## Getting Started

```bash
git clone https://github.com/xihuai18/codex-mcp.git
cd codex-mcp
npm install
npm run build
```

## Development Workflow

```bash
npm run typecheck    # Type check
npm run build        # Build
npm test             # Run tests
npm run lint         # Lint (ESLint)
npm run format:check # Check formatting (Prettier)
```

## Pull Requests

1. Fork the repo and create a branch from `master` (or the repository default branch)
2. Make your changes
3. Ensure `npm run typecheck` and `npm run build` pass
4. Submit a PR with a clear description

## Reporting Issues

Use [GitHub Issues](https://github.com/xihuai18/codex-mcp/issues). Include:
- Steps to reproduce
- Expected vs actual behavior
- Node.js and Codex CLI versions

## Code Style

- TypeScript strict mode
- ESM modules
- Prefer `as const` tuples for shared constants
- Keep tool handlers thin — delegate to SessionManager
