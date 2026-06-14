# `dash/lib/data-source.js`

Shared data-source abstraction for the farm dashboards. Lets each dashboard
switch at runtime between three backends:

| Mode | Backend |
|---|---|
| `sheets` | existing gviz JSONP calls against Google Sheets (current default) |
| `dev` | Supabase dev project `kfwqtaazdankxmdlqdak` |
| `prod` | Supabase prod project `zdvpqygiqavwpxljpvqw` |

## Usage in a dashboard

```html
<script src="../lib/data-source.js"></script>
<script>
  async function loadData() {
    // fetchTable returns a gviz-shaped {cols, rows} regardless of backend,
    // so existing parseGvizTable / row.c[i].v code keeps working.
    const table = await DataSource.fetchTable('invoices');
    const rows = parseGvizTable(table);  // your existing parser
    // ...
  }

  // Render the sheets|dev|prod toggle next to the version stamp
  document.addEventListener('DOMContentLoaded', () => {
    DataSource.attachToggleAfter('versionStamp');
    loadData();
  });
</script>
```

## Mode selection

`getMode()` checks in order:

1. `?src=sheets|dev|prod` URL parameter
2. `localStorage.getItem('dashSource')`
3. Defaults to `sheets`

`setMode(mode)` persists to localStorage and reloads the page with the new
`?src=` so the choice stays across navigation.

## Config

`CONFIG[logicalName]` defines how each logical table resolves per backend:

```js
invoices: {
  sheets: [
    { sheetId: '124y...', gid: '1254110782' }, // invoices_23-25
    { sheetId: '124y...', gid: '544460225'  }, // invoices_2025 (2026 data)
  ],
  supabase: {
    table: 'sales_invoice_v',
    columns: [
      { label: 'InvoiceDate',   field: 'invoice_date',   type: 'date'   },
      { label: 'CustomerName',  field: 'customer_name',  type: 'string' },
      // ...
    ],
  },
}
```

- `sheets` is an array of gviz sources; results are concatenated
- `supabase.columns` maps Supabase fields back to gviz column labels so page
  code sees the same `row.InvoiceDate` etc. after parsing
- `type` is `string | number | date | boolean`; `date` gets rendered as a
  `Date(y,m,d)` string with a `.f` formatted counterpart so gviz parsers work

Add more logical tables as each dashboard migrates.

## Supabase client

Loaded lazily from CDN (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`)
the first time a non-sheets mode is used. Anon keys are hardcoded in this file
(safe in browser, read-only). If either project's anon key is rotated, update
`SUPABASE_PROJECTS` in `data-source.js`.

## Side-by-side verification

To compare two modes on the same dashboard, open two tabs:

- `?src=sheets`
- `?src=dev`

Sanity-check that headline numbers (totals, latest week, top customers) match
before flipping the default away from `sheets`.

## Adding a new logical table

1. Add an entry to `CONFIG` with both `sheets` and `supabase` mappings
2. In the dashboard that needs it, replace the existing gviz fetch with
   `DataSource.fetchTable('your_name')`
3. Side-by-side verify that sheets-mode and dev-mode produce identical
   headline numbers

## Parent `index.html` toggle propagation

The parent `dash/index.html` hosts each dashboard in an iframe. To make a
mode change on the parent toggle cascade to all child iframes, call
`DataSource.propagateToIframes(mode)` whenever the toggle changes. The child
pages then see `?src=<mode>` on their `<iframe src>` and pick it up through
their own `getMode()` call.
