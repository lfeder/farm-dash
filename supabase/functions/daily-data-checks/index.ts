// Nightly data-quality checks for the Daily dashboard.
// Runs at 5pm HST (03:00 UTC) via pg_cron, evaluates each active rule in
// data_check_rule against the live sheet data, upserts results to
// data_check_result, and (optionally) emails a summary with a dashboard link.
//
// Mirrors the dashboard's client-side check engine. Sheet/column specifics live
// in CROP below — keep in sync with lib/data-source.js if the sheets change.

const SUPABASE_URL = Deno.env.get("CHECK_SUPABASE_URL")!; // prod REST base
const SERVICE_KEY  = Deno.env.get("CHECK_SERVICE_KEY")!;  // prod service_role
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_TO     = (Deno.env.get("CHECK_EMAIL_TO") ?? "").split(",").map(s => s.trim()).filter(Boolean);
const EMAIL_FROM   = Deno.env.get("CHECK_EMAIL_FROM") ?? "Farm Dash <onboarding@resend.dev>";
const DASH_URL     = "https://lfeder.github.io/farm-dash/?src=sheets#daily";

const FS   = "1MbHJoJmq0w8hWz8rl9VXezmK-63MFmuK19lz3pu0dfc";
const GROW = "1VtEecYn-W1pbnIU1hRHfxIpkH2DtK7hj0CpcpiLoziM";

// Per crop (rule.harvest_key): how to read the pre-op and the harvest from sheets.
const CROP: Record<string, any> = {
  cuke: {
    preop:   { sheet: FS,   tab: "fsafe_log_C_gh_pre", dateCol: "A", flagCol: "I", membersCol: "B", sep: "+" },
    harvest: { sheet: GROW, tab: "grow_C_harvest",     dateCol: "A", dimCol: "G", where: "and B=2026" },
  },
  lettuce: {
    preop:   { sheet: FS,   tab: "fsafe_log_L_gh_pre", dateCol: "A", flagCol: "S" },
    harvest: { sheet: GROW, tab: "grow_L_seeding",     dateCol: "N", dimCol: "B", where: "" },
  },
};

function hstToday(): string {
  const d = new Date(Date.now() - 10 * 3600 * 1000); // HST = UTC-10
  return d.toISOString().slice(0, 10);
}

// Minimal gviz CSV reader. Our SELECTed columns never contain commas, so a
// split on '","' (after trimming the outer quotes) is sufficient.
async function gviz(sheet: string, tab: string, query: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${sheet}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&tq=${encodeURIComponent(query)}`;
  const text = await (await fetch(url)).text();
  return text.trim().split("\n").filter(Boolean).map(l => l.replace(/^"|"$/g, "").split('","'));
}

async function evaluateRule(rule: any, date: string) {
  const cfg = CROP[rule.harvest_key];
  if (!cfg) return null;
  const p = cfg.preop;
  const cols = p.membersCol ? `${p.dateCol},${p.membersCol},${p.flagCol}` : `${p.dateCol},${p.flagCol}`;
  const preop = (await gviz(p.sheet, p.tab, `select ${cols} where ${p.dateCol} = date '${date}'`)).slice(1);
  const flagIdx = p.membersCol ? 2 : 1;
  const approved = preop.filter(r => (r[flagIdx] || "").toUpperCase() === "TRUE");
  if (!approved.length) return null; // not a harvest day -> no expectation

  let expected = 0;
  if (String(rule.expected).toLowerCase() === "preop") {
    const set = new Set<string>();
    approved.forEach(r => (r[1] || "").split(p.sep || "+").map((s: string) => s.trim()).filter(Boolean).forEach((m: string) => set.add(m)));
    expected = set.size;
  } else {
    expected = Number(rule.expected) || 0;
  }
  if (!expected) return null;

  const h = cfg.harvest;
  const harvest = await gviz(h.sheet, h.tab, `select ${h.dimCol}, count(${h.dimCol}) where ${h.dateCol} = date '${date}' ${h.where} group by ${h.dimCol}`);
  const actual = Math.max(0, harvest.length - 1);
  const passed = actual >= expected;
  const detail = passed ? null : String(rule.message || rule.name).replace("{actual}", String(actual)).replace("{expected}", String(expected));
  return { rule_id: rule.id, checked_date: date, passed, detail, run_at: new Date().toISOString() };
}

async function restGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  return await r.json();
}

Deno.serve(async () => {
  const date = hstToday();
  const rules = await restGet("data_check_rule?is_active=eq.true&select=*");
  const results = [];
  for (const rule of rules) {
    try {
      const res = await evaluateRule(rule, date);
      if (res) results.push(res);
    } catch (e) { console.error("rule", rule.id, e); }
  }

  if (results.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/data_check_result?on_conflict=rule_id,checked_date`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(results),
    });
  }

  const fails = results.filter(r => !r.passed);
  let emailed = false;
  if (RESEND_KEY && EMAIL_TO.length) {
    const body = fails.length
      ? fails.map(f => `⚠ ${f.detail}`).join("<br>")
      : "All data checks passed.";
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM, to: EMAIL_TO,
        subject: `Daily — ${fails.length} data issue${fails.length === 1 ? "" : "s"} (${date})`,
        html: `<p>${body}</p><p><a href="${DASH_URL}">Open the Daily dashboard</a></p>`,
      }),
    });
    emailed = resp.ok;
    if (!resp.ok) console.error("resend error", await resp.text());
  }

  return new Response(JSON.stringify({ date, results, fails: fails.length, emailed }), {
    headers: { "Content-Type": "application/json" },
  });
});
