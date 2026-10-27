# Next.js patterns

Reference implementations for the team's conventions. Adapt names and paths to the project; keep the shapes. Examples assume Next.js 16 with React 19 (async `params`, `searchParams`, `cookies()`; `proxy.ts` instead of `middleware.ts`), generated types in `src/lib/api/schema.d.ts` from `openapi-typescript`, and the default wiring from the architecture: the browser talks only to the Next.js origin, `next.config` rewrites proxy `/api/*` to the backend, and server code calls `API_INTERNAL_URL` directly, forwarding the `botss_session` cookie. If the installed major differs, read its upgrade guide before copying these.

Helpers that are imported but not defined here (`OrderList`, `EmptyState`, `getOrder`, `updateProfileAction`, `searchProducts`) are project code you write, following the same patterns. Each one's expected signature is noted where it is used.

## Contents
1. Typed API client with error envelope
2. List page with cursor pagination (Server Component)
3. Loading, error, and not-found files
4. Server Action with Zod, auth, and revalidation
5. Form with React Hook Form, Zod, and server error mapping
6. Client component with TanStack Query
7. Formatting dates and money without hydration bugs
8. Sign-in, sign-out, and the session

## 1. Typed API client with error envelope

```ts
// src/lib/api/client.ts
import 'server-only';
import { cookies } from 'next/headers';
import type { components } from './schema'; // generated: pnpm gen:api

export type Schemas = components['schemas'];

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string[]> = {},
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const API_URL = process.env.API_INTERNAL_URL; // server-only env var, not NEXT_PUBLIC_
const SESSION_COOKIE = 'botss_session'; // per architecture.md

type FetchOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
};

export async function apiFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  if (!API_URL) throw new Error('API_INTERNAL_URL is not set');
  const url = new URL(path, API_URL);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: `${SESSION_COOKIE}=${session}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: opts.cache ?? 'no-store', // user data: never cache by default
  });

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown_error',
      err?.message ?? 'Something went wrong. Try again.',
      err?.details?.fields ?? {},
      err?.request_id,
    );
  }
  return data as T;
}

// Thin, typed wrappers per resource keep components free of URLs.
// src/lib/api/orders.ts
export type OrderListResponse = Schemas['OrderListResponse'];
export const listOrders = (q: { cursor?: string; limit?: number }) =>
  apiFetch<OrderListResponse>('/api/orders', { query: q });
export const cancelOrder = (id: string) =>
  apiFetch<Schemas['OrderRead']>(`/api/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
```

Notes:
* Generate types with a script in `package.json` (`"gen:api": "openapi-typescript ../.botss/docs/contracts/openapi.yaml -o src/lib/api/schema.d.ts"`). Never edit `schema.d.ts` by hand.
* For client-side calls (TanStack Query), use a sibling `browser-client.ts` without `server-only` that calls relative same-origin paths (`/api/products?q=...`). The `next.config` rewrite in section 8 forwards them to the backend, and the browser sends the `botss_session` cookie automatically because the request is same-origin. No CORS is involved.

## 2. List page with cursor pagination (Server Component)

```tsx
// src/app/orders/page.tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listOrders } from '@/lib/api/orders';
import { ApiError } from '@/lib/api/client';
import { OrderList } from '@/components/orders/order-list';
import { EmptyState } from '@/components/ui/empty-state';

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;

  let data;
  try {
    data = await listOrders({ cursor, limit: 20 });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/sign-in?next=/orders');
    if (e instanceof ApiError && e.code === 'invalid_cursor') redirect('/orders');
    throw e; // error.tsx renders the retry state
  }

  if (data.items.length === 0 && !cursor) {
    return (
      <EmptyState
        title="No orders yet."
        action={<Link href="/menu" className="btn-primary">Browse the menu</Link>}
      />
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="font-display text-3xl text-text">Your orders</h1>
      <OrderList orders={data.items} />
      {data.next_cursor && (
        <Link
          href={`/orders?cursor=${encodeURIComponent(data.next_cursor)}`}
          className="mt-6 inline-flex text-primary underline-offset-4 hover:underline"
        >
          Load more orders
        </Link>
      )}
    </main>
  );
}
```

Copy strings come from the screen spec. Class names use theme tokens only.

## 3. Loading, error, and not-found files

```tsx
// src/app/orders/loading.tsx
export default function Loading() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8" aria-busy="true" aria-label="Loading orders">
      <div className="h-9 w-48 animate-pulse rounded-md bg-border" />
      <ul className="mt-6 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="h-16 animate-pulse rounded-md bg-surface" />
        ))}
      </ul>
    </main>
  );
}
```

```tsx
// src/app/orders/error.tsx
'use client';

export default function OrdersError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8" role="alert">
      <p className="text-text">We couldn't load your orders. Check your connection and try again.</p>
      <button type="button" onClick={reset} className="mt-4 rounded-md bg-primary px-4 py-2 text-primary-foreground">
        Try again
      </button>
    </main>
  );
}
```

```tsx
// src/app/orders/[id]/page.tsx (excerpt)
import { notFound } from 'next/navigation';
// ...
const { id } = await params;
try {
  order = await getOrder(id); // you write this in orders.ts: getOrder(id: string) => apiFetch<Schemas['OrderRead']>(`/api/orders/${id}`)
} catch (e) {
  if (e instanceof ApiError && e.status === 404) notFound(); // renders not-found.tsx
  throw e;
}
```

Never show `error.message` from unknown errors in production UI; use the spec's copy.

## 4. Server Action with Zod, auth, and revalidation

```ts
// src/app/orders/actions.ts
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { cancelOrder } from '@/lib/api/orders';
import { ApiError } from '@/lib/api/client';
import { getSession } from '@/lib/auth'; // defined in section 8

const CancelInput = z.object({ orderId: z.string().uuid() });

export type ActionResult =
  | { ok: true }
  | { ok: false; code: string; message: string; fields?: Record<string, string[]> };

export async function cancelOrderAction(input: unknown): Promise<ActionResult> {
  // 1. This is a public POST endpoint: validate everything.
  const parsed = CancelInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'validation_error', message: 'Invalid request.' };
  }
  // 2. Require a session. The backend still enforces ownership.
  const session = await getSession();
  if (!session) return { ok: false, code: 'unauthenticated', message: 'Sign in to continue.' };

  try {
    await cancelOrder(parsed.data.orderId);
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message, fields: e.fields };
    throw e;
  }
  // 3. Refresh what changed.
  revalidatePath('/orders');
  return { ok: true };
}
```

Return results instead of throwing for expected failures so the client can render them. Only send the fields the action needs to the API, never the raw form data.

## 5. Form with React Hook Form, Zod, and server error mapping

```tsx
// src/components/profile/profile-form.tsx
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTransition } from 'react';
// You write this, shaped like cancelOrderAction in section 4:
//   updateProfileAction(values: ProfileValues): Promise<ActionResult>
import { updateProfileAction } from '@/app/profile/actions';

// Mirrors the contract constraints; the backend remains the authority.
const ProfileSchema = z.object({
  display_name: z.string().trim().min(1, 'Enter a display name.').max(60, 'Use 60 characters or fewer.'),
  phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/, 'Enter a phone number with country code.').optional().or(z.literal('')),
});
type ProfileValues = z.infer<typeof ProfileSchema>;

export function ProfileForm({ initial }: { initial: ProfileValues }) {
  const [pending, startTransition] = useTransition();
  const form = useForm<ProfileValues>({ resolver: zodResolver(ProfileSchema), defaultValues: initial });
  const { register, handleSubmit, setError, formState: { errors } } = form;

  const onSubmit = (values: ProfileValues) =>
    startTransition(async () => {
      const res = await updateProfileAction(values);
      if (res.ok) return; // success toast handled by caller or a toast hook
      // Map API 422 details.fields onto inputs; anything else goes to the form-level error.
      for (const [field, messages] of Object.entries(res.fields ?? {})) {
        if (field in ProfileSchema.shape) {
          setError(field as keyof ProfileValues, { message: messages[0] });
        }
      }
      if (!res.fields || Object.keys(res.fields).length === 0) {
        setError('root', { message: res.message });
      }
    });

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      <div>
        <label htmlFor="display_name" className="block text-sm text-text">Display name</label>
        <input
          id="display_name"
          {...register('display_name')}
          aria-invalid={!!errors.display_name}
          aria-describedby={errors.display_name ? 'display_name-error' : undefined}
          className="mt-1 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-text"
        />
        {errors.display_name && (
          <p id="display_name-error" className="mt-1 text-sm text-danger-foreground">
            {errors.display_name.message}
          </p>
        )}
      </div>

      {errors.root && <p role="alert" className="text-sm text-danger-foreground">{errors.root.message}</p>}

      <button type="submit" disabled={pending} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-60">
        {pending ? 'Saving' : 'Save changes'}
      </button>
    </form>
  );
}
```

On submit with errors, move focus to the first invalid field (React Hook Form does this by default with `shouldFocusError`).

## 6. Client component with TanStack Query

Use only for interactive client data, for example a live search box.

```tsx
// src/components/menu/menu-search.tsx
'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
// You write this in browser-client.ts:
//   searchProducts(q: { q: string; limit: number }, init?: { signal?: AbortSignal }): Promise<Schemas['ProductListResponse']>
// It calls fetch('/api/products?...') (same origin) and throws ApiError on non-2xx, like apiFetch.
import { searchProducts } from '@/lib/api/browser-client';

export function MenuSearch() {
  const [q, setQ] = useState('');
  const deferred = useDeferredValue(q.trim());

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['products', 'search', deferred],
    queryFn: ({ signal }) => searchProducts({ q: deferred, limit: 20 }, { signal }),
    enabled: deferred.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  return (
    <div>
      <label htmlFor="menu-search" className="block text-sm text-text">Search the menu</label>
      <input id="menu-search" type="search" value={q} onChange={(e) => setQ(e.target.value)}
        className="mt-1 w-full rounded-sm border border-border-strong bg-surface px-3 py-2" />
      <div aria-live="polite" className="mt-4">
        {deferred.length >= 2 && isPending && <p className="text-text-muted">Searching</p>}
        {isError && (
          <p className="text-danger-foreground">
            Search isn't working right now. <button type="button" onClick={() => refetch()} className="underline">Try again</button>
          </p>
        )}
        {data && data.items.length === 0 && <p className="text-text-muted">No dishes match "{deferred}".</p>}
        {data && data.items.length > 0 && (
          <ul>{data.items.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
        )}
      </div>
    </div>
  );
}
```

The `QueryClientProvider` lives in one client provider component in the root layout, created with `useState(() => new QueryClient())` so it is never shared between requests on the server.

## 7. Formatting dates and money without hydration bugs
8. Sign-in, sign-out, and the session

```ts
// src/lib/format.ts
export function formatMoney(m: { amount: number; currency: string }, locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(m.amount / 100);
}
export function formatDateTime(iso: string, timeZone: string, locale = 'en-US') {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone,
  }).format(new Date(iso));
}
```

Pass an explicit `timeZone` and `locale` (from the user profile or a cookie) so server and client render the same string. Never call `new Date()` for "now" during render; get it on the server and pass it down if the UI needs it.

## 8. Sign-in, sign-out, and the session

The backend owns sessions: `POST /api/auth/login` validates credentials and responds with `Set-Cookie: botss_session=...; HttpOnly; Secure; SameSite=Lax; Path=/` (no `Domain`, so the cookie belongs to whichever origin received it). The frontend's only job is to make sure that response reaches the browser on the Next.js origin.

**Step 1: proxy `/api/*` to the backend** so the browser only ever talks to one origin:

```ts
// frontend/next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_INTERNAL_URL}/api/:path*` }];
  },
};
export default nextConfig;
```

**Step 2 (recommended, simplest): sign in from the browser through the proxy.** The backend's `Set-Cookie` passes through the rewrite to the browser unchanged, so there is nothing to copy:

```tsx
// src/app/sign-in/sign-in-form.tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

export function SignInForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(form: FormData) {
    startTransition(async () => {
      setError(null);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? 'Sign-in failed. Try again.');
        return;
      }
      // Only redirect to relative paths we expect (open redirect protection).
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/orders');
      router.refresh(); // Server Components re-render with the new cookie
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <label htmlFor="email" className="block text-sm text-text">Email</label>
      <input id="email" name="email" type="email" autoComplete="email" required className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2" />
      <label htmlFor="password" className="block text-sm text-text">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2" />
      {error && <p role="alert" className="text-sm text-danger-foreground">{error}</p>}
      <button type="submit" disabled={pending} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">
        {pending ? 'Signing in' : 'Sign in'}
      </button>
    </form>
  );
}
```

**Alternative: sign in with a Server Action.** A Server Action calls the backend from the Next server, so the backend's `Set-Cookie` lands on the server's `fetch` response, not in the browser. You must copy it across, or the user is never signed in:

```ts
// src/app/sign-in/actions.ts
'use server';

import { cookies } from 'next/headers';
import { z } from 'zod';

const Credentials = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function signInAction(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = Credentials.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Enter your email and password.' };

  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed.data),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: false, message: body?.error?.message ?? 'Sign-in failed. Try again.' };
  }

  // Copy each backend cookie onto the response to the browser, keeping its flags.
  const jar = await cookies();
  for (const header of res.headers.getSetCookie()) {
    const [pair, ...attrs] = header.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const opts: {
      path?: string; httpOnly?: boolean; secure?: boolean;
      sameSite?: 'lax' | 'strict' | 'none'; maxAge?: number; expires?: Date;
    } = { path: '/' };
    for (const attr of attrs) {
      const [k, v] = attr.split('=');
      const key = k.toLowerCase();
      if (key === 'httponly') opts.httpOnly = true;
      else if (key === 'secure') opts.secure = true;
      else if (key === 'samesite') opts.sameSite = v.toLowerCase() as 'lax' | 'strict' | 'none';
      else if (key === 'path') opts.path = v;
      else if (key === 'max-age') opts.maxAge = Number(v);
      else if (key === 'expires') opts.expires = new Date(v);
    }
    jar.set(name, value, opts);
  }
  return { ok: true };
}
```

**Sign-out** calls the backend so the server-side session is destroyed, then removes the cookie:

```ts
// src/app/(account)/actions.ts
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api/client';

export async function signOutAction() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' }); // forwards botss_session
  } finally {
    (await cookies()).delete('botss_session');
  }
  redirect('/sign-in');
}
```

**Reading the session on the server.** `getSession` is a thin, cached call to the backend's "who am I" endpoint (use the path and schema name the contract defines):

```ts
// src/lib/auth.ts
import 'server-only';
import { cache } from 'react';
import { apiFetch, ApiError, type Schemas } from '@/lib/api/client';

export type Session = Schemas['SessionRead']; // for example { user: { id, email, role } }

// Cached per request, so several components can call it without extra round trips.
export const getSession = cache(async (): Promise<Session | null> => {
  try {
    return await apiFetch<Session>('/api/auth/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
});
```

**Optional redirect for signed-out users** in `src/proxy.ts` (Next 16; `middleware.ts` in earlier majors). It only checks that the cookie exists, for convenience. It is not authorization: the backend checks every request.

```ts
// src/proxy.ts
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(req: NextRequest) {
  if (!req.cookies.has('botss_session')) {
    const url = new URL('/sign-in', req.url);
    url.searchParams.set('next', req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/orders/:path*', '/account/:path*'] };
```

Notes:
* The backend's CSRF origin check must accept the Next.js origin for browser requests arriving through the rewrite, and the server-to-server calls from Server Components and Server Actions. Agree the exact rule with the tech lead; do not weaken it on your own.
* Never read, decode, or store the session value in client code; it is `httpOnly` for a reason.
