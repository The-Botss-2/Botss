# Screen spec template

Save as `.botss/docs/design/screens/<screen-slug>.md`, next to `<screen-slug>.html`. Use PRD glossary terms and API contract field names so the frontend agent can map them directly.

```markdown
# Screen: {Order list}
**Route:** /orders   |   **PRD:** FR-4, FR-6, UJ-2   |   **Mockup:** order-list.html

## Purpose
{Customer checks the status of recent orders and cancels one if needed.}
Done looks like: {they found the order and saw its status within a few seconds}.

## Hierarchy
1. {Order status and date (scanning for "where is my lunch")}
2. {Total and item count}
3. {Actions: open, cancel}

## Layout
- **Mobile (375):** {single column list; each row: status badge left, date and total stacked right; cancel lives inside the detail page, not on the row}
- **Tablet (768):** {two-line rows, cancel button appears on rows with status Pending}
- **Desktop (1280):** {table with columns: date, items, total, status, actions; container 72rem}

## Components
{PageHeader, OrderRow, StatusBadge, Button (ghost, danger), EmptyState, Skeleton, Toast}

## Data
| UI element | Field (API) | Format |
|---|---|---|
| Date | `created_at` | "Mon 27 Oct, 1:15 pm" in the user's time zone |
| Total | `total.amount`, `total.currency` | "$19.99" |
| Status | `status` (`pending`, `preparing`, `delivered`, `cancelled`) | Badge: Pending, Preparing, Delivered, Cancelled |

## States
| State | What the user sees |
|---|---|
| Loading | 5 skeleton rows matching row shape; header visible |
| Empty (first use) | Illustration-free message: "No orders yet." Button: "Browse the menu" |
| Error (load failed) | "We couldn't load your orders. Check your connection and try again." Button: "Try again" |
| Cancel in progress | Button shows spinner, label "Cancelling", row stays in place |
| Cancel success | Toast: "Order cancelled." Badge changes to Cancelled |
| Cancel failed (409) | Inline message on row: "This order is already being prepared and can't be cancelled." |
| Long content | 40-character item names truncate with ellipsis; full name in detail page |
| Many items | Cursor pagination: "Load more orders" button below list; hides when no next_cursor |

Interactive elements: hover, focus-visible, active, disabled per DESIGN.md matrix. Cancel is disabled (with reason in a tooltip and aria-describedby) when status is not Pending.

## Copy
| Key | Text |
|---|---|
| title | Your orders |
| cancel_button | Cancel order |
| cancel_confirm_title | Cancel this order? |
| cancel_confirm_body | You won't be charged. This can't be undone. |
| cancel_confirm_yes | Cancel order |
| cancel_confirm_no | Keep order |

## Accessibility
- Landmarks: header, main; list is a `<ul>` (mobile) or `<table>` with headers (desktop).
- Heading order: h1 "Your orders".
- Status badge includes text, not color only.
- After cancel, focus returns to the row; toast is announced via a polite live region.
- Confirm dialog traps focus; Escape closes; initial focus on "Keep order".
```

## Checklist before submitting a screen
- [ ] Every state above is specified, including empty, error, and long content.
- [ ] All copy is final and follows the writing rules.
- [ ] Data fields match the API contract names.
- [ ] Mobile, tablet, desktop layouts described.
- [ ] Only components from the inventory (or new ones added to it with states).
- [ ] The HTML mockup uses realistic domain content and the token CSS variables.
- [ ] Nothing in the screen is a feature the PRD does not have.
