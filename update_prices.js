#!/usr/bin/env node
/**
 * update_prices.js  v2
 * 每日執行：
 *  1. 抓取所有標的前一日收盤價，更新 MARKET_POOL base
 *  2. 對前25名候選抓60日K線，計算真實 RSI/MACD/KD/MA20/量能
 *  3. 將真實指標寫入 REAL_INDICATORS，讓網頁直接使用
 *
 * 用法：
 *   node update_prices.js            ← 每日更新收盤價
 *   node update_prices.js --scan     ← 掃描 PChome 驗證代號是否存在（移除不存在的）
 */

import https from 'https';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const HTML_FILE = path.join(__dirname, 'taiwan_stock_analysis.html');

// ── 從 HTML 讀取 MARKET_POOL 所有代號 ────────────────────────────
function getSymbolsFromHTML() {
  const html  = fs.readFileSync(HTML_FILE, 'utf8');
  const pool  = html.slice(html.indexOf('const MARKET_POOL'), html.indexOf('// ── 確定性隨機引擎'));
  const matches = [...pool.matchAll(/code:'([^']+)'/g)];
  return [...new Set(matches.map(m => m[1]))];
}

// ── Yahoo Finance K 線 ────────────────────────────────────────────
function fetchChart(symbol, range) {
  return new Promise((resolve, reject) => {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
              + encodeURIComponent(symbol)
              + '?interval=1d&range=' + range;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (!j.chart?.result?.[0]) throw new Error('empty');
          const r = j.chart.result[0];
          const q = r.indicators.quote[0];
          resolve({
            symbol,
            closes: q.close  || [],
            highs:  q.high   || [],
            lows:   q.low    || [],
            vols:   q.volume || [],
          });
        } catch(e) { reject(new Error(symbol + ': ' + e.message)); }
      });
    }).on('error', e => reject(new Error(symbol + ': ' + e.message)));
  });
}

// ── 技術指標計算 ──────────────────────────────────────────────────
function calcRSI(arr, n) {
  const c = arr.filter(Boolean);
  if (c.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = c.length - n; i < c.length; i++) {
    const d = c[i] - c[i-1]; if (d > 0) g += d; else l -= d;
  }
  return +(100 - 100 / (1 + g / (l || 0.0001))).toFixed(1);
}

function calcMACD(arr) {
  const c = arr.filter(Boolean);
  if (c.length < 26) return { macd: 0, hist: 0 };
  function ema(a, n) {
    const k = 2 / (n + 1); let e = a[0];
    for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1-k);
    return e;
  }
  const hist = ema(c, 12) - ema(c, 26);
  return { macd: +hist.toFixed(2), hist: +hist.toFixed(2) };
}

function calcKD(closes, highs, lows, n) {
  const c = closes.filter(Boolean);
  const h = highs.filter(Boolean);
  const l = lows.filter(Boolean);
  if (c.length < n) return { k: 50, d: 50 };
  const hh = Math.max(...h.slice(-n)), ll = Math.min(...l.slice(-n));
  const rsv = hh === ll ? 50 : (c[c.length-1] - ll) / (hh - ll) * 100;
  let k = 50, d = 50;
  for (let i = 0; i < 3; i++) { k = k*2/3 + rsv*1/3; d = d*2/3 + k*1/3; }
  return { k: +k.toFixed(1), d: +d.toFixed(1) };
}

function calcMA(arr, n) {
  const c = arr.filter(Boolean);
  if (c.length < n) return c[c.length-1] || 0;
  return c.slice(-n).reduce((a,b) => a+b, 0) / n;
}

function calcVolRatio(vols) {
  const v = vols.filter(Boolean);
  if (v.length < 6) return 1;
  const avg5 = v.slice(-6, -1).reduce((a,b) => a+b, 0) / 5;
  return avg5 > 0 ? +(v[v.length-1] / avg5).toFixed(2) : 1;
}

function buildIndicators(sym, data) {
  const { closes, highs, lows, vols } = data;
  const c = closes.filter(Boolean);
  const last = c[c.length-1];
  const prev = c[c.length-2] || last;

  const rsi     = calcRSI(c, 14);
  const { hist }= calcMACD(c);
  const { k, d }= calcKD(closes, highs, lows, 9);
  const ma20    = calcMA(c, 20);
  const volRat  = calcVolRatio(vols);
  const chgPct  = prev ? +((last/prev - 1)*100).toFixed(2) : 0;
  const ma20gap = ma20 > 0 ? +((last/ma20 - 1)*100).toFixed(1) : 0;

  const macdSig = hist > 0 ? 'bullish' : hist < -1 ? 'bearish' : 'neutral';
  let kdSig     = 'neutral';
  if      (k > d && k < 80 && d < 80) kdSig = 'golden_cross';
  else if (k < d && k > 20)           kdSig = 'death_cross';
  else if (k >= 80)                   kdSig = 'overbought';
  else if (k <= 20)                   kdSig = 'oversold';

  const ma20Stat = last > ma20 ? 'above' : 'below';

  console.log(`    RSI=${rsi}  MACD_hist=${hist}  K=${k} D=${d}  MA20gap=${ma20gap}%  Vol=${volRat}x`);

  return {
    rsi, macd: hist, k, d, macdSignal: macdSig,
    kdSignal: kdSig, ma20Status: ma20Stat,
    ma20gap, volRat, chgPct,
  };
}

// ── 寫入 REAL_INDICATORS ─────────────────────────────────────────
function writeRealIndicators(indicators, html) {
  const lines = Object.entries(indicators).map(([code, v]) =>
    `  '${code}':{rsi:${v.rsi},macd:${v.macd},k:${v.k},d:${v.d},` +
    `macdSignal:'${v.macdSignal}',kdSignal:'${v.kdSignal}',` +
    `ma20Status:'${v.ma20Status}',ma20gap:${v.ma20gap},volRat:${v.volRat},chgPct:${v.chgPct}},`
  );
  const block = `const REAL_INDICATORS = {\n  // 真實技術指標（update_prices.js 每日更新）\n${lines.join('\n')}\n};\n`;

  if (html.includes('const REAL_INDICATORS')) {
    html = html.replace(/const REAL_INDICATORS = \{[\s\S]*?\};\n/, block);
  } else {
    html = html.replace('const REAL_CHIPS', block + 'const REAL_CHIPS');
  }
  return html;
}

// ── Patch scoreOne 讓它讀 REAL_INDICATORS ────────────────────────
function patchScoreOne(html) {
  const MARK = '// [RI_PATCHED]';
  if (html.includes(MARK)) return html;

  const OLD = `  // 技術指標（每日不同）
  var rsi     = rand(20, 82);
  var macd    = rand(-10, 14);
  var kdK     = rand(12, 88);
  var kdD     = kdK + rand(-15, 15);
  var ma20gap = rand(-6, 10);
  var volRat  = rand(0.4, 3.5);
  var chgPct  = +rand(-4, 6).toFixed(2);`;

  const NEW = `  ${MARK}
  // 技術指標：有真實資料用真實，否則亂數
  var _ri = (typeof REAL_INDICATORS !== 'undefined') ? REAL_INDICATORS[c.code] : null;
  var rsi     = _ri ? _ri.rsi     : rand(20, 82);
  var macd    = _ri ? _ri.macd    : rand(-10, 14);
  var kdK     = _ri ? _ri.k       : rand(12, 88);
  var kdD     = _ri ? _ri.d       : (kdK + rand(-15, 15));
  var ma20gap = _ri ? _ri.ma20gap : rand(-6, 10);
  var volRat  = _ri ? _ri.volRat  : rand(0.4, 3.5);
  var chgPct  = _ri ? _ri.chgPct  : +rand(-4, 6).toFixed(2);`;

  if (html.includes(OLD)) {
    console.log('✅ scoreOne 已 patch 使用 REAL_INDICATORS');
    return html.replace(OLD, NEW);
  }
  // 已經 patch 過舊版本，但 marker 不同 ─ 什麼都不做
  console.warn('⚠️  scoreOne patch 區塊未找到（可能已 patch）');
  return html;
}

// ── 更新 base（逐行處理，正確支援中文欄位）──────────────────────
function updateBases(prices, html) {
  const lines = html.split('\n');
  let n = 0;
  const result = lines.map(line => {
    // 找出這行對應的 code
    const m = line.match(/code:'([^']+)'/);
    if (!m) return line;
    const sym = m[1];
    if (!(sym in prices)) return line;
    const price = prices[sym];
    const dp    = price >= 1000 ? 0 : price >= 100 ? 1 : 2;
    const newLine = line.replace(/base:\s*[\d.]+/, `base:${price.toFixed(dp)}`);
    if (newLine !== line) n++;
    return newLine;
  });
  console.log(`✅ 更新 ${n} 檔收盤價`);
  return result.join('\n');
}

// ── PChome 掃描：驗證代號是否存在 ───────────────────────────────
function fetchPChome(codeNum) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'stock.pchome.com.tw',
      path: `/stock/sto0/ock2/sid${codeNum}.html`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Referer': 'https://stock.pchome.com.tw/',
      }
    };
    const req = https.get(opts, (res) => {
      // redirect → 不存在
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const loc = res.headers['location'] || '';
        resolve({ exists: false, name: null, reason: `redirect→${loc.slice(0,60)}` });
        res.resume();
        return;
      }
      if (res.statusCode === 404) {
        resolve({ exists: false, name: null, reason: 'HTTP 404' });
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        resolve({ exists: null, name: null, reason: `HTTP ${res.statusCode}` });
        res.resume();
        return;
      }
      let body = '';
      res.on('data', c => { body += c; if (body.length > 80000) req.destroy(); });
      res.on('end', () => {
        if (body.length < 1000) {
          // 回應太短 = 空頁面 = 不存在
          resolve({ exists: false, name: null, reason: 'empty' });
          return;
        }
        const hasPrice = /成交價|收盤|即時報價|stockData|StockName/.test(body);
        const noResult = /查無此股票|找不到|not found|此股票不存在/i.test(body);
        if (noResult || !hasPrice) {
          resolve({ exists: false, name: null, reason: noResult ? '查無' : '無股價元素' });
          return;
        }
        const m = body.match(/<title>([^(（<]{2,20})[（(]/);
        const name = m ? m[1].trim() : null;
        resolve({ exists: true, name });
      });
    });
    req.on('error', (e) => resolve({ exists: null, name: null, reason: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ exists: null, name: null, reason: 'timeout' }); });
  });
}

async function scanMode() {
  console.log('='.repeat(56));
  console.log(' PChome 代號掃描模式 v2  |  驗證所有個股是否存在');
  console.log(' empty / 查無 / redirect / 404 → 全部移除');
  console.log('='.repeat(56));

  let html = fs.readFileSync(HTML_FILE, 'utf8');
  const pool = html.slice(html.indexOf('const MARKET_POOL'), html.indexOf('// ── 確定性隨機引擎'));
  const entries = [...pool.matchAll(/\{code:'([^']+)',name:'([^']+)'/g)]
    .map(m => ({ code: m[1], name: m[2] }));

  console.log(`\n📋 共 ${entries.length} 檔，開始掃描（每隔 400ms）...\n`);

  const invalid = [];
  const nameFixed = [];
  const errors = [];

  for (let i = 0; i < entries.length; i++) {
    const { code, name } = entries[i];
    const num = code.replace(/\.(TW|TWO)$/, '');
    const result = await fetchPChome(num);

    if (result.exists === false) {
      invalid.push({ code, name, reason: result.reason });
      process.stdout.write(`  ❌ ${code.padEnd(14)} ${name} (${result.reason})\n`);
    } else if (result.exists === true) {
      if (result.name && result.name !== name) {
        nameFixed.push({ code, oldName: name, newName: result.name });
        process.stdout.write(`  ✏️  ${code.padEnd(14)} ${name} → ${result.name}\n`);
      } else {
        process.stdout.write(`  ✅ ${code.padEnd(14)} ${name}\n`);
      }
    } else {
      errors.push({ code, name, reason: result.reason });
      process.stdout.write(`  ⚠️  ${code.padEnd(14)} ${name} (${result.reason})\n`);
    }

    if ((i + 1) % 50 === 0) console.log(`  ── 進度：${i+1}/${entries.length} ──`);
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`✅ 掃描完成`);
  console.log(`❌ 不存在：${invalid.length} 個`);
  console.log(`✏️  名稱不符：${nameFixed.length} 個`);
  console.log(`⚠️  網路錯誤：${errors.length} 個（不處理）`);

  if (invalid.length === 0 && nameFixed.length === 0) {
    console.log('\n🎉 所有代號均有效，無需修改！');
    return;
  }

  // 備份並更新 HTML
  const bak = HTML_FILE.replace('.html', `_scan_bak_${Date.now()}.html`);
  fs.copyFileSync(HTML_FILE, bak);

  const lines = html.split('\n');
  const removeSet = new Set(invalid.map(x => x.code));
  const fixMap = Object.fromEntries(nameFixed.map(x => [x.code, x.newName]));
  let removed = 0, fixed = 0;

  const newLines = lines.map(line => {
    const m = line.match(/code:'([^']+)'/);
    if (!m) return line;
    const code = m[1];
    if (removeSet.has(code)) { removed++; return null; }
    if (fixMap[code]) {
      const nm = line.match(/name:'([^']+)'/);
      if (nm) { fixed++; return line.replace(`name:'${nm[1]}'`, `name:'${fixMap[code]}'`); }
    }
    return line;
  }).filter(l => l !== null);

  fs.writeFileSync(HTML_FILE, newLines.join('\n'), 'utf8');
  console.log(`\n📁 備份：${path.basename(bak)}`);
  console.log(`✅ 已移除 ${removed} 個無效代號，修正 ${fixed} 個名稱`);

  // 輸出移除清單
  if (invalid.length > 0) {
    console.log('\n移除清單：');
    invalid.forEach(x => console.log(`  ${x.code}: ${x.name}`));
  }
}

// ── 主程式 ───────────────────────────────────────────────────────
(async () => {
  // --scan 模式：驗證所有代號
  if (process.argv.includes('--scan')) {
    if (!fs.existsSync(HTML_FILE)) { console.error('❌ 找不到 ' + HTML_FILE); process.exit(1); }
    await scanMode();
    return;
  }

  console.log('='.repeat(56));
  console.log(' 台股每日更新 v2  |  收盤價 + 真實技術指標');
  console.log('='.repeat(56));

  if (!fs.existsSync(HTML_FILE)) {
    console.error('❌ 找不到 ' + HTML_FILE); process.exit(1);
  }

  let html = fs.readFileSync(HTML_FILE, 'utf8');
  const allSyms = getSymbolsFromHTML();
  console.log('\n候選池：' + allSyms.length + ' 檔\n');

  // ── Step 1：所有標的收盤價 ──────────────────────────────────────
  console.log('── Step 1：收盤價 (' + allSyms.length + ' 檔) ──');
  const prices = {};
  let ok = 0, ng = 0;
  for (const sym of allSyms) {
    try {
      const d  = await fetchChart(sym, '5d');
      const cs = d.closes.filter(Boolean);
      if (!cs.length) throw new Error('no data');
      prices[sym] = cs[cs.length - 1];
      const dp = prices[sym] >= 1000 ? 0 : prices[sym] >= 100 ? 1 : 2;
      process.stdout.write(`  ✅ ${sym.padEnd(13)} ${prices[sym].toFixed(dp)}\n`);
      ok++;
    } catch(e) {
      process.stdout.write(`  ⚠️  ${e.message}\n`); ng++;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\n  完成：${ok} 成功，${ng} 失敗`);

  // ── Step 2：前25名候選真實技術指標 ─────────────────────────────
  console.log('\n── Step 2：真實技術指標（前25名候選）──');

  // 取有收盤的前25名（按 base 值排序，用作代理；之後 scoreOne 會用真實指標再排）
  const pool   = html.slice(html.indexOf('const MARKET_POOL'), html.indexOf('// ── 確定性隨機引擎'));
  const poolEntries = [...pool.matchAll(/\{code:'([^']+)',name:'([^']+)'/g)]
    .map(m => ({ code: m[1], name: m[2] }))
    .filter(e => prices[e.code]);

  // 取前25（若要精確選前10可先用亂數分快速篩，這裡直接取前25）
  const top25 = poolEntries.slice(0, 25);

  const indicators = {};
  for (const entry of top25) {
    console.log(`  📡 ${entry.code.padEnd(13)} ${entry.name}`);
    try {
      const d = await fetchChart(entry.code, '3mo');
      indicators[entry.code] = buildIndicators(entry.code, d);
    } catch(e) {
      console.warn(`    ⚠️  失敗：${e.message}`);
    }
    await new Promise(r => setTimeout(r, 350));
  }
  console.log(`\n  完成：${Object.keys(indicators).length} 檔指標`);

  // ── Step 3：寫回 HTML ───────────────────────────────────────────
  console.log('\n── Step 3：寫入 HTML ──');
  const bak = HTML_FILE.replace('.html', `_bak_${Date.now()}.html`);
  fs.copyFileSync(HTML_FILE, bak);

  html = updateBases(prices, html);
  html = writeRealIndicators(indicators, html);
  html = patchScoreOne(html);
  fs.writeFileSync(HTML_FILE, html, 'utf8');

  console.log('📁 備份：' + path.basename(bak));
  console.log('📄 HTML 已更新');
  console.log('\n🎉 完成！重新整理瀏覽器即可看到真實技術指標。');
})();
