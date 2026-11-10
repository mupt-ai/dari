# Dari Router

The smallest managed-router example. Dari's selector automatically chooses between the enabled models, using Dari-managed provider keys.

## Create

```bash
dari auth login
dari router create ./router.yml
```

Your organization must have managed access to the OpenAI and Anthropic providers. Run `dari router models` to confirm the model IDs are available before creating the router.
