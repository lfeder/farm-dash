/**
 * Farm AI chat — browser client.
 *
 * Thin client over the `chat` edge function. This file owns conversation
 * state, the SSE reader, and rendering; it holds no API key and never talks
 * to Anthropic directly.
 *
 * Two parallel records per conversation:
 *   messages — the Anthropic message array, sent verbatim on the next turn.
 *              Tool results in here are the trimmed envelopes the model saw.
 *   log      — what to draw. Carries full-ish result rows so a reload still
 *              renders tables and charts.
 */
(function () {
  'use strict';

  // =========================================================================
  // Config
  // =========================================================================

  const FN_NAME = 'chat';
  const STORE_INDEX = 'farm_chat_index';
  const STORE_CONVO = 'farm_chat_convo_';
  const STORE_LAST = 'farm_chat_last';

  /**
   * Rows kept in localStorage per query. Full rows stay in memory for the live
   * session, so this only bounds what survives a reload — a reloaded chart is
   * drawn from at most this many points, and exports are capped the same way.
   */
  const PERSIST_ROW_CAP = 500;
  /** Rows drawn before the "show all" control appears. */
  const TABLE_PAGE = 200;

  const CHART_JS_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';

  const SERIES_COLORS = [
    '#4ecca3', '#f0a04b', '#6ba8e8', '#e06c9f',
    '#c9b458', '#8f7ae0', '#5fbf9f', '#e07a5f',
  ];

  // =========================================================================
  // State
  // =========================================================================

  /** @type {{id:string,title:string,messages:Array,log:Array}} */
  let convo = null;
  /** queryId -> { columns, rows } for the live session (full, untruncated). */
  const queryData = new Map();
  let controller = null;
  let sending = false;

  const el = {};

  // =========================================================================
  // Utilities
  // =========================================================================

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const fmtNum = (v) => (
    typeof v === 'number'
      ? (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
      : v
  );

  const fmtCost = (c) => (c >= 0.01 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`);

  function isNumericColumn(rows, col) {
    let seen = 0;
    for (const r of rows) {
      const v = r[col];
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number') return false;
      seen++;
    }
    return seen > 0;
  }

  /** Minimal markdown -> HTML. Escapes first, so no raw HTML survives. */
  function markdown(src) {
    const text = esc(src);
    const blocks = text.split(/\n{2,}/);
    const out = [];

    for (const raw of blocks) {
      const block = raw.trim();
      if (!block) continue;

      if (block.startsWith('```')) {
        const body = block.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '');
        out.push(`<pre class="md-pre"><code>${body}</code></pre>`);
        continue;
      }

      const heading = block.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const level = Math.min(heading[1].length + 2, 6);
        out.push(`<h${level} class="md-h">${inline(heading[2])}</h${level}>`);
        continue;
      }

      const lines = block.split('\n');

      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`);
        out.push(`<ul class="md-list">${items.join('')}</ul>`);
        continue;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        out.push(`<ol class="md-list">${items.join('')}</ol>`);
        continue;
      }
      if (lines.length >= 2 && /^\s*\|/.test(lines[0]) && /^[\s|:-]+$/.test(lines[1])) {
        out.push(mdTable(lines));
        continue;
      }

      out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
    }
    return out.join('');

    function inline(s) {
      return s
        .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }

    function mdTable(lines) {
      const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(lines[0]).map((c) => `<th>${inline(c)}</th>`).join('');
      const body = lines.slice(2)
        .filter((l) => l.trim())
        .map((l) => `<tr>${cells(l).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      return `<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
  }

  function toCsv(columns, rows) {
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n');
  }

  function toMarkdownTable(columns, rows) {
    const head = `| ${columns.join(' | ')} |`;
    const rule = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = rows.map((r) => `| ${columns.map((c) => String(r[c] ?? '')).join(' | ')} |`);
    return [head, rule, ...body].join('\n');
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const was = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = was; }, 1200);
    } catch {
      btn.textContent = 'Copy failed';
    }
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  const readIndex = () => {
    try { return JSON.parse(localStorage.getItem(STORE_INDEX) || '[]'); } catch { return []; }
  };
  const writeIndex = (idx) => localStorage.setItem(STORE_INDEX, JSON.stringify(idx));

  function loadConvo(id) {
    try {
      const raw = localStorage.getItem(STORE_CONVO + id);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /**
   * Persist, trimming result rows to stay inside the localStorage quota. If a
   * write still fails, drop the oldest conversations and retry rather than
   * losing the one in front of the user.
   */
  function saveConvo(c = convo) {
    if (!c) return;
    const slim = {
      ...c,
      log: c.log.map((entry) => (
        entry.role !== 'assistant' ? entry : {
          ...entry,
          tools: (entry.tools || []).map((t) => ({
            ...t,
            rows: (t.rows || []).slice(0, PERSIST_ROW_CAP),
            persistTruncated: (t.rows || []).length > PERSIST_ROW_CAP,
          })),
        }
      )),
    };

    const index = readIndex().filter((e) => e.id !== c.id);
    index.unshift({ id: c.id, title: c.title, at: Date.now() });

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        localStorage.setItem(STORE_CONVO + c.id, JSON.stringify(slim));
        writeIndex(index);
        if (c === convo) localStorage.setItem(STORE_LAST, c.id);
        return;
      } catch {
        // Evict the oldest *other* conversation. Never the one being written.
        let victimAt = -1;
        for (let i = index.length - 1; i >= 0; i--) {
          if (index[i].id !== c.id) { victimAt = i; break; }
        }
        if (victimAt === -1) return;
        localStorage.removeItem(STORE_CONVO + index[victimAt].id);
        index.splice(victimAt, 1);
      }
    }
  }

  /** Leaving a conversation cancels any turn still streaming into it. */
  function abortInFlight() {
    if (controller) controller.abort();
  }

  function newConvo() {
    abortInFlight();
    convo = { id: uid(), title: 'New chat', messages: [], log: [] };
    queryData.clear();
    renderAll();
    renderSidebar();
    el.input.focus();
  }

  function openConvo(id) {
    const loaded = loadConvo(id);
    if (!loaded) return;
    abortInFlight();
    convo = loaded;
    queryData.clear();
    // Rehydrate what we persisted so charts and exports work after a reload.
    for (const entry of convo.log) {
      for (const t of entry.tools || []) {
        if (t.queryId && t.rows) queryData.set(t.queryId, { columns: t.columns, rows: t.rows });
      }
    }
    localStorage.setItem(STORE_LAST, id);
    renderAll();
    renderSidebar();
  }

  function deleteConvo(id, ev) {
    ev.stopPropagation();
    localStorage.removeItem(STORE_CONVO + id);
    writeIndex(readIndex().filter((c) => c.id !== id));
    if (convo && convo.id === id) newConvo();
    else renderSidebar();
  }

  // =========================================================================
  // Rendering — shell
  // =========================================================================

  function renderSidebar() {
    const index = readIndex();
    el.convoList.innerHTML = index.map((c) => `
      <div class="convo-item${convo && c.id === convo.id ? ' active' : ''}" data-id="${esc(c.id)}">
        <span class="convo-title">${esc(c.title)}</span>
        <button class="convo-del" data-del="${esc(c.id)}" title="Delete">&times;</button>
      </div>
    `).join('') || '<div class="convo-empty">No conversations yet</div>';

    el.convoList.querySelectorAll('.convo-item').forEach((node) => {
      node.onclick = () => openConvo(node.dataset.id);
    });
    el.convoList.querySelectorAll('.convo-del').forEach((btn) => {
      btn.onclick = (ev) => deleteConvo(btn.dataset.del, ev);
    });
  }

  function renderAll() {
    el.messages.innerHTML = '';
    for (const entry of convo.log) {
      if (entry.role === 'user') {
        addUserBubble(entry.text);
      } else {
        const bubble = addAssistantBubble();
        replayAssistant(bubble, entry);
      }
    }
    el.examples.style.display = convo.log.length ? 'none' : 'flex';
    scrollDown();
  }

  function scrollDown() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function addUserBubble(text) {
    const div = document.createElement('div');
    div.className = 'msg msg-user';
    div.textContent = text;
    el.messages.appendChild(div);
    return div;
  }

  function addAssistantBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    wrap.innerHTML = '<div class="parts"></div><div class="turn-foot"></div><div class="followups"></div>';
    el.messages.appendChild(wrap);
    return {
      wrap,
      parts: wrap.querySelector('.parts'),
      foot: wrap.querySelector('.turn-foot'),
      chips: wrap.querySelector('.followups'),
      textBuf: '',
      textNode: null,
      toolNodes: new Map(),
    };
  }

  // =========================================================================
  // Rendering — parts
  // =========================================================================

  function appendText(bubble, delta) {
    if (!bubble.textNode) {
      const node = document.createElement('div');
      node.className = 'md';
      bubble.parts.appendChild(node);
      bubble.textNode = node;
      bubble.textBuf = '';
    }
    bubble.textBuf += delta;
    bubble.textNode.innerHTML = markdown(bubble.textBuf);
  }

  /** Text and tool parts interleave, so a new tool closes the open text run. */
  function closeTextRun(bubble) {
    bubble.textNode = null;
    bubble.textBuf = '';
  }

  function addToolPart(bubble, { id, sql, purpose }) {
    closeTextRun(bubble);
    const node = document.createElement('div');
    node.className = 'tool';
    node.innerHTML = `
      <div class="tool-head">
        <span class="tool-spin"></span>
        <span class="tool-purpose">${esc(purpose)}</span>
        <span class="tool-meta"></span>
      </div>
      <details class="tool-sql"><summary>sql</summary><pre>${esc(sql)}</pre></details>
      <div class="tool-body"></div>`;
    bubble.parts.appendChild(node);
    if (id) bubble.toolNodes.set(id, node);
    scrollDown();
    return node;
  }

  function finishToolPart(node, evt) {
    if (!node) return;
    node.querySelector('.tool-spin').classList.add('done');
    const meta = node.querySelector('.tool-meta');
    if (evt.error) {
      node.classList.add('tool-error');
      meta.textContent = 'failed';
      node.querySelector('.tool-body').innerHTML =
        `<div class="err">${esc(evt.error)}</div>`;
      return;
    }
    meta.textContent = `${evt.row_count.toLocaleString()} row${evt.row_count === 1 ? '' : 's'} · ${evt.ms}ms`;
    renderTable(node.querySelector('.tool-body'), evt.query_id, evt.columns, evt.rows, evt.truncated);
  }

  function renderTable(host, queryId, columns, rows, serverTruncated) {
    host.innerHTML = '';
    if (!rows || !rows.length) {
      host.innerHTML = '<div class="muted">No rows</div>';
      return;
    }

    const state = { sortCol: null, dir: 1, expanded: false };
    const numeric = new Set(columns.filter((c) => isNumericColumn(rows, c)));

    const table = document.createElement('table');
    table.className = 'result-table';
    const foot = document.createElement('div');
    foot.className = 'table-foot';
    host.appendChild(table);
    host.appendChild(foot);

    const draw = () => {
      let view = rows;
      if (state.sortCol) {
        view = rows.slice().sort((a, b) => {
          const x = a[state.sortCol], y = b[state.sortCol];
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x > y ? 1 : -1) * state.dir;
        });
      }
      const shown = state.expanded ? view : view.slice(0, TABLE_PAGE);

      const head = columns.map((c) => {
        const active = state.sortCol === c ? (state.dir === 1 ? ' ▲' : ' ▼') : '';
        return `<th class="${numeric.has(c) ? 'num' : ''}" data-col="${esc(c)}">${esc(c)}${active}</th>`;
      }).join('');
      const body = shown.map((r) => (
        `<tr>${columns.map((c) => (
          `<td class="${numeric.has(c) ? 'num' : ''}">${esc(fmtNum(r[c]) ?? '')}</td>`
        )).join('')}</tr>`
      )).join('');
      table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;

      table.querySelectorAll('th').forEach((th) => {
        th.onclick = () => {
          const col = th.dataset.col;
          if (state.sortCol === col) state.dir *= -1;
          else { state.sortCol = col; state.dir = 1; }
          draw();
        };
      });

      const hidden = view.length - shown.length;
      foot.innerHTML = `
        ${hidden > 0 ? `<button class="link-btn" data-act="expand">Show all ${view.length.toLocaleString()} rows</button>` : ''}
        ${state.expanded && view.length > TABLE_PAGE ? '<button class="link-btn" data-act="collapse">Collapse</button>' : ''}
        <button class="link-btn" data-act="csv">Copy CSV</button>
        <button class="link-btn" data-act="md">Copy Markdown</button>
        <button class="link-btn" data-act="dl">Download</button>
        ${serverTruncated ? '<span class="muted">· result capped at 5,000 rows</span>' : ''}`;

      foot.querySelectorAll('.link-btn').forEach((btn) => {
        btn.onclick = () => {
          const full = queryData.get(queryId) || { columns, rows };
          if (btn.dataset.act === 'expand') { state.expanded = true; draw(); }
          else if (btn.dataset.act === 'collapse') { state.expanded = false; draw(); }
          else if (btn.dataset.act === 'csv') copy(toCsv(full.columns, full.rows), btn);
          else if (btn.dataset.act === 'md') copy(toMarkdownTable(full.columns, full.rows.slice(0, 100)), btn);
          else if (btn.dataset.act === 'dl') download(`${queryId}.csv`, toCsv(full.columns, full.rows));
        };
      });
    };

    draw();
  }

  // =========================================================================
  // Rendering — charts
  // =========================================================================

  let chartLibPromise = null;

  function loadChartLib() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (chartLibPromise) return chartLibPromise;
    chartLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CHART_JS_SRC;
      s.onload = () => resolve(window.Chart);
      s.onerror = () => reject(new Error('Failed to load Chart.js'));
      document.head.appendChild(s);
    });
    return chartLibPromise;
  }

  async function addChart(bubble, queryId, spec) {
    const data = queryData.get(queryId);
    if (!data || !data.rows.length) return;

    closeTextRun(bubble);
    const node = document.createElement('div');
    node.className = 'chart-wrap';
    node.innerHTML = `<div class="chart-title">${esc(spec.title || '')}</div><canvas></canvas>`;
    bubble.parts.appendChild(node);
    scrollDown();

    let Chart;
    try {
      Chart = await loadChartLib();
    } catch {
      node.innerHTML = '<div class="muted">Chart unavailable (Chart.js failed to load)</div>';
      return;
    }

    const rows = data.rows;
    const labels = rows.map((r) => r[spec.x]);
    const ys = Array.isArray(spec.y) ? spec.y : [spec.y];
    const isPie = spec.chart_type === 'pie';

    const datasets = ys.map((col, i) => ({
      label: col,
      data: rows.map((r) => r[col]),
      borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
      backgroundColor: isPie
        ? rows.map((_, j) => SERIES_COLORS[j % SERIES_COLORS.length])
        : SERIES_COLORS[i % SERIES_COLORS.length] + (spec.chart_type === 'line' ? '22' : 'cc'),
      borderWidth: spec.chart_type === 'line' ? 2 : 1,
      pointRadius: rows.length > 60 ? 0 : 2,
      tension: 0.25,
      fill: spec.chart_type === 'line' && ys.length === 1,
    }));

    const stacked = !!spec.stacked;
    new Chart(node.querySelector('canvas'), {
      type: spec.chart_type === 'horizontalBar' ? 'bar' : spec.chart_type,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: spec.chart_type === 'horizontalBar' ? 'y' : 'x',
        plugins: {
          legend: {
            display: ys.length > 1 || isPie,
            labels: { color: '#aaa', boxWidth: 12, font: { size: 10 } },
          },
        },
        scales: isPie ? {} : {
          x: { stacked, ticks: { color: '#888', maxRotation: 0, autoSkipPadding: 16, font: { size: 10 } }, grid: { color: '#0f3460' } },
          y: { stacked, ticks: { color: '#888', font: { size: 10 } }, grid: { color: '#0f3460' }, beginAtZero: true },
        },
      },
    });
  }

  // =========================================================================
  // Rendering — turn footer, follow-ups, replay
  // =========================================================================

  function renderFooter(bubble, entry) {
    const u = entry.usage || {};
    const cached = (u.cache_read_input_tokens || 0);
    bubble.foot.innerHTML = `
      <span class="muted">
        ${((u.input_tokens || 0) + cached).toLocaleString()} in
        ${cached ? `(${cached.toLocaleString()} cached)` : ''}
        · ${(u.output_tokens || 0).toLocaleString()} out
        · ${fmtCost(entry.cost || 0)}
        ${entry.seconds ? `· ${entry.seconds}s` : ''}
      </span>
      <button class="link-btn" data-act="regen">Regenerate</button>`;
    const btn = bubble.foot.querySelector('[data-act="regen"]');
    if (btn) btn.onclick = regenerate;
  }

  function renderFollowups(bubble, questions) {
    if (!questions || !questions.length) return;
    bubble.chips.innerHTML = questions
      .map((q) => `<button class="chip">${esc(q)}</button>`).join('');
    bubble.chips.querySelectorAll('.chip').forEach((btn) => {
      btn.onclick = () => { el.input.value = btn.textContent; send(); };
    });
  }

  /** Rebuild a completed assistant turn from the persisted log. */
  function replayAssistant(bubble, entry) {
    for (const part of entry.parts || []) {
      if (part.kind === 'text') {
        appendText(bubble, part.text);
        closeTextRun(bubble);
      } else if (part.kind === 'tool') {
        const tool = (entry.tools || []).find((t) => t.queryId === part.queryId);
        if (!tool) continue;
        const node = addToolPart(bubble, { id: null, sql: tool.sql, purpose: tool.purpose });
        finishToolPart(node, {
          query_id: tool.queryId,
          row_count: tool.rowCount,
          ms: tool.ms,
          columns: tool.columns,
          rows: tool.rows,
          truncated: tool.truncated,
          error: tool.error,
        });
      } else if (part.kind === 'chart') {
        addChart(bubble, part.queryId, part.spec);
      }
    }
    if (entry.error) {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = entry.error;
      bubble.parts.appendChild(err);
    }
    renderFooter(bubble, entry);
    renderFollowups(bubble, entry.followups);
  }

  // =========================================================================
  // Send / stream
  // =========================================================================

  function setSending(on) {
    sending = on;
    el.ask.style.display = on ? 'none' : '';
    el.stop.style.display = on ? '' : 'none';
    el.input.disabled = on;
  }

  function regenerate() {
    if (sending || !convo) return;
    // Roll back to just after the last real user message — assistant turns and
    // the tool_result messages that belong to them all go.
    let cut = -1;
    for (let i = convo.messages.length - 1; i >= 0; i--) {
      const m = convo.messages[i];
      if (m.role === 'user' && typeof m.content === 'string') { cut = i; break; }
    }
    if (cut === -1) return;
    convo.messages = convo.messages.slice(0, cut + 1);
    const lastUserLog = convo.log.map((e) => e.role).lastIndexOf('user');
    convo.log = convo.log.slice(0, lastUserLog + 1);
    renderAll();
    stream();
  }

  function send() {
    if (sending) return;
    const text = el.input.value.trim();
    if (!text) return;

    if (!convo.log.length) convo.title = text.slice(0, 60);
    el.input.value = '';
    autoGrow();
    el.examples.style.display = 'none';

    convo.messages.push({ role: 'user', content: text });
    convo.log.push({ role: 'user', text });
    addUserBubble(text);
    scrollDown();
    stream();
  }

  async function stream() {
    setSending(true);
    // Pin the conversation this turn belongs to. If the user switches away
    // mid-stream, the result must not land in whatever is open when it
    // finishes — see the guard in the finally block.
    const target = convo;
    const bubble = addAssistantBubble();
    const entry = {
      role: 'assistant', parts: [], tools: [], followups: [],
      usage: {}, cost: 0, error: null,
    };
    const started = Date.now();

    const status = document.createElement('div');
    status.className = 'status-line';
    status.textContent = 'Thinking…';
    bubble.parts.appendChild(status);

    controller = new AbortController();
    const { url, anon } = DataSource.SUPABASE_PROJECTS.prod;

    try {
      const res = await fetch(`${url}/functions/v1/${FN_NAME}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${anon}`,
          'apikey': anon,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: convo.messages }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail || `Request failed (${res.status})`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let openTool = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;

        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (!frame.startsWith('data:')) continue;

          let evt;
          try { evt = JSON.parse(frame.slice(5).trim()); } catch { continue; }

          if (evt.type === 'status') {
            status.textContent = evt.text + '…';
          } else if (evt.type === 'text') {
            status.remove();
            appendText(bubble, evt.delta);
            if (!entry.parts.length || entry.parts[entry.parts.length - 1].kind !== 'text') {
              entry.parts.push({ kind: 'text', text: '' });
            }
            entry.parts[entry.parts.length - 1].text += evt.delta;
            scrollDown();
          } else if (evt.type === 'tool_start') {
            status.remove();
            openTool = {
              queryId: evt.query_id, sql: evt.sql, purpose: evt.purpose,
              rowCount: 0, ms: 0, columns: [], rows: [], error: null,
            };
            entry.tools.push(openTool);
            entry.parts.push({ kind: 'tool', queryId: evt.query_id });
            addToolPart(bubble, { id: evt.id, sql: evt.sql, purpose: evt.purpose });
          } else if (evt.type === 'tool_end') {
            const node = bubble.toolNodes.get(evt.id);
            finishToolPart(node, evt);
            if (openTool && openTool.queryId === evt.query_id) {
              Object.assign(openTool, {
                rowCount: evt.row_count || 0, ms: evt.ms || 0,
                columns: evt.columns || [], rows: evt.rows || [],
                truncated: !!evt.truncated, error: evt.error || null,
              });
            }
            if (!evt.error) {
              queryData.set(evt.query_id, { columns: evt.columns || [], rows: evt.rows || [] });
            }
            scrollDown();
          } else if (evt.type === 'chart') {
            entry.parts.push({ kind: 'chart', queryId: evt.query_id, spec: evt.spec });
            addChart(bubble, evt.query_id, evt.spec);
          } else if (evt.type === 'followups') {
            entry.followups = evt.questions;
            renderFollowups(bubble, evt.questions);
          } else if (evt.type === 'error') {
            entry.error = evt.message;
            const err = document.createElement('div');
            err.className = 'err';
            err.textContent = evt.message;
            bubble.parts.appendChild(err);
          } else if (evt.type === 'done') {
            target.messages = evt.messages;
            entry.usage = evt.usage || {};
            entry.cost = evt.cost || 0;
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        entry.error = 'Stopped.';
        const note = document.createElement('div');
        note.className = 'muted';
        note.textContent = 'Stopped.';
        bubble.parts.appendChild(note);
      } else {
        entry.error = err.message || String(err);
        const node = document.createElement('div');
        node.className = 'err';
        node.textContent = entry.error;
        bubble.parts.appendChild(node);
      }
    } finally {
      status.remove();
      entry.seconds = Math.round((Date.now() - started) / 100) / 10;
      renderFooter(bubble, entry);
      target.log.push(entry);
      saveConvo(target);

      // Only touch the visible UI if the user is still on this conversation.
      if (convo === target) {
        renderSidebar();
        scrollDown();
        el.input.focus();
      }
      setSending(false);
      controller = null;
    }
  }

  // =========================================================================
  // Input
  // =========================================================================

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 160) + 'px';
  }

  function bindInput() {
    el.input.addEventListener('input', autoGrow);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }

  // =========================================================================
  // Boot
  // =========================================================================

  function init() {
    Object.assign(el, {
      messages: document.getElementById('messages'),
      input: document.getElementById('question'),
      ask: document.getElementById('ask-btn'),
      stop: document.getElementById('stop-btn'),
      examples: document.getElementById('examples'),
      convoList: document.getElementById('convo-list'),
      newBtn: document.getElementById('new-chat'),
    });

    el.ask.onclick = send;
    el.stop.onclick = () => controller && controller.abort();
    el.newBtn.onclick = newConvo;
    el.examples.querySelectorAll('.example-btn').forEach((btn) => {
      btn.onclick = () => { el.input.value = btn.textContent; send(); };
    });

    bindInput();

    const last = localStorage.getItem(STORE_LAST);
    if (last && loadConvo(last)) openConvo(last);
    else newConvo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
