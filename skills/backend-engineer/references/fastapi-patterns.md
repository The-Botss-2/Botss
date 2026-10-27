# FastAPI patterns

Reference code for the default stack. Follow the project's existing code first. These are the patterns the scaffold (T000) is expected to set up, and the shape new code should take. Pin versions to current in `pyproject.toml`. The snippets target Pydantic v2, SQLAlchemy 2.x async with asyncpg, httpx 0.28+, and pytest-asyncio 1.x in auto mode.

Helpers marked **you write this** are not defined in this file. Write them in the module named, with the signature shown.

## Contents
1. Settings
2. Database engine, base, and session
3. App setup
4. Error envelope and handlers
5. Sessions and the auth dependency
6. Model, schemas, and service
7. Router with cursor pagination
8. Test setup (pytest config and conftest)
9. Endpoint tests
10. Alembic workflow

## 1. Settings

```python
# app/core/config.py
from functools import lru_cache
from pathlib import Path
from typing import Literal
from pydantic import PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]   # backend/app/core/config.py -> repo root

class Settings(BaseSettings):
    # Commands run from backend/, but .env lives at the repo root. Real env vars always win.
    model_config = SettingsConfigDict(env_file=(REPO_ROOT / ".env", ".env"), extra="ignore")

    environment: Literal["local", "test", "ci", "production"] = "local"
    database_url: PostgresDsn             # postgresql+asyncpg://...
    session_cookie_name: str = "botss_session"
    session_days: int = 14
    # Only needed when a browser calls the API cross-origin. The default setup proxies /api
    # through the Next.js origin, so this stays empty. Must be a JSON list in env:
    # CORS_ORIGINS='["https://app.example.com"]'
    cors_origins: list[str] = []

@lru_cache
def get_settings() -> Settings:
    return Settings()   # raises at startup if a required var is missing
```

## 2. Database engine, base, and session

```python
# app/core/db.py
from collections.abc import AsyncIterator
from datetime import datetime
from sqlalchemy import DateTime, MetaData
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from app.core.config import get_settings

engine = create_async_engine(str(get_settings().database_url), pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)                 # stable constraint names for Alembic
    type_annotation_map = {datetime: DateTime(timezone=True)}     # every datetime column is timestamptz

async def get_session() -> AsyncIterator[AsyncSession]:
    # The dependency never commits. Code after `yield` may run after the response is sent
    # (FastAPI 0.118+), so a commit here could fail silently after the client got a 2xx.
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
```

**Commit rule.** Write endpoints commit explicitly before returning: the service does the work and `flush()`es inside a `try` that maps `IntegrityError` to a domain error, and the router calls `await session.commit()` (section 7). Then a failed commit becomes an error response, not a lost write behind a 200. (FastAPI 0.121+ also offers `Depends(get_session, scope="function")`, which runs the teardown before the response is sent. It is fine to use on top of this, but do not rely on it alone.)

## 3. App setup

```python
# app/main.py (excerpt)
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.router import api_router
from app.core.config import get_settings
from app.core.db import engine
from app.core.errors import register_error_handlers

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()

settings = get_settings()
app = FastAPI(lifespan=lifespan)

if settings.cors_origins:   # only for cross-origin setups; never ["*"] with credentials
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )

register_error_handlers(app)
app.include_router(api_router, prefix="/api")

if settings.environment == "test":
    # Seed and fault-injection endpoints for e2e tests. Registered ONLY in the test
    # environment, never in local, ci builds that deploy, staging, or production.
    from app.api.testing import router as testing_router   # you write this module
    app.include_router(testing_router, prefix="/api/test")
```

**Standard routes other roles rely on.** The frontend and QA skills assume these exist, so T000 or the auth task must create them (adjust names only through the contract):

| Route | Purpose | Exists in |
|---|---|---|
| `POST /api/auth/login` | Verify credentials, create a session, set the `botss_session` cookie | all environments |
| `POST /api/auth/logout` | Revoke the session, clear the cookie | all environments |
| `GET /api/auth/me` | Return the signed-in user (401 if none); used by the frontend's `getSession()` | all environments |
| `GET /api/health/live`, `GET /api/health/ready` | Liveness, and readiness with a DB check | all environments |
| `POST /api/test/users` | Create a user with a known password for e2e tests | `ENVIRONMENT=test` only |
| `POST /api/test/<entity>` | Seed project data owned by the signed-in user (for example `/api/test/orders`) | `ENVIRONMENT=test` only |
| `POST /api/test/faults` | Make named operations fail (for example `{"orders_list": 503}`) until reset | `ENVIRONMENT=test` only |

Health endpoints live in `app/api/health.py`: `GET /api/health/live` returns 200 if the process is up, and `GET /api/health/ready` runs `SELECT 1` and returns 503 if the database is unreachable.

## 4. Error envelope and handlers

```python
# app/core/errors.py
import logging
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger(__name__)

class DomainError(Exception):
    status_code = 400
    code = "bad_request"
    message = "The request could not be processed."
    def __init__(self, details: dict | None = None):
        self.details = details or {}

class NotFound(DomainError):
    status_code, code, message = 404, "not_found", "Not found."

class Conflict(DomainError):
    status_code, code, message = 409, "conflict", "This conflicts with the current state."

class EmailAlreadyRegistered(Conflict):
    code, message = "email_taken", "An account with this email already exists."

class OrderNotCancellable(Conflict):
    code, message = "order_not_cancellable", "This order can no longer be cancelled."

class InvalidCursor(DomainError):
    status_code, code, message = 400, "invalid_cursor", "The pagination cursor is invalid."

def _body(request: Request, code: str, message: str, details: dict | None = None) -> dict:
    return {"error": {"code": code, "message": message, "details": details or {},
                      "request_id": getattr(request.state, "request_id", None)}}

def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def domain(request: Request, exc: DomainError):
        return JSONResponse(_body(request, exc.code, exc.message, exc.details), exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation(request: Request, exc: RequestValidationError):
        fields: dict[str, list[str]] = {}
        for err in exc.errors():
            name = ".".join(str(p) for p in err["loc"] if p not in ("body", "query", "path"))
            fields.setdefault(name or "_", []).append(err["msg"])   # never include err["input"]
        return JSONResponse(_body(request, "validation_error", "Some fields are invalid.",
                                  {"fields": fields}), 422)

    @app.exception_handler(StarletteHTTPException)
    async def http(request: Request, exc: StarletteHTTPException):
        codes = {401: "not_authenticated", 403: "forbidden", 404: "not_found", 405: "method_not_allowed"}
        return JSONResponse(_body(request, codes.get(exc.status_code, "http_error"),
                                  str(exc.detail) if exc.status_code < 500 else "Server error."),
                            exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log.exception("unhandled error", extra={"request_id": getattr(request.state, "request_id", None)})
        return JSONResponse(_body(request, "internal_error", "Something went wrong."), 500)
```

`HTTPException.detail` is only ever a fixed string you wrote, never exception text.

## 5. Sessions and the auth dependency

The default is server-side sessions: an opaque random token in an `httpOnly` cookie, stored **hashed** in a `sessions` table, so sign-out and password change can revoke it. No JWTs by default.

```python
# app/models/session.py
import uuid
from datetime import datetime
from sqlalchemy import ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from app.core.db import Base

class UserSession(Base):
    __tablename__ = "sessions"
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(unique=True)     # sha256 hex of the cookie token
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
```

```python
# app/services/session_service.py
import hashlib, secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings
from app.models.session import UserSession
from app.models.user import User

def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()

async def create_session(session: AsyncSession, user_id: UUID) -> str:
    """Returns the raw token for the cookie. Only the hash is stored."""
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=get_settings().session_days)
    session.add(UserSession(user_id=user_id, token_hash=_hash(token), expires_at=expires))
    await session.flush()
    return token

async def user_for_token(session: AsyncSession, token: str) -> User | None:
    now = datetime.now(timezone.utc)
    return await session.scalar(
        select(User).join(UserSession, UserSession.user_id == User.id).where(
            UserSession.token_hash == _hash(token),
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > now,
        )
    )

async def revoke(session: AsyncSession, token: str) -> None:                  # sign-out
    await session.execute(update(UserSession).where(UserSession.token_hash == _hash(token))
                          .values(revoked_at=datetime.now(timezone.utc)))

async def revoke_all_for_user(session: AsyncSession, user_id: UUID) -> None:  # password change
    await session.execute(update(UserSession).where(UserSession.user_id == user_id,
                                                    UserSession.revoked_at.is_(None))
                          .values(revoked_at=datetime.now(timezone.utc)))
```

```python
# app/core/security.py
from typing import Annotated
from fastapi import Depends, HTTPException, Request, Response
from pwdlib import PasswordHash
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings
from app.core.db import get_session
from app.models.user import User
from app.services import session_service

password_hash = PasswordHash.recommended()   # argon2

SessionDep = Annotated[AsyncSession, Depends(get_session)]

async def get_current_user(request: Request, session: SessionDep) -> User:
    token = request.cookies.get(get_settings().session_cookie_name)
    user = await session_service.user_for_token(session, token) if token else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    return user

CurrentUser = Annotated[User, Depends(get_current_user)]

def require_role(*roles: str):
    async def checker(user: CurrentUser) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="You do not have access to this.")
        return user
    return Depends(checker)

def set_session_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        s.session_cookie_name, token,
        httponly=True,
        secure=s.environment == "production",   # Secure only in production, so http test clients work
        samesite="lax",
        max_age=60 * 60 * 24 * s.session_days, path="/",
    )
```

On login: verify the password, call `create_session`, `await session.commit()`, then `set_session_cookie`. On sign-out: `revoke`, commit, and `response.delete_cookie(...)`. On password change: `revoke_all_for_user`, then create a fresh session for the current device.

## 6. Model, schemas, and service

```python
# app/models/order.py
import uuid
from datetime import datetime
from sqlalchemy import CheckConstraint, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.core.db import Base

ORDER_STATUSES = ("pending", "preparing", "delivered", "cancelled")

class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint("status IN ('pending','preparing','delivered','cancelled')", name="status"),
        Index("ix_orders_user_created", "user_id", "created_at", "id"),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(default="pending")
    total_amount: Mapped[int]                         # minor units
    currency: Mapped[str] = mapped_column(default="USD")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
    items: Mapped[list["OrderItem"]] = relationship(back_populates="order", lazy="raise")

    @property
    def total(self) -> dict:
        """Wire shape for money, read by OrderRead via from_attributes."""
        return {"amount": self.total_amount, "currency": self.currency}
```

```python
# app/schemas/common.py
from pydantic import BaseModel, Field

class Money(BaseModel):
    amount: int = Field(description="Minor units, e.g. cents")
    currency: str = Field(min_length=3, max_length=3)   # ISO 4217
```

```python
# app/schemas/order.py
from datetime import datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict
from app.schemas.common import Money

OrderStatus = Literal["pending", "preparing", "delivered", "cancelled"]

class OrderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    status: OrderStatus
    total: Money
    created_at: datetime

class OrderListResponse(BaseModel):
    items: list[OrderRead]
    next_cursor: str | None
```

```python
# app/services/order_service.py
import base64, json
from datetime import datetime
from uuid import UUID
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.errors import InvalidCursor, NotFound, OrderNotCancellable
from app.models.order import Order

def _encode(o: Order) -> str:
    raw = json.dumps({"c": o.created_at.isoformat(), "i": str(o.id)})
    return base64.urlsafe_b64encode(raw.encode()).decode()

def _decode(cursor: str) -> tuple[datetime, UUID]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return datetime.fromisoformat(data["c"]), UUID(data["i"])
    except (ValueError, KeyError, TypeError) as exc:
        raise InvalidCursor() from exc

async def list_orders(session: AsyncSession, user_id: UUID, limit: int, cursor: str | None):
    stmt = select(Order).where(Order.user_id == user_id)       # owner scope in SQL
    if cursor:
        c_at, c_id = _decode(cursor)
        stmt = stmt.where(or_(Order.created_at < c_at,
                              and_(Order.created_at == c_at, Order.id < c_id)))
    stmt = stmt.order_by(Order.created_at.desc(), Order.id.desc()).limit(limit + 1)
    rows = list((await session.scalars(stmt)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    return rows, (_encode(rows[-1]) if has_more else None)

async def get_order(session: AsyncSession, user_id: UUID, order_id: UUID) -> Order:
    order = await session.scalar(select(Order).where(Order.id == order_id, Order.user_id == user_id))
    if order is None:
        raise NotFound()          # same answer whether missing or someone else's
    return order

async def cancel_order(session: AsyncSession, user_id: UUID, order_id: UUID) -> Order:
    order = await get_order(session, user_id, order_id)
    if order.status != "pending":
        raise OrderNotCancellable(details={"status": order.status})
    order.status = "cancelled"
    await session.flush()
    return order
```

The `limit + 1` trick avoids returning a cursor that leads to an empty page.

Mapping unique violations to a domain error (flush inside the `try`, so the error surfaces here and not at commit):

```python
# app/services/user_service.py (excerpt)
from sqlalchemy.exc import IntegrityError
from app.core.errors import EmailAlreadyRegistered

async def register(session: AsyncSession, email: str, password: str) -> User:
    user = User(email=email.lower(), password_hash=password_hash.hash(password))
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise EmailAlreadyRegistered() from exc
    return user
```

## 7. Router with cursor pagination

```python
# app/api/orders.py
from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Query
from app.core.security import CurrentUser, SessionDep
from app.schemas.order import OrderListResponse, OrderRead
from app.services import order_service

router = APIRouter(prefix="/orders", tags=["orders"])

@router.get("", response_model=OrderListResponse)
async def list_orders(
    user: CurrentUser,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: str | None = None,
):
    items, next_cursor = await order_service.list_orders(session, user.id, limit, cursor)
    return OrderListResponse(items=items, next_cursor=next_cursor)

@router.post("/{order_id}/cancel", response_model=OrderRead)
async def cancel_order(order_id: UUID, user: CurrentUser, session: SessionDep):
    order = await order_service.cancel_order(session, user.id, order_id)
    await session.commit()        # explicit commit before the response; see section 2
    return order
```

Create endpoints use `status_code=201`; deletes use `status_code=204` and return `Response(status_code=204)`. Every write endpoint commits before returning.

Loading relationships explicitly:

```python
stmt = select(Order).where(Order.user_id == user_id).options(selectinload(Order.items))
```

## 8. Test setup (pytest config and conftest)

Tests run against a separate Postgres database named by `TEST_DATABASE_URL`, never the dev database.

```toml
# backend/pyproject.toml (excerpt)
[tool.pytest.ini_options]
asyncio_mode = "auto"                          # async tests and fixtures need no marker
asyncio_default_fixture_loop_scope = "session" # one event loop for the whole run, so the
asyncio_default_test_loop_scope = "session"    # session-scoped engine is never shared across loops
testpaths = ["tests"]
```

```python
# tests/conftest.py
import os

TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")
if not TEST_DB_URL:
    raise RuntimeError(
        "TEST_DATABASE_URL is not set. Point it at the test database, e.g. "
        "postgresql+asyncpg://app:app@localhost:${DB_PORT}/app_test"
    )
# Set before importing the app: settings are read at import time.
os.environ["DATABASE_URL"] = TEST_DB_URL
os.environ["ENVIRONMENT"] = "test"

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from app.core.db import get_session
from app.main import app

@pytest_asyncio.fixture(scope="session")
async def engine():
    eng = create_async_engine(TEST_DB_URL)
    yield eng
    await eng.dispose()

@pytest_asyncio.fixture
async def session(engine):
    # Each test runs in an outer transaction that is always rolled back. Commits inside
    # the app release a savepoint instead of committing for real.
    async with engine.connect() as conn:
        trans = await conn.begin()
        s = AsyncSession(bind=conn, expire_on_commit=False,
                         join_transaction_mode="create_savepoint")
        try:
            yield s
        finally:
            await s.close()
            await trans.rollback()

@pytest_asyncio.fixture
async def client(session):
    async def _override():
        yield session
    app.dependency_overrides[get_session] = _override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
```

Schema setup: run `alembic upgrade head` against the test database once before the suite, so tests exercise the real migrations rather than `create_all`. A task's `verify` command does this itself so it works without the Makefile:

```bash
cd backend && DATABASE_URL="$TEST_DATABASE_URL" uv run alembic upgrade head && uv run pytest -q
```

Factories and an auth helper:

```python
# tests/factories.py
from uuid import uuid4
from app.core.security import password_hash
from app.models.order import Order
from app.models.user import User

async def make_user(session, **kw) -> User:
    user = User(email=kw.get("email", f"u{uuid4().hex[:8]}@example.com"),
                password_hash=password_hash.hash("correct horse"), role=kw.get("role", "customer"))
    session.add(user)
    await session.flush()
    return user

async def make_order(session, *, user: User, **kw) -> Order:
    order = Order(user_id=user.id, status=kw.get("status", "pending"),
                  total_amount=kw.get("total_amount", 1999), currency=kw.get("currency", "USD"))
    session.add(order)
    await session.flush()
    return order

async def login(client, user) -> None:
    res = await client.post("/api/auth/login", json={"email": user.email, "password": "correct horse"})
    assert res.status_code == 200      # cookie is now stored on the client (not Secure outside production)
```

## 9. Endpoint tests

```python
from tests.factories import login, make_order, make_user

async def test_cannot_cancel_another_users_order(client, session):
    owner, other = await make_user(session), await make_user(session)
    order = await make_order(session, user=owner)
    await login(client, other)
    res = await client.post(f"/api/orders/{order.id}/cancel")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "not_found"
    await session.refresh(order)
    assert order.status == "pending"

async def test_list_orders_requires_login(client):
    res = await client.get("/api/orders")
    assert res.status_code == 401

async def test_limit_out_of_range_is_422(client, session):
    await login(client, await make_user(session))
    res = await client.get("/api/orders?limit=101")
    assert res.status_code == 422
    assert "limit" in res.json()["error"]["details"]["fields"]

async def test_order_money_shape(client, session):
    user = await make_user(session)
    await make_order(session, user=user, total_amount=1250)
    await login(client, user)
    item = (await client.get("/api/orders")).json()["items"][0]
    assert item["total"] == {"amount": 1250, "currency": "USD"}
```

## 10. Alembic workflow

```bash
uv run alembic revision --autogenerate -m "add orders table"
# read the generated file and fix it by hand (see postgres-and-migrations.md checklist)
uv run alembic upgrade head
uv run alembic downgrade -1      # proves the downgrade works
uv run alembic upgrade head
uv run alembic heads             # must show exactly one head
```

`alembic/env.py` must use the async engine (`run_async_migrations`), import every model module so autogenerate sees them, use `Base.metadata` (with the naming convention), and set `compare_type=True` and `compare_server_default=True` in `context.configure`.

Alembic keeps **one revision chain for the whole project**, whatever tables a migration touches. Only one migration-creating task may be in flight at a time; the plan chains them with `after`. If `alembic heads` shows two heads, stop and tell the tech lead.
