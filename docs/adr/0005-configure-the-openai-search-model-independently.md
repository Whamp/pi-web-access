---
status: accepted
---

# Configure the OpenAI search model independently

The OpenAI search model is selected independently of the model whose agent turn calls Web search, so an agent running on another provider can still use OpenAI-backed search. Web Access exposes one unqualified `openaiSearchModel` selector, defaults it to `gpt-5.6-luna:xhigh`, treats Pi's generated model catalog as authoritative, prefers `openai-codex` credentials over a direct OpenAI API key, and never silently substitutes another model or reasoning level.

Explicit OpenAI selection fails with actionable guidance when the selector is invalid. Automatic provider selection instead returns one Provider warning per tool call and continues to the next Search provider, preserving its “just works” behavior without hiding stale configuration. A catalog-contract test fails when Pi introduces a GPT generation above 5.6 so maintainers reconsider the default deliberately.
