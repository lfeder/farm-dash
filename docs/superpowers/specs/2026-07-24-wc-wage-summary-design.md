# WC Wage Summary — WC/TDI page section

**Date:** 2026-07-24
**Repos touched:** `farm-dash` (UI + data-source), `aloha-data-migrations` (new prod view + apply workflow)
**Status:** Approved design, pending implementation plan

## Background

The app repo (`aloha-app`) once had a read-only HR sub-module, **"Worker Comp
Summary"**, that pivoted payroll into workers-comp wage totals by class code and
pay structure. It was removed on 2026-07-13 (commit `e33cd942`), and its backing
prod view `hr_payroll_wc_summary` was dropped in `aloha-data-migrations`
(`20260713010000`).

We are reproducing that summary as a **new section on the existing farm-dash
WC/TDI page** (`wc-tdi/index.html`), which is embedded in the aloha app at
`/home/hawaii_farming/tools/farm-dash`. The farm-dash is a separate static
HTML/JS site (fork `Michael-Chege/farm-dash`, upstream `lfeder/farm-dash`) that
reads prod Supabase (`zdvpqygiqavwpxljpvqw`) through `*_v` views via the anon
publishable key.

## Goal

Add a faithful reproduction of the Worker Comp Summary — the Month → Check Date →
Class Code pivot plus the per-check-date By-Class and By-Structure summaries — as
an **always-visible section appended below** the existing WC/TDI tables, styled
with the page's existing dark theme.

## Decisions (locked)

1. **Placement:** new section below the existing WC/TDI content, always visible
   (no toggle segment).
2. **Fidelity:** full reproduction, including the **by-pay-structure** breakdown
   (which the current live views don't expose).
3. **Wage basis:** **base wages for everything** — same formula the rest of this
   page uses (`gross_wage − overtime_pay − per_diem − auto_allowance`). This makes
   the section's totals reconcile with the existing "Workers' Comp · monthly"
   table above it. (The original sub-module used `regular_pay`; we deliberately
   switch to base wages so the two WC tables on one page tie out.)

## Data layer (aloha-data-migrations)

### New view: `wc_summary_paycheck_v`

Per-paycheck WC wages at the grain needed to roll up both ways.

- **Grain:** `(year, month, check_date, wc_code, pay_structure)`
- **Columns:**
  - `year int`, `month int`, `check_date date`
  - `wc_code text` = `COALESCE(NULLIF(TRIM(wc), ''), 'Unclassified')`
  - `pay_structure text` (raw `hr_payroll.pay_structure`; may be null/blank)
  - `base_wages numeric` = `round(sum(gross_wage − overtime_pay − per_diem − auto_allowance), 2)`
    with each term `COALESCE(..., 0)`
  - `overtime numeric` = `round(sum(overtime_pay), 2)`
- **Filters (match the other WC views):**
  `COALESCE(is_deleted, false) = false`, `payroll_processor <> 'HF'`,
  `org_id = 'hawaii_farming'`.
- **Grants:** `GRANT SELECT ON public.wc_summary_paycheck_v TO anon, authenticated;`
- Follows the same security posture as `wc_basis_paycheck_v` /
  `wc_basis_monthly_v` (definer-style view, org hard-coded, granted to anon —
  single-tenant public compliance dashboard).

Rationale for a single view at `(check_date, wc_code, pay_structure)` grain: the
client rolls it up by class (sum over structures) and by structure (sum over
classes) — exactly what the original `hr_payroll_wc_summary` did. Reusing
`wc_basis_paycheck_v` isn't enough because it lacks `pay_structure`.

### Rollout

- New migration file in `aloha-data-migrations/supabase/migrations/`
  (`20260724000000_wc_summary_paycheck_v.sql` — bump the `YYYYMMDDHHMMSS` prefix
  to the actual commit date at implementation time), idempotent
  (`CREATE OR REPLACE VIEW`, `GRANT`).
- New gated `apply-wc-summary-paycheck-v.yml` workflow following the house
  pattern (`workflow_dispatch`, `apply` choice input, dry-run `BEGIN … ROLLBACK`
  by default, then `--single-transaction` psql apply against
  `secrets.SUPABASE_DB_URL_PROD`, then a verify step). Dispatch `apply=false`
  first, confirm, then `apply=true`. **Not** `db push`.

## UI layer (farm-dash)

### `lib/data-source.js`

Register a `wc_summary` logical table in `CONFIG`, mirroring the
`wc_basis_paycheck` entry:

```
wc_summary: {
  sheets: [],
  supabase: {
    table: 'wc_summary_paycheck_v', orderBy: 'check_date',
    select: 'year,month,check_date,wc_code,pay_structure,base_wages,overtime',
    columns: [
      { label: 'Year',      field: 'year',          type: 'number' },
      { label: 'Month',     field: 'month',         type: 'number' },
      { label: 'Check',     field: 'check_date',    type: 'date'   },
      { label: 'Code',      field: 'wc_code',       type: 'string' },
      { label: 'Structure', field: 'pay_structure', type: 'string' },
      { label: 'Base',      field: 'base_wages',    type: 'number' },
      { label: 'OT',        field: 'overtime',      type: 'number' },
    ],
  },
},
```

### `wc-tdi/index.html`

Append a new section below the existing `#main` / rules note. It is independent
of the existing `wc`/`tdi` view toggle (always rendered).

**Data prep**
- Fetch `wc_summary` (prod) alongside the existing loads.
- Parse to rows `{ year, month, check_date{y,m,d}, code, structure, base, ot }`.
- Filter: drop rows whose `code` is empty / `N/A` / `Unclassified`.
- Scope to the **6 most recent calendar months** present in the data.
- Group by calendar month (no 6/22 renewal split — the original grouped by
  calendar month only).

**Pivot table** (Month → Check Date → Class Code)
- Columns: Period Month · Check Date · Class Code · Base · OT.
- Leaf rows = class code within a check date; blank the Month/Check-Date label on
  repeat rows so they read as merged groups.
- Per-check-date subtotal rows and per-month subtotal rows (use `.tot`/`.roll`
  styling).
- Pinned grand-total row labeled **"Last 6 months"**.
- Sort months and check dates descending; class codes ascending.

**Per-check-date summaries**
- A `<select>` of check dates (most recent first; `M/D/YYYY` labels), defaulting
  to the most recent, driving:
  - **By Class Code** table: Class Code · Base · OT, with a `TOTAL` row.
  - **By Structure** table: Structure · Base · OT, with a `TOTAL` row.
- Null/blank structure labeled `—`, sorted to the end.
- Clicking a check-date row in the pivot also selects that date (nice-to-have,
  matches the original's cell-click behavior).

**Styling:** reuse the page's existing CSS classes (`table`, `th`, `td.lbl`,
`tr.tot`, `tr.roll`, `td.tot`, `.pill`, `.muted`) so the section matches. No new
color system.

**Export (optional, match page convention):** the existing page has an Export
CSV button scoped to the active view. Out of scope for v1 unless trivial; note it
as a follow-up.

## Out of scope

- Editable parameters (no cap/params for this section).
- The 6/22 policy-renewal month split (original summary didn't split).
- Changing the existing WC-monthly or TDI-quarterly views.
- CSV export for the new section (follow-up).

## Verification

- Migration dry-run (`apply=false`) shows the view created and a sample select;
  `apply=true` then a verify select returns rows for `hawaii_farming`.
- On the page: totals in the new section's By-Class / pivot reconcile with the
  existing "Workers' Comp · monthly" table for overlapping months (both base
  wages now).
- Section renders with real prod data at `/home/hawaii_farming/tools/farm-dash`
  → WC/TDI page (via `?src=prod`).
