# Contributing

Issues and pull requests are welcome.

## How Changes Land

This repository is published from Dari's source repository, and `main` is replaced on every release. A pull request merged here would be overwritten, so maintainers apply accepted changes upstream instead, keeping you as the commit author, and close the pull request when the release carrying it is published.

## Development

Requires [Bun](https://bun.sh) 1.3 or later.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

Tests make no provider or network calls; keep it that way. CI runs the same commands on every pull request.

## Pull Requests

- Keep each pull request to one change, and include tests when behavior changes.
- Keep protocol translation directional: client input in `src/protocol/input`, canonical interactions in `src/interaction`, client output in `src/protocol/output`, and provider translation in `src/providers`.
- Deployment-specific behavior (storage, accounting, tenancy) belongs behind `GatewayPlatform`, not in the runtime. `src/self_host/` is the reference platform.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

Contributions are licensed under [Apache-2.0](LICENSE).
