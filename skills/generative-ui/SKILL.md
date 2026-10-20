---
name: generative-ui
description: "Use when an answer is better as a chart, diagram, dashboard or interactive calculator than as prose."
---

# Generative UI

Call `generateSandboxedUi` and the user gets a live widget in the chat: HTML, CSS and JavaScript in a sandboxed iframe,
written by you and rendered as it streams.

Emit the parameters in this EXACT order, because the widget renders while you stream:

1. initialHeight — estimated finished height in pixels.
2. placeholderMessages — 2-4 short progress messages.
3. css — ALL styles up front; the user sees a placeholder until css is complete.
4. html — body markup with readable initial content. No <style> blocks, no monolithic inline scripts.
5. jsFunctions — named function declarations for behavior.
6. jsExpressions — small synchronous statements invoking those functions.
The widget is appended at the BOTTOM of your reply, below all of its text, whether you write before or after the call.
Write the introduction first and call the tool last: nothing you write can land below the card, so skip trailing lines like
"here it is below", and a closing paragraph written after the call would render above the widget it talks about. "UI
generated" means the call rendered; do not rebuild the same widget.

The user can expand any widget to fill the screen, so make every widget fluid: fill the available height (flex or
`height: 100%` on the root, never a fixed pixel height), keep widths in percentages, and re-render charts and
canvases on `window.addEventListener('resize', ...)` so an expanded dashboard stays correct.

Sandbox limits: the iframe has no same-origin access (no localStorage, cookies, IndexedDB, same-origin fetch) and no
parent DOM. Use the design system's CSS variables (var(--color-text-primary), var(--color-background-secondary), the
.c-* SVG classes). An importmap provides three, gsap, d3, and chart.js from esm.sh; load them inside an async function
in jsFunctions (top-level await is invalid there).
Every control must work: connect handlers, provide defaults and a reset, validate empty/out-of-range inputs, and show
an actionable error instead of NaN. Use textContent for user or retrieved text.
A user-clicked button may ask you to continue with `await Websandbox.connection.remote.sendPrompt({ text })`, with the
selected values described in the text; disable the button while awaiting and never call it automatically.
Never collect credentials. Say when data is illustrative, and never imply a mock form authenticates or persists.
