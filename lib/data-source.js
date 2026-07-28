/**
 * Shared data-source abstraction for dashboards.
 *
 * Two backends:
 *   'sheets' — gviz JSONP calls against Google Sheets
 *   'prod'   — Supabase prod project (zdvpqygiqavwpxljpvqw)
 *
 * There is NO global runtime toggle anymore: each page pins its source per
 * feed by passing { mode: 'prod' | 'sheets' } to fetchTable(). If a caller
 * omits mode, fetchTable defaults to 'prod' when the table has a Supabase
 * source, else 'sheets'.
 *
 * Each logical table name (e.g. 'invoices') has a config entry mapping to
 * the physical sheet source(s) OR the Supabase view/table. fetchTable()
 * returns a gviz-shaped {cols, rows} object no matter the backend, so page
 * code that already parses gviz responses only changes the fetch call.
 *
 * Supabase client is loaded lazily from CDN on first use.
 */
(function (global) {
  'use strict';

  // =========================================================================
  // Configuration
  // =========================================================================

  const SUPABASE_PROJECTS = {
    prod: {
      url: 'https://zdvpqygiqavwpxljpvqw.supabase.co',
      anon: 'sb_publishable_HaoyPZbNIUxKPnwCh3iI3Q_1NIiWGgv',
    },
  };

  // Shared sheet IDs so we don't repeat them.
  const SHEETS = {
    invoices: '124y8JdWXmbf_hb1vfimHmGaKLVXrRHybw02w_ozCExE',
    grow:     '1VtEecYn-W1pbnIU1hRHfxIpkH2DtK7hj0CpcpiLoziM',
    chem:     '1XwaLTghRd1SRuebJmCyjZJ6z5i6vu_nrI0nR0kkE2c0',
    fsafe:    '1MbHJoJmq0w8hWz8rl9VXezmK-63MFmuK19lz3pu0dfc',
    plantmap: '1ewWyvaXGkRCvZxjUxBOHGY4PKdMHwKeTA5jTIod48LE',
    salespo:  '1lSWWLxyD0l83HfuiNI_iud6F9hopY4hoL0F_4P9nATc',
  };

  /**
   * Per logical table: how to load it in sheets mode and in supabase mode.
   *
   * sheets: array of { sheetId, gid } sources (multiple get concatenated)
   * supabase: { table, select?, filter?, columns }
   *   columns is an ordered list of { label, field, type, transform? } — the
   *   label matches what the sheet header would be so downstream parseGvizTable
   *   in page code sees the same column names.
   */
  const CONFIG = {
    invoices: {
      sheets: [
        { sheetId: SHEETS.invoices, gid: '1254110782' }, // invoices_23-25
        { sheetId: SHEETS.invoices, gid: '544460225'  }, // invoices_2025 (holds 2026 data)
      ],
      supabase: {
        table: 'sales_invoice_v',
        select: '*',
        columns: [
          { label: 'InvoiceDate',   field: 'invoice_date',   type: 'date'   },
          { label: 'CustomerName',  field: 'customer_name',  type: 'string' },
          { label: 'ProductCode',   field: 'product_code',   type: 'string' },
          { label: 'Cases',         field: 'cases',          type: 'number' },
          { label: 'Dollars',       field: 'dollars',        type: 'number' },
          { label: 'InvoiceNumber', field: 'invoice_number', type: 'string' },
          { label: 'Pounds',        field: 'pounds',         type: 'number' },
          { label: 'Variety',       field: 'variety',        type: 'string' },
          { label: 'Grade',         field: 'grade',          type: 'number' },
          { label: 'Year',          field: 'year',           type: 'number' },
          { label: 'Month',         field: 'month',          type: 'number' },
          { label: 'ISOYear',       field: 'iso_year',       type: 'number' },
          { label: 'ISOWeek',       field: 'iso_week',       type: 'number' },
          { label: 'DOW',           field: 'dow',            type: 'number' },
          { label: 'Farm',          field: 'farm_id',        type: 'string',
            transform: (v) => v === 'cuke' ? 'Cuke' : (v === 'lettuce' ? 'Lettuce' : v) },
          { label: 'CustomerGroup', field: 'customer_group', type: 'string' },
        ],
      },
    },
    // Same shape as 'invoices', but in prod mode reads sales_invoice_edi_v:
    // 2025 from the (frozen) sales_invoice table, 2026 from edi_qb_invoice_summary
    // (QuickBooks, synced nightly). Used by the sales page so its prod numbers stay
    // current after the sales_invoice sheet-feed stopped on 2026-07-12. Sheets mode
    // is identical to 'invoices'. (logistics still uses 'invoices' / sales_invoice_v.)
    invoices_edi: {
      sheets: [
        { sheetId: SHEETS.invoices, gid: '1254110782' }, // invoices_23-25
        { sheetId: SHEETS.invoices, gid: '544460225'  }, // invoices_2025 (holds 2026 data)
      ],
      supabase: {
        table: 'sales_invoice_edi_v',
        select: '*',
        columns: [
          { label: 'InvoiceDate',   field: 'invoice_date',   type: 'date'   },
          { label: 'CustomerName',  field: 'customer_name',  type: 'string' },
          { label: 'ProductCode',   field: 'product_code',   type: 'string' },
          { label: 'Cases',         field: 'cases',          type: 'number' },
          { label: 'Dollars',       field: 'dollars',        type: 'number' },
          { label: 'InvoiceNumber', field: 'invoice_number', type: 'string' },
          { label: 'Pounds',        field: 'pounds',         type: 'number' },
          { label: 'Variety',       field: 'variety',        type: 'string' },
          { label: 'Grade',         field: 'grade',          type: 'number' },
          { label: 'Year',          field: 'year',           type: 'number' },
          { label: 'Month',         field: 'month',          type: 'number' },
          { label: 'ISOYear',       field: 'iso_year',       type: 'number' },
          { label: 'ISOWeek',       field: 'iso_week',       type: 'number' },
          { label: 'DOW',           field: 'dow',            type: 'number' },
          { label: 'Farm',          field: 'farm_id',        type: 'string',
            transform: (v) => v === 'cuke' ? 'Cuke' : (v === 'lettuce' ? 'Lettuce' : v) },
          { label: 'CustomerGroup', field: 'customer_group', type: 'string' },
        ],
      },
    },
    // Sales-page Budget tab (prod-only; fetch with {mode:'prod'}). Raw per-SKU
    // budget-case tables + the price row; the page unpivots and aggregates to
    // farm / variety / product client-side (mirrors Michael Chege's dash logic).
    // SKU columns: kr,kw,kf,jr,jw,jf,ok,oj,lr,lw,lf,wr,ef,ar,wf,af.
    budget_week_raw: {
      supabase: {
        table: 'finance_sales_budget_week', select: '*', orderBy: 'isoweek',
        columns: ['year','isoweek','kr','kw','kf','jr','jw','jf','ok','oj','lr','lw','lf','wr','ef','ar','wf','af']
          .map(l => ({ label: l, field: l, type: 'number' })),
      },
    },
    budget_month_raw: {
      supabase: {
        table: 'finance_sales_budget_month', select: '*', orderBy: 'month',
        columns: ['year','month','kr','kw','kf','jr','jw','jf','ok','oj','lr','lw','lf','wr','ef','ar','wf','af']
          .map(l => ({ label: l, field: l, type: 'number' })),
      },
    },
    budget_prices: {
      supabase: {
        table: 'finance_sales_budget_prices', select: '*', orderBy: 'year',
        columns: ['year','kr','kw','kf','jr','jw','jf','ok','oj','lr','lw','lf','wr','ef','ar','wf','af']
          .map(l => ({ label: l, field: l, type: 'number' })),
      },
    },
    // Pre-aggregated invoice actuals for the Budget tab (avoids fetching ~24k raw
    // invoice rows on load). Summed by iso-week / month / farm / product, 2025+.
    sales_actuals: {
      supabase: {
        table: 'finance_sales_actuals_v', select: '*', orderBy: 'id',
        columns: [
          { label: 'ISOYear',     field: 'isoyear',      type: 'number' },
          { label: 'ISOWeek',     field: 'isoweek',      type: 'number' },
          { label: 'Year',        field: 'year',         type: 'number' },
          { label: 'Month',       field: 'month',        type: 'number' },
          { label: 'Farm',        field: 'farm_id',      type: 'string' },
          { label: 'ProductCode', field: 'product_code', type: 'string' },
          { label: 'Cases',       field: 'cases',        type: 'number' },
          { label: 'Dollars',     field: 'dollars',      type: 'number' },
          { label: 'Pounds',      field: 'pounds',       type: 'number' },
        ],
      },
    },
    // Day-aware YTD actuals for the Budget table so it ties to QB on a calendar
    // basis (Jan 1 -> today). Per year/farm/product: full-year and YTD-through-
    // today sums (the view uses today's HST date). ~31 rows.
    sales_actuals_ytd: {
      supabase: {
        table: 'finance_sales_actuals_ytd_v', select: '*', orderBy: 'year',
        columns: [
          { label: 'Year',        field: 'year',         type: 'number' },
          { label: 'Farm',        field: 'farm_id',      type: 'string' },
          { label: 'ProductCode', field: 'product_code', type: 'string' },
          { label: 'FYDollars',   field: 'fy_dollars',   type: 'number' },
          { label: 'FYCases',     field: 'fy_cases',     type: 'number' },
          { label: 'YTDDollars',  field: 'ytd_dollars',  type: 'number' },
          { label: 'YTDCases',    field: 'ytd_cases',    type: 'number' },
        ],
      },
    },
    // On-grade harvest (the "Grown" line) — SHEETS-only, because the nightly
    // sheets->Supabase grow migration is incomplete (Supabase lettuce is missing
    // 2025 entirely and lags 2026). gviz GROUP BYs pre-sum net weight by day so
    // the client only aggregates to iso-week. The Budget tab fetches both with
    // {mode:'sheets'} and builds the weekly grown series in buildHarvestRows().
    // grow_C_harvest: A=HarvestDate B=Year H=Variety(K/J/E) I=Grade L=NetWeight.
    grow_cuke_harvest_wk: {
      sheets: [
        { sheetId: SHEETS.grow, tab: 'grow_C_harvest',
          tq: "select A, H, I, sum(L) where B >= 2025 group by A, H, I label A 'HarvestDate', H 'Variety', I 'Grade', sum(L) 'Pounds'" },
      ],
    },
    // grow_L_seeding: N=harvestdate E=seedname P=greenhousenetweight (all grade 1).
    grow_lettuce_harvest_wk: {
      sheets: [
        { sheetId: SHEETS.grow, tab: 'grow_L_seeding',
          tq: "select N, E, sum(P) where P > 0 and YEAR(N) >= 2025 group by N, E label N 'HarvestDate', E 'SeedName', sum(P) 'Pounds'" },
      ],
    },
    // Daily-page invoices, pre-aggregated to daily-by-farm dollar totals (a
    // gviz GROUP BY acts as the "view"). The daily $ table and weekly chart
    // only ever sum Dollars by date×farm, so per-invoice rows aren't needed:
    // 2025 8027 rows -> 486, 2026 4652 -> ~344. The WHERE bakes in the same
    // filters the page used to apply client-side (drop 'Sales', require a
    // CustomerGroup). 23-25 tab cols: A=InvoiceDate E=Dollars J=Year C=ProductCode
    // O=Farm P=CustomerGroup.
    invoices_daily: {
      sheets: [
        { sheetId: SHEETS.invoices, gid: '1254110782',
          tq: "select A,O,sum(E) where J=2025 and C<>'Sales' and P is not null and P<>'' group by A,O label sum(E) 'Dollars', A 'InvoiceDate', O 'Farm'" },
        { sheetId: SHEETS.invoices, gid: '544460225',
          tq: "select A,O,sum(E) where C<>'Sales' and P is not null and P<>'' group by A,O label sum(E) 'Dollars', A 'InvoiceDate', O 'Farm'" },
      ],
      // Supabase: aggregated view sales_invoice_daily_v (719 rows, daily-by-farm,
      // 2025+; Sales/no-CustomerGroup already excluded) instead of ~23k raw rows.
      supabase: {
        table: 'sales_invoice_daily_v',
        select: '*',
        orderBy: 'invoice_date',
        columns: [
          { label: 'InvoiceDate', field: 'invoice_date', type: 'date'   },
          { label: 'Farm',        field: 'farm_id',      type: 'string',
            transform: (v) => v === 'cuke' ? 'Cuke' : (v === 'lettuce' ? 'Lettuce' : v) },
          { label: 'Dollars',     field: 'dollars',      type: 'number' },
        ],
      },
    },
    // Daily-page cuke harvest, pre-aggregated to date×GH×variety×grade net weight
    // (the daily table only shows one day's GH totals). 64k rows -> ~5.1k.
    // grow_C_harvest cols: A=HarvestDate B=Year F=HarvestDay G=Greenhouse
    // H=Variety I=Grade L=GreenhouseNetWeight.
    cuke_harvest_daily: {
      sheets: [
        { sheetId: SHEETS.grow, tab: 'grow_C_harvest',
          tq: "select A,G,H,I,sum(L),min(F) where B=2026 group by A,G,H,I label sum(L) 'GreenhouseNetWeight', min(F) 'DaysSinceSeed', A 'HarvestDate', G 'Greenhouse', H 'Variety', I 'Grade'" },
      ],
      supabase: {
        table: 'grow_cuke_harvest_daily_v',
        select: '*',
        orderBy: 'harvest_date',
        columns: [
          { label: 'HarvestDate',         field: 'harvest_date',          type: 'date'   },
          { label: 'Greenhouse',          field: 'greenhouse',            type: 'string' },
          { label: 'Variety',             field: 'variety',               type: 'string' },
          { label: 'Grade',               field: 'grade',                 type: 'string' },
          { label: 'GreenhouseNetWeight', field: 'greenhouse_net_weight', type: 'number' },
          { label: 'DaysSinceSeed',       field: 'days_since_seed',        type: 'number' },
        ],
      },
    },
    expenses: {
      // No dashboard currently reads expenses from sheet tabs directly; the
      // nightly sync is the only sheet consumer. Leaving sheets empty here
      // means fetchTable('expenses') only works in prod mode.
      sheets: [],
      supabase: {
        table: 'fin_expense_v',
        select: '*',
        columns: [
          { label: 'Txn Date',         field: 'txn_date',         type: 'date'    },
          { label: 'Payee',            field: 'payee_name',       type: 'string'  },
          { label: 'Description',      field: 'description',      type: 'string'  },
          { label: 'Account',          field: 'account_name',     type: 'string'  },
          { label: 'AccountRef',       field: 'account_ref',      type: 'string'  },
          { label: 'Class',            field: 'class_name',       type: 'string'  },
          { label: 'Amount',           field: 'amount',           type: 'number'  },
          { label: 'IsCredit',         field: 'is_credit',        type: 'boolean' },
          { label: 'EffectiveAmount',  field: 'effective_amount', type: 'number'  },
          { label: 'Macro',            field: 'macro_category',   type: 'string'  },
          { label: 'Year',             field: 'year',             type: 'number'  },
          { label: 'Month',            field: 'month',            type: 'number'  },
        ],
      },
    },
    cuke_harvest: {
      sheets: [
        { sheetId: SHEETS.grow, tab: 'grow_C_harvest',
          // Remap sheet's HarvestDay column to the CamelCase name the
          // dashboard reads for the Day column (days since seeding).
          label_map: { 'HarvestDay': 'DaysSinceSeed' } },
      ],
      supabase: {
        table: 'grow_cuke_harvest',
        select: '*',
        columns: [
          // SeedingDate must precede HarvestDate: parseGvizTable derives the
          // row's _y/_m/_d from the LAST date-typed column, and the daily page
          // filters on harvest date — so HarvestDate has to win.
          { label: 'SeedingDate',         field: 'seeding_date',           type: 'date'   },
          { label: 'HarvestDate',         field: 'harvest_date',           type: 'date'   },
          { label: 'Greenhouse',          field: 'greenhouse',             type: 'string' },
          { label: 'Variety',             field: 'variety',                type: 'string' },
          { label: 'Grade',               field: 'grade',                  type: 'string' },
          { label: 'GreenhouseNetWeight', field: 'greenhouse_net_weight',  type: 'number' },
          { label: 'DaysSinceSeed',       field: 'days_since_seed',        type: 'number' },
        ],
      },
    },
    lettuce_harvest: {
      sheets: [
        // grow_L_seeding carries both seeding config and harvest outcome.
        // - tq filters to cycles that have a harvest_date in 2026 (matches
        //   legacy dashboard behavior; forward-planned cycles with blank
        //   harvestdate are excluded)
        // - label_map rewrites the sheet's lowercase-with-trailing-space
        //   column headers to the CamelCase names dashboards expect
        { sheetId: SHEETS.grow, tab: 'grow_L_seeding', tq: 'SELECT * WHERE YEAR(N)=2026',
          // NB: fetchSheetGviz trims column labels before applying label_map,
          // so these keys must NOT have trailing spaces (the sheet headers do,
          // e.g. "pond ", but they're trimmed to "pond" before we map them).
          label_map: {
            'pond':                  'Pond',
            'side':                  'Side',
            'seedname':              'SeedName',
            'boardsperpond':         'BoardsPerPond',
            'poundsperboard':        'PoundsPerBoard',
            'greenhousenetweight':   'GreenhouseNetWeight',
            'harvestdate':           'HarvestDate',
            'variety':               'Variety',
          } },
      ],
      supabase: {
        // Base table (the grow_lettuce_harvest_v view does not exist in prod).
        // Base table already carries boards_per_pond / pounds_per_board /
        // greenhouse_net_weight directly, so no view-side reconstruction needed.
        table: 'grow_lettuce_harvest',
        select: '*',
        columns: [
          { label: 'HarvestDate',         field: 'harvest_date',           type: 'date'   },
          { label: 'Pond',                field: 'pond',                   type: 'string' },
          { label: 'SeedName',            field: 'seed_name',              type: 'string' },
          { label: 'BoardsPerPond',       field: 'boards_per_pond',        type: 'number' },
          { label: 'PoundsPerBoard',      field: 'pounds_per_board',       type: 'number' },
          { label: 'GreenhouseNetWeight', field: 'greenhouse_net_weight',  type: 'number' },
        ],
      },
    },
    // Packhouse (PH) lettuce weigh station — the second weight, measured in the
    // PH after the greenhouse (GH) weight. Prod-only: there is no sheets
    // equivalent, so callers must fetch with { mode: 'prod' }. Grain is
    // pond/side per harvest_date (A / B / AB), so consumers sum sides to a pond.
    lettuce_ph_weight: {
      sheets: [],
      supabase: {
        // Read the view, not the base table: prod exposes grow data through
        // _v views (base tables aren't reliably reachable via the API).
        table: 'grow_lettuce_pond_weight_v',
        select: 'harvest_date,pond,side,seed_name,number_of_boards,net_weight',
        orderBy: 'harvest_date',
        tiebreak: 'id',
        columns: [
          { label: 'HarvestDate', field: 'harvest_date',     type: 'date'   },
          { label: 'Pond',        field: 'pond',             type: 'string' },
          { label: 'Side',        field: 'side',             type: 'string' },
          { label: 'SeedName',    field: 'seed_name',        type: 'string' },
          { label: 'Boards',      field: 'number_of_boards', type: 'number' },
          { label: 'NetWeight',   field: 'net_weight',       type: 'number' },
        ],
      },
    },
    // Lettuce pond water level — current cm-below-top per pond, E/W averaged and
    // pond-mapped server-side by grow_lettuce_water_level_v (reading date comes
    // from the monitoring task's start_time, not the ETL stamp). Prod-only.
    lettuce_water_level: {
      sheets: [],
      supabase: {
        table: 'grow_lettuce_water_level_v',
        select: 'pond,reading_date,cm_below_top,n_readings',
        orderBy: 'pond',
        columns: [
          { label: 'Pond',        field: 'pond',         type: 'string' },
          { label: 'ReadingDate', field: 'reading_date', type: 'date'   },
          { label: 'CmBelowTop',  field: 'cm_below_top', type: 'number' },
          { label: 'NReadings',   field: 'n_readings',   type: 'number' },
        ],
      },
    },
    // --- plant-map source tables ---
    // Plant-map composes its sheet-shaped rows from four small tables
    // joined/pivoted client-side (660 rows total). No view needed.
    gh_rows: {
      sheets: [],
      supabase: {
        table: 'org_site_gh_row',
        select: 'id,site_id,row_num',
        orderBy: 'row_num',
        columns: [
          { label: 'id',           field: 'id',                 type: 'string' },
          { label: 'site_id',      field: 'site_id',            type: 'string' },
          { label: 'row_num',      field: 'row_num',            type: 'number' },
        ],
      },
    },
    gh_blocks: {
      sheets: [],
      supabase: {
        table: 'org_site_gh_block',
        select: 'site_id,block_num,name,row_num_from,row_num_to,direction',
        orderBy: 'block_num',
        columns: [
          { label: 'site_id',      field: 'site_id',      type: 'string' },
          { label: 'block_num',    field: 'block_num',    type: 'number' },
          { label: 'name',         field: 'name',         type: 'string' },
          { label: 'row_num_from', field: 'row_num_from', type: 'number' },
          { label: 'row_num_to',   field: 'row_num_to',   type: 'number' },
          { label: 'direction',    field: 'direction',    type: 'string' },
        ],
      },
    },
    row_plantings: {
      sheets: [],
      supabase: {
        table: 'grow_cuke_gh_row_planting',
        select: 'id,org_site_gh_row_id,scenario,grow_variety_id,grow_variety_id_2,plants_per_bag,num_bags',
        // Order by PK: org_site_gh_row_id has ties (one row per scenario)
        // so it isn't stable across the pagination boundary.
        orderBy: 'id',
        columns: [
          { label: 'row_id',        field: 'org_site_gh_row_id', type: 'string' },
          { label: 'scenario',      field: 'scenario',           type: 'string' },
          { label: 'variety',       field: 'grow_variety_id',    type: 'string' },
          { label: 'variety2',      field: 'grow_variety_id_2',  type: 'string' },
          { label: 'plants_per_bag',field: 'plants_per_bag',     type: 'number' },
          { label: 'num_bags',      field: 'num_bags',           type: 'number' },
        ],
      },
    },
    cuke_seed_batches: {
      sheets: [],
      supabase: {
        table: 'grow_cuke_seed_batch',
        select: 'site_id,seeding_date,next_bag_change_date',
        orderBy: 'seeding_date',
        columns: [
          { label: 'site_id',              field: 'site_id',              type: 'string' },
          { label: 'seeding_date',         field: 'seeding_date',         type: 'date'   },
          { label: 'next_bag_change_date', field: 'next_bag_change_date', type: 'date'   },
        ],
      },
    },
    // Grow seeding plan — all ponds, used by pack plan for row/lb estimates
    lettuce_grow_plan: {
      sheets: [
        { sheetId: SHEETS.grow, tab: 'grow_L_seeding',
          tq: 'SELECT B,C,D,J,M,O,P,AH WHERE M IS NOT NULL ORDER BY M,B',
          label_map: {
            'pond':                'Pond',
            'side':                'Side',
            'variety':             'Variety',
            'boardsperpond':       'Boards',
            'expectedharvestdate': 'HarvestDate',
            'poundsperboard':      'LbPerBoard',
            'greenhousenetweight': 'ExpLb',
            'rowspercycle':        'Rows',
          } },
      ],
      supabase: { table: 'grow_lettuce_harvest', select: '*', orderBy: 'harvest_date', tiebreak: 'id',
        columns: [
          { label: 'Pond',        field: 'pond',                  type: 'string' },
          { label: 'HarvestDate', field: 'harvest_date',          type: 'date'   },
          { label: 'Boards',      field: 'boards_per_pond',       type: 'number' },
          { label: 'LbPerBoard',  field: 'pounds_per_board',      type: 'number' },
          { label: 'ExpLb',       field: 'greenhouse_net_weight', type: 'number' },
        ] },
    },
    // PO lines by pack date — used by pack plan
    lettuce_pack_orders: {
      sheets: [
        { sheetId: SHEETS.salespo, gid: '1670277892',
          // Only fetch rows with a PackDate for LW/LR/LF/WR (AE=PackDate, D=ProductCode, E=PurchaseOrderQuantity)
          tq: "SELECT AE,D,E WHERE AE IS NOT NULL AND (D='LW' OR D='LR' OR D='LF' OR D='WR')",
          label_map: {
            'ProductCode':           'SKU',
            'PurchaseOrderQuantity': 'Cases',
          } },
      ],
      supabase: {
        // Bucket orders by the stored EXPECTED pack date (estimated_pack_date on
        // sales_po_line, surfaced via sales_lettuce_ph_v — the same view the
        // aloha Lettuce P&H page uses). invoice_date is exposed only as a
        // client-side fallback (see ordersByDate) when estimated_pack_date is
        // missing; it is NOT the bucketing key. (The actual pack date lives in
        // the fulfillment/pack_session tables and is a separate concept.)
        table: 'sales_lettuce_ph_v',
        select: 'estimated_pack_date,invoice_date,sales_product_id,order_quantity',
        orderBy: 'estimated_pack_date',
        tiebreak: 'id',
        columns: [
          { label: 'PackDate', field: 'estimated_pack_date', type: 'date'   },
          { label: 'InvDate',  field: 'invoice_date',        type: 'date'   },
          { label: 'SKU',      field: 'sales_product_id',    type: 'string' },
          { label: 'Cases',    field: 'order_quantity',      type: 'number' },
        ],
      },
    },
    // Cuke PO lines by INVOICE date — used by the daily-page cuke PO table.
    // Prod-only (fetch with {mode:'prod'}); no sheets equivalent. Sourced from
    // sales_cuke_po_v (mirrors sales_lettuce_ph_v but farm_id='Cuke'), one row
    // per PO line: KW/KR/KF/JW/JR (+EF). Client buckets by invoice_date and
    // sums cases per SKU; pounds are computed client-side from CUKE_LB.
    cuke_pack_orders: {
      sheets: [],
      supabase: {
        table: 'sales_cuke_po_v',
        select: 'invoice_date,sales_product_id,order_quantity,pounds',
        orderBy: 'invoice_date',
        tiebreak: 'id',
        columns: [
          { label: 'InvDate', field: 'invoice_date',     type: 'date'   },
          { label: 'SKU',     field: 'sales_product_id',  type: 'string' },
          { label: 'Cases',   field: 'order_quantity',    type: 'number' },
          // pounds = order_quantity * case_net_weight (single source of truth
          // is sales_product.case_net_weight; do NOT hardcode weights again).
          { label: 'Pounds',  field: 'pounds',            type: 'number' },
        ],
      },
    },
    // --- Food safety: EMP (environmental pathogen) results ---
    // Sheets is the live source today (Supabase is a placeholder until the
    // fsafe_result pipeline is current). Page reads: SampleDateTime, TestName,
    // PositiveResults ('true'/'false' text), Farm, SiteName.
    fsafe_emp: {
      sheets: [
        // Only positive results are needed for the pathogen-free counter, so
        // filter server-side (1482 rows -> ~130). Columns: B=Farm, E=SiteName,
        // F=TestName, H=SampleDateTime, M=PositiveResults.
        { sheetId: SHEETS.fsafe, tab: 'fsafe_log_emp',
          tq: "select B,E,F,H,M where lower(M) = 'true'" },
      ],
      // Placeholder: maps fsafe_result onto the same column names. PositiveResults
      // is derived from result_pass (a pathogen positive => result_pass = false).
      supabase: {
        table: 'fsafe_result', select: '*', orderBy: 'sampled_at', tiebreak: 'id',
        columns: [
          { label: 'SampleDateTime',  field: 'sampled_at',         type: 'date'   },
          { label: 'TestName',        field: 'fsafe_lab_test_id',  type: 'string' },
          { label: 'PositiveResults', field: 'result_pass',        type: 'string',
            transform: (v) => (v === false ? 'true' : 'false') },
          { label: 'Farm',            field: 'farm_id',            type: 'string' },
          { label: 'SiteName',        field: 'site_id',            type: 'string' },
        ],
      },
    },
    // --- Food safety: corrective-action log ---
    // Page reads: ReportedDate, Log, Farm, SiteName, Warning, CorrectiveAction,
    // OtherCorrectiveAction.
    fsafe_ca: {
      sheets: [
        { sheetId: SHEETS.fsafe, tab: 'fsafe_log_corrective_action' },
      ],
      // Placeholder: ops_corrective_action_taken is only lightly populated today.
      supabase: {
        table: 'ops_corrective_action_taken', select: '*', orderBy: 'created_at',
        columns: [
          { label: 'ReportedDate',          field: 'created_at',         type: 'date'   },
          { label: 'Log',                   field: 'ops_template_id',    type: 'string' },
          { label: 'Farm',                  field: 'farm_id',            type: 'string' },
          { label: 'Warning',               field: 'result_description', type: 'string' },
          { label: 'CorrectiveAction',      field: 'other_action',       type: 'string' },
          { label: 'OtherCorrectiveAction', field: 'notes',              type: 'string' },
        ],
      },
    },
    // --- Food safety: GH pre-op checklists (drives data-quality checks) ---
    // Only Checked Date + Approved to Harvest are needed. Cuke col I / lettuce
    // col S = 'Approved to Harvest'. Filtered to 2026 server-side.
    fsafe_cuke_preop: {
      sheets: [
        // B = Greenhouse(s) list (e.g. "01+03+05+06+08+HI+HK+KO") drives the
        // expected GH count for the cuke check.
        { sheetId: SHEETS.fsafe, tab: 'fsafe_log_C_gh_pre',
          tq: "select A,B,I where A >= date '2026-01-01'" },
      ],
    },
    fsafe_lettuce_preop: {
      sheets: [
        { sheetId: SHEETS.fsafe, tab: 'fsafe_log_L_gh_pre',
          tq: "select A,S where A >= date '2026-01-01'" },
      ],
    },
    // --- Data-quality rules (prod Supabase; fetched with {mode:'prod'}) ---
    // Results are written to data_check_result via getClient('prod').
    data_check_rule: {
      sheets: [],
      supabase: {
        table: 'data_check_rule', select: '*', orderBy: 'id',
        columns: [
          { label: 'id',             field: 'id',             type: 'string'  },
          { label: 'name',           field: 'name',           type: 'string'  },
          { label: 'check_type',     field: 'check_type',     type: 'string'  },
          { label: 'preop_table',    field: 'preop_table',    type: 'string'  },
          { label: 'preop_date_col', field: 'preop_date_col', type: 'string'  },
          { label: 'preop_flag_col', field: 'preop_flag_col', type: 'string'  },
          { label: 'harvest_key',       field: 'harvest_key',       type: 'string'  },
          { label: 'dimension',         field: 'dimension',         type: 'string'  },
          { label: 'expected',          field: 'expected',          type: 'string'  },
          { label: 'preop_members_col', field: 'preop_members_col', type: 'string'  },
          { label: 'preop_members_sep', field: 'preop_members_sep', type: 'string'  },
          { label: 'message',           field: 'message',           type: 'string'  },
          { label: 'severity',          field: 'severity',          type: 'string'  },
          { label: 'is_active',         field: 'is_active',         type: 'boolean' },
        ],
      },
    },
    // --- Lettuce scheduling (sheets only for now) ---
    // All 2026 cycles (filtered by date only — seed/exp-harvest/harvest in 2026,
    // regardless of cycle status). Cols: B=pond C=side
    // D=variety E=seedname I=seedsperboard J=boardsperpond K=seedingdate
    // L=ponddate M=expectedharvestdate N=harvestdate AC=cyclestatus.
    lettuce_schedule: {
      sheets: [
        { sheetId: SHEETS.grow, tab: 'grow_L_seeding',
          tq: "select B,C,D,E,I,J,K,L,M,N,AC where YEAR(K)=2026 or YEAR(M)=2026 or YEAR(N)=2026",
          label_map: {
            pond: 'Pond', side: 'Side', variety: 'Variety', seedname: 'SeedName',
            seedsperboard: 'SeedsPerBoard', boardsperpond: 'Boards', seedingdate: 'SeedingDate',
            ponddate: 'PondDate', expectedharvestdate: 'ExpHarvestDate', harvestdate: 'HarvestDate',
            cyclestatus: 'Status',
          } },
      ],
    },
    // --- WC / TDI (prod-only aggregate views; no per-employee PII) ---
    // The page fetches these with {mode:'prod'}. The views pre-aggregate so the
    // public anon key never sees names / net pay / deductions. Exclusion rules
    // (HF, board, per diem/auto, OT premium, weekly cap) live in the views.
    wc_basis_monthly: {
      sheets: [],
      supabase: {
        table: 'wc_basis_monthly_v', orderBy: 'wc_code',
        select: 'year,month,wc_code,base_wages,overtime',
        columns: [
          { label: 'Year',  field: 'year',       type: 'number' },
          { label: 'Month', field: 'month',      type: 'number' },
          { label: 'Code',  field: 'wc_code',    type: 'string' },
          { label: 'Base',  field: 'base_wages', type: 'number' },
          { label: 'OT',    field: 'overtime',   type: 'number' },
        ],
      },
    },
    wc_basis_paycheck: {
      sheets: [],
      supabase: {
        table: 'wc_basis_paycheck_v', orderBy: 'check_date',
        select: 'year,month,check_date,wc_code,base_wages,overtime',
        columns: [
          { label: 'Year',  field: 'year',       type: 'number' },
          { label: 'Month', field: 'month',      type: 'number' },
          { label: 'Check', field: 'check_date', type: 'date'   },
          { label: 'Code',  field: 'wc_code',    type: 'string' },
          { label: 'Base',  field: 'base_wages', type: 'number' },
          { label: 'OT',    field: 'overtime',   type: 'number' },
        ],
      },
    },
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
    tdi_quarterly: {
      sheets: [],
      supabase: {
        table: 'tdi_quarterly_v', orderBy: 'quarter',
        select: 'year,quarter,gross_wages,taxable_wages,last_check,male,female',
        columns: [
          { label: 'Year',      field: 'year',          type: 'number' },
          { label: 'Quarter',   field: 'quarter',       type: 'number' },
          { label: 'Gross',     field: 'gross_wages',   type: 'number' },
          { label: 'Taxable',   field: 'taxable_wages', type: 'number' },
          { label: 'LastCheck', field: 'last_check',    type: 'date'   },
          { label: 'Male',      field: 'male',          type: 'number' },
          { label: 'Female',    field: 'female',        type: 'number' },
        ],
      },
    },
    wc_tdi_param: {
      sheets: [],
      supabase: {
        table: 'wc_tdi_param', orderBy: 'year',
        select: 'year,weekly_wage_base_cap,employee_rate_pct',
        columns: [
          { label: 'Year', field: 'year',                 type: 'number' },
          { label: 'Cap',  field: 'weekly_wage_base_cap',  type: 'number' },
          { label: 'Rate', field: 'employee_rate_pct',     type: 'number' },
        ],
      },
    },
    wc_audit_paycheck: {
      sheets: [],
      supabase: {
        table: 'hr_wc_audit_paycheck_v', orderBy: 'check_date',
        select: 'year,month,check_date,wc_code,gross_wage,overtime_pay,subject_wage',
        columns: [
          { label: 'Year',    field: 'year',         type: 'number' },
          { label: 'Month',   field: 'month',        type: 'number' },
          { label: 'Check',   field: 'check_date',   type: 'date'   },
          { label: 'Code',    field: 'wc_code',      type: 'string' },
          { label: 'Gross',   field: 'gross_wage',   type: 'number' },
          { label: 'OT',      field: 'overtime_pay', type: 'number' },
          { label: 'Subject', field: 'subject_wage', type: 'number' },
        ],
      },
    },
    wc_audit_headcount: {
      sheets: [],
      supabase: {
        table: 'hr_wc_audit_headcount_monthly_v', orderBy: 'month',
        select: 'year,month,employees',
        columns: [
          { label: 'Year',  field: 'year',      type: 'number' },
          { label: 'Month', field: 'month',     type: 'number' },
          { label: 'Emp',   field: 'employees', type: 'number' },
        ],
      },
    },
    // Additional logical tables get added here as each dashboard migrates.
  };

  // =========================================================================
  // Supabase client (lazy)
  // =========================================================================

  let supabasePromise = null;
  let cachedClient = {};

  function loadSupabaseLib() {
    if (supabasePromise) return supabasePromise;
    supabasePromise = new Promise((resolve, reject) => {
      if (global.supabase && global.supabase.createClient) {
        resolve(global.supabase);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.onload = () => {
        if (global.supabase && global.supabase.createClient) resolve(global.supabase);
        else reject(new Error('supabase-js loaded but createClient missing'));
      };
      script.onerror = () => reject(new Error('Failed to load supabase-js from CDN'));
      document.head.appendChild(script);
    });
    return supabasePromise;
  }

  async function getSupabaseClient(mode) {
    if (cachedClient[mode]) return cachedClient[mode];
    const { createClient } = await loadSupabaseLib();
    const proj = SUPABASE_PROJECTS[mode];
    if (!proj) throw new Error('Unknown supabase project for mode: ' + mode);
    cachedClient[mode] = createClient(proj.url, proj.anon);
    return cachedClient[mode];
  }

  // =========================================================================
  // Sheets fetch (gviz JSONP)
  // =========================================================================

  function fetchSheetGviz(sheetId, source) {
    // source: { gid } or { tab } or { tab, tq }
    return new Promise((resolve, reject) => {
      const tag = source.gid || source.tab || '0';
      const cbName = '_cb_' + String(tag).replace(/[^a-z0-9_]/gi, '') + '_' + Math.floor(Math.random() * 1e9);
      let url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json;responseHandler:${cbName}`;
      if (source.gid) url += `&gid=${source.gid}`;
      if (source.tab) url += `&sheet=${encodeURIComponent(source.tab)}`;
      if (source.tq)  url += `&tq=${encodeURIComponent(source.tq)}`;
      const timer = setTimeout(() => {
        delete global[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
        reject(new Error('JSONP timeout: ' + tag));
      }, 15000);
      global[cbName] = function (resp) {
        clearTimeout(timer);
        delete global[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
        if (!resp || resp.status === 'error') { reject(resp ? resp.errors : 'no response'); return; }
        // Trim trailing spaces from column labels before label_map so label_map
        // keys don't need to include trailing spaces that some sheets produce.
        if (resp.table && resp.table.cols) {
          resp.table.cols = resp.table.cols.map(c => ({...c, label: (c.label || '').trim()}));
        }
        resolve(resp.table);
      };
      const script = document.createElement('script');
      script.src = url;
      script.onerror = () => { clearTimeout(timer); delete global[cbName]; reject('Network error: ' + tag); };
      document.head.appendChild(script);
    });
  }

  function mergeGvizTables(tables) {
    if (!tables.length) return { cols: [], rows: [] };
    return {
      cols: tables[0].cols,
      rows: tables.flatMap(t => t.rows || []),
    };
  }

  // =========================================================================
  // Supabase -> gviz-shape
  // =========================================================================

  function toGvizDateString(val) {
    if (!val) return null;
    // Supabase gives ISO date (YYYY-MM-DD) or ISO datetime. Extract Y/M/D.
    const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1; // gviz uses 0-indexed months
    const d = parseInt(m[3], 10);
    return { v: `Date(${y},${mo},${d})`, f: `${m[2]}/${m[3]}/${m[1]}` };
  }

  function rowsToGviz(supaRows, columns) {
    const cols = columns.map((c, i) => ({
      id: String.fromCharCode(65 + (i % 26)),
      label: c.label,
      type: c.type,
    }));
    const rows = supaRows.map((r) => {
      const c = columns.map((col) => {
        let v = r[col.field];
        if (col.transform) v = col.transform(v);
        if (v === null || v === undefined) return { v: null };
        if (col.type === 'date') {
          const d = toGvizDateString(v);
          return d || { v: null };
        }
        if (col.type === 'number') {
          const n = typeof v === 'number' ? v : parseFloat(v);
          return isNaN(n) ? { v: null } : { v: n, f: String(v) };
        }
        if (col.type === 'boolean') {
          return { v: !!v };
        }
        return { v: String(v) };
      });
      return { c };
    });
    return { cols, rows };
  }

  // =========================================================================
  // Public API: fetchTable
  // =========================================================================

  async function fetchTable(logicalName, opts = {}) {
    const conf = CONFIG[logicalName];
    if (!conf) throw new Error('Unknown logical table: ' + logicalName);
    // Sources are pinned by each caller via opts.mode (the global sheets/prod
    // toggle is gone). If a caller omits it, default to prod when the table has
    // a Supabase source, else fall back to sheets.
    const mode = opts.mode || (conf.supabase ? 'prod' : 'sheets');

    if (mode === 'sheets') {
      if (!conf.sheets || !conf.sheets.length) {
        throw new Error(`Logical table '${logicalName}' has no sheets source; pick prod mode`);
      }
      const tables = await Promise.all(conf.sheets.map(async s => {
        const t = await fetchSheetGviz(s.sheetId, s);
        // Optional label_map: rewrite column labels (e.g. the grow sheet
        // has lowercase-with-trailing-space headers like "pond " that the
        // dashboards can't read as r.Pond).
        if (s.label_map && t.cols) {
          t.cols = t.cols.map(c => ({ ...c, label: s.label_map[c.label] || c.label }));
        }
        return t;
      }));
      return mergeGvizTables(tables);
    }

    // prod (Supabase)
    const sc = conf.supabase;
    if (!sc) throw new Error(`Logical table '${logicalName}' has no supabase source`);
    const client = await getSupabaseClient(mode);
    const pageSize = 1000;
    const all = [];
    const orderBy = sc.orderBy || 'id';
    let page = 0;
    while (true) {
      // Build a fresh query each iteration — supabase-js PostgrestBuilder
      // state is not reliably reusable across awaits, and pagination MUST
      // order by a stable column or rows can appear twice across pages.
      let query = client.from(sc.table).select(sc.select || '*').order(orderBy, { ascending: true });
      // Secondary unique sort key: orderBy alone (e.g. a date) has many tied
      // rows, and Postgres gives no stable order for ties across separate
      // range() requests — rows near page boundaries can be silently dropped
      // or duplicated on multi-page fetches. Opt-in via `tiebreak` because
      // some aggregate views have no id column.
      if (sc.tiebreak && sc.tiebreak !== orderBy) query = query.order(sc.tiebreak, { ascending: true });
      if (opts.filters) {
        for (const [col, val] of Object.entries(opts.filters)) {
          query = query.eq(col, val);
        }
      }
      const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      all.push(...data);
      if (data.length < pageSize) break;
      page++;
    }
    return rowsToGviz(all, sc.columns);
  }

  // =========================================================================
  // Export
  // =========================================================================

  // Expose raw client for write paths (pages doing direct .update() / .insert()).
  // Defaults to prod — the only live Supabase project (no sheets client exists).
  async function getClient(mode) {
    return getSupabaseClient(mode || 'prod');
  }

  global.DataSource = {
    fetchTable,
    getClient,
    CONFIG, // exposed for debugging / extensions
    SUPABASE_PROJECTS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
