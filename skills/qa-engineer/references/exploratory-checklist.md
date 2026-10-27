# Exploratory testing checklist

Pick the items that apply to the feature in front of you. You do not need every row every time. Note each one you tried in the QA report, with its result.

## Contents
1. Input values
2. Actions and timing
3. Navigation and state
4. Sessions and permissions
5. Environment
6. What to watch while exploring

## 1. Input values

| Try | Watch for |
|---|---|
| Empty field, only spaces | Saved as blank? Clear message naming the field? |
| Minimum and maximum lengths, and one past each | Off-by-one; server and client limits agree |
| Very long text (5,000 characters, one unbroken word) | Layout overflow, truncation without tooltip, 500 errors |
| Unicode: emoji, accents, CJK, combined characters | Stored and shown correctly; length counted sensibly |
| Right-to-left text (Arabic, Urdu, Hebrew) mixed with English | Text direction, alignment, punctuation placement |
| Special characters: `' " < > & ; -- / \ %` | Escaped in display; no broken queries or HTML |
| Leading and trailing spaces, different letter case in emails | Duplicate accounts (`Ali@x.com` vs `ali@x.com`)? |
| Numbers: 0, negative, decimals, huge, non-numeric | Rounding, overflow, money precision |
| Dates: past, far future, Feb 29, end of month, midnight, other time zones | Off-by-one day, wrong time zone shown |
| Files: zero bytes, over the limit, wrong type with right extension, very long filename | Clear rejection; no crash; size limit enforced on server |
| Pasted content with formatting or newlines | Unexpected HTML, broken single-line fields |

## 2. Actions and timing

| Try | Watch for |
|---|---|
| Double or triple click a submit button | Duplicate records, double charges |
| Submit, then immediately navigate away | Half-saved state, lost data without warning |
| Rapid repeated actions (toggle a like 10 times fast) | Final state wrong, race conditions |
| Slow network (DevTools throttling, "Slow 3G") | Missing loading states, buttons usable mid-request, timeouts with no message |
| Request fails mid-flow (backend stopped) | Honest error, retry possible, no fake success |
| Long idle on a page, then act | Expired session handled gracefully |

## 3. Navigation and state

| Try | Watch for |
|---|---|
| Browser back after submitting | Resubmission, stale data, broken page |
| Refresh in the middle of a multi-step flow | Lost progress without warning, broken step |
| Open the same item in two tabs, edit both | Last write silently wins? Conflict message? |
| Deep link straight to an inner page | Works, or redirects to sign-in and back |
| Bookmark a filtered or sorted list and reopen | Filters kept in the URL |
| Delete something other pages still show | Dangling references, 500s |
| Empty states (new user, no data) | Helpful empty state with a next action, not a blank area |

## 4. Sessions and permissions

| Try | Watch for |
|---|---|
| Use the feature signed out | Redirect to sign in, no data leaked |
| Sign out in one tab, act in another | Rejected cleanly |
| Change an ID in the URL or request to another user's resource | 404 (or 403), never the other user's data |
| Call the API directly for an action the UI hides from this role | Server enforces the rule, not just the UI |
| Lower-privilege role sees admin pages or buttons | Hidden and enforced |

## 5. Environment

| Try | Watch for |
|---|---|
| Mobile viewport (375 px wide) and tablet | Overflow, tiny tap targets, hidden actions |
| Zoom to 200% | Content still usable, no clipping |
| Keyboard only (Tab, Shift+Tab, Enter, Escape) | Every action reachable; visible focus; dialogs trap and return focus |
| Dark mode, if supported | Unreadable text, invisible borders |
| Reduced motion setting | Animations respect it |

## 6. What to watch while exploring

* **Browser console:** errors, hydration warnings, unhandled promise rejections.
* **Network tab:** failed requests the UI does not mention; requests firing twice; huge payloads.
* **Backend logs:** exceptions behind a screen that looked fine.
* **Database:** the stored values match what the UI claims was saved.
* **Messages:** success messages that match the action ("Order cancelled", not "Success"), and errors that say what to do next.
