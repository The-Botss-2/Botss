# UX writing and accessibility floor

## Part 1: UI copy rules

Words are interface. Most usability problems in generated apps are copy problems: vague buttons, robotic errors, empty screens that say nothing.

1. **Buttons say what happens.** Verb plus object: "Save changes", "Send invoice", "Cancel order". Not "Submit", "OK", "Continue" when something more specific is true.
2. **Success echoes the action.** The "Publish" button leads to "Published." The "Invite teammate" button leads to "Invitation sent to sara@example.com."
3. **Errors say what happened and what to do.** No apologies, no blame, no codes alone, no vagueness.
   * Good: "That email is already registered. Sign in instead, or use a different email."
   * Bad: "Oops! Something went wrong." / "Error 409" / "Invalid input."
4. **Empty states invite action.** Say what will appear here and how to get it there: "No invoices yet. Create your first invoice to get paid faster." with a "Create invoice" button.
5. **Sentence case** for everything: titles, buttons, labels, menus. Not Title Case, not ALL CAPS.
6. **Plain, short, specific.** Prefer common words. Cut "please", "simply", "just", "successfully". Numbers as digits.
7. **Same thing, same word.** Use the PRD glossary terms. If it is an "Order" in the PRD, it is never a "purchase" on a button.
8. **Destructive actions name the consequence.** "Delete project? This removes 14 tasks and can't be undone." The confirm button repeats the verb: "Delete project", not "Yes".
9. **Labels are nouns, help text explains.** Label "Phone number"; help text "We only call about delivery problems."
10. **Placeholders are examples, never labels.** Placeholder text disappears on typing and is low contrast.
11. **Loading text is honest.** "Loading orders" or a skeleton; for long work, say what is happening and roughly how long.
12. **Dates and money in the user's terms.** "Today, 1:15 pm", "$19.99", not ISO strings or minor units.

## Part 2: Accessibility floor (WCAG 2.2 AA)

These are minimums, not stretch goals. Automated tools catch only part of them, so design them in.

### Color and contrast
* Normal text: at least **4.5:1** against its background.
* Large text: at least **3:1**. Large means **24px regular or larger, or 18.66px (14pt) bold or larger**.
* UI components and meaningful graphics (input borders, icons that carry meaning, focus rings, chart lines): at least **3:1** against adjacent colors.
* Check every foreground and background token pair in **both** light and dark mode.
* **Never use color alone** to convey meaning. Status needs text or an icon; errors need a message; links in body text need underline or another non-color cue.

### Focus and keyboard
* Every interactive element is reachable and usable by keyboard, in a logical order that follows the visual order.
* **Focus is always visible** with a clear indicator (2px ring with offset, at least 3:1 contrast). Never `outline: none` without a replacement.
* Focus is not hidden behind sticky headers, cookie bars, or toasts (WCAG 2.4.11).
* Dialogs trap focus, close on Escape, and return focus to the element that opened them.
* Provide a "Skip to content" link on pages with repeated navigation.

### Targets
* Pointer targets at least **24x24 CSS px** (WCAG 2.5.8), with **44x44 recommended** for primary actions and anything used on touch devices.
* Adequate spacing between adjacent small targets.

### Forms
* Every input has a visible **label** (not only a placeholder), programmatically associated.
* Required fields marked in text, not only with color or an asterisk without explanation.
* Errors appear next to the field, describe the fix, and are associated with the input (`aria-describedby`); on submit, focus moves to the first error or an error summary.
* Do not ask users to re-enter information they already gave in the same flow (WCAG 3.3.7). Allow paste in password and code fields.

### Structure and content
* One `h1` per page, headings in order, landmarks (header, nav, main, footer).
* Meaningful images have alt text that says what matters; decorative images have empty alt.
* Icon-only buttons have an accessible name ("Close", "Delete order").
* Status changes that do not move focus (toasts, "saved", live counts) are announced via a polite live region.
* Text resizes to 200% without loss; layouts reflow at 320px width without horizontal scrolling.

### Motion
* Respect `prefers-reduced-motion`: remove non-essential animation, keep state changes instant.
* Nothing flashes more than three times per second.
* Auto-moving content (carousels, tickers) can be paused.

### What to write in each screen spec
Landmarks, heading order, focus order for complex widgets, what is announced on state changes, accessible names for icon buttons, and any keyboard shortcuts.
