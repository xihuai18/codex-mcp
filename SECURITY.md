# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1.0 | No        |

Only the latest released minor line receives security fixes. Critical fixes are backported to the latest two patch releases in that supported minor line.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Use GitHub's private vulnerability reporting (Security Advisories → "Report a vulnerability")
3. Include a description of the vulnerability and steps to reproduce

You should receive a response within 48 hours.

## Security Considerations

- codex-mcp assumes the MCP client and server run on the same machine (stdio transport, shared filesystem). It is not designed for remote/cross-machine deployment.
- codex-mcp spawns `codex app-server` child processes that can execute commands on your system
- Always use appropriate `approvalPolicy` and `sandbox` settings
- The `danger-full-access` sandbox mode grants unrestricted system access — use with caution
- Approval requests auto-decline after 60 seconds by default
