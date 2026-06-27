# Dashboard → Supabase Migration Plan

Status: **in progress.**
Supabase project: prod `zdvpqygiqavwpxljpvqw`.
Canonical schema + migration scripts live in [`aloha-data-migrations`](https://github.com/Hawaii-Farming/aloha-data-migrations).

---

## Goal

Migrate the dashboards under `C:\lf\farm\dash\` from Google Sheets (gviz JSONP)
to Supabase. Support a 2-way runtime toggle: `sheets | prod`. Default stays
`sheets` until each dashboard passes side-by-side verification.

## Progress snapshot (2026-04-18)

| Piece | Status |
|---|---|
| Plant-map schema in Supabase | ✅ prod (5 tables: `org_site_gh`, `_block`, `_row`, `grow_cuke_seed_batch`, `grow_cuke_gh_row_planting`) |
| Historical cuke seed batches migrated | ✅ 660 rows to `grow_cuke_seed_batch` |
| Forward cuke seeding plan (52 weeks) | ✅ 159 rows inserted, status `planned` |
| Invoice + expense tables | ✅ `sales_invoice` (21,579 rows), `fin_expense` (17,624 rows) — nightly-synced from sheet |
| Views for dashboards | ✅ `sales_invoice_v`, `fin_expense_v` (derived year/month/iso_*) |
| Shared data-source abstraction | ✅ `dash/lib/data-source.js` (sheets\|prod toggle) |
| Dashboard migrations | In progress — see rollout below |
| Prod deploy of everything above | Not started |

## Current data sources

Each dashboard currently fetches independently via gviz. The new
`dash/lib/data-source.js` wraps both the gviz and Supabase backends so page
code only calls `DataSource.fetchTable(logicalName)`.

| Dashboard | Sheet(s) | Logical table(s) in Supabase |
|---|---|---|
| `dash/sales/index.html` | `124y…CExE` invoice tabs | `sales_invoice_v` |
| `dash/sales/budget.html` | `124y…CExE`, `1VtE…ziM` | `sales_invoice_v`, grow-seed-batch views |
| `dash/logistics/index.html` | `124y…CExE` | `sales_invoice_v` |
| `dash/daily/index.html` | `124y…CExE`, `1VtE…ziM` | `sales_invoice_v` + grow views |
| `dash/chem/index.html` | `1Xwa…E2c0`, `1VtE…ziM` | grow_spray_* + grow views |
| `dash/chat/index.html` | `1VtE…ziM`, `1MbH…0dfc` | grow/fsafe — broad access |
| `dash/plant-map/index.html` | `1ewW…48LE` gid 1615707612 | `grow_cuke_gh_row_planting` + edit write path |

## Toggle UI

- 2-way selector rendered by `DataSource.attachToggleAfter(versionStampEl)`
  next to each dashboard's version stamp
- Persists via `localStorage('dashSource')` and `?src=` URL param
- Parent `index.html` can call `DataSource.propagateToIframes(mode)` to
  cascade the choice to children
- Default stays `sheets` until each dashboard passes side-by-side
  verification

## Shared data-source abstraction

File: `dash/lib/data-source.js` (see `dash/lib/README.md` for usage).

`fetchTable(logicalName)` returns a gviz-shaped `{cols, rows}` object
regardless of backend. Existing `parseGvizTable` functions in page code keep
working — no logic changes needed downstream of the fetch.

Config per logical table:

```js
invoices: {
  sheets: [
    { sheetId: SHEETS.invoices, gid: '1254110782' }, // invoices_23-25
    { sheetId: SHEETS.invoices, gid: '544460225'  }, // invoices_2025 (2026 data)
  ],
  supabase: {
    table: 'sales_invoice_v',
    columns: [
      { label: 'InvoiceDate', field: 'invoice_date', type: 'date' },
      // ...
    ],
  },
}
```

Supabase client is loaded lazily from CDN on first non-sheets use.
Anon/publishable keys for both projects are hardcoded (browser-safe).

## Plant-map schema — done (via cuke split)

The plan's original proposal for `greenhouse` / `plant_row_position` /
`plant_row_planting` / `gh_event` was **superseded** by the cuke split that
shipped 2026-04-17. Live schema:

- `org_site_gh` — per-GH layout (orientation, sidewalk, grid position)
- `org_site_gh_block` — named blocks per GH with `row_num` ranges
- `org_site_gh_row` — every physical row with bag capacity
- `grow_cuke_gh_row_planting` — variety per row per scenario (`current` / `planned`)
- `grow_cuke_seed_batch` — seeding events (historical + 52-week forward plan)

Bag-change dates live on `grow_cuke_seed_batch.next_bag_change_date` per
cycle; no separate `gh_event` table needed.

HK (Hamakua + Kohala sharing one `org_site.id='hk'`) handled via row-num
offset (+100 for Kohala) and named blocks (`name='Hamakua'` / `name='Kohala'`)
so the plant-map UI can still render them as separate sections. See
`aloha-data-migrations/docs/2026-04-17_cuke_split_update.md` for full notes.

## Invoice + expense pipeline

Nightly Python script
`aloha-data-migrations/migrations/20260401000034_fin_invoice_expense.py`
reads 4 sheet tabs via unauthenticated gviz CSV and clear-and-reinserts:

- `invoices_23-25` + `invoices_2025` → `sales_invoice`
- `expenses_2019-25` + `expense_2026` → `fin_expense`

When QB API integration lands later, we swap the upstream source and kill
the sheet middleman. Dashboards are insulated because they read from
`sales_invoice_v` / `fin_expense_v`.

### Dropped columns (derivable on read via the views)

- Invoice: `Year`, `Month`, `ISOYear`, `ISOWeek`, `DOW`
- Expense: `MM`, `YY`

### Script scope

- `farm_id` on invoices: derived from sheet `Farm` column (Cuke/Lettuce)
- `farm_id` on expenses: null for now (sheet doesn't carry it)
- `effective_amount` on expenses: preserves the sheet's pre-computed signed amount (negates when `is_credit=true`)

## Rollout order

One dashboard at a time, side-by-side verify before moving on.

1. **`sales/index.html`** — canary, simplest gviz swap. ✅ migrated; flips to `prod` via the toggle
2. `logistics/index.html` — same `sales_invoice_v` source
3. `daily/index.html` — date aggregation stress test; adds grow views
4. `chem/index.html` — adds chem-related tables (need new logical tables in config)
5. `chat/index.html` — widest reader; needs cross-domain config entries
6. `sales/budget.html` — rework `fetch-budget-data.js` to query Supabase
7. `plant-map/index.html` — reads `grow_cuke_*` + `org_site_gh*`. Needs an
   edit write path for variety changes — propose small edge function
   holding a scoped service-role key; anon keys stay read-only

### Per-dashboard verification

Side-by-side: load `?src=sheets` and `?src=prod` in two tabs, compare headline
numbers (totals, latest week, top customers). Only move on when they match.

## Open items

- **Forward-seed editing UI** — the 159 planned `grow_cuke_seed_batch` rows
  need a page where ops can nudge individual `seeding_date` /
  `transplant_date` when reality diverges from the rotation model.
- **Plant-map write path** — edge function design (auth, allowed columns,
  validation) so non-service-role browsers can edit
  `grow_cuke_gh_row_planting`.
- **Prod deploy** — prod is the only live Supabase project. Same SQL + Python
  sequence keeps it populated.

## Session resume instructions

1. Read this file.
2. Check prod populated via `sales_invoice`, `fin_expense`, `grow_cuke_seed_batch` counts.
3. Next: pick the next dashboard in the rollout order and migrate its fetch
   to `DataSource.fetchTable(...)` + add the toggle.
