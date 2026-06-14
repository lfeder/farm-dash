/**
 * Shared data-source abstraction for dashboards.
 *
 * Three modes behind a runtime toggle:
 *   'sheets' — existing gviz JSONP calls (current default)
 *   'dev'    — Supabase dev project (kfwqtaazdankxmdlqdak)
 *   'prod'   — Supabase prod project (zdvpqygiqavwpxljpvqw)
 *
 * Mode is read from ?src=... URL param first, then localStorage('dashSource'),
 * defaulting to 'sheets'. setMode() persists to localStorage and reloads the
 * page with ?src= appended.
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
    dev: {
      url: 'https://kfwqtaazdankxmdlqdak.supabase.co',
      anon: 'sb_publishable_AMRw7zq1xtPex_3-8wgvDA_A3QzWgHb',
    },
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
    expenses: {
      // No dashboard currently reads expenses from sheet tabs directly; the
      // nightly sync is the only sheet consumer. Leaving sheets empty here
      // means fetchTable('expenses') only works in dev/prod mode.
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
            'seedname':              'SeedName',
            'boardsperpond':         'BoardsPerPond',
            'poundsperboard':        'PoundsPerBoard',
            'greenhousenetweight':   'GreenhouseNetWeight',
            'harvestdate':           'HarvestDate',
            'variety':               'Variety',
          } },
      ],
      supabase: {
        // Base table (the grow_lettuce_harvest_v view does not exist in dev/prod).
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
      supabase: { table: 'grow_lettuce_harvest', select: '*', orderBy: 'harvest_date',
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
        table: 'sales_po_detail_v',
        select: 'invoice_date,sales_product_id,order_quantity',
        orderBy: 'invoice_date',
        columns: [
          { label: 'PackDate', field: 'invoice_date',     type: 'date'   },
          { label: 'SKU',      field: 'sales_product_id', type: 'string' },
          { label: 'Cases',    field: 'order_quantity',   type: 'number' },
        ],
      },
    },
    // Additional logical tables get added here as each dashboard migrates.
  };

  // =========================================================================
  // Mode state
  // =========================================================================

  const STORAGE_KEY = 'dashSource';
  const VALID_MODES = ['sheets', 'dev', 'prod'];

  function getMode() {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('src');
    if (fromUrl && VALID_MODES.includes(fromUrl)) return fromUrl;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_MODES.includes(stored)) return stored;
    return 'dev';
  }

  function setMode(mode) {
    if (!VALID_MODES.includes(mode)) throw new Error('Bad mode: ' + mode);
    localStorage.setItem(STORAGE_KEY, mode);
    const url = new URL(window.location.href);
    url.searchParams.set('src', mode);
    window.location.href = url.toString();
  }

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
    const mode = opts.mode || getMode();
    const conf = CONFIG[logicalName];
    if (!conf) throw new Error('Unknown logical table: ' + logicalName);

    if (mode === 'sheets') {
      if (!conf.sheets || !conf.sheets.length) {
        throw new Error(`Logical table '${logicalName}' has no sheets source; pick dev or prod mode`);
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

    // dev or prod
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
  // Toggle UI
  // =========================================================================

  function renderModeToggle(container, opts = {}) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    const current = getMode();
    container.style.cssText = (container.style.cssText || '') + `;display:inline-flex;align-items:center;gap:4px;margin-left:8px;`;
    container.innerHTML = '';
    const sel = document.createElement('select');
    sel.title = 'Data source';
    sel.style.cssText = 'background:#111;color:#bbb;border:1px solid #333;padding:2px 6px;font-size:0.72rem;border-radius:3px;cursor:pointer;';
    VALID_MODES.forEach(m => {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      if (m === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => setMode(sel.value));
    container.appendChild(sel);
  }

  /**
   * Inject a toggle next to an existing element (e.g. version stamp).
   * Calls renderModeToggle into a new span appended after targetEl.
   */
  function attachToggleAfter(targetEl) {
    if (typeof targetEl === 'string') targetEl = document.getElementById(targetEl);
    if (!targetEl) return;
    const span = document.createElement('span');
    span.id = 'ds-mode-toggle';
    targetEl.parentNode.insertBefore(span, targetEl.nextSibling);
    renderModeToggle(span);
    return span;
  }

  // Parent-index helper: if we're inside an iframe, ensure the iframe URL
  // carries ?src= so child pages read the same mode.
  function propagateToIframes(mode) {
    document.querySelectorAll('iframe').forEach(frame => {
      const src = frame.getAttribute('src');
      if (!src) return;
      try {
        const u = new URL(src, window.location.href);
        u.searchParams.set('src', mode);
        frame.setAttribute('src', u.toString());
      } catch (_) { /* ignore */ }
    });
  }

  // =========================================================================
  // Export
  // =========================================================================

  // Expose raw client for write paths (pages doing direct .update() / .insert())
  async function getClient(mode) {
    return getSupabaseClient(mode || getMode());
  }

  global.DataSource = {
    fetchTable,
    getClient,
    getMode,
    setMode,
    renderModeToggle,
    attachToggleAfter,
    propagateToIframes,
    CONFIG, // exposed for debugging / extensions
    SUPABASE_PROJECTS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
