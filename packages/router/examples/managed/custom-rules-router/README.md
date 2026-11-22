# Custom Rules Router

A managed **Describe Your Router** configuration. Dari's selector applies the natural-language `when` rules to each request and routes among every enabled model when no rule matches.

## Create

```bash
dari auth login
dari router apply ./router.yaml
```

The spec restricts the reasoning levels offered for each model. An omitted `thinking_level` lets the selector choose an enabled level; this example pins each rule for clarity.
