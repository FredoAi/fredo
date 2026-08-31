# Fredo Security Policy

## Supported Versions

Fredo has not shipped a stable release yet. Security fixes are applied to the development branch only.

| Version | Supported |
|---------|-----------|
| `main` (current dev builds) | :white_check_mark: |
| Earlier commits / tags | :x: |

## Reporting a Vulnerability

**Do not open a public issue for a security-sensitive finding.**

Report vulnerabilities privately through the GitHub repository's Security tab: **Security → Report a vulnerability** (a private security advisory). Only the maintainers can see reports submitted this way.

Please include as much of the following as you can:

- A description of the vulnerability and its impact
- Step-by-step instructions or a proof of concept to reproduce it
- The affected commit or build of Fredo
- Any logs or output relevant to the finding

## Coordinated Disclosure

We follow a 90-day coordinated disclosure timeline:

1. You report the vulnerability privately via the Security tab.
2. The maintainer acknowledges the report and begins triage.
3. A fix is developed and released to `main`, and you are credited (unless you prefer otherwise).
4. Details are disclosed publicly no later than **90 days** after the initial report, regardless of release status, so users of dev builds can assess their exposure.

If you need an exception to the timeline (for example, an actively exploited issue), say so in your report.

## What Is NOT a Vulnerability

Fredo is a **local desktop application** whose threat model is the same-OS local user — not a networked, multi-tenant service. The following are known, documented design decisions, not security vulnerabilities:

- **Same-OS-user IPC access.** Any process running as the same OS user can send commands to the local IPC socket. OS-level user isolation is the security boundary. See [docs/SECURITY.md → IPC Socket](../docs/SECURITY.md#ipc-socket).
- **Loopback OTLP injection.** The OTLP receivers bind to `127.0.0.1` only, and any local process can send telemetry to them, including fabricated spans. See [docs/SECURITY.md → OTLP Receivers](../docs/SECURITY.md#otlp-receivers).
- **Webview-less filesystem surface.** The webview is granted no filesystem permissions; all filesystem operations run in the trusted Rust backend via Tauri commands. A compromised webview still cannot read or write the filesystem directly. See [docs/SECURITY.md → Tauri Capabilities](../docs/SECURITY.md#tauri-capabilities).

The technical trust model lives in [docs/SECURITY.md](../docs/SECURITY.md).
