#!/usr/bin/env node
// Fetches invoice and grow data from Google Sheets and saves as budget-data.json
// Run: node sales/fetch-budget-data.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const SALES_SHEET = '124y8JdWXmbf_hb1vfimHmGaKLVXrRHybw02w_ozCExE';
const SALES_GIDS = ['1254110782', '544460225'];
const GROW_SHEET = '1VtEecYn-W1pbnIU1hRHfxIpkH2DtK7hj0CpcpiLoziM';
const GROW_TABS = ['grow_C_harvest', 'grow_L_seeding'];
const OUT_FILE = path.join(__dirname, 'budget-data.json');

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  const headers = lines[0].replace(/\r/g, '').split(',').map(h => h.replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.replace(/\r/g, '').split(',').map(v => v.replace(/"/g, ''));
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
}

async function main() {
  console.log('Fetching invoice data...');
  const invoiceRows = [];
  for (const gid of SALES_GIDS) {
    // Only fetch fields we need: InvoiceDate, ProductCode, Cases, Year, CustomerName
    const url = `https://docs.google.com/spreadsheets/d/${SALES_SHEET}/gviz/tq?tqx=out:csv&gid=${gid}&tq=${encodeURIComponent("SELECT A,B,C,D,J WHERE C<>'Sales' AND B<>'Kaukau 4 Keiki'")}`;
    const csv = await fetchCSV(url);
    const rows = parseCSV(csv);
    rows.forEach(r => {
      const yr = parseInt(r.Year);
      if (yr !== 2025 && yr !== 2026) return;
      invoiceRows.push({
        d: r.InvoiceDate,  // date string
        p: r.ProductCode,  // product code
        c: parseFloat(r.Cases) || 0  // cases
      });
    });
    console.log(`  Tab gid=${gid}: ${rows.length} rows total, ${invoiceRows.length} kept so far`);
  }

  console.log('Fetching grow data...');
  // Cucumber harvest: only 2026, variety K/J/E
  const cukeUrl = `https://docs.google.com/spreadsheets/d/${GROW_SHEET}/gviz/tq?tqx=out:csv&sheet=grow_C_harvest&tq=${encodeURIComponent("SELECT A,H,I,L WHERE B=2026 AND (H='K' OR H='J' OR H='E')")}`;
  const cukeCSV = await fetchCSV(cukeUrl);
  const cukeRows = parseCSV(cukeCSV).map(r => ({
    d: r.HarvestDate,
    v: r.Variety,
    g: r.Grade,
    lb: parseFloat(r.GreenhouseNetWeight) || 0
  }));
  console.log(`  grow_C_harvest: ${cukeRows.length} rows`);

  // Lettuce: harvestdate=col N, variety=col D, greenhousenetweight=col P
  const lettUrl = `https://docs.google.com/spreadsheets/d/${GROW_SHEET}/gviz/tq?tqx=out:csv&sheet=grow_L_seeding&tq=${encodeURIComponent("SELECT N,D,P WHERE YEAR(N)=2026")}`;
  const lettCSV = await fetchCSV(lettUrl);
  const lettRows = parseCSV(lettCSV).map(r => {
    const norm = {};
    Object.keys(r).forEach(k => norm[k.toLowerCase()] = r[k]);
    return {
      d: norm.harvestdate || '',
      v: norm.variety || '',
      lb: parseFloat(norm.greenhousenetweight) || 0
    };
  }).filter(r => r.d && r.lb > 0);
  console.log(`  grow_L_seeding: ${lettRows.length} rows`);

  const output = {
    ts: new Date().toISOString(),
    invoices: invoiceRows,
    cukeGrow: cukeRows,
    lettuceGrow: lettRows
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output));
  const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`\nSaved ${OUT_FILE} (${sizeMB} MB)`);
  console.log(`  ${invoiceRows.length} invoice rows, ${cukeRows.length} cuke grow rows, ${lettRows.length} lettuce grow rows`);
}

main().catch(e => { console.error(e); process.exit(1); });
