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
// ---------- Onde guardar os dados ----------
// Na hospedagem, a pasta do projeto é substituída a cada publicação. Por isso os
// dados (conexões e custos) ficam num DISCO PERSISTENTE quando existir.
// Ordem: variável DATA_DIR > /var/data (disco do Render) > pasta do projeto.
function escolherPastaDados() {
  const candidatos = [ENV.DATA_DIR, '/var/data'].filter(Boolean);
  for (const dir of candidatos) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* tenta o próximo */ }
  }
  return __dirname;
}
const DATA_DIR = escolherPastaDados();
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const COSTS_FILE = path.join(DATA_DIR, 'costs.json');

// Primeira vez no disco: aproveita o costs.json que veio junto com o código
if (DATA_DIR !== __dirname && !fs.existsSync(COSTS_FILE)) {
  const semente = path.join(__dirname, 'costs.json');
  try { if (fs.existsSync(semente)) fs.copyFileSync(semente, COSTS_FILE); } catch { /* segue */ }
}

// ---------- Persistência simples ----------
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
let tokens = readJSON(TOKENS_FILE, {});          // { ml: { access_token, refresh_token, expires_at, user_id } }

// Normaliza o arquivo de custos para o novo formato com HISTÓRICO por data.
// Cada item: { nome, ean, imposto, custos: [ { desde:'YYYY-MM-DD', ate:null, custo, custoExtra } ] }
function normalizeCosts(c) {
  c = c || {};
  c.taxaPadrao = c.taxaPadrao != null ? c.taxaPadrao : 0.09;
  c.itens = c.itens || {};
  // Anuncios do marketplace apontando para um produto interno.
  // Ex.: { "MLB123456": "KIT50X" } - a venda desse anuncio usa o custo do KIT50X.
  c.aliases = c.aliases || {};
  // Anúncios que já venderam e ainda não têm produto. Ficam gravados até serem resolvidos,
  // por isso o alerta não depende do filtro de período da tela.
  c.pendentes = c.pendentes || {};
  // Foto de cada SKU, aproveitada das vendas — serve para a tela de associação
  c.fotos = c.fotos || {};
  for (const sku of Object.keys(c.itens)) {
    const it = c.itens[sku];
    if (!Array.isArray(it.custos)) {
      // migra formato antigo { custo, imposto } -> histórico único desde sempre
      it.custos = [{ desde: '1970-01-01', ate: null, custo: it.custo != null ? it.custo : 0, custoExtra: it.custoExtra != null ? it.custoExtra : 0 }];
    }
    delete it.custo; delete it.custoExtra;
    it.nome = it.nome || '';
    it.ean = it.ean || '';
  }
  return c;
}
let costs = normalizeCosts(readJSON(COSTS_FILE, { taxaPadrao: 0.09, itens: {} }));

// ---------- Contas do Mercado Livre ----------
// Várias contas ML no mesmo painel (ex.: matriz e filial). Cada uma vira um canal.
// Todas usam o MESMO app do ML (mesmo Client ID/Secret) — muda só quem faz o login.
const CONTAS_ML = {
  ml:    { nome: 'Mercado Livre', cor: '#ffe600', env: 'ML_REFRESH_TOKEN' },
  ldmsc: { nome: 'LDM SC',        cor: '#00b8d9', env: 'ML_REFRESH_TOKEN_LDMSC' },
};
const ehContaML = (c) => Object.prototype.hasOwnProperty.call(CONTAS_ML, c);

// Em hospedagem o disco é temporário: se não há token salvo mas existe a variável
// de ambiente correspondente, restaura a conexão daquela conta a partir dela.
for (const c of Object.keys(CONTAS_ML)) {
  const envVar = CONTAS_ML[c].env;
  if ((!tokens[c] || !tokens[c].refresh_token) && ENV[envVar]) {
    tokens[c] = { refresh_token: ENV[envVar], expires_at: 0 };
  }
}

// ---------- HTTP helper (Promise) ----------
function request(method, urlStr, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body && typeof body !== 'string' ? new URLSearchParams(body).toString() : body;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || undefined,
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
const mlConnected = (conta = 'ml') => !!(tokens[conta] && tokens[conta].refresh_token);
const contasConectadas = () => Object.keys(CONTAS_ML).filter((c) => mlConnected(c));

async function mlGetValidToken(conta = 'ml') {
  const t = tokens[conta];
  if (!t) throw new Error(`Conta "${(CONTAS_ML[conta] || {}).nome || conta}" não conectada.`);
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
  tokens[conta] = {
    ...t,
    access_token: json.access_token,
    refresh_token: json.refresh_token || t.refresh_token,
    expires_at: Date.now() + (json.expires_in || 21600) * 1000,
  };
  writeJSON(TOKENS_FILE, tokens);
  return tokens[conta].access_token;
}

async function mlExchangeCode(code, conta = 'ml') {
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
  tokens[conta] = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 21600) * 1000,
    user_id: json.user_id,
  };
  writeJSON(TOKENS_FILE, tokens);
  // Guarda QUEM é o vendedor autorizado, para dar para conferir na tela
  // (evita conectar a mesma conta duas vezes sem perceber).
  try {
    const me = await mlApi('/users/me', conta);
    tokens[conta].user_id = me.id;
    tokens[conta].apelido = me.nickname || '';
    writeJSON(TOKENS_FILE, tokens);
  } catch { /* segue sem o apelido */ }
  // Em hospedagem, salve este valor na variável indicada para não perder a conexão em reinícios.
  const envVar = (CONTAS_ML[conta] || {}).env || 'ML_REFRESH_TOKEN';
  console.log(`\n===== ${envVar} (guarde nas variáveis de ambiente do host) =====\n` + json.refresh_token + '\n=======================================================================\n');
}

async function mlApi(pathStr, conta = 'ml') {
  const token = await mlGetValidToken(conta);
  const { status, json } = await request('GET', `${ML.apiHost}${pathStr}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (status === 401) throw new Error('Token ML inválido/expirado. Reconecte.');
  return json;
}

// Busca pedidos pagos no período (paginado)
async function mlFetchOrders(sellerId, fromISO, toISO, conta = 'ml') {
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
    const data = await mlApi(`/orders/search?${qs}`, conta);
    const results = data.results || [];
    orders.push(...results);
    const total = (data.paging && data.paging.total) || results.length;
    offset += limit;
    if (offset >= total || results.length === 0) break;
  }
  return orders;
}

// Roda várias tarefas ao mesmo tempo, com limite (o ML recusa rajadas grandes)
async function emLotes(itens, limite, tarefa) {
  const out = new Array(itens.length);
  let i = 0;
  const trabalhadores = new Array(Math.min(limite, itens.length || 1)).fill(0).map(async () => {
    while (i < itens.length) { const k = i++; out[k] = await tarefa(itens[k], k); }
  });
  await Promise.all(trabalhadores);
  return out;
}

// Dados do envio do pedido: frete pago pelo vendedor + modalidade real (FULL, Flex, Coleta...).
// A modalidade fica no ENVIO, não no anúncio: o mesmo anúncio pode sair pelo Full num
// pedido e pelo Mercado Envios em outro (quando acaba o estoque no Full, por exemplo).
async function mlEnvio(shipmentId, conta = 'ml') {
  const info = { frete: 0, tipo: '' };
  if (!shipmentId) return info;
  const [custos, envio] = await Promise.all([
    mlApi(`/shipments/${shipmentId}/costs`, conta).catch(() => null),
    mlApi(`/shipments/${shipmentId}`, conta).catch(() => null),
  ]);
  if (custos) {
    if (custos.senders && custos.senders[0] && typeof custos.senders[0].cost === 'number') info.frete = custos.senders[0].cost;
    else if (typeof custos.gross_amount === 'number') info.frete = custos.gross_amount;
  }
  if (envio) {
    info.tipo = envio.logistic_type
      || (envio.logistic && envio.logistic.type)
      || (envio.shipping_option && envio.shipping_option.logistic_type)
      || '';
  }
  return info;
}

// Custo de frete pago pelo vendedor (opcional, 1 chamada por envio)
async function mlShippingSellerCost(shipmentId, conta = 'ml') {
  try {
    const c = await mlApi(`/shipments/${shipmentId}/costs`, conta);
    // estrutura: { gross_amount, senders:[{cost}], receiver:{cost} }
    if (c && c.senders && c.senders[0] && typeof c.senders[0].cost === 'number') return c.senders[0].cost;
    if (c && typeof c.gross_amount === 'number') return c.gross_amount;
  } catch { /* ignora */ }
  return 0;
}

// Monta a estrutura de dashboard a partir dos pedidos do ML
async function mlBuildChannel(fromISO, toISO, { withShipping = true, conta = 'ml' } = {}) {
  const me = await mlApi('/users/me', conta);
  const sellerId = me.id;
  const orders = await mlFetchOrders(sellerId, fromISO, toISO, conta);

  registrarPendentes(orders, conta);

  let fat = 0, comissao = 0, freteVendedor = 0, custoProdutos = 0, imposto = 0;
  let pedidosSemAssoc = 0;
  const bySku = {}; // sku -> { nome, un, fat, comissao, custo, imposto }

  for (const o of orders) {
    // Venda com anuncio nao associado a produto NAO entra nas contas (fica no alerta)
    const semAssoc = (o.order_items || []).some((it) => !temAssociacao(chaveAnuncio(it.item)));
    if (semAssoc) { pedidosSemAssoc++; continue; }
    for (const it of (o.order_items || [])) {
      const qty = it.quantity || 0;
      const unit = it.unit_price || 0;
      const receita = unit * qty;
      const fee = (it.sale_fee || 0) * qty; // comissão por unidade * qtd
      const sku = resolverSku(chaveAnuncio(it.item)) || 'SEM_SKU';
      const nome = (it.item && it.item.title) || sku;
      const cf = costFor(sku, o.date_created);            // custo vigente na data da venda
      const custoItem = (cf.custo + cf.custoExtra) * qty;
      const impItem = receita * cf.imposto;
      fat += receita; comissao += fee; custoProdutos += custoItem; imposto += impItem;
      if (!bySku[sku]) bySku[sku] = { nome, sku, un: 0, fat: 0, comissao: 0, custo: 0, imposto: 0 };
      bySku[sku].un += qty;
      bySku[sku].fat += receita;
      bySku[sku].comissao += fee;
      bySku[sku].custo += custoItem;
      bySku[sku].imposto += impItem;
    }
    if (withShipping && o.shipping && o.shipping.id) {
      freteVendedor += await mlShippingSellerCost(o.shipping.id, conta);
    }
  }

  const liq = fat - comissao - freteVendedor;

  const produtos = [];
  for (const sku of Object.keys(bySku)) {
    const p = bySku[sku];
    const liqItem = p.fat - p.comissao;
    const lucro = liqItem - p.custo - p.imposto;
    const mpa = p.fat ? (lucro / p.fat) * 100 : 0;
    produtos.push([p.nome, sku, p.un, round2(p.fat), round2(lucro), round2(lucro), round2(mpa), null]);
  }
  produtos.sort((a, b) => b[3] - a[3]);

  const lb = liq - custoProdutos - imposto;

  const cfgConta = CONTAS_ML[conta] || CONTAS_ML.ml;
  const channel = {
    nome: cfgConta.nome, cor: cfgConta.cor,
    fat: round2(fat), liq: round2(liq), lucroBruto: round2(lb),
    ads: 0, // ML Ads: integração separada (Product Ads API) — fase seguinte
    lucro: round2(lb),
    pedidos: orders.length - pedidosSemAssoc,
    semAssoc: pedidosSemAssoc,
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

// Data de hoje em ISO curto (YYYY-MM-DD), fuso local
const todayISO = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };

// ---------- Associacao anuncio -> produto ----------
// A "chave" identifica o anuncio: o SKU do vendedor ou, se nao houver, o ID do anuncio (MLB...).
const chaveAnuncio = (item) => (item && (item.seller_sku || item.seller_custom_field)) || (item && item.id) || '';
// Resolve a chave para o SKU do produto interno (usando as associacoes feitas na tela)
const resolverSku = (chave) => (costs.aliases && costs.aliases[chave]) || chave;
// Esta associado? = existe produto cadastrado com esse SKU
const temAssociacao = (chave) => !!(chave && costs.itens[resolverSku(chave)]);

// ---------- Lista global de pendências (independe do filtro de período) ----------
// Tira da lista tudo que já foi resolvido (produto cadastrado ou anúncio associado)
function limparPendentes() {
  let mudou = false;
  for (const chave of Object.keys(costs.pendentes)) {
    if (temAssociacao(chave)) { delete costs.pendentes[chave]; mudou = true; }
  }
  return mudou;
}
// Anota os anúncios sem produto encontrados numa leitura de pedidos
function registrarPendentes(orders, conta) {
  let mudou = limparPendentes();
  for (const o of (orders || [])) {
    for (const it of (o.order_items || [])) {
      const chave = chaveAnuncio(it.item);
      if (!chave || temAssociacao(chave)) continue;
      const a = costs.pendentes[chave] || {};
      const data = o.date_created || '';
      const novo = {
        titulo: (it.item && it.item.title) || a.titulo || chave,
        anuncioId: (it.item && it.item.id) || a.anuncioId || '',
        canal: conta || a.canal || 'ml',
        ultima: data > (a.ultima || '') ? data : (a.ultima || data),
      };
      if (JSON.stringify(a) !== JSON.stringify(novo)) { costs.pendentes[chave] = novo; mudou = true; }
    }
  }
  if (mudou) writeJSON(COSTS_FILE, costs);
  return mudou;
}
const totalPendentes = () => Object.keys(costs.pendentes).length;

// Guarda a foto do anúncio no SKU correspondente (usada na tela de associação)
function guardarFotos(orders, thumbs) {
  let mudou = false;
  for (const o of (orders || [])) {
    for (const it of (o.order_items || [])) {
      const id = it.item && it.item.id;
      const sku = resolverSku(chaveAnuncio(it.item));
      const url = id && thumbs[id];
      if (!sku || !url || costs.fotos[sku] === url) continue;
      costs.fotos[sku] = url; mudou = true;
    }
  }
  if (mudou) writeJSON(COSTS_FILE, costs);
}

// Varredura larga (últimos 90 dias) para achar pendências antigas, sem depender da tela
let varrendo = false;
async function varrerPendentes(dias = 90) {
  if (varrendo) return totalPendentes();
  varrendo = true;
  try {
    const ate = new Date().toISOString();
    const de = new Date(Date.now() - dias * 86400000).toISOString();
    for (const conta of contasConectadas()) {
      try {
        const me = await mlApi('/users/me', conta);
        const orders = await mlFetchOrders(me.id, de, ate, conta);
        registrarPendentes(orders, conta);
      } catch { /* tenta na próxima vez */ }
    }
    costs.varreduraEm = new Date().toISOString();
    writeJSON(COSTS_FILE, costs);
  } finally { varrendo = false; }
  return totalPendentes();
}

// Retorna o custo vigente de um SKU na data da venda (histórico)
function costFor(sku, dateISO) {
  const conf = costs.itens[sku] || {};
  const taxa = conf.imposto != null ? conf.imposto : (costs.taxaPadrao != null ? costs.taxaPadrao : 0.09);
  const d = (dateISO || todayISO()).slice(0, 10);
  let best = null;
  for (const e of (conf.custos || [])) {
    if (e.desde <= d && (!e.ate || e.ate >= d)) { if (!best || e.desde > best.desde) best = e; }
  }
  return { custo: best ? best.custo : 0, custoExtra: best ? best.custoExtra : 0, imposto: taxa, nome: conf.nome || '' };
}

// Cria/atualiza um produto. modo: 'todas' | 'novas' | 'periodo'
function upsertProduct(b) {
  const sku = String(b.sku || '').trim();
  if (!sku) return;
  const it = costs.itens[sku] || (costs.itens[sku] = { nome: '', ean: '', custos: [] });
  if (b.nome != null && b.nome !== '') it.nome = String(b.nome);
  if (b.ean != null && b.ean !== '') it.ean = String(b.ean);
  if (b.imposto != null && b.imposto !== '') it.imposto = Number(b.imposto);
  const custo = Number(b.custo) || 0;
  const custoExtra = Number(b.custoExtra) || 0;
  const modo = b.modo || 'todas';
  if (modo === 'todas' || !it.custos || it.custos.length === 0) {
    it.custos = [{ desde: '1970-01-01', ate: null, custo, custoExtra }];          // vale para todas as vendas
  } else if (modo === 'periodo' && b.desde) {
    it.custos.push({ desde: b.desde, ate: b.ate || null, custo, custoExtra });      // período específico
  } else {
    it.custos.push({ desde: todayISO(), ate: null, custo, custoExtra });            // só vendas novas a partir de hoje
  }
  it.custos.sort((a, z) => (a.desde < z.desde ? -1 : 1));
}

// Monta o objeto detalhado de UM pedido (usado por mlListSales e demoSales)
// itens: [{ titulo, sku, qtd, unit, total, precoUnit, liquido, imposto, custo, custoExtra, lucro, margem, comissao }]
// resumo: totais do pedido para a área expansível (estilo Gestor Seller)
function buildOrder({ id, data, dataAprov, status, envio, pack, itemsRaw, freteVend, freteComp, descontos, conta = 'ml' }) {
  const taxaPadrao = costs.taxaPadrao != null ? costs.taxaPadrao : 0.09;
  const totalProduto = itemsRaw.reduce((s, it) => s + it.unit * it.qtd, 0) || 1e-9;
  const itens = itemsRaw.map((it) => {
    const tp = it.unit * it.qtd;
    const share = tp / totalProduto;
    const fVend = freteVend * share, desc = descontos * share, fComp = freteComp * share;
    const cf = costFor(it.sku, data);                     // custo vigente na data da venda (histórico)
    const taxa = cf.imposto;
    const imposto = tp * taxa;
    const custo = cf.custo * it.qtd;
    const custoExtra = cf.custoExtra * it.qtd;
    // Cupom/desconto é bancado pelo vendedor => reduz o líquido (é custo, não bônus)
    const liquido = tp - it.comissao - fVend - desc;      // líquido do marketplace
    const lucro = liquido - imposto - custo - custoExtra;
    const totalExib = tp + fComp;                          // total pago pelo comprador
    const margem = totalExib ? (lucro / totalExib) * 100 : 0;
    return {
      titulo: it.titulo, sku: it.sku, qtd: it.qtd, img: it.img || '',
      chave: it.chave || it.sku, anuncioId: it.anuncioId || '', associado: it.associado !== false,
      precoUnit: round2(it.unit), total: round2(totalExib),
      liquido: round2(liquido), imposto: round2(imposto),
      custo: round2(custo), custoExtra: round2(custoExtra),
      lucro: round2(lucro), margem: round2(margem), comissao: round2(it.comissao),
      freteVend: round2(fVend), freteComp: round2(fComp), descontos: round2(desc),
    };
  });
  const soma = (k) => itens.reduce((s, i) => s + i[k], 0);
  const comissaoTot = soma('comissao');
  return {
    id: String(id), data, dataAprov: dataAprov || data, status,
    canal: conta, marketplace: (CONTAS_ML[conta] || CONTAS_ML.ml).nome,
    semAssoc: itens.some((i) => i.associado === false),
    envio: envio || '', pack: !!pack,
    itens,
    resumo: {
      totalProduto: round2(totalProduto), total: round2(totalProduto + freteComp),
      freteVend: round2(freteVend), freteComp: round2(freteComp), descontos: round2(descontos),
      comissao: round2(comissaoTot), imposto: round2(soma('imposto')), custo: round2(soma('custo')), custoExtra: round2(soma('custoExtra')),
      liquido: round2(soma('liquido')), lucro: round2(soma('lucro')),
    },
  };
}

// Busca fotos e tipo de envio dos anúncios em lote via /items multiget.
// O pedido não traz o tipo de logística (FULL / Flex / Coleta...), o anúncio traz.
async function mlItemInfo(itemIds, conta = 'ml') {
  const thumbs = {}, envios = {};
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const res = await mlApi(`/items?ids=${chunk.join(',')}&attributes=id,secure_thumbnail,thumbnail,shipping`, conta);
      (res || []).forEach((r) => {
        const b = (r && r.body) || r;
        if (!b || !b.id) return;
        let u = b.secure_thumbnail || b.thumbnail || '';
        if (u && u.startsWith('http://')) u = u.replace('http://', 'https://');
        thumbs[b.id] = u;
        if (b.shipping && b.shipping.logistic_type) envios[b.id] = b.shipping.logistic_type;
      });
    } catch { /* ignora */ }
  }
  return { thumbs, envios };
}
const mlItemThumbs = async (ids, conta) => (await mlItemInfo(ids, conta)).thumbs;

// Lista de vendas individuais detalhadas (para a página "Vendas")
async function mlListSales(fromISO, toISO, conta = 'ml') {
  const me = await mlApi('/users/me', conta);
  const orders = await mlFetchOrders(me.id, fromISO, toISO, conta);
  const allIds = orders.flatMap((o) => (o.order_items || []).map((it) => it.item && it.item.id));
  const { thumbs, envios } = await mlItemInfo(allIds, conta);
  registrarPendentes(orders, conta);
  guardarFotos(orders, thumbs);
  // frete + modalidade de envio de cada pedido, buscados em paralelo
  const envioPedido = await emLotes(orders, 8, (o) => mlEnvio(o.shipping && o.shipping.id, conta));
  const out = [];
  orders.forEach((o, idx) => {
    const items = o.order_items || [];
    const freteVend = envioPedido[idx].frete;
    const pays = o.payments || [];
    const freteComp = pays.reduce((s, pp) => s + (pp.shipping_cost || 0), 0);
    const descontos = (o.coupon && o.coupon.amount) ? o.coupon.amount : 0;
    const itemsRaw = items.map((it) => ({
      titulo: (it.item && it.item.title) || '—',
      chave: chaveAnuncio(it.item),
      anuncioId: (it.item && it.item.id) || '',
      sku: resolverSku(chaveAnuncio(it.item)),
      associado: temAssociacao(chaveAnuncio(it.item)),
      qtd: it.quantity || 0,
      unit: it.unit_price || 0,
      comissao: (it.sale_fee || 0) * (it.quantity || 0),
      img: (it.item && thumbs[it.item.id]) || '',
    }));
    out.push(buildOrder({
      id: o.id, data: o.date_created, dataAprov: o.date_closed, status: o.status,
      // modalidade real deste pedido; o anúncio só serve de reserva se o envio não responder
      envio: envioPedido[idx].tipo
        || (o.shipping && o.shipping.logistic_type)
        || items.map((it) => it.item && envios[it.item.id]).find(Boolean) || '',
      pack: !!o.pack_id,
      itemsRaw, freteVend, freteComp, descontos, conta,
    }));
  });
  return out;
}

// Vendas de exemplo (modo demonstração) geradas a partir dos produtos demo
function demoSales() {
  const prods = (DEMO && DEMO.produtos) ? DEMO.produtos.filter((p) => p[2] > 0).slice(0, 12) : [];
  const now = Date.now();
  const st = ['paid', 'shipped', 'delivered'];
  const env = ['self_service', 'cross_docking', 'fulfillment'];
  return prods.map((p, i) => {
    const qtd = 1 + (i % 3);
    const unit = round2(p[3] / p[2]);
    const comissao = round2(unit * qtd * 0.13);
    const freteVend = 12 + (i % 4) * 3.5;
    return buildOrder({
      id: 2000000000 + i,
      data: new Date(now - i * 36e5 * 5).toISOString(),
      dataAprov: new Date(now - i * 36e5 * 5 + 120000).toISOString(),
      status: st[i % 3], envio: env[i % 3], pack: i % 4 === 0,
      itemsRaw: [{ titulo: p[0], sku: p[1], qtd, unit, comissao }],
      freteVend, freteComp: i % 2 ? 4.99 : 0, descontos: i % 3 ? 1.6 : 0,
    });
  });
}

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
  const produtosPorCanal = {};
  const status = { amz: 'soon', shp: 'soon', mag: 'soon', tik: 'soon', loja: 'soon' };
  let algumConectado = false;

  // Cada conta do ML vira um canal próprio (ex.: Mercado Livre e LDM SC)
  for (const conta of Object.keys(CONTAS_ML)) {
    if (!mlConnected(conta)) { status[conta] = 'disconnected'; continue; }
    try {
      const built = await mlBuildChannel(from, to, { withShipping: ENV.ML_SHIPPING !== 'off', conta });
      channels[conta] = built.channel;
      dreDetail[conta] = built.dreDetail;
      produtosPorCanal[conta] = built.produtos;
      status[conta] = 'connected';
      algumConectado = true;
    } catch (e) {
      status[conta] = 'error';
      status[conta + 'Error'] = String(e.message || e);
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
  if (!algumConectado && DEMO) {
    return { channels: DEMO.channels, dreDetail: DEMO.dreDetail, abc: DEMO.abc, produtos: DEMO.produtos, produtosPorCanal: {}, status, demo: true, period: { from, to } };
  }

  // Junta os produtos das contas somando por SKU (para a visão "todos os canais")
  const soma = {};
  for (const conta of Object.keys(produtosPorCanal)) {
    for (const p of produtosPorCanal[conta]) {
      const sku = p[1];
      if (!soma[sku]) soma[sku] = [p[0], sku, 0, 0, 0, 0, 0, null];
      soma[sku][2] += p[2]; soma[sku][3] += p[3]; soma[sku][4] += p[4]; soma[sku][5] += p[5];
    }
  }
  const produtos = Object.values(soma).map((p) => {
    p[3] = round2(p[3]); p[4] = round2(p[4]); p[5] = round2(p[5]);
    p[6] = p[3] ? round2((p[4] / p[3]) * 100) : 0;
    return p;
  }).sort((a, b) => b[3] - a[3]);

  const abc = classifyABC(produtos);
  const abcPorCanal = {};
  for (const conta of Object.keys(produtosPorCanal)) abcPorCanal[conta] = classifyABC(produtosPorCanal[conta]);
  // Total de vendas deixadas de fora por falta de associacao (alerta na tela)
  const semAssoc = Object.keys(channels).reduce((s, k) => s + ((channels[k] && channels[k].semAssoc) || 0), 0);
  return { channels, dreDetail, abc, abcPorCanal, produtos, produtosPorCanal, semAssoc, status, demo: false, period: { from, to } };
}

// ================= ROTEAMENTO HTTP =================
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

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

// Proteção por senha (para o painel ficar privado quando publicado na internet).
// Só ativa se APP_PASSWORD estiver definido. Usa autenticação básica do navegador.
function checkAuth(req, res) {
  if (!ENV.APP_PASSWORD) return true; // sem senha definida => aberto (ok para uso local)
  const h = req.headers.authorization || '';
  const b64 = h.split(' ')[1];
  if (b64) {
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    if (pass === ENV.APP_PASSWORD) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Leco Shop"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Acesso restrito. Informe a senha.');
  return false;
}

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req, res)) return;
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
      if (b && b.taxaPadrao != null) { costs.taxaPadrao = b.taxaPadrao; writeJSON(COSTS_FILE, costs); }
      return sendJSON(res, 200, { ok: true });
    }
    // ===== Produtos (cadastro + custos com histórico por data) =====
    if (p === '/api/products' && req.method === 'GET') {
      const hoje = todayISO();
      const itens = Object.keys(costs.itens).map((sku) => {
        const conf = costs.itens[sku];
        const cf = costFor(sku, hoje);
        return {
          sku, nome: conf.nome || '', ean: conf.ean || '',
          imposto: conf.imposto != null ? conf.imposto : (costs.taxaPadrao != null ? costs.taxaPadrao : 0.09),
          custo: cf.custo, custoExtra: cf.custoExtra, versoes: (conf.custos || []).length,
          img: costs.fotos[sku] || '',
        };
      });
      return sendJSON(res, 200, { taxaPadrao: costs.taxaPadrao, itens });
    }
    if (p === '/api/products' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.op === 'delete') { delete costs.itens[String(b.sku || '').trim()]; writeJSON(COSTS_FILE, costs); return sendJSON(res, 200, { ok: true }); }
      if (b.op === 'save') { upsertProduct(b); limparPendentes(); writeJSON(COSTS_FILE, costs); return sendJSON(res, 200, { ok: true, pendentes: totalPendentes() }); }
      return sendJSON(res, 400, { error: 'op inválida' });
    }
    // Associa um anuncio do marketplace a um produto interno ja existente
    if (p === '/api/associar' && req.method === 'POST') {
      const b = await readBody(req);
      const chave = String(b.chave || '').trim();
      const sku = String(b.sku || '').trim();
      if (!chave || !sku) return sendJSON(res, 400, { error: 'informe o anúncio e o produto' });
      if (!costs.itens[sku]) return sendJSON(res, 400, { error: 'produto não encontrado: ' + sku });
      costs.aliases[chave] = sku;
      limparPendentes();
      writeJSON(COSTS_FILE, costs);
      return sendJSON(res, 200, { ok: true, chave, sku, pendentes: totalPendentes() });
    }
    // Lista global de anúncios pendentes (não depende do filtro de período da tela)
    if (p === '/api/pendentes') {
      if (u.searchParams.get('varrer') === '1') await varrerPendentes(Number(u.searchParams.get('dias')) || 90);
      else if (limparPendentes()) writeJSON(COSTS_FILE, costs);
      const lista = Object.keys(costs.pendentes).map((chave) => ({ chave, ...costs.pendentes[chave] }));
      lista.sort((a, b) => String(b.ultima || '').localeCompare(String(a.ultima || '')));
      // busca as fotos dos anúncios (agrupadas por conta)
      for (const conta of contasConectadas()) {
        const ids = lista.filter((x) => x.canal === conta && x.anuncioId).map((x) => x.anuncioId);
        if (!ids.length) continue;
        try {
          const thumbs = await mlItemThumbs(ids, conta);
          lista.forEach((x) => { if (thumbs[x.anuncioId]) x.img = thumbs[x.anuncioId]; });
        } catch { /* segue sem foto */ }
      }
      return sendJSON(res, 200, { pendentes: lista, total: lista.length, varreduraEm: costs.varreduraEm || null });
    }
    if (p === '/api/desassociar' && req.method === 'POST') {
      const b = await readBody(req);
      delete costs.aliases[String(b.chave || '').trim()];
      writeJSON(COSTS_FILE, costs);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/products/export' || p === '/api/products/template') {
      const tpl = p.endsWith('template');
      const linhas = ['sku;nome;ean;imposto;custo;custo_extra'];
      if (tpl) {
        linhas.push('SKU-EXEMPLO;Nome do produto exemplo;7891234567890;9;22,50;0,50');
      } else {
        const hoje = todayISO();
        for (const sku of Object.keys(costs.itens)) {
          const conf = costs.itens[sku]; const cf = costFor(sku, hoje);
          const imp = ((conf.imposto != null ? conf.imposto : costs.taxaPadrao) * 100);
          linhas.push([sku, (conf.nome || '').replace(/;/g, ','), conf.ean || '', String(imp).replace('.', ','), String(cf.custo).replace('.', ','), String(cf.custoExtra).replace('.', ',')].join(';'));
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${tpl ? 'modelo-produtos' : 'meus-produtos'}.csv"` });
      return res.end('﻿' + linhas.join('\r\n'));
    }
    if (p === '/api/products/import' && req.method === 'POST') {
      const b = await readBody(req);
      const modo = b.modo || 'novas';
      const rows = String(b.csv || '').split(/\r?\n/).filter((l) => l.trim());
      const num = (v) => Number(String(v == null ? '' : v).replace(',', '.').trim());
      let n = 0;
      for (const line of rows) {
        const c = line.split(';');
        if ((c[0] || '').trim().toLowerCase() === 'sku') continue;
        const sku = (c[0] || '').trim(); if (!sku) continue;
        upsertProduct({
          sku, nome: (c[1] || '').trim(), ean: (c[2] || '').trim(),
          imposto: (c[3] != null && c[3] !== '') ? num(c[3]) / 100 : null,
          custo: num(c[4] || 0), custoExtra: num(c[5] || 0), modo,
        });
        n++;
      }
      writeJSON(COSTS_FILE, costs);
      return sendJSON(res, 200, { ok: true, importados: n });
    }
    if (p === '/auth/ml') {
      if (!ML.clientId) return sendJSON(res, 400, { error: 'Configure ML_CLIENT_ID no .env' });
      // qual conta está sendo conectada (ml = principal, ldmsc = filial SC)
      const conta = ehContaML(u.searchParams.get('conta')) ? u.searchParams.get('conta') : 'ml';
      const state = conta + '.' + crypto.randomBytes(6).toString('hex');
      const auth = `${ML.authHost}/authorization?` + new URLSearchParams({
        response_type: 'code', client_id: ML.clientId, redirect_uri: ML.redirectUri, state,
      });
      res.writeHead(302, { Location: auth });
      return res.end();
    }
    if (p === '/callback') {
      const code = u.searchParams.get('code');
      if (!code) { res.writeHead(400); return res.end('Sem code'); }
      const st = String(u.searchParams.get('state') || '');
      const conta = ehContaML(st.split('.')[0]) ? st.split('.')[0] : 'ml';
      await mlExchangeCode(code, conta);
      res.writeHead(302, { Location: '/?connected=' + conta });
      return res.end();
    }
    if (p === '/api/status') {
      const contas = {};
      let mudou = false;
      for (const c of Object.keys(CONTAS_ML)) {
        const conectada = mlConnected(c);
        // Descobre o vendedor da conta (uma vez só; depois fica guardado)
        if (conectada && !tokens[c].apelido) {
          try {
            const me = await mlApi('/users/me', c);
            tokens[c].user_id = me.id; tokens[c].apelido = me.nickname || ''; mudou = true;
          } catch { /* ignora */ }
        }
        contas[c] = {
          nome: CONTAS_ML[c].nome, cor: CONTAS_ML[c].cor, conectada,
          apelido: conectada ? (tokens[c].apelido || '') : '',
          userId: conectada ? (tokens[c].user_id || null) : null,
        };
      }
      if (mudou) writeJSON(TOKENS_FILE, tokens);
      // Duas contas apontando para o MESMO vendedor = login repetido
      const ids = Object.keys(contas).filter((c) => contas[c].userId).map((c) => String(contas[c].userId));
      const duplicada = ids.length > 1 && new Set(ids).size < ids.length;
      return sendJSON(res, 200, { ml: mlConnected('ml'), contas, duplicada, clientIdSet: !!ML.clientId, redirectUri: ML.redirectUri });
    }
    if (p === '/api/dashboard') {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const from = u.searchParams.get('from') || first.toISOString().slice(0, 19) + '.000-03:00';
      const to = u.searchParams.get('to') || now.toISOString().slice(0, 19) + '.000-03:00';
      const data = await buildDashboard({ from, to });
      return sendJSON(res, 200, data);
    }
    if (p === '/api/sales') {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const from = u.searchParams.get('from') || first.toISOString().slice(0, 19) + '.000-03:00';
      const to = u.searchParams.get('to') || now.toISOString().slice(0, 19) + '.000-03:00';
      const conectadas = contasConectadas();
      if (!conectadas.length) return sendJSON(res, 200, { sales: demoSales(), demo: true });
      // se o filtro pedir um canal específico, busca só nele
      const filtro = u.searchParams.get('canal');
      const alvo = ehContaML(filtro) ? conectadas.filter((c) => c === filtro) : conectadas;
      let sales = [];
      const erros = [];
      for (const conta of alvo) {
        try { sales = sales.concat(await mlListSales(from, to, conta)); }
        catch (e) { erros.push(`${CONTAS_ML[conta].nome}: ${String(e.message || e)}`); }
      }
      sales.sort((a, b) => new Date(b.data) - new Date(a.data));
      const semAssoc = sales.filter((s) => s.semAssoc).length;
      // ?semAssoc=1 lista SO as vendas com anuncio nao associado
      const soSemAssoc = u.searchParams.get('semAssoc') === '1';
      const lista = soSemAssoc ? sales.filter((s) => s.semAssoc) : sales;
      return sendJSON(res, 200, { sales: lista, semAssoc, demo: false, error: erros.length ? erros.join(' | ') : undefined });
    }
    if (p.startsWith('/api/disconnect/')) {
      const conta = p.split('/')[3];
      if (ehContaML(conta)) { delete tokens[conta]; writeJSON(TOKENS_FILE, tokens); return sendJSON(res, 200, { ok: true }); }
      return sendJSON(res, 400, { error: 'conta inválida' });
    }
    if (p === '/') return serveStatic(res, 'index.html');
    return serveStatic(res, p.replace(/^\//, ''));
  } catch (e) {
    return sendJSON(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Leco Shop rodando em  http://localhost:${PORT}`);
  console.log(`  Dados salvos em: ${DATA_DIR}${DATA_DIR === __dirname ? '  (TEMPORARIO — some a cada publicacao)' : '  (disco persistente OK)'}`);
  for (const c of Object.keys(CONTAS_ML)) {
    console.log(`  ${CONTAS_ML[c].nome}: ${mlConnected(c) ? 'CONECTADO' : 'nao conectado — abra o site e clique em Conectar'}`);
  }
  if (!ML.clientId) console.log('  Falta configurar o .env (ML_CLIENT_ID / ML_CLIENT_SECRET). Veja o README.\n');
  // Ao subir, procura anúncios sem produto nos últimos 90 dias (em segundo plano).
  // Assim o alerta já aparece certo mesmo se o usuário abrir o painel filtrado em "Hoje".
  setTimeout(() => { varrerPendentes(90).catch(() => {}); }, 3000);
});
