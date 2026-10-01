# Security

Streamr deCentral runs in the browser and can sign transactions (wallet extensions, or a private key kept
encrypted in the browser as a Keystore V3 file). Security reports are very welcome.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting instead
(Security tab of this repository, "Report a vulnerability"), with the steps to reproduce and what an attacker
could do. You'll get an answer as soon as possible.

## What the app does to stay safe

- **Untrusted data as text.** Operator metadata, stream ids and metadata, and explorer or RPC error texts are
  written with `textContent` or `escapeHtml()`. Tooltips never use `innerHTML`.
- **Content Security Policy.** `script-src 'self'`: no inline scripts or `on*` attributes; only the app's own
  files run (libraries are bundled or served from `/libs`, never from CDNs).
- **HTTP headers** (`vercel.json`): no framing (`frame-ancestors 'none'`, `X-Frame-Options`), `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`.
- **Private keys** never leave the browser; when saved, they are encrypted with the user's password (scrypt + AES).
- **Tests** (`npm test`) check the CSP on every page and that injected markup shows as text.
- **Dependencies** are pinned to exact versions; Dependabot (`.github/dependabot.yml`) reports security alerts and
  proposes updates every week.
