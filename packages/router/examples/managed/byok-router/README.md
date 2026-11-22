# BYOK Router

This managed router pays for OpenAI with Dari credits and serves DeepSeek through your own Fireworks key. A spec holds no credentials, so save the key to your organization first.

## Create

```bash
dari auth login
printf %s "$FIREWORKS_API_KEY" | dari accounts provider add fireworks "Fireworks" --value-stdin
dari router apply ./router.yaml
```

Run `dari router models` first to confirm the selected models and provider support.
