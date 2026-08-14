/**
 * Farm AI chat — agent loop.
 *
 * The browser posts a conversation; this function runs the Claude tool loop
 * server-side and streams the result back as SSE. Claude gets two tools:
 *
 *   run_sql(sql, purpose)              -> executes via the chat_query RPC
 *   render_chart(query_id, ...)        -> tells the browser to draw a chart
 *
 * Why it lives here and not in the page:
 *   - the Anthropic key stays server-side
 *   - a turn is N API calls, not one, so the loop wants a real runtime
 *   - result sets get split: a small sample goes back to Claude, the full
 *     rows stream to the browser (see runSql)
 *
 * Wire protocol (SSE, one JSON object per `data:` line) — see README.md.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Reasoning model for the loop. Thinking stays ON — see note in buildRequest. */
const MODEL = "claude-opus-5";
const EFFORT = "medium";
const MAX_TOKENS = 8000;

/** Follow-up chips are a throwaway call; a small model is plenty. */
const FOLLOWUP_MODEL = "claude-haiku-4-5";

/** Ceiling on run_sql -> think -> run_sql cycles within a single user turn. */
const MAX_TOOL_ITERATIONS = 12;

/**
 * Rows handed back to Claude per query. Full result sets blow the context
 * window by the third iteration, so Claude sees a sample plus aggregates
 * while the browser renders everything.
 */
const MODEL_ROW_SAMPLE = 30;

/** Rows streamed to the browser. Guards the SSE payload, not the model. */
const CLIENT_ROW_CAP = 5000;

/** Schema rarely changes; re-fetching it on every request is wasted latency. */
const SCHEMA_TTL_MS = 5 * 60_000;

/** USD per million tokens, for the per-message cost readout. */
const USD_PER_MTOK: Record<string, {
  input: number; output: number; cacheWrite: number; cacheRead: number;
}> = {
  "claude-opus-5":    { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}

interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface TurnResult {
  content: ContentBlock[];
  stop_reason: string | null;
  usage: Usage;
}

type Emit = (event: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "run_sql",
    description:
      "Run a read-only SQL query against the farm's Postgres database and get " +
      "the rows back. Use this whenever answering needs data. You may call it " +
      "several times in one turn: query, look at what came back, then refine or " +
      "drill in. If a query errors, you get the Postgres message back and should " +
      "fix the SQL and retry rather than giving up.\n\n" +
      "You receive a sample of the rows plus aggregates for numeric columns; the " +
      "full result set is displayed to the user, so do not re-query just to show " +
      "them more rows.",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "A single PostgreSQL SELECT or WITH statement. No semicolon needed. " +
            "SELECT/WITH only — writes and DDL are rejected.",
        },
        purpose: {
          type: "string",
          description:
            "Short phrase describing what this query is for, shown to the user " +
            "while it runs. E.g. 'Cuke harvest by greenhouse, last 30 days'.",
        },
      },
      required: ["sql", "purpose"],
    },
  },
  {
    name: "render_chart",
    description:
      "Draw a chart from the results of a previous run_sql call in this turn. " +
      "Prefer a chart over a bare table for anything with a time axis or a " +
      "comparison across categories — most farm data is one of those. The user " +
      "still sees the underlying table, so do not describe the chart in detail; " +
      "just interpret it.",
    input_schema: {
      type: "object",
      properties: {
        query_id: {
          type: "string",
          description: "The query_id returned by the run_sql call that produced the data.",
        },
        chart_type: {
          type: "string",
          enum: ["line", "bar", "horizontalBar", "scatter", "pie"],
          description:
            "line for time series, bar for category comparison, " +
            "horizontalBar when category labels are long, pie only for parts of a whole.",
        },
        x: {
          type: "string",
          description: "Column name for the x axis (or the label/slice column for pie).",
        },
        y: {
          type: "array",
          items: { type: "string" },
          description: "One or more numeric column names to plot as series.",
        },
        title: { type: "string", description: "Chart title." },
        stacked: {
          type: "boolean",
          description: "Stack the series. Only meaningful for bar charts with multiple y columns.",
        },
      },
      required: ["query_id", "chart_type", "x", "y", "title"],
    },
  },
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Facts about the environment, not about the business. These stay on: without
 * the timezone the model silently answers "today" in UTC and is off by a day,
 * and without the hr_* note a blocked query looks like a bug rather than policy.
 */
const ENVIRONMENT_FACTS = `
## Environment

- Timezone is HST (UTC-10), no daylight saving. "Today" means the HST date —
  \`(now() AT TIME ZONE 'Pacific/Honolulu')::date\`.
- hr_* and app_hr_* tables are restricted and will reject any query. If a
  question needs them, say so plainly rather than working around it.
`.trim();

/**
 * The semantic layer. OFF until it has been refined — unvetted business claims
 * in the prompt are worse than none, because the model will repeat them as
 * fact without querying ("Costco is about half of revenue") and filter to
 * categories that may not match how the data is actually keyed.
 *
 * To turn it back on, flip the flag. Curated material to grow it with lives in
 * chat/org-knowledge.md and chat/context-rank-keep.json. It sits above the
 * cache breakpoint, so length is nearly free after the first request in each
 * window; accuracy is what costs.
 */
const USE_BUSINESS_CONTEXT = false;

const BUSINESS_CONTEXT = `
## The business

Hawaii Farming LLC — a Big Island (Waimea) greenhouse operation growing
cucumbers and lettuce, revenue over $10M/yr, all sold in-state.

- Costco is roughly half of revenue, across seven Hawaii warehouse ship-tos.
- Sales go through distributors, not direct: HFA for cucumbers, Armstrong
  Produce (AP) for lettuce.
- Club channel (Costco, Sam's) takes W packs only; grocery takes R packs only.
- About 71% of revenue ships off-island to Oahu.

## Crops and sites

- Cucumbers: 12 greenhouses across two properties (JTL and BIP), coco-coir
  bags with drip fertigation. Varieties are Keiki (K), Japanese (J), English (E).
  Harvested daily except Christmas and New Year's.
- Lettuce: one 3-acre Cravo greenhouse with seven ponds, deep-water culture.
  One blend, 'Mixed Version 2.0'. Four cuts a week.
- The two systems barely overlap — nearly every table is partitioned by
  \`farm_id\` ('cuke' / 'lettuce'). Almost any cross-crop question needs that split.

## Query conventions

- Prefer views over base tables where one exists — they carry the filters and
  derivations the dashboards rely on. Useful ones: grow_cuke_harvest_v,
  grow_lettuce_gh_harvest_v, grow_lettuce_pond_weight_v, lettuce_schedule_v,
  sales_invoice_v, sales_invoice_edi_v, fin_expense_v, finance_sales_actuals_v,
  finance_po_fill_v.
- Lettuce is weighed twice and the two rarely match. grow_lettuce_gh_harvest_v
  is the greenhouse (GH) weight, computed as boards × lb/board at cut time;
  grow_lettuce_pond_weight_v is the packhouse (PH) weight measured afterward,
  at pond/side grain. "How much lettuce did we harvest" almost always means the
  GH weight — say which one you used.
- sales_invoice_v is the general invoice feed. sales_invoice_edi_v is the one
  the sales page uses: 2025 from the frozen sales_invoice table, 2026 onward
  from QuickBooks. Use _edi_v when the question is about current sales figures.
- Dollar and case figures live on invoice rows; pounds are usually derived
  from case counts via sales_product.case_net_weight — do not hardcode weights.

## Known gaps (these are answers, not missing data)

- Arugula was tried and failed. An empty arugula result is correct.
- Payroll arrives from a PEO as imported totals, not timeclock detail.
- The cucumber properties have no weather station; the single station is on
  the lettuce farm.
`.trim();

function buildSystemPrompt(schemaText: string): ContentBlock[] {
  const body = `
You are the analytics assistant for Hawaii Farming's internal dashboard. You
answer questions about the farm's data by querying Postgres and explaining what
you find.

${USE_BUSINESS_CONTEXT ? `${ENVIRONMENT_FACTS}\n\n${BUSINESS_CONTEXT}` : ENVIRONMENT_FACTS}

## Database schema (public schema)
${schemaText}

## How to work

- Query first, then answer. Never guess at numbers you have not queried.
- You have not been briefed on this business. Do not assume what a code, grade,
  customer or product name means — look at the data and let it tell you.
- Answer in prose. Lead with the finding — the number, the trend, the outlier —
  then the supporting detail. The user sees the table and chart alongside your
  text, so do not read the table back to them row by row.
- Multi-part questions are normal. Query, look at the result, and query again
  to drill in. That is what the tools are for.
- If a query errors, read the Postgres message, fix the SQL, and retry.
- If a result is empty or surprising, check your assumptions with another query
  (wrong date range, wrong filter, wrong code) before reporting it as a finding.
- Chart anything with a time axis or a cross-category comparison.
- Limit result sets to what answers the question. Aggregate in SQL rather than
  returning thousands of raw rows.
- State the caveat when one matters: the date range you actually used, rows
  excluded, a filter you applied. Be brief about it.
- If the data cannot answer the question, say that and say what would be needed.
  Do not substitute a near-miss answer without flagging it.
`.trim();

  // Single cache breakpoint at the end of the system prompt. Tools render
  // before system, so this covers both. Everything volatile (the conversation)
  // sits after it and never invalidates the prefix.
  return [{ type: "text", text: body, cache_control: { type: "ephemeral" } }];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface SchemaTable {
  table: string;
  kind: string;
  columns: { name: string; type: string }[] | null;
}

let schemaCache: { text: string; at: number } | null = null;

async function loadSchema(): Promise<string> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) {
    return schemaCache.text;
  }
  const tables = await callRpc<SchemaTable[]>("chat_schema", {});
  const text = tables
    .map((t) => {
      const cols = (t.columns ?? []).map((c) => `  ${c.name} ${c.type}`).join("\n");
      return `${t.kind === "view" ? "VIEW" : "TABLE"} ${t.table}:\n${cols}`;
    })
    .join("\n\n");
  schemaCache = { text, at: Date.now() };
  return text;
}

// ---------------------------------------------------------------------------
// Postgres access
// ---------------------------------------------------------------------------

/**
 * Calls a Postgres RPC through PostgREST using the anon key — the same grants
 * the dashboards already run under. chat_query is SECURITY DEFINER and does its
 * own SELECT-only / no-hr_* enforcement, so guardrails live in one place.
 */
async function callRpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not configured");

  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = payload?.message || payload?.error || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

/** Sum/min/max/avg per numeric column, so Claude gets totals without re-querying. */
function summarize(rows: Record<string, unknown>[], columns: string[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const col of columns) {
    const nums: number[] = [];
    for (const row of rows) {
      const v = row[col];
      if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    }
    // Require most of the column to be numeric before calling it a number column.
    if (nums.length === 0 || nums.length < rows.length * 0.8) continue;
    let sum = 0, min = Infinity, max = -Infinity;
    for (const n of nums) {
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    out[col] = {
      sum: round(sum),
      min: round(min),
      max: round(max),
      avg: round(sum / nums.length),
    };
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Runs one query. Streams the full rows to the browser and returns the
 * trimmed envelope that goes back into Claude's context.
 */
async function runSql(
  sql: string,
  purpose: string,
  toolUseId: string,
  queryId: string,
  emit: Emit,
  seen: Set<string>,
): Promise<{ content: string; isError: boolean }> {
  emit({ type: "tool_start", id: toolUseId, name: "run_sql", query_id: queryId, sql, purpose });

  const started = Date.now();
  let rows: Record<string, unknown>[];
  try {
    rows = await callRpc<Record<string, unknown>[]>("chat_query", { q: sql });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "tool_end", id: toolUseId, query_id: queryId, error: message, ms: Date.now() - started });
    // Handed back as a tool error so Claude can fix the SQL and retry.
    return { content: `Query failed: ${message}`, isError: true };
  }

  const ms = Date.now() - started;
  if (!Array.isArray(rows)) rows = [];
  const columns = rows.length ? Object.keys(rows[0]) : [];

  // Only the id is retained: the browser holds the rows, and render_chart just
  // needs to know the id refers to a query that actually ran.
  seen.add(queryId);

  emit({
    type: "tool_end",
    id: toolUseId,
    query_id: queryId,
    ms,
    row_count: rows.length,
    columns,
    rows: rows.slice(0, CLIENT_ROW_CAP),
    truncated: rows.length > CLIENT_ROW_CAP,
    error: null,
  });

  const sample = rows.slice(0, MODEL_ROW_SAMPLE);
  const envelope: Record<string, unknown> = {
    query_id: queryId,
    row_count: rows.length,
    columns,
    rows: sample,
  };
  if (rows.length > MODEL_ROW_SAMPLE) {
    envelope.note =
      `Showing the first ${MODEL_ROW_SAMPLE} of ${rows.length} rows. The user ` +
      `sees the full result. Aggregates below cover all ${rows.length} rows.`;
    envelope.aggregates = summarize(rows, columns);
  }
  return { content: JSON.stringify(envelope), isError: false };
}

// ---------------------------------------------------------------------------
// Anthropic streaming
// ---------------------------------------------------------------------------

function buildRequest(messages: Message[], system: ContentBlock[]) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    tools: TOOLS,
    messages,
    // Thinking stays on. Beyond the quality gain on multi-step questions,
    // disabling it on Opus 5 can make the model emit a tool call as plain
    // text — the call silently never runs, which is invisible in a tool loop.
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    stream: true,
  };
}

/**
 * Runs one Claude turn, streaming text to the client and assembling the
 * complete assistant message (thinking and tool_use blocks included, which
 * must be echoed back verbatim on the next request).
 */
async function streamTurn(
  body: unknown,
  apiKey: string,
  emit: Emit,
  signal: AbortSignal,
): Promise<TurnResult> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    let message = `Anthropic API error ${res.status}`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch { /* keep the generic message */ }
    throw new Error(message);
  }

  const blocks: ContentBlock[] = [];
  const partialJson: Record<number, string> = {};
  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let stopReason: string | null = null;

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE frames are separated by a blank line.
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;

      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }

      switch (evt.type) {
        case "message_start": {
          // Input and cache counts are final at message_start. Assign rather
          // than add — message_delta repeats a cumulative output count, and
          // adding both would inflate the cost readout.
          const u = (evt.message as { usage?: Partial<Usage> })?.usage;
          if (u) {
            usage.input_tokens = u.input_tokens ?? 0;
            usage.cache_creation_input_tokens = u.cache_creation_input_tokens ?? 0;
            usage.cache_read_input_tokens = u.cache_read_input_tokens ?? 0;
          }
          break;
        }
        case "content_block_start": {
          const idx = evt.index as number;
          const block = { ...(evt.content_block as ContentBlock) };
          if (block.type === "text") block.text = "";
          if (block.type === "thinking") block.thinking = "";
          if (block.type === "tool_use") partialJson[idx] = "";
          blocks[idx] = block;
          if (block.type === "tool_use" && block.name === "run_sql") {
            emit({ type: "status", text: "Writing a query" });
          }
          break;
        }
        case "content_block_delta": {
          const idx = evt.index as number;
          const delta = evt.delta as Record<string, string>;
          const block = blocks[idx];
          if (!block) break;
          if (delta.type === "text_delta") {
            block.text = (block.text ?? "") + delta.text;
            emit({ type: "text", delta: delta.text });
          } else if (delta.type === "thinking_delta") {
            block.thinking = (block.thinking ?? "") + delta.thinking;
          } else if (delta.type === "signature_delta") {
            block.signature = (block.signature ?? "") + delta.signature;
          } else if (delta.type === "input_json_delta") {
            partialJson[idx] = (partialJson[idx] ?? "") + delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const idx = evt.index as number;
          const block = blocks[idx];
          if (block?.type === "tool_use") {
            try {
              block.input = JSON.parse(partialJson[idx] || "{}");
            } catch {
              block.input = {};
            }
          }
          break;
        }
        case "message_delta": {
          const d = evt.delta as { stop_reason?: string };
          if (d?.stop_reason) stopReason = d.stop_reason;
          // Cumulative for the message so far — the last one wins.
          const u = evt.usage as Partial<Usage> | undefined;
          if (typeof u?.output_tokens === "number") usage.output_tokens = u.output_tokens;
          break;
        }
        case "error": {
          const e = evt.error as { message?: string } | undefined;
          throw new Error(e?.message || "Anthropic stream error");
        }
      }
    }
  }

  return { content: blocks.filter(Boolean), stop_reason: stopReason, usage };
}

function mergeUsage(target: Usage, src: Partial<Usage>) {
  if (typeof src.input_tokens === "number") target.input_tokens += src.input_tokens;
  if (typeof src.output_tokens === "number") target.output_tokens += src.output_tokens;
  if (typeof src.cache_creation_input_tokens === "number") {
    target.cache_creation_input_tokens += src.cache_creation_input_tokens;
  }
  if (typeof src.cache_read_input_tokens === "number") {
    target.cache_read_input_tokens += src.cache_read_input_tokens;
  }
}

function costOf(usage: Usage, model: string): number {
  const p = USD_PER_MTOK[model];
  if (!p) return 0;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cacheWrite +
      usage.cache_read_input_tokens * p.cacheRead) / 1e6
  );
}

// ---------------------------------------------------------------------------
// Follow-up suggestions
// ---------------------------------------------------------------------------

/**
 * One cheap call after the answer lands. Best-effort: a failure here must never
 * take down a turn that already produced a good answer.
 */
async function suggestFollowups(
  question: string,
  answer: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (!answer.trim()) return [];
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model: FOLLOWUP_MODEL,
        max_tokens: 300,
        system:
          "You suggest follow-up questions for a farm analytics chat. Given a " +
          "question and its answer, propose three natural next questions the " +
          "user would plausibly ask. Each must be answerable from farm operations " +
          "or sales data, under 60 characters, and specific — no 'tell me more'.",
        messages: [{
          role: "user",
          content: `Question: ${question}\n\nAnswer: ${answer.slice(0, 2000)}`,
        }],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                questions: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["questions"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const text = json?.content?.find((b: ContentBlock) => b.type === "text")?.text;
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function runAgent(
  messages: Message[],
  apiKey: string,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  const schemaText = await loadSchema();
  const system = buildSystemPrompt(schemaText);
  const queries = new Set<string>();
  const totals: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  // Query ids must be unique across the whole conversation, not just this
  // request: the browser keys its result cache on them, and a bare counter
  // would make turn 2's "q1" clobber turn 1's.
  const requestId = crypto.randomUUID().slice(0, 8);
  let queryCounter = 0;
  let answerText = "";

  emit({ type: "status", text: "Thinking" });

  let hitIterationCap = true;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const turn = await streamTurn(buildRequest(messages, system), apiKey, emit, signal);
    mergeUsage(totals, turn.usage);

    // An empty assistant turn would be rejected as a message on the next
    // request, so stop rather than poison the history the client persists.
    if (!turn.content.length) { hitIterationCap = false; break; }

    messages.push({ role: "assistant", content: turn.content });

    for (const block of turn.content) {
      if (block.type === "text" && block.text) answerText += block.text;
    }

    if (turn.stop_reason !== "tool_use") { hitIterationCap = false; break; }

    // Every tool_use block in the turn must get exactly one tool_result, and
    // they all go back in a single user message.
    const results: ContentBlock[] = [];
    for (const block of turn.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "run_sql") {
        const args = (block.input ?? {}) as { sql?: string; purpose?: string };
        const queryId = `q${requestId}_${++queryCounter}`;
        const { content, isError } = await runSql(
          String(args.sql ?? ""),
          String(args.purpose ?? "Running query"),
          String(block.id),
          queryId,
          emit,
          queries,
        );
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content,
          ...(isError ? { is_error: true } : {}),
        });
      } else if (block.name === "render_chart") {
        const spec = (block.input ?? {}) as Record<string, unknown>;
        const queryId = String(spec.query_id ?? "");
        if (!queries.has(queryId)) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown query_id '${queryId}'. Use the query_id returned by run_sql.`,
            is_error: true,
          });
        } else {
          emit({ type: "chart", query_id: queryId, spec });
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Chart rendered for the user.",
          });
        }
      } else {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Unknown tool '${block.name}'.`,
          is_error: true,
        });
      }
    }

    if (!results.length) { hitIterationCap = false; break; }
    messages.push({ role: "user", content: results });
    emit({ type: "status", text: "Reading results" });
  }

  // Running out of iterations means the user got queries but no closing answer.
  // Say so rather than letting the turn just stop.
  if (hitIterationCap) {
    emit({
      type: "error",
      message:
        `Stopped after ${MAX_TOOL_ITERATIONS} query rounds without reaching an ` +
        `answer. The results above are real — try narrowing the question.`,
    });
  }

  const lastUserText = findLastUserText(messages);
  const followups = await suggestFollowups(lastUserText, answerText, apiKey, signal);
  if (followups.length) emit({ type: "followups", questions: followups });

  emit({
    type: "done",
    usage: totals,
    cost: costOf(totals, MODEL),
    messages,
  });
}

function findLastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const text = m.content.find((b) => b.type === "text")?.text;
    if (text) return text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// HTTP entrypoint
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ error: "ANTHROPIC_API_KEY is not set on this function" }, 500);
  }

  let messages: Message[];
  try {
    const body = await req.json();
    messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Body must be { messages: [...] } with at least one message" }, 400);
    }
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const emit: Emit = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client hung up mid-turn. Stop writing; the abort signal unwinds
          // the loop and an enqueue-after-close must not mask that.
          closed = true;
        }
      };
      try {
        await runAgent(messages, apiKey, emit, req.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The client has likely rendered partial text already, so report the
        // failure in-band rather than tearing the connection down.
        emit({ type: "error", message });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed by a disconnect */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
