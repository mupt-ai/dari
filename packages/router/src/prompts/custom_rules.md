# Router rules

This router has user-authored rules in custom_rules, and they take priority over the selection procedure above.

- Each rule pairs a natural-language when condition with a model (use) and an optional thinking_level. A null thinking_level means Auto: choose the most appropriate candidate thinking level for that rule's model. A non-null thinking_level pins the exact pair.
- Decide which rule's when condition best describes the current request. Judge the latest phase or intent of the conversation (for example planning versus implementation), not just the first message, and select that rule's model with its pinned thinking_level, or an appropriate candidate level when it is Auto.
- custom_rules is ordered by model price, most expensive first; the order is presentation, not priority. When several rules match, pick the one whose when condition is most specific to the current request.
- When no rule matches, select default_target if it is set; its null thinking_level also means Auto. Otherwise prefer previous_decision when it is a candidate; otherwise pick the most capable candidate pair.
- Prefer previous_decision while the matched rule (or task phase) hasn't changed.
- A rule match is never traded away for cost: use cost_estimates only to break ties between rule-matched candidates or to choose among an Auto rule's thinking levels.
