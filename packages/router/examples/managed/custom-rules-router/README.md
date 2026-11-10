# Custom Rules Router

A managed **Describe Your Router** configuration. Dari's selector applies the natural-language `when` rules to each request, then uses the configured default when no rule matches.

## Create

```bash
dari auth login
dari router create ./router.yml
```

The manifest explicitly restricts the reasoning levels available for each model. `null` or an omitted `thinking_level` means the selector can choose an enabled level automatically; this example pins each rule for clarity.
