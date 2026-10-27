# PostgreSQL and migrations

## Contents
1. Type choices
2. Keys, constraints, and indexes
3. Query habits
4. Migration rules
5. Expand and contract
6. Migration review checklist

## 1. Type choices

| Data | Use | Avoid, and why |
|---|---|---|
| Primary keys | `uuid` (v4, or v7 if insert order matters) | Sequential ints in URLs: they expose counts and invite ID probing |
| Timestamps | `timestamptz`, stored UTC | `timestamp` without time zone: silently ambiguous |
| Money | `bigint`/`integer` minor units + `text` currency code | `float`/`real`: rounding errors. `numeric` is fine for rates, not needed for cents |
| Status / small fixed sets that may change | `text` + `CHECK (status IN (...))` | Postgres `ENUM`: adding or renaming values needs special migrations and autogenerate handles it badly |
| Strings | `text` with a `CHECK (char_length(x) <= n)` if a limit matters | `varchar(n)` as a habit: no performance gain, harder to change |
| Email | `text` + unique index on `lower(email)` (or `citext`) | Plain unique on `email`: lets `A@x.com` and `a@x.com` both register |
| Booleans | `boolean NOT NULL DEFAULT false` | Nullable booleans: three states nobody planned for |
| Flexible optional attributes | `jsonb` with `CHECK (jsonb_typeof(x) = 'object')` | `jsonb` for core fields you filter or join on: no constraints, weak typing |
| Large files | Object storage, store the key in `text` | `bytea` blobs in the main tables |

Every table gets `created_at timestamptz NOT NULL DEFAULT now()` and `updated_at` (updated by the ORM `onupdate` or a trigger).

## 2. Keys, constraints, and indexes

* **Index every foreign key.** Postgres does not do it automatically, and unindexed FKs make joins and `ON DELETE` cascades slow.
* Choose `ON DELETE` deliberately: `CASCADE` for owned children (order items), `RESTRICT` when deletion must be blocked, `SET NULL` for optional references. Write the choice in the data model.
* Put uniqueness and validity in the database (`UNIQUE`, `CHECK`, `NOT NULL`). Application checks race; constraints do not. Catch `IntegrityError` and map it to a 409 domain error.
* `UNIQUE NULLS NOT DISTINCT` (Postgres 15+) when a nullable column must still be unique.
* **Composite indexes follow the query:** equality columns first, then the sort columns. For `WHERE user_id = ? ORDER BY created_at DESC, id DESC`, index `(user_id, created_at, id)`.
* **Partial indexes** for hot subsets: `CREATE INDEX ... ON orders (user_id) WHERE status = 'pending'`.
* Do not add indexes speculatively. Each one slows writes. Add the ones your task's queries use.

## 3. Query habits

* Filter by owner or tenant in the `WHERE` clause of every query on user data.
* Select related data in the same round trip (`selectinload`, `joinedload`) instead of loading it per row.
* Paginate every list; never return unbounded result sets.
* Use `EXPLAIN ANALYZE` locally when a query touches a large or growing table, and check it uses the index you added.
* Use `SELECT ... FOR UPDATE` (`with_for_update()`) when a read-then-write must not race (stock counts, balances), or do the change as one conditional `UPDATE ... WHERE status = 'pending'` and check the row count.
* Bulk inserts and backfills go in batches, not one giant statement.

## 4. Migration rules

1. **Autogenerate, then edit by hand.** Autogenerate commonly gets these wrong:
   * Column renames appear as drop plus add, which deletes data. Replace with `op.alter_column(..., new_column_name=...)`.
   * Server defaults and `CHECK` constraints may be missing or rendered oddly.
   * Enum type changes are not detected.
   * Index names and partial or expression indexes (`lower(email)`) need manual `op.create_index(..., postgresql_where=...)` or `sa.text(...)`.
2. **Name constraints** using a naming convention on `MetaData` so downgrades and later migrations can refer to them.
3. **Every migration is reversible.** Write `downgrade()` and test `upgrade, downgrade -1, upgrade`. If a downgrade would lose data, say so in a comment and in the handoff.
4. **One head.** `alembic heads` shows one revision. Two heads mean two tasks created migrations in parallel; stop and tell the tech lead.
5. **Never edit a merged migration.** Write a new migration to change it. Other environments have already run the old one.
6. **Data migrations** (backfills) are separate from schema migrations, batched, and idempotent (safe to re-run).
7. **No application imports in migrations.** Models change over time; a migration importing today's model breaks when replayed later. Use `op` and `sa.table()` definitions inside the migration.
8. Adding a `NOT NULL` column to a table with rows: add it nullable or with a server default, backfill, then set `NOT NULL` in a later step.
9. Creating an index on a large existing table in production: `op.create_index(..., postgresql_concurrently=True)` inside an `with op.get_context().autocommit_block():` block, since concurrent index builds cannot run in a transaction. For an MVP with small tables a normal index is fine; note the choice.

## 5. Expand and contract

Changing a column or table that running code already uses must not break the previous release, because a rollback runs old code against the new schema.

1. **Expand:** add the new column or table (nullable or with a default). Old code ignores it.
2. **Migrate:** backfill in batches; deploy code that writes both or reads the new one with a fallback.
3. **Switch:** deploy code that only uses the new structure.
4. **Contract:** in a later release, drop the old column or table.

Destructive changes (`DROP COLUMN`, `DROP TABLE`, `NOT NULL` on existing data, type narrowing) belong in the contract step only, after no running code uses the old shape. During initial MVP development, before anything is deployed, a task may change its own unreleased tables directly; the tech lead says when the project counts as released.

## 6. Migration review checklist

Use this on your own migration before handoff (reviewers use it too):

- [ ] The file was read and edited by hand after autogenerate.
- [ ] No drop plus add that should be a rename.
- [ ] Every new FK has an index.
- [ ] `timestamptz` for times, minor-unit integers for money, `text` + `CHECK` for statuses.
- [ ] Constraints and indexes have explicit names.
- [ ] `NOT NULL` on existing tables follows the add, backfill, then constrain pattern.
- [ ] `downgrade()` exists and was run.
- [ ] Exactly one Alembic head after the change.
- [ ] No imports from `app.models` inside the migration.
- [ ] No destructive change to a released table outside the contract step.
- [ ] Data migrations are batched and idempotent.
