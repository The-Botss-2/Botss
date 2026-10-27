# Testing the frontend

## Contents
1. What to test where
2. Vitest and Testing Library setup
3. Component test patterns
4. Mocking HTTP with MSW
5. Server Components and Server Actions
6. What Playwright can and cannot mock (for QA handoff)

## 1. What to test where

| Layer | Tool | Owner | Examples |
|---|---|---|---|
| Pure logic | Vitest | Frontend | formatters, Zod schemas, mappers, URL builders |
| Components with states or logic | Vitest + Testing Library + user-event | Frontend | form validation and server error mapping, list empty and error states, disabled logic |
| Hooks | Vitest + `renderHook` | Frontend | custom hooks with non-trivial logic |
| Full pages and journeys across frontend and backend | Playwright | QA | sign in, create order, cancel order |

Do not test Next.js itself, Tailwind classes, or static markup without logic.

## 2. Vitest and Testing Library setup

Usually created by the scaffold task (T000). If you need to check it:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
```

```ts
// vitest.setup.ts
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from './src/test/msw-server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); cleanup(); });
afterAll(() => server.close());
```

`onUnhandledRequest: 'error'` makes a test fail loudly if code calls an endpoint you did not expect.

## 3. Component test patterns

Query the way users find things: `getByRole`, `getByLabelText`, `getByText`. Use `data-testid` only when nothing semantic exists.

```tsx
// src/components/profile/profile-form.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect } from 'vitest';
import { ProfileForm } from './profile-form';

vi.mock('@/app/profile/actions', () => ({ updateProfileAction: vi.fn() }));
import { updateProfileAction } from '@/app/profile/actions';

describe('ProfileForm', () => {
  it('shows a field error when the display name is empty', async () => {
    render(<ProfileForm initial={{ display_name: 'Sara', phone: '' }} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Display name'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a display name.')).toBeInTheDocument();
    expect(updateProfileAction).not.toHaveBeenCalled();
  });

  it('maps API field errors onto the matching input', async () => {
    vi.mocked(updateProfileAction).mockResolvedValue({
      ok: false, code: 'validation_error', message: 'Check the highlighted fields.',
      fields: { display_name: ['That name is taken.'] },
    });
    render(<ProfileForm initial={{ display_name: 'Sara', phone: '' }} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }));
    const input = screen.getByLabelText('Display name');
    expect(await screen.findByText('That name is taken.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});
```

Mocking the Server Action module is fine here: it is the boundary between the component and the server. Do not mock child components or hooks the component owns.

Patterns:
* One behavior per test, named after what the user experiences.
* Test every state the spec lists: render with empty data, with an error, with long text.
* Use `findBy...` for things that appear asynchronously; avoid `waitFor` with arbitrary timeouts.
* Accessibility smoke test: render the component and assert no axe violations with a `vitest-axe` matcher, if the project has it.

## 4. Mocking HTTP with MSW

For client components that call the API from the browser (TanStack Query), mock the network, not the fetch function:

```ts
// src/test/msw-server.ts
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('*/api/products/search', ({ request }) => {
    const q = new URL(request.url).searchParams.get('q');
    return HttpResponse.json({ items: q === 'none' ? [] : [{ id: 'p1', name: 'Lamb karahi' }], next_cursor: null });
  }),
];
export const server = setupServer(...handlers);
```

Per-test overrides for error states:

```ts
server.use(
  http.get('*/api/products/search', () =>
    HttpResponse.json({ error: { code: 'server_error', message: 'Try again.', request_id: 'r1' } }, { status: 500 }),
  ),
);
```

Mock responses must match the contract's schemas exactly (snake_case, envelope shape). Build them with small factory functions typed with the generated `Schemas` types, so a contract change breaks the test at compile time instead of silently passing.

Wrap components that use TanStack Query in a fresh `QueryClient` per test with `retry: false`.

## 5. Server Components and Server Actions

* **Async Server Components** cannot be rendered by Testing Library reliably. Keep them thin: fetch, handle 401 and 404, pass data to a presentational component. Unit test the presentational component and any mapping functions; leave the full page to QA's Playwright tests.
* **Server Actions** are plain async functions. Test their logic by calling them directly with the API client module mocked: invalid input returns `validation_error`, no session returns `unauthenticated`, an `ApiError` is mapped to a result, success calls `revalidatePath` (mock `next/cache`).

## 6. What Playwright can and cannot mock

Write this in your handoff when it affects QA:
* `page.route()` intercepts only requests **the browser** makes. It **cannot** intercept fetches made by Server Components or Server Actions, because those run in the Next.js server process and call FastAPI directly.
* So end-to-end tests run against a real backend with a seeded test database (the usual approach), or a stub API server the Next server is configured to call. Client-side requests can still be mocked with `page.route()` to test error UI.
* Run E2E against `next build && next start`, not `next dev`.
