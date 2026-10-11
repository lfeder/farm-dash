# One-time P1 germ split — handoff

## Objective

Split only the current planned P1AB seed batches into two real batches:

- first 10 boards / 1 row: seed two days before ponding
- remaining boards / rows: seed one day before ponding

Both keep the same pond and expected-harvest dates. This is a one-off data
change, **not** a recurring Builder feature. No rows already on the pond, no
harvested rows, and no future recurring schedule generation should change.

## Prepared migration

Run:

`supabase/lettuce_split_future_p1_germ_once.sql`

The transaction:

- only considers `hawaii_farming` / `P1AB` rows;
- requires an open, non-deleted row with `seeding_date >= Honolulu today` and
  `transplant_date > Honolulu today`;
- refuses any candidate that is not an exact 10-boards-per-row P1 batch;
- updates the original row to 10 boards / 1 row / pond minus 2 days;
- inserts the remaining boards / rows as a sibling seeded pond minus 1 day;
- stores the original record in `archive.lettuce_p1_germ_split_once`;
- cannot split the same source row twice.

## Verified scope before migration

On 2026-09-04, the live read-only query found eight eligible records:

| Pond date | Original boards / rows | Expected harvest |
|---|---:|---|
| 2026-09-06 | 160 / 16 | 2026-09-23 |
| 2026-09-09 | 170 / 17 | 2026-09-27 |
| 2026-09-13 | 170 / 17 | 2026-09-30 |
| 2026-09-16 | 160 / 16 | 2026-10-04 |
| 2026-09-20 | 170 / 17 | 2026-10-07 |
| 2026-09-23 | 160 / 16 | 2026-10-11 |
| 2026-09-27 | 170 / 17 | 2026-10-14 |
| 2026-09-30 | 170 / 17 | 2026-10-18 |

Re-check this scope immediately before running the migration. If it is no
longer exactly these eligible rows, stop and report the difference.

## Supabase MCP setup

The global Codex configuration now includes a project-scoped Supabase MCP:

```bash
codex mcp list
```

It should list `supabase` with this URL:

```text
https://mcp.supabase.com/mcp?project_ref=zdvpqygiqavwpxljpvqw&features=database,docs
```

OAuth was approved with `projects:read`, `database:read`, and `database:write`.
After restarting Codex, verify that the Supabase MCP tools themselves are
available. The prior terminal session authenticated the connection but a fresh
Codex subprocess still reported no Supabase tool; no SQL was executed.

## Resume prompt

Use this prompt after restarting Codex:

> Read `docs/lettuce-p1-germ-split-handoff.md` and
> `supabase/lettuce_split_future_p1_germ_once.sql`. Use the Supabase MCP to
> re-check eligible P1AB records first. If they remain exactly the documented
> unponded scope, execute the migration transaction, then query and report both
> resulting batches for every affected pond date. Do not modify any already
> ponded or harvested batch, and do not change the Builder.

## Current repository state

Only this handoff file and the one-time migration are new. Earlier experimental
changes to make the Builder split every future P1 cycle were fully reverted.
No production data has been written.
