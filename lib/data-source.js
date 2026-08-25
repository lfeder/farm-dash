/**
 * Shared data-source abstraction for dashboards.
 *
 * One backend: the Supabase prod project (zdvpqygiqavwpxljpvqw). Google Sheets
 * was switched off on 2026-08-09 and the last two feeds still reading it —
 * weekly cuke and lettuce harvest, on the Sales page — moved to
 * grow_harvest_weekly_v on 2026-08-25, at which point the gviz fetcher, the
 * sheet IDs and the { mode: 'sheets' } branch were deleted rather than left
 * one URL parameter away from being live again.
 *
 * Each logical table name (e.g. 'invoices') maps to a Supabase view or table.
 * fetchTable() still returns a gviz-shaped {cols, rows}, because that is the
 * shape every page already parses — the shape outlived the source.
 *
 * `mode` is accepted and ignored, so the existing { mode: 'prod' } call sites
 * keep working.
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


  /**
   * Per logical table: how to load it in sheets mode and in supabase mode.
   *
   * supabase: { table, select?, filter?, columns }
   *   columns is an ordered list of { label, field, type, transform? } — the
   *   label matches what the sheet header would be so downstream parseGvizTable
   *   in page code sees the same column names.
   */
  // Rolling date floor for prod fetches: ISO date N days before today. Keeps
  // the daily page's payload bounded as history grows.
  const daysAgo = n => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const yearStart = () => new Date().getUTCFullYear() + '-01-01';

  const CONFIG = {
    invoices: {
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
    // Ordered vs fulfilled cases for the Budget tab's "% short" charts. Summed
    // by iso-week / month / farm / product from the PO book, 2025+. Excludes the
    // Trash/Donation dispositions, the KFree/JFree comp products and the zero-
    // quantity always_on_po shells; bucketed on sales_po.order_date so ordered
    // and fulfilled always land in the same period.
    po_fill: {
      supabase: {
        table: 'finance_po_fill_v', select: '*', orderBy: 'id',
        columns: [
          { label: 'ISOYear',     field: 'isoyear',      type: 'number' },
          { label: 'ISOWeek',     field: 'isoweek',      type: 'number' },
          { label: 'Year',        field: 'year',         type: 'number' },
          { label: 'Month',       field: 'month',        type: 'number' },
          { label: 'Farm',        field: 'farm_id',      type: 'string' },
          { label: 'ProductCode', field: 'product_code', type: 'string' },
          { label: 'Ordered',     field: 'ordered',      type: 'number' },
          { label: 'Fulfilled',   field: 'fulfilled',    type: 'number' },
        ],
      },
    },
    // On-grade harvest — the "Grown" line on the Budget tab.
    // Weekly harvested pounds, both crops, straight out of prod. Replaces the
    // pair of gviz aggregations over grow_C_harvest and grow_L_seeding that fed
    // this before — those sheets stopped being written on 2026-08-09, so the
    // Sales page had been charting a frozen picture ever since. The view
    // already emits the exact shape the page built by hand: isoyear, isoweek,
    // year, month, farm, variety, grade, pounds_grown.
    grow_harvest_weekly: {
      supabase: {
        table: 'grow_harvest_weekly_v', select: '*',
        orderBy: 'isoyear', tiebreak: 'isoweek',
        columns: [
          { label: 'isoyear',       field: 'isoyear',       type: 'number' },
          { label: 'isoweek',       field: 'isoweek',       type: 'number' },
          { label: 'year',          field: 'year',          type: 'number' },
          { label: 'month',         field: 'month',         type: 'number' },
          { label: 'farm',          field: 'farm',          type: 'string' },
          { label: 'variety',       field: 'variety',       type: 'string' },
          { label: 'grade',         field: 'grade',         type: 'number' },
          { label: 'pounds_grown',  field: 'pounds_grown',  type: 'number' },
        ],
      },
    },
    // Daily-page invoices, pre-aggregated to daily-by-farm dollar totals (a
    // gviz GROUP BY acts as the "view"). The daily $ table and weekly chart
    // only ever sum Dollars by date×farm, so per-invoice rows aren't needed:
    // 2025 8027 rows -> 486, 2026 4652 -> ~344. The WHERE bakes in the same
    // filters the page used to apply client-side (drop 'Sales', require a
    // CustomerGroup). 23-25 tab cols: A=InvoiceDate E=Dollars J=Year C=ProductCode
    // O=Farm P=CustomerGroup.
    invoices_daily: {
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
      supabase: {
        table: 'grow_cuke_harvest_daily_v',
        select: '*',
        // Day-scoped: the daily page only ever reads this filtered to the
        // reference date, so fetch that one day (~40 rows) instead of a year
        // (~6.9k). The year floor this replaces was itself replacing a
        // hardcoded `where B=2026` in the sheets query.
        dateCol: 'harvest_date',
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
      supabase: {
        // GH weigh data lives on grow_lettuce_seed_batch (the app writes the
        // harvest outcome back onto the seeding row, like the old grow_L_seeding
        // sheet). grow_lettuce_gh_harvest_v derives pond/side from
        // site_id/batch_code and computes net weight = boards × lb/board
        // (no stored GH net weight). View filters to is_deleted=false and
        // harvest_date not null.
        table: 'grow_lettuce_gh_harvest_v',
        select: 'harvest_date,pond,side,seed_name,boards_per_pond,pounds_per_board,greenhouse_net_weight,max_lb',
        // Day-scoped: only ever read for the reference date.
        dateCol: 'harvest_date',
        orderBy: 'harvest_date',
        tiebreak: 'id',
        columns: [
          { label: 'HarvestDate',         field: 'harvest_date',           type: 'date'   },
          { label: 'Pond',                field: 'pond',                   type: 'string' },
          { label: 'Side',                field: 'side',                   type: 'string' },
          { label: 'SeedName',            field: 'seed_name',              type: 'string' },
          { label: 'BoardsPerPond',       field: 'boards_per_pond',        type: 'number' },
          { label: 'PoundsPerBoard',      field: 'pounds_per_board',       type: 'number' },
          { label: 'GreenhouseNetWeight', field: 'greenhouse_net_weight',  type: 'number' },
          // max_lb: lb/board the batch would yield if cut for max weight; the
          // crew cuts for quality (height recorded), so this is the reported
          // GH lb figure going forward.
          { label: 'MaxLb',               field: 'max_lb',                 type: 'number' },
        ],
      },
    },
    // Packhouse (PH) lettuce weigh station — the second weight, measured in the
    // PH after the greenhouse (GH) weight. Prod-only: there is no sheets
    // equivalent, so callers must fetch with { mode: 'prod' }. Grain is
    // pond/side per harvest_date (A / B / AB), so consumers sum sides to a pond.
    lettuce_ph_weight: {
      supabase: {
        // Read the view, not the base table: prod exposes grow data through
        // _v views (base tables aren't reliably reachable via the API).
        table: 'grow_lettuce_pond_weight_v',
        select: 'harvest_date,pond,side,seed_name,number_of_boards,net_weight',
        // Day-scoped: only ever read for the reference date.
        dateCol: 'harvest_date',
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
      supabase: {
        table: 'org_site_cuke_gh_row',
        select: 'id,site_id,row_num:row_number',
        orderBy: 'row_number',
        columns: [
          { label: 'id',           field: 'id',                 type: 'string' },
          { label: 'site_id',      field: 'site_id',            type: 'string' },
          { label: 'row_num',      field: 'row_num',            type: 'number' },
        ],
      },
    },
    gh_blocks: {
      supabase: {
        table: 'org_site_cuke_gh_block',
        select: 'site_id,block_num:block_number,name,row_num_from:row_number_from,row_num_to:row_number_to,direction',
        orderBy: 'block_number',
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
      supabase: {
        table: 'grow_cuke_gh_row_planting',
        select: 'id,org_site_cuke_gh_row_id,scenario,grow_variety_id,grow_variety_id_2,plants_per_bag,num_bags',
        // Order by PK: org_site_cuke_gh_row_id has ties (one row per scenario)
        // so it isn't stable across the pagination boundary.
        orderBy: 'id',
        columns: [
          { label: 'row_id',        field: 'org_site_cuke_gh_row_id', type: 'string' },
          { label: 'scenario',      field: 'scenario',           type: 'string' },
          { label: 'variety',       field: 'grow_variety_id',    type: 'string' },
          { label: 'variety2',      field: 'grow_variety_id_2',  type: 'string' },
          { label: 'plants_per_bag',field: 'plants_per_bag',     type: 'number' },
          { label: 'num_bags',      field: 'num_bags',           type: 'number' },
        ],
      },
    },
    cuke_seed_batches: {
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
      // Placeholder: maps fsafe_result onto the same column names. PositiveResults
      // is derived from result_pass (a pathogen positive => result_pass = false).
      supabase: {
        table: 'fsafe_result',
        // Mirrors the sheets `where lower(M)='true'`: only pathogen positives
        // feed the counter, so filter server-side (18k rows -> ~100) and select
        // only the five columns the page maps.
        select: 'sampled_at,fsafe_lab_test_id,result_pass,farm_id,site_id,id',
        // is_deleted rows are soft-deleted mistakes/test entries -- they were
        // counting as real hits and resetting the pathogen-free counter.
        where: [
          { op: 'eq', col: 'result_pass', val: false },
          { op: 'eq', col: 'is_deleted',  val: false },
        ],
        orderBy: 'sampled_at', tiebreak: 'id',
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
      // Placeholder: ops_corrective_action_taken is only lightly populated today.
      supabase: {
        table: 'ops_corrective_action_taken',
        select: 'created_at,ops_template_id,farm_id,result_description,other_action,notes',
        where: [{ op: 'gte', col: 'created_at', val: () => daysAgo(120) }],
        orderBy: 'created_at',
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
    // --- Data-quality checks: what SHOULD have harvested on a given day ---
    // Cuke: greenhouses with any food-safety log filed that day (pre OR post).
    // Reads fsafe_cuke_gh_checked_v because ops_task_tracker and org_site are
    // both invisible to the anon key -- the view is a narrower grant than
    // opening those two tables. Replaces the old pre-op feeds, which needed
    // ops_template_result + ops_template_question just to resolve an
    // "Approved to Harvest" answer.
    cuke_checked_gh: {
      supabase: {
        table: 'fsafe_cuke_gh_checked_v',
        select: 'checked_date,greenhouses,gh_count',
        where: [{ op: 'eq', col: 'org_id', val: 'hawaii_farming' }],
        orderBy: 'checked_date', tiebreak: 'checked_date',
        dateCol: 'checked_date',
        columns: [
          { label: 'Checked Date',  field: 'checked_date', type: 'date'   },
          { label: 'Greenhouse(s)', field: 'greenhouses',  type: 'string' },
          { label: 'Count',         field: 'gh_count',     type: 'number' },
        ],
      },
    },
    // Lettuce: ponds scheduled to harvest that day, straight from the seed
    // batches. No pre-op involved and no hardcoded pond count -- this follows
    // reality when a pond goes offline or a lane is split.
    lettuce_scheduled_ponds: {
      supabase: {
        table: 'grow_lettuce_seed_batch',
        select: 'site_id,harvest_date',
        where: [
          { op: 'eq', col: 'org_id',     val: 'hawaii_farming' },
          { op: 'eq', col: 'is_deleted', val: false },
        ],
        orderBy: 'harvest_date', tiebreak: 'site_id',
        dateCol: 'harvest_date',
        columns: [
          { label: 'Harvest Date', field: 'harvest_date', type: 'date'   },
          { label: 'Site',         field: 'site_id',      type: 'string' },
        ],
      },
    },
    // --- Data-quality rules (prod Supabase; fetched with {mode:'prod'}) ---
    // Results are written to data_check_result via getClient('prod').
    data_check_rule: {
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
    // Daily harvest-photo gallery, read straight off the harvest. One row per
    // lettuce batch cut on the day, already resolved to its crop group, so the
    // page needs no variety mapping. Day-scoped: the caller passes the date the
    // report is showing, so the gallery moves with the Today/Yesterday toggle.
    //
    // The three states the tile shows are read off the absence of things: no
    // row for a group means it was not harvested, a row with no photo_path
    // means it was harvested and not photographed. There is no status column
    // and no snapshot — dash_crop_photo was retired 2026-08-25 once it turned
    // out the page had been allowed to read the batches all along.
    crop_harvest: {
      supabase: {
        table: 'dash_crop_harvest_v', select: '*',
        orderBy: 'sort_order', tiebreak: 'batch_code', dateCol: 'harvest_date',
        columns: [
          { label: 'group_id',     field: 'group_id',     type: 'string' },
          { label: 'label',        field: 'label',        type: 'string' },
          { label: 'sort_order',   field: 'sort_order',   type: 'number' },
          { label: 'harvest_date', field: 'harvest_date', type: 'string' },
          { label: 'photo_path',   field: 'photo_path',   type: 'string' },
          { label: 'batch_code',   field: 'batch_code',   type: 'string' },
          { label: 'cultivar',     field: 'cultivar',     type: 'string' },
        ],
      },
    },
    // The four crop groups themselves. Fetched separately because a group with
    // no harvest that day has no row in crop_harvest, and "not harvested" is
    // one of the three things a tile has to be able to say.
    crop_groups: {
      supabase: {
        table: 'dash_crop_group', select: '*',
        orderBy: 'sort_order', where: [{ col: 'is_active', op: 'eq', val: true }],
        columns: [
          { label: 'id',         field: 'id',         type: 'string' },
          { label: 'label',      field: 'label',      type: 'string' },
          { label: 'sort_order', field: 'sort_order', type: 'number' },
        ],
      },
    },
    // --- Lettuce scheduling ---
    // Primary source is now prod Supabase (lettuce_schedule_v over
    // grow_lettuce_seed_batch, the app's table — Michael's sheet import landed
    // 08/04).
    // All 2026 cycles, filtered by date only. On-pond/harvested state comes from
    // harvest_date alone — the status column was dropped 2026-08-18 (it disagreed
    // with harvest_date on 20 rows and nothing read it).
    lettuce_schedule: {
      supabase: {
        table: 'lettuce_schedule_v', orderBy: 'seeding_date',
        select: 'pond,side,variety,seedname,seedsperboard,boards,seeding_date,pond_date,estimated_harvest_date,harvest_date',
        columns: [
          { label: 'Pond',           field: 'pond',                   type: 'string' },
          { label: 'Side',           field: 'side',                   type: 'string' },
          { label: 'Variety',        field: 'variety',                type: 'string' },
          { label: 'SeedName',       field: 'seedname',               type: 'string' },
          { label: 'SeedsPerBoard',  field: 'seedsperboard',          type: 'number' },
          { label: 'Boards',         field: 'boards',                 type: 'number' },
          { label: 'SeedingDate',    field: 'seeding_date',           type: 'date'   },
          { label: 'PondDate',       field: 'pond_date',              type: 'date'   },
          { label: 'ExpHarvestDate', field: 'estimated_harvest_date', type: 'date'   },
          { label: 'HarvestDate',    field: 'harvest_date',           type: 'date'   },
        ],
      },
    },
    // --- WC / TDI (prod-only aggregate views; no per-employee PII) ---
    // The page fetches these with {mode:'prod'}. The views pre-aggregate so the
    // public anon key never sees names / net pay / deductions. Exclusion rules
    // (HF, board, per diem/auto, OT premium, weekly cap) live in the views.
    wc_basis_monthly: {
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
      supabase: {
        table: 'wc_summary_paycheck_v', orderBy: 'check_date',
        select: 'year,month,check_date,wc_code,pay_structure,base_wages,overtime,total_cost',
        columns: [
          { label: 'Year',      field: 'year',          type: 'number' },
          { label: 'Month',     field: 'month',         type: 'number' },
          { label: 'Check',     field: 'check_date',    type: 'date'   },
          { label: 'Code',      field: 'wc_code',       type: 'string' },
          { label: 'Structure', field: 'pay_structure', type: 'string' },
          { label: 'Base',      field: 'base_wages',    type: 'number' },
          { label: 'OT',        field: 'overtime',      type: 'number' },
          { label: 'TotalCost', field: 'total_cost',    type: 'number' },
        ],
      },
    },
    tdi_quarterly: {
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
    // opts.mode is accepted and ignored — every feed is Supabase now. Kept so
    // the { mode: 'prod' } already written at ~40 call sites stays valid.
    const sc = conf.supabase;
    if (!sc) throw new Error(`Logical table '${logicalName}' has no source`);
    if (!sc) throw new Error(`Logical table '${logicalName}' has no supabase source`);
    const client = await getSupabaseClient(mode);
    const pageSize = 1000;
    const all = [];
    const orderBy = sc.orderBy || 'id';

    // PostgREST caps every response at 1000 rows, so a 7k-row feed is 7 HTTP
    // round-trips. Doing them one after another is what made the daily page
    // slow. Ask for an exact count on the first page, then fetch the rest
    // CONCURRENTLY -- wall-clock becomes one round-trip instead of N.
    const buildQuery = () => {
      let q = client.from(sc.table).select(sc.select || '*', { count: 'exact' })
        .order(orderBy, { ascending: true });
      if (sc.tiebreak && sc.tiebreak !== orderBy) q = q.order(sc.tiebreak, { ascending: true });
      for (const w of (sc.where || [])) {
        const v = typeof w.val === 'function' ? w.val() : w.val;
        q = w.op === 'in' ? q.in(w.col, v) : q[w.op](w.col, v);
      }
      // Day-scoped feeds: a config names its date column, and the caller passes
      // { date: 'YYYY-MM-DD' }. The page then re-fetches just this feed when the
      // date picker moves, instead of pulling a year up front to display one day.
      if (opts.date && sc.dateCol) q = q.eq(sc.dateCol, opts.date);
      if (opts.filters) for (const [col, val] of Object.entries(opts.filters)) q = q.eq(col, val);
      return q;
    };

    const first = await buildQuery().range(0, pageSize - 1);
    if (first.error) throw first.error;
    all.push(...(first.data || []));
    const total = first.count;
    if (total != null && total > pageSize) {
      const rest = [];
      for (let off = pageSize; off < total; off += pageSize) {
        rest.push(buildQuery().range(off, off + pageSize - 1));
      }
      const results = await Promise.all(rest);
      for (const r of results) {
        if (r.error) throw r.error;
        all.push(...(r.data || []));
      }
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
