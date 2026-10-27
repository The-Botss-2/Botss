# Design system reference

## Contents
1. design-tokens.json format
2. Tailwind v4 theme snippet
3. Scales
4. Component state matrix
5. DESIGN.md outline

## 1. design-tokens.json format

One file, three layers. Values are hex or CSS values; references use `{path}`.

```json
{
  "$schema": "botss-design-tokens/v1",
  "brand": {
    "clay":  {"50": "#FBF3EF", "100": "#F4DFD5", "600": "#9C4A2F", "700": "#7E3B25"},
    "ink":   {"50": "#F6F6F4", "200": "#DEDDD8", "500": "#85837B", "600": "#6B6961", "800": "#2E2D29", "950": "#161613"},
    "moss":  {"100": "#E3EEDD", "700": "#3F6B2F"},
    "brick": {"100": "#F8E1DD", "700": "#A3271B"}
  },
  "semantic": {
    "light": {
      "bg": "{brand.ink.50}",
      "surface": "#FFFFFF",
      "text": "{brand.ink.950}",
      "text-muted": "{brand.ink.600}",
      "border": "{brand.ink.200}",
      "border-strong": "{brand.ink.500}",
      "primary": "{brand.clay.600}",
      "primary-foreground": "#FFFFFF",
      "success-subtle": "{brand.moss.100}",
      "success-foreground": "{brand.moss.700}",
      "danger-subtle": "{brand.brick.100}",
      "danger-foreground": "{brand.brick.700}",
      "focus-ring": "{brand.clay.700}"
    },
    "dark": {
      "bg": "{brand.ink.950}",
      "surface": "{brand.ink.800}",
      "text": "{brand.ink.50}",
      "text-muted": "#A9A79F",
      "border": "#3B3A35",
      "border-strong": "#807E76",
      "primary": "#E08A66",
      "primary-foreground": "{brand.ink.950}",
      "success-subtle": "#24341E",
      "success-foreground": "#A9D494",
      "danger-subtle": "#3A1C17",
      "danger-foreground": "#F2A397",
      "focus-ring": "#F0B49B"
    }
  },
  "component": {
    "button": {"radius": "{radius.md}", "height": "2.75rem"},
    "input": {"radius": "{radius.sm}", "height": "2.75rem"}
  },
  "font": {
    "display": {"family": "Fraunces", "fallback": "Georgia, serif", "css_var": "--font-fraunces"},
    "body": {"family": "Source Sans 3", "fallback": "system-ui, sans-serif", "css_var": "--font-source-sans"},
    "mono": {"family": "JetBrains Mono", "fallback": "ui-monospace, monospace", "css_var": "--font-jetbrains-mono"}
  },
  "type": {
    "display": {"size": "clamp(2rem, 1.4rem + 2.4vw, 3.25rem)", "line": "1.1", "weight": 600},
    "h1": {"size": "clamp(1.75rem, 1.4rem + 1.4vw, 2.25rem)", "line": "1.2", "weight": 600},
    "h2": {"size": "1.375rem", "line": "1.3", "weight": 600},
    "body": {"size": "1rem", "line": "1.6", "weight": 400},
    "small": {"size": "0.875rem", "line": "1.5", "weight": 400}
  },
  "space": {"1": "0.25rem", "2": "0.5rem", "3": "0.75rem", "4": "1rem", "6": "1.5rem", "8": "2rem", "12": "3rem", "16": "4rem"},
  "radius": {"sm": "0.25rem", "md": "0.5rem", "lg": "1rem", "full": "9999px"},
  "shadow": {
    "sm": "0 1px 2px rgb(22 22 19 / 0.06)",
    "md": "0 4px 12px rgb(22 22 19 / 0.08)"
  },
  "motion": {
    "fast": "120ms", "base": "200ms", "slow": "320ms",
    "ease": "cubic-bezier(0.2, 0, 0, 1)"
  },
  "layout": {"measure": "68ch", "container": "72rem"},
  "contrast": {
    "light/text-on-bg": 16.76, "light/text-on-surface": 18.13,
    "light/text-muted-on-bg": 5.08, "light/text-muted-on-surface": 5.50,
    "light/primary-foreground-on-primary": 6.12,
    "light/success-foreground-on-success-subtle": 5.23,
    "light/danger-foreground-on-danger-subtle": 5.87, "light/danger-foreground-on-surface": 7.33,
    "light/border-strong-on-surface": 3.80, "light/border-strong-on-bg": 3.51,
    "light/focus-ring-on-bg": 7.64,
    "dark/text-on-bg": 16.76, "dark/text-on-surface": 12.74,
    "dark/text-muted-on-bg": 7.52, "dark/text-muted-on-surface": 5.72,
    "dark/primary-foreground-on-primary": 6.90,
    "dark/success-foreground-on-success-subtle": 7.91,
    "dark/danger-foreground-on-danger-subtle": 7.70, "dark/danger-foreground-on-surface": 6.87,
    "dark/border-strong-on-surface": 3.39, "dark/border-strong-on-bg": 4.46,
    "dark/focus-ring-on-surface": 7.68
  }
}
```

Record measured contrast ratios under `contrast` so reviewers can see you checked them. The ratios above are measured for this example palette (WCAG relative luminance); compute real ones for your palette with a script, not by eye. Text pairs need 4.5:1 (3:1 for large text), and component boundaries such as input borders and the focus ring need 3:1 against what is next to them. `border` (about 1.4:1) is for decorative dividers only; inputs, checkboxes, and other controls whose edge identifies them use `border-strong`.

## 2. Tailwind v4 theme snippet

Tailwind v4 is configured in CSS, not in `tailwind.config.js`. Generate this from the JSON and put it in DESIGN.md; the scaffold copies it into `frontend/src/app/globals.css`.

```css
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

/* Font families come from next/font CSS variables set on <html> (see below).
   `inline` makes the utilities reference the variables at use time. */
@theme inline {
  --font-display: var(--font-fraunces), Georgia, serif;
  --font-body: var(--font-source-sans), system-ui, sans-serif;
  --font-mono: var(--font-jetbrains-mono), ui-monospace, monospace;
}

@theme {

  --color-bg: #F6F6F4;
  --color-surface: #FFFFFF;
  --color-text: #161613;
  --color-text-muted: #6B6961;
  --color-border: #DEDDD8;
  --color-border-strong: #85837B;
  --color-primary: #9C4A2F;
  --color-primary-foreground: #FFFFFF;
  --color-success-subtle: #E3EEDD;
  --color-success-foreground: #3F6B2F;
  --color-danger-subtle: #F8E1DD;
  --color-danger-foreground: #A3271B;
  --color-focus-ring: #7E3B25;

  --container-measure: 68ch; /* max-w-measure for body text */

  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 1rem;

  --shadow-sm: 0 1px 2px rgb(22 22 19 / 0.06);
  --shadow-md: 0 4px 12px rgb(22 22 19 / 0.08);

  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
}

.dark {
  --color-bg: #161613;
  --color-surface: #2E2D29;
  --color-text: #F6F6F4;
  --color-text-muted: #A9A79F;
  --color-border: #3B3A35;
  --color-border-strong: #807E76;
  --color-primary: #E08A66;
  --color-primary-foreground: #161613;
  --color-success-subtle: #24341E;
  --color-success-foreground: #A9D494;
  --color-danger-subtle: #3A1C17;
  --color-danger-foreground: #F2A397;
  --color-focus-ring: #F0B49B;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

This yields utilities like `bg-surface`, `text-text-muted`, `border-border-strong`, `bg-primary text-primary-foreground`, `rounded-md`, `shadow-sm`, `font-display`, `max-w-measure`. Engineers use only these, never raw hex or arbitrary values like `bg-[#9C4A2F]` or `max-w-[68ch]`. If a needed value is missing, add a token here rather than allowing a one-off.

Fonts are loaded in the app with `next/font`, which serves them under generated family names. A literal `"Fraunces"` in CSS would never match and would silently fall back to Georgia, so load each font with a `variable` and put the variables on `<html>`; the `@theme inline` block above then points the utilities at them:

```tsx
// frontend/src/app/layout.tsx (excerpt)
import { Fraunces, Source_Sans_3 } from 'next/font/google';

const display = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });
const body = Source_Sans_3({ subsets: ['latin'], variable: '--font-source-sans', display: 'swap' });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="bg-bg font-body text-text">{children}</body>
    </html>
  );
}
```

In preview HTML mockups, a Google Fonts link plus a plain `font-family: "Fraunces"` is fine, since there is no next/font renaming there.

## 3. Scales

* **Spacing:** 4px base. Use the steps in the JSON; avoid one-off values. Larger gaps between groups than within groups (proximity shows grouping).
* **Type:** at most 5 to 6 sizes in the whole app. Headings line height 1.1 to 1.3, body 1.5 to 1.7. Body text max width 60 to 75 characters (the `--container-measure` token, used as `max-w-measure`).
* **Radius:** 2 to 4 steps. Mixing many radii looks accidental.
* **Elevation:** 2 to 3 shadow steps. Prefer borders and background contrast for structure; save shadows for things that float (menus, dialogs, toasts).
* **Motion:** short (120 to 320 ms), purposeful (shows where something came from or went), and removed under reduced motion. No motion purely for decoration on page load.
* **Breakpoints:** Tailwind defaults (`sm 640`, `md 768`, `lg 1024`, `xl 1280`). Design at 375px first, then 768 and 1280.

## 4. Component state matrix

Every interactive component in the inventory needs every applicable state defined in DESIGN.md:

| Component | Default | Hover | Focus-visible | Active | Disabled | Loading | Error | Selected or checked |
|---|---|---|---|---|---|---|---|---|
| Button (primary, secondary, ghost, danger) | yes | yes | yes | yes | yes | yes (label kept, spinner inside, width stable) | n/a | n/a |
| Text input, textarea | yes | yes | yes | n/a | yes | n/a | yes (message below, icon, border) | n/a |
| Select, combobox | yes | yes | yes | open | yes | yes (options loading) | yes | yes |
| Checkbox, radio, switch | yes | yes | yes | yes | yes | n/a | yes | yes |
| Link | yes | yes | yes | yes | n/a | n/a | n/a | visited if useful |
| Card (clickable) | yes | yes | yes | yes | n/a | skeleton | n/a | yes |
| Table row | yes | yes | yes (row or cell) | n/a | n/a | skeleton rows | inline error row | yes |
| Tabs | yes | yes | yes | yes | yes | n/a | n/a | yes |
| Dialog | open, closing | n/a | focus trapped | n/a | n/a | yes (content) | yes | n/a |
| Toast | success, error, info | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

Screen-level states (each screen spec must cover): loading, empty (first use), empty (no results for a filter), error (load failed, with retry), partial (some data failed), success feedback after an action, and offline or slow network if the PRD cares.

Focus-visible style is defined once: a 2px `focus-ring` outline with 2px offset, visible on every background in both modes.

## 5. DESIGN.md outline

```markdown
# Design: {Product}
## Visual theme            (one paragraph: mood, the one bold move, why it fits)
## Color roles             (semantic tokens, light and dark, with contrast ratios)
## Typography              (families, roles, scale, line lengths)
## Spacing and layout      (scale, grid, container widths, breakpoints)
## Elevation and radius
## Motion                  (durations, easing, reduced motion)
## Components              (inventory; each with states, variants, usage rules)
## Do and don't            (5 to 10 concrete pairs)
## Responsive rules
## Tailwind v4 theme       (the @theme snippet)
## Building with this system (rules for engineers: tokens only, where icons come from, image treatment)
```
