/**
 * Leco Shop · Backend de integração ao vivo com marketplaces
 * -----------------------------------------------------------
 * Zero dependências externas — usa apenas módulos nativos do Node.js (18+).
 *
 *   Fase 1: Mercado Livre (OAuth 2.0 + pedidos + taxas + frete)
 *   Fase 2/3: Amazon, Shopee, Magalu, TikTok Shop (esqueleto pronto abaixo)
 *
 * Fluxo:
 *   1) npm start  ->  http://localhost:3000
 *   2) Clique em "Conectar Mercado Livre"  ->  autoriza na sua conta ML
 *   3) O dashboard passa a puxar os pedidos reais e montar o DRE.
 *
 * Custo de produto e imposto vêm de costs.json (o ML não fornece isso).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

// ---------- Config (.env) ----------
function loadEnv() {
  const p = path.join(__dirname, '.env');
  const env = {};
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  return { ...env, ...process.env };
}
let ENV = loadEnv();
const PORT = Number(ENV.PORT || 3000);
function buildML() {
  return {
    clientId: ENV.ML_CLIENT_ID || '',
    clientSecret: ENV.ML_CLIENT_SECRET || '',
    redirectUri: ENV.ML_REDIRECT_URI || `http://localhost:${PORT}/callback`,
    authHost: 'https://auth.mercadolivre.com.br',
    apiHost: 'https://api.mercadolibre.com',
  };
}
let ML = buildML();
// Salva credenciais no .env a partir da tela (sem o usuário editar arquivo)
function saveEnv(patch) {
  ENV = { ...ENV, ...patch };
  const keys = ['ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'ML_REDIRECT_URI', 'PORT', 'ML_SHIPPING'];
  const lines = keys.filter((k) => ENV[k] != null && ENV[k] !== '').map((k) => `${k}=${ENV[k]}`);
  fs.writeFileSync(path.join(__dirname, '.env'), lines.join('\n') + '\n');
  ML = buildML();
}
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const COSTS_FILE = path.join(__dirname, 'costs.json');

// ---------- Persistência simples ----------
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
let tokens = readJSON(TOKENS_FILE, {});          // { ml: { access_token, refresh_token, expires_at, user_id } }
let costs = readJSON(COSTS_FILE, { taxaPadrao: 0.09, itens: {} });

// ---------- HTTP helper (Promise) ----------
function request(method, urlStr, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body && typeof body !== 'string' ? new URLSearchParams(body).toString() : body;
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Accept': 'application/json', ...headers },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ================= MERCADO LIVRE =================
const mlConnected = () => !!(tokens.ml && tokens.ml.refresh_token);

async function mlGetValidToken() {
  const t = tokens.ml;
  if (!t) throw new Error('Mercado Livre não conectado.');
  if (Date.now() < (t.expires_at || 0) - 60000) return t.access_token;
  // refresh
  const { status, json } = await request('POST', `${ML.apiHost}/oauth/token`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: {
      grant_type: 'refresh_token',
      client_id: ML.clientId,
      client_secret: ML.clientSecret,
      refresh_token: t.refresh_token,
    },
  });
  if (status !== 200) throw new Error('Falha ao renovar token ML: ' + JSON.stringify(json));
  tokens.ml = {
    ...t,
    access_token: json.access_token,
    refresh_token: json.refresh_token || t.refresh_token,
    expires_at: Date.now() + (json.expires_in || 21600) * 1000,
  };
  writeJSON(TOKENS_FILE, tokens);
  return tokens.ml.access_token;
}

async function mlExchangeCode(code) {
  const { status, json } = await request('POST', `${ML.apiHost}/oauth/token`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: {
      grant_type: 'authorization_code',
      client_id: ML.clientId,
      client_secret: ML.clientSecret,
      code,
      redirect_uri: ML.redirectUri,
    },
  });
  if (status !== 200) throw new Error('Falha na autorização ML: ' + JSON.stringify(json));
  tokens.ml = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 21600) * 1000,
    user_id: json.user_id,
  };
  writeJSON(TOKENS_FILE, tokens);
}

async function mlApi(pathStr) {
  const token = await mlGetValidToken();
  const { status, json } = await request('GET', `${ML.apiHost}${pathStr}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (status === 401) throw new Error('Token ML inválido/expirado. Reconecte.');
  return json;
}

// Busca pedidos pagos no período (paginado)
async function mlFetchOrders(sellerId, fromISO, toISO) {
  const orders = [];
  let offset = 0;
  const limit = 50;
  for (let guard = 0; guard < 200; guard++) {
    const qs = new URLSearchParams({
      seller: sellerId,
      'order.status': 'paid',
      'order.date_created.from': fromISO,
      'order.date_created.to': toISO,
      sort: 'date_desc',
      offset: String(offset),
      limit: String(limit),
    });
    const data = await mlApi(`/orders/search?${qs}`);
    const results = data.results || [];
    orders.push(...results);
    const total = (data.paging && data.paging.total) || results.length;
    offset += limit;
    if (offset >= total || results.length === 0) break;
  }
  return orders;
}

// Custo de frete pago pelo vendedor (opcional, 1 chamada por envio)
async function mlShippingSellerCost(shipmentId) {
  try {
    const c = await mlApi(`/shipments/${shipmentId}/costs`);
    // estrutura: { gross_amount, senders:[{cost}], receiver:{cost} }
    if (c && c.senders && c.senders[0] && typeof c.senders[0].cost === 'number') return c.senders[0].cost;
    if (c && typeof c.gross_amount === 'number') return c.gross_amount;
  } catch { /* ignora */ }
  return 0;
}

// Monta a estrutura de dashboard a partir dos pedidos do ML
async function mlBuildChannel(fromISO, toISO, { withShipping = true } = {}) {
  const me = await mlApi('/users/me');
  const sellerId = me.id;
  const orders = await mlFetchOrders(sellerId, fromISO, toISO);

  let fat = 0, comissao = 0, freteVendedor = 0;
  const bySku = {}; // sku -> { nome, un, fat, comissao }

  for (const o of orders) {
    for (const it of (o.order_items || [])) {
      const qty = it.quantity || 0;
      const unit = it.unit_price || 0;
      const receita = unit * qty;
      const fee = (it.sale_fee || 0) * qty; // comissão por unidade * qtd
      fat += receita;
      comissao += fee;
      const sku = (it.item && (it.item.seller_sku || it.item.seller_custom_field)) || (it.item && it.item.id) || 'SEM_SKU';
      const nome = (it.item && it.item.title) || sku;
      if (!bySku[sku]) bySku[sku] = { nome, sku, un: 0, fat: 0, comissao: 0 };
      bySku[sku].un += qty;
      bySku[sku].fat += receita;
      bySku[sku].comissao += fee;
    }
    if (withShipping && o.shipping && o.shipping.id) {
      freteVendedor += await mlShippingSellerCost(o.shipping.id);
    }
  }

  const liq = fat - comissao - freteVendedor;

  // Custos e impostos vêm de costs.json
  let custoProdutos = 0, imposto = 0;
  const taxaPadrao = costs.taxaPadrao != null ? costs.taxaPadrao : 0.09;
  const produtos = [];
  for (const sku of Object.keys(bySku)) {
    const p = bySku[sku];
    const conf = costs.itens[sku] || {};
    const custoUnit = conf.custo != null ? conf.custo : 0;
    const taxa = conf.imposto != null ? conf.imposto : taxaPadrao;
    const custoTot = custoUnit * p.un;
    const impTot = p.fat * taxa;
    custoProdutos += custoTot;
    imposto += impTot;
    const liqItem = p.fat - p.comissao;
    const lucro = liqItem - custoTot - impTot;
    const mpa = p.fat ? (lucro / p.fat) * 100 : 0;
    produtos.push([p.nome, sku, p.un, round2(p.fat), round2(lucro), round2(lucro), round2(mpa), null]);
  }
  produtos.sort((a, b) => b[3] - a[3]);

  const lb = liq - custoProdutos - imposto;

  const channel = {
    nome: 'Mercado Livre', cor: '#ffe600',
    fat: round2(fat), liq: round2(liq), lucroBruto: round2(lb),
    ads: 0, // ML Ads: integração separada (Product Ads API) — fase seguinte
    lucro: round2(lb),
    pedidos: orders.length,
  };
  const dreDetail = {
    fat: round2(fat),
    taxas: [['Comissão e taxa fixa', round2(-comissao)], ['Frete pago pelo vendedor', round2(-freteVendedor)]],
    liq: round2(liq),
    custos: [['Custo dos produtos', round2(-custoProdutos)], ['Imposto', round2(-imposto)]],
    lb: round2(lb),
  };
  return { channel, dreDetail, produtos };
}

const round2 = (v) => Math.round(v * 100) / 100;

// Classifica curva ABC (Pareto por faturamento)
function classifyABC(produtos) {
  const sorted = [...produtos].sort((a, b) => b[3] - a[3]);
  const total = sorted.reduce((s, p) => s + p[3], 0) || 1;
  let acc = 0;
  const abc = { A: base(), B: base(), C: base(), Z: base() };
  for (const p of sorted) {
    let curva;
    if (p[2] === 0) curva = 'Z';
    else { const share = (acc + p[3]) / total; curva = share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C'; acc += p[3]; }
    p[7] = curva;
    const b = abc[curva];
    b.un += p[2]; b.prod += 1; b.fat += p[3]; b.lpa += p[5];
  }
  for (const k of Object.keys(abc)) {
    abc[k].fat = round2(abc[k].fat); abc[k].lpa = round2(abc[k].lpa);
    abc[k].lpap = abc[k].fat ? round2((abc[k].lpa / abc[k].fat) * 100) : 0;
  }
  return abc;
  function base() { return { un: 0, prod: 0, fat: 0, lb: 0, lbp: 0, lpa: 0, lpap: 0 }; }
}

// ================= DADOS DEMO (fallback quando nada conectado) =================
const DEMO = readJSON(path.join(__dirname, 'demo-data.json'), null);

// ================= MONTAGEM DO DASHBOARD =================
async function buildDashboard({ from, to }) {
  const channels = {};
  const dreDetail = {};
  let produtos = [];
  const status = { ml: 'disconnected', amz: 'soon', shp: 'soon', mag: 'soon', tik: 'soon', loja: 'soon' };

  if (mlConnected()) {
    try {
      const built = await mlBuildChannel(from, to, { withShipping: ENV.ML_SHIPPING !== 'off' });
      channels.ml = built.channel;
      dreDetail.ml = built.dreDetail;
      produtos = built.produtos;
      status.ml = 'connected';
    } catch (e) {
      status.ml = 'error';
      status.mlError = String(e.message || e);
    }
  }

  // canais futuros como placeholders
  const placeholders = {
    amz: { nome: 'Amazon', cor: '#ff9900' }, shp: { nome: 'Shopee', cor: '#ee4d2d' },
    mag: { nome: 'Magalu', cor: '#0086ff' }, tik: { nome: 'TikTok Shop', cor: '#69c9d0' },
    loja: { nome: 'Loja própria', cor: '#a78bfa' },
  };
  for (const k of Object.keys(placeholders)) {
    channels[k] = { ...placeholders[k], fat: 0, liq: 0, lucroBruto: 0, ads: 0, lucro: 0, novo: true };
  }

  // se nada conectado, usa dados demo para o usuário ver a interface
  if (status.ml !== 'connected' && DEMO) {
    return { channels: DEMO.channels, dreDetail: DEMO.dreDetail, abc: DEMO.abc, produtos: DEMO.produtos, status, demo: true, period: { from, to } };
  }

  const abc = classifyABC(produtos);
  return { channels, dreDetail, abc, produtos, status, demo: false, period: { from, to } };
}

// ================= ROTEAMENTO HTTP =================
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}
const sendJSON = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  try {
    // Configuração de credenciais pela tela (sem editar .env na mão)
    if (p === '/api/config' && req.method === 'GET') {
      return sendJSON(res, 200, { clientId: ML.clientId, hasSecret: !!ML.clientSecret, redirectUri: ML.redirectUri });
    }
    if (p === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      saveEnv({
        ML_CLIENT_ID: (b.clientId || '').trim(),
        ML_CLIENT_SECRET: (b.clientSecret || '').trim(),
        ML_REDIRECT_URI: (b.redirectUri || ML.redirectUri).trim(),
      });
      return sendJSON(res, 200, { ok: true, redirectUri: ML.redirectUri, clientIdSet: !!ML.clientId });
    }
    // Custos por SKU pela tela
    if (p === '/api/costs' && req.method === 'GET') return sendJSON(res, 200, costs);
    if (p === '/api/costs' && req.method === 'POST') {
      const b = await readBody(req);
      if (b && b.itens) {
        costs = { taxaPadrao: b.taxaPadrao != null ? b.taxaPadrao : costs.taxaPadrao, itens: b.itens };
        writeJSON(COSTS_FILE, costs);
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/auth/ml') {
      if (!ML.clientId) return sendJSON(res, 400, { error: 'Configure ML_CLIENT_ID no .env' });
      const state = crypto.randomBytes(8).toString('hex');
      const auth = `${ML.authHost}/authorization?` + new URLSearchParams({
        response_type: 'code', client_id: ML.clientId, redirect_uri: ML.redirectUri, state,
      });
      res.writeHead(302, { Location: auth });
      return res.end();
    }
    if (p === '/callback') {
      const code = u.searchParams.get('code');
      if (!code) { res.writeHead(400); return res.end('Sem code'); }
      await mlExchangeCode(code);
      res.writeHead(302, { Location: '/?connected=ml' });
      return res.end();
    }
    if (p === '/api/status') return sendJSON(res, 200, {
      ml: mlConnected(), clientIdSet: !!ML.clientId, redirectUri: ML.redirectUri,
    });
    if (p === '/api/dashboard') {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const from = u.searchParams.get('from') || first.toISOString().slice(0, 19) + '.000-03:00';
      const to = u.searchParams.get('to') || now.toISOString().slice(0, 19) + '.000-03:00';
      const data = await buildDashboard({ from, to });
      return sendJSON(res, 200, data);
    }
    if (p === '/api/disconnect/ml') { delete tokens.ml; writeJSON(TOKENS_FILE, tokens); return sendJSON(res, 200, { ok: true }); }
    if (p === '/') return serveStatic(res, 'index.html');
    return serveStatic(res, p.replace(/^\//, ''));
  } catch (e) {
    return sendJSON(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Leco Shop rodando em  http://localhost:${PORT}`);
  console.log(`  Mercado Livre: ${mlConnected() ? 'CONECTADO' : 'nao conectado — abra o site e clique em Conectar'}`);
  if (!ML.clientId) console.log('  Falta configurar o .env (ML_CLIENT_ID / ML_CLIENT_SECRET). Veja o README.\n');
});
