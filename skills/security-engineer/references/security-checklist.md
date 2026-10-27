# Security review checklist

For each item: check the code, then test it on the local stack where you can. "How to test" gives a quick local check. Record what you tested in the report, including items that passed.

## Contents
1. Authentication
2. Authorization
3. Sessions and cookies
4. Input handling and injection
5. Output, XSS, and the client boundary
6. CSRF, CORS, and headers
7. Server-side requests (SSRF) and redirects
8. File uploads
9. Rate limiting and abuse
10. Secrets and configuration
11. Errors and logging
12. Dependencies and supply chain
13. Data protection

## 1. Authentication
| Check | How to test |
|---|---|
| Every non-public route requires auth (enumerate from routers and Server Actions, not the UI) | Call each route without a cookie; expect 401 |
| Passwords hashed with argon2 or bcrypt | Read the hashing code; inspect a stored hash prefix |
| Sign-in errors do not reveal whether the email exists | Compare responses for a real and a fake email |
| Password reset tokens are single-use, expire, and are not guessable | Reuse a token; wait past expiry; check token length and source |
| Sign-out and password change invalidate existing sessions | Keep an old cookie, change password, reuse it |
| Email verification (if required) cannot be skipped | Call protected actions with an unverified account |

## 2. Authorization
| Check | How to test |
|---|---|
| Object-level: every `{id}` read, update, delete is scoped to the owner or tenant | Two users; as A, request B's resource IDs; expect 404 |
| Function-level: admin and role-only actions enforced on the server | As a normal user, call admin endpoints directly |
| Mass assignment: bodies cannot set `role`, `owner_id`, `is_admin`, `price`, `status` unless allowed | Add those fields to requests; check stored values |
| List endpoints never return other users' or tenants' rows | Create data for two users; list as one |
| IDs are not enumerable for user-owned data (UUIDs) | Inspect URLs and responses |
| Middleware is not the only check (Next.js) | Read the data-layer code for each protected read and write |
| Server Actions check auth and validate input | Call the action endpoint directly with crafted arguments |

## 3. Sessions and cookies
| Check | How to test |
|---|---|
| Session cookie `httpOnly`, `Secure` (in production config), `SameSite=Lax` or `Strict` | Inspect `Set-Cookie` |
| No tokens or session data in `localStorage` or `sessionStorage` | Search the frontend code; inspect storage in the browser |
| Session lifetime and idle timeout fit the stakes | Read config |
| JWTs (if used): algorithm fixed, signature verified, expiry checked, `none` rejected | Send a token with `alg: none` or an expired token |

## 4. Input handling and injection
| Check | How to test |
|---|---|
| All input validated at the boundary with explicit types, lengths, ranges | Send oversize, wrong-type, and missing fields |
| No SQL built by string formatting; ORM or bound parameters only | Grep for f-strings or `%` inside `text()` and raw queries |
| No shell commands with user input; no `eval` or `exec` on input | Grep `subprocess`, `os.system`, `eval` |
| Deserialization of untrusted data uses safe formats (no `pickle`, unsafe YAML loads) | Grep |
| Search and filter params allow-listed (sort fields, filter fields) | Send `?sort=password_hash` |

## 5. Output, XSS, and the client boundary
| Check | How to test |
|---|---|
| No `dangerouslySetInnerHTML` with unsanitized content | Grep; store `<img src=x onerror=alert(1)>` and view it |
| User-controlled URLs in `href` reject `javascript:` | Save a `javascript:` link |
| No secrets in `NEXT_PUBLIC_` variables | Read `.env.example` and the env module |
| Secret-reading modules import `server-only` | Grep server modules |
| Client bundle contains no secrets or internal URLs | `next build`, then search `.next/static` for key names |
| API responses contain only fields the UI needs (no hashes, internal flags) | Inspect responses |

## 6. CSRF, CORS, and headers
| Check | How to test |
|---|---|
| Cookie-authenticated mutations protected (SameSite plus Origin check or CSRF token) | Send a cross-origin POST with the cookie |
| CORS lists exact origins; never wildcard with credentials | Read config; send a request with a foreign `Origin` |
| Security headers: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `frame-ancestors` (or `X-Frame-Options`), HSTS in production | Inspect response headers |
| Trusted hosts and proxy headers configured only for the known proxy | Send a forged `X-Forwarded-For` and `Host` |

## 7. Server-side requests (SSRF) and redirects
| Check | How to test |
|---|---|
| Server fetches of user-supplied URLs (webhooks, previews, imports) use an allow list, block private IP ranges and metadata addresses, set timeouts and size limits | Submit `http://169.254.169.254/` and `http://localhost:5432` |
| Redirect targets after sign-in are allow-listed or relative paths only | Use `?next=https://evil.example` |

## 8. File uploads
| Check | How to test |
|---|---|
| Size limit enforced on the server | Upload a file over the limit with curl, bypassing the UI |
| Type checked by content, not extension | Upload an HTML file renamed `.png` |
| Stored with random names, outside executable or public paths | Read storage code |
| Served with correct `Content-Type` and `Content-Disposition` | Download an uploaded file and inspect headers |

## 9. Rate limiting and abuse
| Check | How to test |
|---|---|
| Sign-in, sign-up, password reset, and OTP endpoints rate limited per IP and per account | A short burst (10 to 20 requests) on the local stack; expect 429 |
| Rate limiter state shared across workers (Redis or similar), not an in-process dict | Read the implementation |
| List and search endpoints have a maximum page size | Request `limit=100000` |
| Expensive operations (exports, emails) limited per user | Repeat the action quickly |

## 10. Secrets and configuration
| Check | How to test |
|---|---|
| No secrets in the repository or its history | `gitleaks detect` or `trufflehog git file://. --no-verification` (never `--only-verified`, which logs in to real providers with any key it finds) |
| `.env` files ignored by git; `.env.example` has placeholders only | `git check-ignore .env`; read the example |
| Debug modes off in production config (`echo=True`, debug toolbars, verbose errors) | Read production settings |
| Test-only routes (`/api/test/...` seeding and fault injection) are registered only when `ENVIRONMENT == "test"`, never by a `!= "production"` check | Read the router setup; request `/api/test/users` on a non-test run and expect 404 |
| Default credentials removed (database, admin seed users) | Read compose files and seed scripts |
| Containers run as a non-root user | Read Dockerfiles |

## 11. Errors and logging
| Check | How to test |
|---|---|
| Error responses use the standard envelope with a generic message; no stack traces, SQL, paths, or `str(e)` | Trigger 400, 404, 409, 422, 500 and read responses |
| Validation errors do not echo rejected values (they may be passwords or tokens) | Send an invalid password field; read the 422 body |
| Logs contain no passwords, tokens, cookies, or full personal data | Exercise sign-in and checkout; read backend logs |
| Security-relevant events logged (sign-in failures, permission denials, admin actions) | Trigger them; read logs |

## 12. Dependencies and supply chain
| Check | How to test |
|---|---|
| Lockfiles committed and used in builds (`uv sync --frozen`, `pnpm install --frozen-lockfile`) | Read Dockerfiles and CI |
| Known vulnerable dependencies triaged | `pip-audit`, `pnpm audit --prod` |
| GitHub Actions pinned to commit SHAs; workflow `permissions` minimal | Read workflows |
| Base images pinned and scanned | `trivy image` |

## 13. Data protection
| Check | How to test |
|---|---|
| Sensitive personal data stored only if the PRD needs it | Compare the data model with the PRD |
| Account deletion removes or anonymizes personal data as the PRD states | Delete an account; query the database |
| Backups and exports (if any) are access-controlled | Read config |
