# Security

Report a vulnerability privately through [GitHub's private vulnerability reporting](https://github.com/mupt-ai/dari/security/advisories/new). Do not open a public issue.

Include the affected version, how to reproduce it, and its impact. We will acknowledge the report, keep you updated while we fix it, and credit you in the advisory unless you prefer otherwise.

Fixes ship in the latest release only; upgrade to receive them.

## Deployment Notes

- The gateway listens on `127.0.0.1` by default. Before exposing it with `DARI_GATEWAY_HOST`, put it behind TLS and use long random `DARI_GATEWAY_KEYS`.
- The SQLite database (`DARI_GATEWAY_DB`) stores subscription tokens in plaintext. The gateway creates it readable only by its owner; keep it that way, and back it up like a secret.
- Anyone with a gateway key can spend your provider keys and connected subscriptions.
