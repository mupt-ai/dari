# Managed Router Examples

Runnable router specs for Dari's managed router path. TypeScript framework examples remain in the parent [`examples/`](../) directory.

## Prerequisites

Install the [Dari CLI](https://github.com/mupt-ai/dari), sign in, and inspect the current model catalog:

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/dari/main/install.sh | bash
dari auth login
dari router models
```

Your organization needs access to the providers and models used by an example. For BYOK examples, export the provider key named in that example's README.

## Examples

- [`dari/`](dari) — automatic selection with managed provider credentials.
- [`byok-router/`](byok-router) — automatic selection with a provider key from your environment.
- [`custom-rules-router/`](custom-rules-router) — natural-language rules with explicit model and reasoning-level constraints.

## Create And Call A Router

From an example directory:

```bash
cd examples/managed/dari
dari router apply ./router.yaml
dari router get <router_id>
```

Create a routing key and call the endpoint returned by `dari router get`:

```bash
dari api-keys create --name example-client --type routing
export DARI_ROUTING_API_KEY="dari_..."

curl https://routing.dari.dev/rtr_.../chat/completions \
  -H "Authorization: Bearer $DARI_ROUTING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"dari/routing","messages":[{"role":"user","content":"Explain prompt caching."}]}'
```

Run `dari router models` before editing a spec. Model IDs and reasoning levels must match the current catalog.

## Adding An Example

Each example is a self-contained directory containing a `README.md` and `router.yaml`. Keep one managed-router concept per example. Specs hold no credentials; BYOK examples save the key with `dari accounts provider add`. Validate changes against a test organization with `dari router apply <example>/router.yaml`.
