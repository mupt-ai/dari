# BYOK Router

This managed router uses a Dari-managed OpenAI key and your own Fireworks key. The manifest reads the Fireworks credential from `FIREWORKS_API_KEY`; no key is stored in YAML.

## Create

```bash
export FIREWORKS_API_KEY=fw_...
dari auth login
dari router create ./router.yml
```

The CLI sends the key only while creating or replacing the router configuration. Run `dari router models` first to confirm the selected models and provider support.
