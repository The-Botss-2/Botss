# UI states and accessibility patterns

The screen spec lists the states; this file is how to build them well.

## Part 1: States

| State | Build it as | Common mistakes |
|---|---|---|
| Loading (page) | `loading.tsx` skeleton shaped like the final layout | Full-page spinner; layout shift when content arrives |
| Loading (section) | `<Suspense fallback={<Skeleton/>}>` around the slow part | One slow query blocking the whole page |
| Loading (action) | Button shows pending label and spinner, stays the same width, `disabled` and `aria-busy` | Double submits; button text jumping |
| Empty (first use) | Spec copy plus the primary action that fills it | Blank area; "No data" |
| Empty (no results) | Says which filter caused it and offers to clear it | Same message as first use |
| Error (load) | `error.tsx` or inline block with spec copy and a retry | Raw error text; no way to recover |
| Error (action) | Inline next to what failed, or field errors from 422 | Toast that disappears before it is read |
| Success | Spec copy echoing the action (toast or inline), focus stays sensible | Silent success; redirect without feedback |
| Disabled | Visually distinct, explains why (helper text or `aria-describedby`) | Disabled with no reason |
| Long content | Truncate with ellipsis plus full text available (title, detail page) | Overflowing layouts, broken grids |
| Not found / no access | `notFound()` page, or a "you don't have access" state for 403 | Leaking that a resource exists |
| Unauthenticated | Redirect to sign in with `next` param back to the page | Showing an error page |

Optimistic updates (TanStack Query `onMutate`) only where the spec asks for instant feedback, and always roll back with an error message on failure.

## Part 2: Accessibility patterns

### Basics
* One `h1` per page; headings do not skip levels.
* Landmarks: `header`, `nav`, `main`, `footer`. One `main`.
* Interactive elements are native: `button`, `a href`, `input`, `select`. If you must build a custom widget, follow the WAI-ARIA Authoring Practices pattern for it exactly.
* Every input has a `<label htmlFor>`. Placeholder is not a label.
* Icon-only buttons: `aria-label="Delete order"` or visually hidden text.
* Images: meaningful `alt`; decorative images `alt=""`.

### Focus
* Never remove focus outlines. Use the design system's focus style: `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring`.
* After route changes, Next moves focus appropriately; after in-page changes (closing a dialog, deleting a row), move focus somewhere sensible (the trigger, the next row, the list heading).
* Sticky headers must not cover the focused element (`scroll-margin-top` on targets).

### Dialogs
* Use the native `<dialog>` element with `showModal()`, or a well-tested accessible primitive the project already uses (for example Radix). Requirements: focus moves in on open, is trapped while open, Escape closes, focus returns to the trigger on close, background is inert, the dialog has an accessible name (`aria-labelledby` its title).
* Destructive confirms put initial focus on the safe option.

### Forms
* Show errors next to fields, link them with `aria-describedby`, set `aria-invalid`.
* On failed submit, focus the first invalid field or an error summary at the top that links to each field.
* Mark required fields in the label text ("Email (required)") or explain the asterisk once.
* Use the right input types and `autocomplete` values (`email`, `current-password`, `new-password`, `tel`, `one-time-code`) so browsers and password managers help.

### Live regions
* Toasts and status messages render inside a persistent container with `role="status"` (polite) or `role="alert"` (urgent errors only). The container must exist before the message is inserted, or screen readers will not announce it.

### Tables and lists
* Tabular data uses `<table>` with `<th scope="col">`. A clickable row needs a real link or button inside it for keyboard users.
* Lists use `<ul>`/`<ol>`.

### Motion and color
* Wrap non-essential animation with `motion-safe:` utilities, or rely on the global reduced-motion rule in `globals.css`.
* Status always has text or an icon, never color alone.

### Quick self-check before handoff
1. Tab through the whole screen: every control reachable, visible focus, logical order, nothing trapped by accident.
2. Use the screen at 200% zoom and at 320px width: no lost content, no horizontal scroll.
3. Run axe in the browser or in a component test (`vitest-axe` or `jest-axe` style matcher) and fix violations.
4. Turn on reduced motion and dark mode if supported; recheck.
