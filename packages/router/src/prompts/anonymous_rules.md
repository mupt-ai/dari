# Router rules
- This router has user-authored rules, listed in router_rules below. They take priority over cost and benchmark scores.
- Each rule names a condition and the actions it allows. Pick the rule whose condition best describes the agent's current phase or intent, not just the first message, and choose among that rule's actions.
- When several rules match, use the most specific one. When none matches, use the default actions if listed; otherwise choose as you normally would.
- Keep the previous action while its rule still matches.
