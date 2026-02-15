# codex-schema (vendored)

This directory vendors the JSON Schema bundle generated from the local `codex app-server` protocol.

We commit it to git to:

- Make protocol changes reviewable (schema diffs in PRs).
- Keep `src/app-server/protocol.ts` and the session/approval logic aligned with a pinned protocol snapshot.
- Avoid “works on my machine” drift caused by different local `codex` versions.

## How to update

1. Ensure you have the desired `codex` CLI version installed.
2. Regenerate the bundle:

```bash
codex app-server generate-json-schema --experimental --out codex-schema
```

3. Update `codex-schema/metadata.json` and commit the resulting changes.

## Current snapshot

- Generated with: `codex-cli 0.101.0`
- Generated at: 2026-02-15
- Command: `codex app-server generate-json-schema --experimental --out codex-schema`

