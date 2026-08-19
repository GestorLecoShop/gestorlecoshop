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
// Nome do canal para exibir no card da venda (Mercado Livre, LDM SC, Amazon...)
const NOMES_CANAL = { amz: 'Amazon', shp: 'Shopee', tik: 'TikTok Shop' };
const nomeCanal = (c) => (CONTAS_ML[c] && CONTAS_ML[c].nome) || NOMES_CANAL[c] || 'Mercado Livre';

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

// ================= AMAZON (Selling Partner API) =================
// Desde out/2023 a Amazon não exige mais AWS IAM nem assinatura SigV4: basta o
// token do Login with Amazon (LWA). Guardamos as credenciais no disco persistente.
const AMZ_FILE = path.join(DATA_DIR, 'amazon.json');
const AMZ_HOSTS = {
  na: 'https://sellingpartnerapi-na.amazon.com',   // inclui o Brasil
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};
const AMZ_MERCADO_BR = 'A2Q3Y263D00KWC';
let amz = readJSON(AMZ_FILE, {});
amz = { clientId: '', clientSecret: '', refreshToken: '', marketplaceId: AMZ_MERCADO_BR, regiao: 'na', ...amz };
const amzConectada = () => !!(amz.clientId && amz.clientSecret && amz.refreshToken);
const amzSalvar = () => writeJSON(AMZ_FILE, amz);

let amzToken = { valor: '', expiraEm: 0 };
async function amzAccessToken() {
  if (amzToken.valor && Date.now() < amzToken.expiraEm - 60000) return amzToken.valor;
  const { status, json } = await request('POST', 'https://api.amazon.com/auth/o2/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: {
      grant_type: 'refresh_token',
      refresh_token: amz.refreshToken,
      client_id: amz.clientId,
      client_secret: amz.clientSecret,
    },
  });
  if (status !== 200 || !json.access_token) {
    throw new Error('Amazon: não consegui renovar o acesso — ' + (json.error_description || json.error || ('HTTP ' + status)));
  }
  amzToken = { valor: json.access_token, expiraEm: Date.now() + (json.expires_in || 3600) * 1000 };
  return amzToken.valor;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Datas em horário de Brasília. O servidor roda em UTC, então escrevemos o
// relógio de Brasília e o fuso de verdade — antes cortávamos o "Z" do UTC e
// colávamos "-03:00", o que jogava o período 3 horas para frente.
const isoBR = (d) => new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 19) + '-03:00';
const agoraBR = () => isoBR(new Date(Date.now() - 120000));
function inicioDoMesBR() {
  const b = new Date(Date.now() - 3 * 3600e3);
  return isoBR(new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 1, 3, 0, 0)));
}

// Chamada à SP-API já com token, repetindo quando a Amazon pede para desacelerar (429)
async function amzApi(caminho, tentativa = 0) {
  const token = await amzAccessToken();
  const host = AMZ_HOSTS[amz.regiao] || AMZ_HOSTS.na;
  const { status, json } = await request('GET', host + caminho, {
    headers: { 'x-amz-access-token': token, 'Accept': 'application/json' },
  });
  if (status === 429 && tentativa < 5) { await esperar(1500 * (tentativa + 1)); return amzApi(caminho, tentativa + 1); }
  if (status >= 400) {
    const e = (json && json.errors && json.errors[0]) || {};
    throw new Error('Amazon ' + status + ': ' + (e.message || e.code || JSON.stringify(json).slice(0, 160)));
  }
  return json || {};
}

// Aviso do canal Amazon quando a leitura sai incompleta. Fica visível na tela em
// vez de virar número errado no painel.
let amzAviso = '';

// getOrders tem cota baixíssima (cerca de 1 chamada por minuto). O amzApi já
// repete algumas vezes; aqui insistimos mais um pouco, só para 429.
async function amzTentar(caminho) {
  const esperas = [8000, 25000];
  let ultimo;
  for (let i = 0; i <= esperas.length; i++) {
    try { return await amzApi(caminho); }
    catch (e) {
      ultimo = e;
      if (!/429|throttl|quota|rate/i.test(String(e.message || ''))) throw e;
      if (i < esperas.length) await esperar(esperas[i]);
    }
  }
  throw ultimo;
}

// Pedidos do período (paginado por NextToken). Períodos longos são quebrados em
// janelas de 7 dias: uma janela que falhe não derruba as outras, e o que já foi
// lido nunca é descartado.
async function amzPedidos(deISO, ateISO) {
  const out = [];
  const falhas = [];
  const inicio = new Date(deISO).getTime();
  const fim = new Date(ateISO).getTime();
  const passo = 7 * 864e5;
  for (let t = inicio; t < fim; t += passo) {
    const de = new Date(t).toISOString();
    const ate = new Date(Math.min(t + passo, fim)).toISOString();
    let proximo = '';
    for (let i = 0; i < 60; i++) {
      const q = new URLSearchParams({ MarketplaceIds: amz.marketplaceId });
      if (proximo) q.set('NextToken', proximo);
      else { q.set('CreatedAfter', de); q.set('CreatedBefore', ate); q.set('MaxResultsPerPage', '100'); }
      let p;
      try { p = (await amzTentar('/orders/v0/orders?' + q.toString())).payload || {}; }
      catch (e) { falhas.push(de.slice(0, 10) + ' a ' + ate.slice(0, 10) + ': ' + String(e.message || e)); break; }
      out.push(...(p.Orders || []));
      proximo = p.NextToken || '';
      if (!proximo) break;
      await esperar(2000);
    }
    if (t + passo < fim) await esperar(2000);
  }
  return { pedidos: out, falhas };
}

// Taxas e valores por pedido: um único pedido de eventos financeiros do período,
// bem mais barato que consultar pedido a pedido.
async function amzFinanceiro(deISO, ateISO) {
  const porPedido = {};
  let proximo = '';
  for (let i = 0; i < 60; i++) {
    const q = new URLSearchParams({ MaxResultsPerPage: '100' });
    if (proximo) q.set('NextToken', proximo);
    else { q.set('PostedAfter', deISO); q.set('PostedBefore', ateISO); }
    let j;
    try { j = await amzApi('/finances/v0/financialEvents?' + q.toString()); }
    catch { break; }   // sem financeiro o painel ainda mostra o faturamento
    const ev = ((j.payload || {}).FinancialEvents) || {};
    for (const s of (ev.ShipmentEventList || [])) {
      const id = s.AmazonOrderId;
      if (!id) continue;
      const alvo = porPedido[id] || (porPedido[id] = {
        comissao: 0, fba: 0, outras: 0, data: '', itens: {},
        fretePedido: 0, taxasPedido: 0, freteComprador: 0,
      });
      if (s.PostedDate && (!alvo.data || s.PostedDate < alvo.data)) alvo.data = s.PostedDate;
      for (const it of (s.ShipmentItemList || [])) {
        const sku = it.SellerSKU || '';
        const linha = alvo.itens[sku] || (alvo.itens[sku] = { qtd: 0, receita: 0, imposto: 0, frete: 0, taxas: 0 });
        linha.qtd += it.QuantityShipped || 0;
        for (const c of (it.ItemChargeList || [])) {
          const v = ((c.ChargeAmount || {}).CurrencyAmount) || 0;
          // O comprador pagou preço + imposto, e a Amazon repassa os dois ao vendedor.
          // Somar só o Principal cortava ~35% do faturamento nos pedidos FBA.
          if (c.ChargeType === 'Principal') linha.receita += v;
          else if (c.ChargeType === 'Tax') { linha.receita += v; linha.imposto += v; }
          else if (String(c.ChargeType || '').includes('Shipping')) { linha.frete += v; alvo.freteComprador += v; }
          else linha.receita += v;
        }
        for (const f of (it.ItemFeeList || [])) {
          const v = ((f.FeeAmount || {}).CurrencyAmount) || 0;   // vem negativo
          linha.taxas += v;
          if (f.FeeType === 'Commission') alvo.comissao += v;
          else if (String(f.FeeType || '').startsWith('FBA')) alvo.fba += v;
          else alvo.outras += v;
        }
      }
      // Taxas do pedido (não do item): é aqui que mora o frete do DBA/Easy Ship.
      // Ignorar estas duas listas deixava o frete pago pelo vendedor sempre zerado.
      for (const lista of [s.ShipmentFeeList, s.ShipmentFeeAdjustmentList, s.OrderFeeList, s.OrderFeeAdjustmentList]) {
        for (const f of (lista || [])) {
          const v = Math.abs(((f.FeeAmount || {}).CurrencyAmount) || 0);
          if (/ship|postage|delivery|frete/i.test(String(f.FeeType || ''))) alvo.fretePedido += v;
          else alvo.taxasPedido += v;
        }
      }
    }
    // Taxas de serviço vêm numa lista à parte do envio. É aqui que a Amazon
    // lança a postagem do DBA/Easy Ship — fora do ShipmentEvent.
    for (const sv of (ev.ServiceFeeEventList || [])) {
      const id = sv.AmazonOrderId;
      if (!id) continue;
      const alvo = porPedido[id] || (porPedido[id] = {
        comissao: 0, fba: 0, outras: 0, data: '', itens: {},
        fretePedido: 0, taxasPedido: 0, freteComprador: 0,
      });
      const motivo = String(sv.FeeReason || '') + ' ' + String(sv.FeeDescription || '');
      for (const f of (sv.FeeList || [])) {
        const v = Math.abs(((f.FeeAmount || {}).CurrencyAmount) || 0);
        const tipo = String(f.FeeType || '') + ' ' + motivo;
        if (/ship|postage|delivery|frete|easy/i.test(tipo)) alvo.fretePedido += v;
        else alvo.taxasPedido += v;
      }
    }
    proximo = ev.NextToken || (j.payload || {}).NextToken || '';
    if (!proximo) break;
    await esperar(600);
  }
  return porPedido;
}

// Nome da loja, só para identificar a conta na tela
async function amzLoja() {
  try {
    const j = await amzApi('/sellers/v1/marketplaceParticipations');
    const lista = (j.payload || []).map((x) => (x.marketplace || {}));
    const m = lista.find((x) => x.id === amz.marketplaceId) || lista[0] || {};
    return m.name || 'Amazon';
  } catch { return 'Amazon'; }
}

// Tipo de envio do pedido, com as mesmas cinco modalidades que o Gestor Seller usa:
//   AFN com origem própria = FBA On Site · AFN = estoque na Amazon (FBA)
//   EasyShip = a Amazon coleta e entrega (DBA) · Priority/Premium = própria prioridade
function amzEnvio(o) {
  if (o.FulfillmentChannel === 'AFN') return o.SupplySourceId ? 'fba_onsite' : 'fba';
  if (o.EasyShipShipmentStatus) return 'dba';
  const cat = String(o.ShipmentServiceLevelCategory || '');
  if (o.IsPremiumOrder || cat === 'Priority' || cat === 'Expedited') return 'proprio_prioridade';
  return 'proprio';
}

// A Amazon lança as taxas alguns dias DEPOIS da venda. Se buscarmos o financeiro
// só no mesmo período do pedido, vem faturamento sem taxa nenhuma. Por isso a
// janela do financeiro começa antes e vai até agora.
function janelaFinanceiro(deISO) {
  const de = new Date(new Date(deISO).getTime() - 7 * 864e5).toISOString();
  return { de, ate: new Date(Date.now() - 120000).toISOString() };
}

// Pedidos + taxas + itens, tudo que as telas precisam
// ===== Armazém local dos pedidos da Amazon =====
// A Amazon libera 1 chamada de getOrders por minuto e 1 de getOrderItems a cada
// 2 segundos. Consultar a API a cada abertura de tela estoura a cota e devolve
// dado pela metade. Então um sincronizador roda em segundo plano, guarda tudo em
// disco, e as telas leem do arquivo — abrem na hora e a venda aparece em menos
// de um minuto.
const AMZ_DB_FILE = path.join(DATA_DIR, 'amazon-db.json');
let amzDB = readJSON(AMZ_DB_FILE, {});
amzDB = { pedidos: {}, itens: {}, fin: {}, falhas: {}, ultimaSync: '', ultimaFin: '', ...amzDB };
let amzDBsujo = false;
const amzFila = [];          // pedidos esperando os itens
let amzCiclando = false;
let amzErroSync = '';

// A fila mora na memória; num reinício ela sumiria e os pedidos guardados sem
// itens ficariam órfãos para sempre. Então recomeçamos a fila pelo que falta.
for (const id of Object.keys(amzDB.pedidos)) if (!amzDB.itens[id]) amzFila.push(id);

function amzGuardar() {
  if (!amzDBsujo) return;
  writeJSON(AMZ_DB_FILE, amzDB);
  amzDBsujo = false;
}

// Só o que mudou desde a última passada (LastUpdatedAfter), 1 chamada por minuto
async function amzSyncPedidos() {
  const desde = amzDB.ultimaSync || new Date(Date.now() - 45 * 864e5).toISOString();
  const marca = new Date(Date.now() - 120000).toISOString();
  let proximo = '';
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ MarketplaceIds: amz.marketplaceId });
    if (proximo) q.set('NextToken', proximo);
    else { q.set('LastUpdatedAfter', desde); q.set('MaxResultsPerPage', '100'); }
    const p = (await amzApi('/orders/v0/orders?' + q.toString())).payload || {};
    for (const o of (p.Orders || [])) {
      amzDB.pedidos[o.AmazonOrderId] = o;
      amzDBsujo = true;
      if (!amzDB.itens[o.AmazonOrderId] && !amzFila.includes(o.AmazonOrderId)) amzFila.push(o.AmazonOrderId);
    }
    proximo = p.NextToken || '';
    if (!proximo) break;
    await esperar(61000);   // getOrders: 0,0167 req/s
  }
  amzDB.ultimaSync = marca;
  amzDBsujo = true;
}

// Itens dos pedidos novos, respeitando 0,5 req/s
async function amzSyncItens() {
  for (let n = 0; n < 20 && amzFila.length; n++) {
    const id = amzFila.shift();
    try {
      const r = (await amzApi('/orders/v0/orders/' + id + '/orderItems')).payload || {};
      amzDB.itens[id] = r.OrderItems || [];
      delete amzDB.falhas[id];
      amzDBsujo = true;
    } catch (e) {
      const msg = String(e.message || e);
      // Cota estourada: devolve para o começo e espera o próximo ciclo
      if (/429|throttl|quota/i.test(msg)) { amzFila.unshift(id); break; }
      // Outro erro: anota e tenta de novo mais tarde, até desistir
      const tentativas = ((amzDB.falhas[id] || {}).n || 0) + 1;
      amzDB.falhas[id] = { n: tentativas, erro: msg.slice(0, 140) };
      amzDBsujo = true;
      if (tentativas < 4) amzFila.push(id);
    }
    await esperar(2200);
  }
}

// Taxas: o extrato demora dias para fechar, então revisamos uma janela larga
async function amzSyncFinanceiro() {
  const de = new Date(Date.now() - 40 * 864e5).toISOString();
  const ate = new Date(Date.now() - 120000).toISOString();
  const fin = await amzFinanceiro(de, ate);
  Object.assign(amzDB.fin, fin);
  amzDB.ultimaFin = ate;
  amzDBsujo = true;
}

async function amzCiclo() {
  if (amzCiclando || !amzConectada()) return;
  amzCiclando = true;
  try {
    await amzSyncPedidos();
    await amzSyncItens();
    const venceu = !amzDB.ultimaFin || (Date.now() - new Date(amzDB.ultimaFin).getTime()) > 15 * 60000;
    if (venceu) await amzSyncFinanceiro();
    amzErroSync = '';
  } catch (e) {
    amzErroSync = String(e.message || e);
  }
  amzGuardar();
  amzCiclando = false;
}
setInterval(amzCiclo, 60000);
setTimeout(amzCiclo, 8000);

// Leitura instantânea, direto do arquivo — nenhuma chamada à Amazon aqui
async function amzPedidosDetalhados(deISO, ateISO) {
  const de = new Date(deISO).getTime();
  const ate = new Date(ateISO).getTime();
  const pedidos = Object.keys(amzDB.pedidos)
    .map((id) => amzDB.pedidos[id])
    .filter((o) => { const t = new Date(o.PurchaseDate).getTime(); return t >= de && t <= ate; })
    .sort((a, b) => new Date(b.PurchaseDate) - new Date(a.PurchaseDate));
  const itens = pedidos.map((o) => amzDB.itens[o.AmazonOrderId] || []);
  const total = Object.keys(amzDB.pedidos).length;
  amzAviso = amzErroSync ? ('sincronia com erro — ' + amzErroSync)
    : (!total ? 'primeira sincronia em andamento, aguarde alguns minutos'
      : (amzFila.length ? amzFila.length + ' pedido(s) ainda buscando os itens' : ''));
  return { pedidos, fin: amzDB.fin, itens };
}

// Vendas detalhadas da Amazon para a página "Vendas"
async function amzListSales(deISO, ateISO) {
  const { pedidos, fin, itens } = await amzPedidosDetalhados(deISO, ateISO, true);
  const out = [];
  let semPreco = 0;
  let mudouPendentes = limparPendentes();
  pedidos.forEach((o, i) => {
    const f = fin[o.AmazonOrderId] || { itens: {} };
    const lista = itens[i] || [];
    const itemsRaw = (lista.length ? lista : Object.keys(f.itens).map((sku) => ({ SellerSKU: sku }))).map((it) => {
      const skuBruto = it.SellerSKU || '';
      const lf = f.itens[skuBruto] || {};
      const qtd = it.QuantityOrdered || lf.qtd || 0;
      // ItemPrice vem SEM o imposto e o imposto vem à parte em ItemTax. O comprador
      // pagou os dois e a Amazon repassa os dois — somar só o ItemPrice cortava
      // cerca de 35% do faturamento em todo pedido FBA.
      const precoDoPedido = Number(((it.ItemPrice || {}).Amount) || 0)
        + Number(((it.ItemTax || {}).Amount) || 0);
      // O pedido manda o preço cheio; o extrato manda só o Principal, sem imposto.
      // Por isso o pedido vem primeiro e o extrato fica de reserva.
      const receita = precoDoPedido > 0 ? precoDoPedido : (lf.receita || 0);
      if (skuBruto && !temAssociacao(skuBruto)
        && registrarPendente(skuBruto, it.Title || ('SKU ' + skuBruto + ' (Amazon)'), 'amz', o.PurchaseDate)) mudouPendentes = true;
      return {
        titulo: it.Title || skuBruto || '—',
        chave: skuBruto,
        anuncioId: it.ASIN || '',
        sku: resolverSku(skuBruto),
        associado: temAssociacao(skuBruto),
        qtd,
        unit: qtd ? receita / qtd : 0,
        comissao: lf.taxas ? -lf.taxas : 0,
        img: costs.fotos[resolverSku(skuBruto)] || '',
      };
    });
    // pedido pendente sem preço no item: rateia o total do pedido pela quantidade
    const somaItens = itemsRaw.reduce((s, i) => s + i.unit * i.qtd, 0);
    const totalPedido = Number(((o.OrderTotal || {}).Amount) || 0);
    if (!somaItens && totalPedido) {
      const qt = itemsRaw.reduce((s, i) => s + i.qtd, 0) || 1;
      itemsRaw.forEach((i) => { i.unit = totalPedido / qt; });
    }
    // Pedido ainda sem preço liberado pela Amazon: em vez de sumir da lista, entra
    // com valor zero e um selo. Some era pior — a venda simplesmente não existia.
    const temPreco = itemsRaw.reduce((s, i) => s + i.unit * i.qtd, 0) > 0;
    if (!temPreco) semPreco++;
    // Taxas lançadas no pedido (não no item): rateamos junto da comissão
    const taxasDoPedido = (f.taxasPedido || 0);
    if (taxasDoPedido) {
      const base = itemsRaw.reduce((s, i) => s + i.unit * i.qtd, 0) || 1;
      itemsRaw.forEach((i) => { i.comissao += taxasDoPedido * ((i.unit * i.qtd) / base); });
    }
    // Frete e promoção também vêm no item do pedido, e é de lá que sai o custo do
    // DBA: a Amazon entrega de graça para o comprador e desconta do vendedor, o
    // que aparece como ShippingDiscount. Sem ler isso o frete ficava sempre zero.
    const soma = (campo) => lista.reduce((s, it) => s + Number(((it[campo] || {}).Amount) || 0), 0);
    const fretePeloComprador = soma('ShippingPrice') + soma('ShippingTax');
    const fretePeloVendedor = soma('ShippingDiscount') + soma('ShippingDiscountTax');
    const promocoes = soma('PromotionDiscount') + soma('PromotionDiscountTax');
    const st = String(o.OrderStatus || '').toLowerCase();
    const pedido = buildOrder({
      id: o.AmazonOrderId, data: o.PurchaseDate, dataAprov: o.PurchaseDate,
      status: st === 'canceled' ? 'cancelled' : (st === 'pending' ? 'pending' : 'shipped'),
      envio: amzEnvio(o), pack: false,
      itemsRaw,
      freteVend: (f.fretePedido || 0) + fretePeloVendedor,
      freteComp: fretePeloComprador || (f.freteComprador || 0),
      descontos: promocoes, conta: 'amz',
    });
    // A Amazon lança as taxas dias depois da venda. Enquanto não lança, o lucro
    // do pedido está otimista — marcamos para não confundir com número fechado.
    pedido.taxaPendente = !fin[o.AmazonOrderId];
    pedido.semPreco = !temPreco;
    out.push(pedido);
  });
  if (semPreco) {
    amzAviso = (amzAviso ? amzAviso + ' · ' : '')
      + semPreco + ' pedido(s) ainda sem preço liberado pela Amazon';
  }
  if (mudouPendentes) writeJSON(COSTS_FILE, costs);
  return out;
}

// Monta o canal Amazon (mesma estrutura do Mercado Livre) para o dashboard.
// Soma as próprias vendas para que painel e página de vendas nunca divirjam.
async function amzBuildChannel(deISO, ateISO) {
  const vendas = await amzListSales(deISO, ateISO);
  let semTaxa = 0;
  let fat = 0, comissao = 0, freteVendedor = 0, custoProdutos = 0, imposto = 0;
  let pedidosSemAssoc = 0, contados = 0;
  const bySku = {};

  for (const v of vendas) {
    if (v.status === 'cancelled') continue;
    if (v.semPreco) continue;                    // sem valor liberado, não dá para medir
    if (v.semAssoc) { pedidosSemAssoc++; continue; }
    if (v.taxaPendente) semTaxa++;
    contados++;
    fat += v.resumo.total;
    comissao += v.resumo.comissao;
    freteVendedor += v.resumo.freteVend;
    custoProdutos += v.resumo.custo + v.resumo.custoExtra;
    imposto += v.resumo.imposto;
    for (const it of v.itens) {
      const b = bySku[it.sku] || (bySku[it.sku] = { nome: it.titulo, un: 0, fat: 0, comissao: 0, custo: 0, imposto: 0 });
      b.un += it.qtd; b.fat += it.total;
      b.comissao += it.comissao; b.custo += it.custo + it.custoExtra; b.imposto += it.imposto;
    }
  }

  const liq = fat - comissao - freteVendedor;
  const lb = liq - custoProdutos - imposto;
  const channel = {
    nome: 'Amazon', cor: '#ff9900',
    fat: round2(fat), liq: round2(liq), lucroBruto: round2(lb),
    ads: 0, lucro: round2(lb), pedidos: contados, semAssoc: pedidosSemAssoc,
    taxasPendentes: semTaxa,
  };
  const taxas = [['Comissão e taxas Amazon', -round2(comissao)], ['Frete pago pelo vendedor', -round2(freteVendedor)]];
  if (semTaxa) taxas.push([`⏳ ${semTaxa} pedido${semTaxa > 1 ? 's' : ''} com taxa ainda não lançada pela Amazon`, 0]);
  const dreDetail = {
    fat: round2(fat),
    taxas,
    liq: round2(liq),
    custos: [['Custo dos produtos', -round2(custoProdutos)], ['Impostos', -round2(imposto)]],
    lb: round2(lb),
  };
  const produtos = Object.keys(bySku).map((sku) => {
    const b = bySku[sku];
    const lucro = b.fat - b.comissao - b.custo - b.imposto;
    return [b.nome, sku, b.un, round2(b.fat), round2(lucro), round2(lucro), round2(b.fat ? (lucro / b.fat) * 100 : 0), null];
  }).sort((a, z) => z[3] - a[3]);

  return { channel, dreDetail, produtos };
}

// ================= SHOPEE (Open Platform v2) =================
// Toda chamada é assinada com HMAC-SHA256 usando a partner_key como segredo.
//   API pública:  partner_id + caminho + timestamp
//   API de loja:  partner_id + caminho + timestamp + access_token + shop_id
const SHP_FILE = path.join(DATA_DIR, 'shopee.json');
const SHP_HOSTS = {
  br: 'https://openplatform.shopee.com.br',
  global: 'https://partner.shopeemobile.com',
  sandbox: 'https://openplatform.sandbox.test-stable.shopee.sg',
};
let shp = readJSON(SHP_FILE, {});
shp = { partnerId: '', partnerKey: '', shopId: '', accessToken: '', refreshToken: '', expiraEm: 0, regiao: 'br', loja: '', ...shp };
const shpHost = () => SHP_HOSTS[shp.regiao] || SHP_HOSTS.br;
const shpTemApp = () => !!(shp.partnerId && shp.partnerKey);
const shpConectada = () => !!(shpTemApp() && shp.shopId && shp.refreshToken);
const shpSalvar = () => writeJSON(SHP_FILE, shp);

function shpAssinar(caminho, ts, comLoja) {
  let base = String(shp.partnerId) + caminho + String(ts);
  if (comLoja) base += String(shp.accessToken) + String(shp.shopId);
  return crypto.createHmac('sha256', String(shp.partnerKey)).update(base).digest('hex');
}

// Link que o vendedor abre para autorizar a loja
function shpLinkAutorizacao(redirect) {
  const ts = Math.floor(Date.now() / 1000);
  const caminho = '/api/v2/shop/auth_partner';
  const q = new URLSearchParams({
    partner_id: String(shp.partnerId), timestamp: String(ts),
    sign: shpAssinar(caminho, ts, false), redirect,
  });
  return shpHost() + caminho + '?' + q.toString();
}

// Troca o code da autorização por access_token + refresh_token
async function shpTrocarCode(code, shopId) {
  const ts = Math.floor(Date.now() / 1000);
  const caminho = '/api/v2/auth/token/get';
  const q = new URLSearchParams({ partner_id: String(shp.partnerId), timestamp: String(ts), sign: shpAssinar(caminho, ts, false) });
  const { status, json } = await request('POST', shpHost() + caminho + '?' + q.toString(), {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, partner_id: Number(shp.partnerId), shop_id: Number(shopId) }),
  });
  if (status !== 200 || !json.access_token) throw new Error('Shopee: ' + (json.message || json.error || ('HTTP ' + status)));
  shp.shopId = String(shopId);
  shp.accessToken = json.access_token;
  shp.refreshToken = json.refresh_token;
  shp.expiraEm = Date.now() + (json.expire_in || 14400) * 1000;
  shpSalvar();
  return json;
}

// Renova o access_token (vale 4 horas). A Shopee gira os dois tokens.
async function shpRenovar() {
  const ts = Math.floor(Date.now() / 1000);
  const caminho = '/api/v2/auth/access_token/get';
  const q = new URLSearchParams({ partner_id: String(shp.partnerId), timestamp: String(ts), sign: shpAssinar(caminho, ts, false) });
  const { status, json } = await request('POST', shpHost() + caminho + '?' + q.toString(), {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: shp.refreshToken, partner_id: Number(shp.partnerId), shop_id: Number(shp.shopId) }),
  });
  const r = json.response || json;
  if (status !== 200 || !r.access_token) throw new Error('Shopee: não consegui renovar — ' + (json.message || json.error || ('HTTP ' + status)));
  shp.accessToken = r.access_token;
  if (r.refresh_token) shp.refreshToken = r.refresh_token;
  shp.expiraEm = Date.now() + (r.expire_in || 14400) * 1000;
  shpSalvar();
  return shp.accessToken;
}

async function shpToken() {
  if (shp.accessToken && Date.now() < shp.expiraEm - 300000) return shp.accessToken;
  return shpRenovar();
}

// Chamada autenticada a uma API de loja
async function shpApi(caminho, params = {}, corpo = null) {
  await shpToken();
  const ts = Math.floor(Date.now() / 1000);
  const q = new URLSearchParams({
    partner_id: String(shp.partnerId), timestamp: String(ts),
    access_token: shp.accessToken, shop_id: String(shp.shopId),
    sign: shpAssinar(caminho, ts, true),
  });
  for (const k of Object.keys(params)) if (params[k] !== '' && params[k] != null) q.set(k, String(params[k]));
  const url = shpHost() + caminho + '?' + q.toString();
  const { status, json } = corpo
    ? await request('POST', url, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })
    : await request('GET', url, {});
  if (status >= 400 || (json && json.error)) {
    throw new Error('Shopee ' + (json && json.error ? json.error : status) + ': ' + ((json && json.message) || '').slice(0, 180));
  }
  return json || {};
}

// Pedidos do período. A Shopee aceita janela de no máximo 15 dias por consulta.
async function shpPedidos(deISO, ateISO) {
  const t0 = Math.floor(new Date(deISO).getTime() / 1000);
  const t1 = Math.floor(new Date(ateISO).getTime() / 1000);
  const sns = [];
  for (let ini = t0; ini < t1; ini += 15 * 86400) {
    const fim = Math.min(ini + 15 * 86400 - 1, t1);
    let cursor = '';
    for (let i = 0; i < 60; i++) {
      const j = await shpApi('/api/v2/order/get_order_list', {
        time_range_field: 'create_time', time_from: ini, time_to: fim, page_size: 100, cursor,
      });
      const r = j.response || {};
      (r.order_list || []).forEach((o) => sns.push(o.order_sn));
      if (!r.more || !r.next_cursor) break;
      cursor = r.next_cursor;
    }
  }
  return [...new Set(sns)];
}

// Detalhe dos pedidos (até 50 por chamada)
async function shpDetalhes(sns) {
  const out = [];
  const campos = 'item_list,total_amount,order_status,create_time,pay_time,shipping_carrier,'
    + 'fulfillment_flag,checkout_shipping_carrier,payment_method,buyer_username';
  for (let i = 0; i < sns.length; i += 50) {
    const j = await shpApi('/api/v2/order/get_order_detail', {
      order_sn_list: sns.slice(i, i + 50).join(','), response_optional_fields: campos,
    });
    out.push(...(((j.response || {}).order_list) || []));
  }
  return out;
}

// Taxas reais e valor líquido (escrow), até 50 pedidos por chamada
async function shpEscrow(sns) {
  const mapa = {};
  for (let i = 0; i < sns.length; i += 50) {
    let j;
    try { j = await shpApi('/api/v2/payment/get_escrow_detail_batch', {}, { order_sn_list: sns.slice(i, i + 50) }); }
    catch { continue; }
    const lista = j.response || [];
    for (const e of (Array.isArray(lista) ? lista : [])) {
      const d = e.escrow_detail || e;
      if (d && d.order_sn) mapa[d.order_sn] = d.order_income || {};
    }
  }
  return mapa;
}

// Tipo de envio da Shopee: estoque no Shopee (Full) ou envio do vendedor
const shpEnvio = (o) => (String(o.fulfillment_flag || '').includes('shopee') ? 'shopee_full' : 'shopee_envios');

// Vendas detalhadas da Shopee para a página "Vendas"
async function shpListSales(deISO, ateISO) {
  const sns = await shpPedidos(deISO, ateISO);
  if (!sns.length) return [];
  const [detalhes, escrow] = await Promise.all([shpDetalhes(sns), shpEscrow(sns)]);
  const out = [];
  let mudouPendentes = limparPendentes();
  for (const o of detalhes) {
    const inc = escrow[o.order_sn] || {};
    const porSku = {};
    for (const it of (inc.items || [])) porSku[it.item_sku || it.model_sku || ''] = it;
    const itemsRaw = (o.item_list || []).map((it) => {
      const sku = it.model_sku || it.item_sku || '';
      const qtd = it.model_quantity_purchased || 0;
      const ei = porSku[sku] || {};
      const unit = ei.discounted_price != null ? ei.discounted_price
        : (it.model_discounted_price != null ? it.model_discounted_price : (it.model_original_price || 0));
      if (sku && !temAssociacao(sku)
        && registrarPendente(sku, it.item_name || ('SKU ' + sku + ' (Shopee)'), 'shp', new Date((o.create_time || 0) * 1000).toISOString())) mudouPendentes = true;
      return {
        titulo: it.item_name || sku || '—', chave: sku, anuncioId: String(it.item_id || ''),
        sku: resolverSku(sku), associado: temAssociacao(sku),
        qtd, unit, comissao: 0,
        img: (it.image_info && it.image_info.image_url) || costs.fotos[resolverSku(sku)] || '',
      };
    });
    // as taxas da Shopee vêm no total do pedido, não por item: rateamos pelo valor
    const taxaTotal = (inc.commission_fee || 0) + (inc.service_fee || 0) + (inc.seller_transaction_fee || 0)
      + (inc.order_ams_commission_fee || 0) + (inc.campaign_fee || 0) + (inc.seller_order_processing_fee || 0);
    const somaItens = itemsRaw.reduce((s, i) => s + i.unit * i.qtd, 0) || 1;
    itemsRaw.forEach((i) => { i.comissao = taxaTotal * ((i.unit * i.qtd) / somaItens); });
    const freteVend = Math.max(0, (inc.actual_shipping_fee || 0) - (inc.shopee_shipping_rebate || 0) - (inc.buyer_paid_shipping_fee || 0));
    out.push(buildOrder({
      id: o.order_sn, data: new Date((o.create_time || 0) * 1000).toISOString(),
      dataAprov: new Date((o.pay_time || o.create_time || 0) * 1000).toISOString(),
      status: String(o.order_status || '').toUpperCase() === 'CANCELLED' ? 'cancelled' : 'shipped',
      envio: shpEnvio(o), pack: false,
      itemsRaw, freteVend, freteComp: (inc.buyer_paid_shipping_fee || 0),
      descontos: (inc.voucher_from_seller || 0) + (inc.seller_discount || 0), conta: 'shp',
    }));
  }
  if (mudouPendentes) writeJSON(COSTS_FILE, costs);
  return out;
}

// Canal Shopee para o dashboard
async function shpBuildChannel(deISO, ateISO) {
  const vendas = await shpListSales(deISO, ateISO);
  let fat = 0, comissao = 0, freteVendedor = 0, custoProdutos = 0, imposto = 0;
  let pedidosSemAssoc = 0, contados = 0;
  const bySku = {};
  for (const v of vendas) {
    if (v.status === 'cancelled') continue;
    if (v.semAssoc) { pedidosSemAssoc++; continue; }
    contados++;
    fat += v.resumo.total;
    comissao += v.resumo.comissao;
    freteVendedor += v.resumo.freteVend;
    custoProdutos += v.resumo.custo + v.resumo.custoExtra;
    imposto += v.resumo.imposto;
    for (const it of v.itens) {
      const b = bySku[it.sku] || (bySku[it.sku] = { nome: it.titulo, un: 0, fat: 0, lucro: 0 });
      b.un += it.qtd; b.fat += it.total; b.lucro += it.lucro;
    }
  }
  const liq = fat - comissao - freteVendedor;
  const lb = liq - custoProdutos - imposto;
  return {
    channel: {
      nome: 'Shopee', cor: '#ee4d2d',
      fat: round2(fat), liq: round2(liq), lucroBruto: round2(lb),
      ads: 0, lucro: round2(lb), pedidos: contados, semAssoc: pedidosSemAssoc,
    },
    dreDetail: {
      fat: round2(fat),
      taxas: [['Comissão e taxas Shopee', -round2(comissao)], ['Frete pago pelo vendedor', -round2(freteVendedor)]],
      liq: round2(liq),
      custos: [['Custo dos produtos', -round2(custoProdutos)], ['Impostos', -round2(imposto)]],
      lb: round2(lb),
    },
    produtos: Object.keys(bySku).map((sku) => {
      const b = bySku[sku];
      return [b.nome, sku, b.un, round2(b.fat), round2(b.lucro), round2(b.lucro), round2(b.fat ? (b.lucro / b.fat) * 100 : 0), null];
    }).sort((a, z) => z[3] - a[3]),
  };
}

// ================= TIKTOK SHOP (Partner API) =================
// Assinatura (conforme o exemplo oficial):
//   1) pega os parâmetros da query, menos sign e access_token
//   2) ordena as chaves em ordem alfabética e junta como {chave}{valor}
//   3) coloca o caminho da API na frente
//   4) anexa o corpo cru (quando não é multipart)
//   5) embrulha tudo no app_secret: secret + texto + secret
//   6) HMAC-SHA256 com o próprio secret, em hexadecimal
const TTK_FILE = path.join(DATA_DIR, 'tiktok.json');
const TTK_AUTH_HOST = 'https://auth.tiktok-shops.com';
const TTK_API_HOST = 'https://open-api.tiktokglobalshop.com';
let ttk = readJSON(TTK_FILE, {});
ttk = { appKey: '', appSecret: '', serviceId: '', accessToken: '', refreshToken: '', expiraEm: 0, shopId: '', shopCipher: '', loja: '', ...ttk };
const ttkTemApp = () => !!(ttk.appKey && ttk.appSecret);
const ttkConectada = () => !!(ttkTemApp() && ttk.refreshToken && ttk.shopCipher);
const ttkSalvar = () => writeJSON(TTK_FILE, ttk);

function ttkAssinar(caminho, params, corpo) {
  const chaves = Object.keys(params).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  let texto = chaves.map((k) => k + params[k]).join('');
  texto = caminho + texto;
  if (corpo) texto += corpo;
  texto = ttk.appSecret + texto + ttk.appSecret;
  return crypto.createHmac('sha256', ttk.appSecret).update(texto).digest('hex');
}

// Link que o vendedor abre para autorizar a loja
const ttkLinkAutorizacao = () =>
  'https://services.tiktokshop.com/open/authorize?service_id=' + encodeURIComponent(ttk.serviceId || '');

// Troca o code por tokens (endpoint de auth não é assinado)
async function ttkTrocarCode(code) {
  const q = new URLSearchParams({
    app_key: ttk.appKey, app_secret: ttk.appSecret, auth_code: code, grant_type: 'authorized_code',
  });
  const { status, json } = await request('GET', TTK_AUTH_HOST + '/api/v2/token/get?' + q.toString(), {});
  const d = (json && json.data) || {};
  if (status !== 200 || !d.access_token) throw new Error('TikTok: ' + ((json && json.message) || ('HTTP ' + status)));
  ttk.accessToken = d.access_token;
  ttk.refreshToken = d.refresh_token;
  ttk.expiraEm = (d.access_token_expire_in ? d.access_token_expire_in * 1000 : Date.now() + 6 * 3600e3);
  ttkSalvar();
  return d;
}

async function ttkRenovar() {
  const q = new URLSearchParams({
    app_key: ttk.appKey, app_secret: ttk.appSecret, refresh_token: ttk.refreshToken, grant_type: 'refresh_token',
  });
  const { status, json } = await request('GET', TTK_AUTH_HOST + '/api/v2/token/refresh?' + q.toString(), {});
  const d = (json && json.data) || {};
  if (status !== 200 || !d.access_token) throw new Error('TikTok: não consegui renovar — ' + ((json && json.message) || ('HTTP ' + status)));
  ttk.accessToken = d.access_token;
  if (d.refresh_token) ttk.refreshToken = d.refresh_token;
  ttk.expiraEm = (d.access_token_expire_in ? d.access_token_expire_in * 1000 : Date.now() + 6 * 3600e3);
  ttkSalvar();
  return ttk.accessToken;
}

async function ttkToken() {
  if (ttk.accessToken && Date.now() < ttk.expiraEm - 300000) return ttk.accessToken;
  return ttkRenovar();
}

async function ttkApi(caminho, params = {}, corpo = null, metodo = 'GET') {
  await ttkToken();
  const p = { app_key: ttk.appKey, timestamp: String(Math.floor(Date.now() / 1000)), ...params };
  if (ttk.shopCipher && !p.shop_cipher && !caminho.includes('/authorization/')) p.shop_cipher = ttk.shopCipher;
  const body = corpo ? JSON.stringify(corpo) : '';
  p.sign = ttkAssinar(caminho, p, body);
  const url = TTK_API_HOST + caminho + '?' + new URLSearchParams(p).toString();
  const headers = { 'x-tts-access-token': ttk.accessToken, 'Content-Type': 'application/json' };
  const { status, json } = await request(metodo, url, body ? { headers, body } : { headers });
  if (status >= 400 || (json && json.code && json.code !== 0)) {
    throw new Error('TikTok ' + ((json && json.code) || status) + ': ' + (((json && json.message) || '')).slice(0, 180));
  }
  return (json && json.data) || {};
}

// Descobre a loja autorizada e guarda o shop_cipher (obrigatório nas demais chamadas)
async function ttkDescobrirLoja() {
  const d = await ttkApi('/authorization/202309/shops');
  const loja = (d.shops || [])[0];
  if (!loja) throw new Error('TikTok: nenhuma loja autorizada para este app.');
  ttk.shopId = String(loja.id || '');
  ttk.shopCipher = loja.cipher || '';
  ttk.loja = loja.name || 'TikTok Shop';
  ttkSalvar();
  return loja;
}

// Pedidos do período (a busca já devolve o pedido completo)
async function ttkPedidos(deISO, ateISO) {
  const t0 = Math.floor(new Date(deISO).getTime() / 1000);
  const t1 = Math.floor(new Date(ateISO).getTime() / 1000);
  const out = [];
  let token = '';
  for (let i = 0; i < 60; i++) {
    const d = await ttkApi('/order/202309/orders/search',
      { page_size: '50', ...(token ? { page_token: token } : {}) },
      { create_time_ge: t0, create_time_lt: t1 }, 'POST');
    out.push(...(d.orders || []));
    token = d.next_page_token || '';
    if (!token) break;
  }
  return out;
}

// Taxas reais por pedido (extrato financeiro). Se não vier, seguimos sem elas.
async function ttkTaxas(ids) {
  const mapa = {};
  await emLotes(ids, 4, async (id) => {
    try {
      const d = await ttkApi('/finance/202309/orders/' + id + '/statement_transactions');
      const t = (d.statement_transactions || [])[0] || d;
      if (t) mapa[id] = t;
    } catch { /* pedido ainda não liquidado */ }
  });
  return mapa;
}

const ttkEnvio = (o) => (String(o.fulfillment_type || '').includes('TIKTOK') ? 'tiktok_full' : 'tiktok_envios');

// Vendas detalhadas do TikTok Shop
async function ttkListSales(deISO, ateISO) {
  const pedidos = await ttkPedidos(deISO, ateISO);
  if (!pedidos.length) return [];
  const taxas = await ttkTaxas(pedidos.map((o) => o.id));
  const out = [];
  let mudouPendentes = limparPendentes();
  for (const o of pedidos) {
    const t = taxas[o.id] || {};
    const pag = o.payment || {};
    const itemsRaw = (o.line_items || []).map((it) => {
      const sku = it.seller_sku || it.sku_id || '';
      if (sku && !temAssociacao(sku)
        && registrarPendente(sku, it.product_name || ('SKU ' + sku + ' (TikTok)'), 'tik', new Date((o.create_time || 0) * 1000).toISOString())) mudouPendentes = true;
      return {
        titulo: it.product_name || sku || '—', chave: sku, anuncioId: String(it.product_id || ''),
        sku: resolverSku(sku), associado: temAssociacao(sku),
        qtd: 1,
        unit: Number(it.sale_price || it.original_price || 0),
        comissao: 0,
        img: it.sku_image || costs.fotos[resolverSku(sku)] || '',
      };
    });
    const taxaTotal = Math.abs(Number(t.platform_commission || 0))
      + Math.abs(Number(t.transaction_fee || 0))
      + Math.abs(Number(t.affiliate_commission || 0))
      + Math.abs(Number(t.sfp_service_fee || 0));
    const soma = itemsRaw.reduce((s, i) => s + i.unit * i.qtd, 0) || 1;
    itemsRaw.forEach((i) => { i.comissao = taxaTotal * ((i.unit * i.qtd) / soma); });
    out.push(buildOrder({
      id: o.id, data: new Date((o.create_time || 0) * 1000).toISOString(),
      dataAprov: new Date((o.paid_time || o.create_time || 0) * 1000).toISOString(),
      status: String(o.status || '').toUpperCase() === 'CANCELLED' ? 'cancelled' : 'shipped',
      envio: ttkEnvio(o), pack: false,
      itemsRaw,
      freteVend: Math.abs(Number(t.actual_shipping_fee || 0)),
      freteComp: Number(pag.shipping_fee || 0),
      descontos: Number(pag.seller_discount || 0), conta: 'tik',
    }));
  }
  if (mudouPendentes) writeJSON(COSTS_FILE, costs);
  return out;
}

// Canal TikTok Shop para o dashboard
async function ttkBuildChannel(deISO, ateISO) {
  const vendas = await ttkListSales(deISO, ateISO);
  let fat = 0, comissao = 0, freteVendedor = 0, custoProdutos = 0, imposto = 0;
  let pedidosSemAssoc = 0, contados = 0;
  const bySku = {};
  for (const v of vendas) {
    if (v.status === 'cancelled') continue;
    if (v.semAssoc) { pedidosSemAssoc++; continue; }
    contados++;
    fat += v.resumo.total; comissao += v.resumo.comissao; freteVendedor += v.resumo.freteVend;
    custoProdutos += v.resumo.custo + v.resumo.custoExtra; imposto += v.resumo.imposto;
    for (const it of v.itens) {
      const b = bySku[it.sku] || (bySku[it.sku] = { nome: it.titulo, un: 0, fat: 0, lucro: 0 });
      b.un += it.qtd; b.fat += it.total; b.lucro += it.lucro;
    }
  }
  const liq = fat - comissao - freteVendedor;
  const lb = liq - custoProdutos - imposto;
  return {
    channel: {
      nome: 'TikTok Shop', cor: '#69c9d0',
      fat: round2(fat), liq: round2(liq), lucroBruto: round2(lb),
      ads: 0, lucro: round2(lb), pedidos: contados, semAssoc: pedidosSemAssoc,
    },
    dreDetail: {
      fat: round2(fat),
      taxas: [['Comissão e taxas TikTok', -round2(comissao)], ['Frete pago pelo vendedor', -round2(freteVendedor)]],
      liq: round2(liq),
      custos: [['Custo dos produtos', -round2(custoProdutos)], ['Impostos', -round2(imposto)]],
      lb: round2(lb),
    },
    produtos: Object.keys(bySku).map((sku) => {
      const b = bySku[sku];
      return [b.nome, sku, b.un, round2(b.fat), round2(b.lucro), round2(b.lucro), round2(b.fat ? (b.lucro / b.fat) * 100 : 0), null];
    }).sort((a, z) => z[3] - a[3]),
  };
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

// Anota um anúncio pendente vindo de canais que não são o Mercado Livre (ex.: Amazon)
function registrarPendente(chave, titulo, canal, data) {
  if (!chave || temAssociacao(chave)) return false;
  const a = costs.pendentes[chave] || {};
  const novo = {
    titulo: titulo || a.titulo || chave,
    anuncioId: a.anuncioId || '',
    canal: canal || a.canal || 'amz',
    ultima: (data || '') > (a.ultima || '') ? (data || '') : (a.ultima || data || ''),
  };
  if (JSON.stringify(a) === JSON.stringify(novo)) return false;
  costs.pendentes[chave] = novo;
  return true;
}

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
    canal: conta, marketplace: nomeCanal(conta),
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

  // Amazon (Selling Partner API)
  if (amzConectada()) {
    try {
      amzAviso = '';
      const built = await amzBuildChannel(from, to);
      channels.amz = built.channel;
      dreDetail.amz = built.dreDetail;
      produtosPorCanal.amz = built.produtos;
      status.amz = amzAviso ? 'error' : 'connected';
      if (amzAviso) status.amzError = amzAviso;
      algumConectado = true;
    } catch (e) {
      status.amz = 'error';
      status.amzError = String(e.message || e);
    }
  } else {
    status.amz = 'disconnected';
  }

  // Shopee (Open Platform)
  if (shpConectada()) {
    try {
      const built = await shpBuildChannel(from, to);
      channels.shp = built.channel;
      dreDetail.shp = built.dreDetail;
      produtosPorCanal.shp = built.produtos;
      status.shp = 'connected';
      algumConectado = true;
    } catch (e) {
      status.shp = 'error';
      status.shpError = String(e.message || e);
    }
  } else {
    status.shp = 'disconnected';
  }

  // TikTok Shop (Partner API)
  if (ttkConectada()) {
    try {
      const built = await ttkBuildChannel(from, to);
      channels.tik = built.channel;
      dreDetail.tik = built.dreDetail;
      produtosPorCanal.tik = built.produtos;
      status.tik = 'connected';
      algumConectado = true;
    } catch (e) {
      status.tik = 'error';
      status.tikError = String(e.message || e);
    }
  } else {
    status.tik = 'disconnected';
  }

  // canais futuros como placeholders
  const placeholders = {
    mag: { nome: 'Magalu', cor: '#0086ff' },
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
    // ===== Amazon: credenciais e teste de conexão =====
    if (p === '/api/amazon' && req.method === 'GET') {
      return sendJSON(res, 200, {
        conectada: amzConectada(),
        clientId: amz.clientId || '',
        temSecret: !!amz.clientSecret,
        temRefresh: !!amz.refreshToken,
        marketplaceId: amz.marketplaceId || AMZ_MERCADO_BR,
        regiao: amz.regiao || 'na',
        loja: amz.loja || '',
      });
    }
    if (p === '/api/amazon' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.clientId != null) amz.clientId = String(b.clientId).trim();
      if (b.clientSecret) amz.clientSecret = String(b.clientSecret).trim();
      if (b.refreshToken) amz.refreshToken = String(b.refreshToken).trim();
      if (b.marketplaceId) amz.marketplaceId = String(b.marketplaceId).trim();
      if (b.regiao) amz.regiao = String(b.regiao).trim();
      amzToken = { valor: '', expiraEm: 0 };      // força renovar com as novas chaves
      amzSalvar();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/amazon/testar' && req.method === 'POST') {
      if (!amzConectada()) return sendJSON(res, 200, { ok: false, erro: 'Preencha as três credenciais primeiro.' });
      try {
        amzToken = { valor: '', expiraEm: 0 };
        const loja = await amzLoja();
        amz.loja = loja; amzSalvar();
        return sendJSON(res, 200, { ok: true, loja });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, erro: String(e.message || e) });
      }
    }
    // Diagnóstico da senha do painel. Nunca devolve a senha, só se ela chegou.
    if (p === '/api/diag/auth') {
      const v = ENV.APP_PASSWORD;
      return sendJSON(res, 200, {
        definida: !!v,
        tamanho: typeof v === 'string' ? v.length : 0,
        tipo: typeof v,
        veioDoAmbiente: !!process.env.APP_PASSWORD,
        chavesParecidas: Object.keys(process.env).filter((k) => /PASS|SENHA|APP_/i.test(k)),
      });
    }

    // IP de saída deste servidor — a Shopee exige IPs individuais na whitelist.
    // Consulta alguns serviços de eco para ver de qual endereço saímos de fato.
    if (p === '/api/meu-ip') {
      const fontes = ['https://api.ipify.org?format=json', 'https://ifconfig.co/json', 'https://api64.ipify.org?format=json'];
      const achados = [];
      for (const f of fontes) {
        try {
          const { json } = await request('GET', f, {});
          const ip = (json && (json.ip || json.IP)) || '';
          if (ip) achados.push({ fonte: new URL(f).hostname, ip });
        } catch (e) { achados.push({ fonte: new URL(f).hostname, erro: String(e.message || e).slice(0, 80) }); }
      }
      const ips = [...new Set(achados.map((a) => a.ip).filter(Boolean))];
      return sendJSON(res, 200, { ips, detalhe: achados });
    }

    // Diagnóstico: quais listas de evento financeiro a Amazon realmente manda,
    // e como é uma taxa de serviço por dentro. Serve para achar onde mora o
    // frete do DBA sem ficar chutando.
    if (p === '/api/amazon/eventos') {
      const de = new Date(Date.now() - 20 * 864e5).toISOString();
      const ate = new Date(Date.now() - 120000).toISOString();
      const j = await amzApi('/finances/v0/financialEvents?' + new URLSearchParams({
        MaxResultsPerPage: '100', PostedAfter: de, PostedBefore: ate,
      }).toString());
      const ev = ((j.payload || {}).FinancialEvents) || {};
      const listas = {};
      for (const k of Object.keys(ev)) if (Array.isArray(ev[k]) && ev[k].length) listas[k] = ev[k].length;
      const env = (ev.ShipmentEventList || [])[0] || {};
      return sendJSON(res, 200, {
        listas,
        exemploServico: (ev.ServiceFeeEventList || [])[0] || null,
        camposDoEnvio: Object.keys(env),
        taxasDoEnvio: (env.ShipmentFeeList || []).concat(env.OrderFeeList || []),
      });
    }

    // Diagnóstico: um pedido cru, exatamente como veio da Amazon, para conferir
    // campo a campo quando algum número não bate.
    if (p === '/api/amazon/pedido') {
      const id = u.searchParams.get('id') || '';
      const achado = Object.keys(amzDB.pedidos).find((k) => k.endsWith(id));
      if (!achado) return sendJSON(res, 200, { erro: 'não encontrei esse pedido', guardados: Object.keys(amzDB.pedidos).length });
      return sendJSON(res, 200, {
        pedido: amzDB.pedidos[achado],
        itens: amzDB.itens[achado] || [],
        financeiro: amzDB.fin[achado] || null,
        falha: amzDB.falhas[achado] || null,
        fila: amzFila.length,
        falhasTotal: Object.keys(amzDB.falhas).length,
        exemploFalha: Object.keys(amzDB.falhas).map((k) => amzDB.falhas[k].erro)[0] || '',
      });
    }

    // ===== TikTok Shop =====
    if (p === '/api/tiktok' && req.method === 'GET') {
      return sendJSON(res, 200, {
        temApp: ttkTemApp(), conectada: ttkConectada(),
        appKey: ttk.appKey || '', temSecret: !!ttk.appSecret, serviceId: ttk.serviceId || '',
        shopId: ttk.shopId || '', loja: ttk.loja || '',
        redirect: (ML.redirectUri || '').replace(/\/callback$/, '') + '/callback-tiktok',
      });
    }
    if (p === '/api/tiktok' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.appKey != null) ttk.appKey = String(b.appKey).trim();
      if (b.appSecret) ttk.appSecret = String(b.appSecret).trim();
      if (b.serviceId != null) ttk.serviceId = String(b.serviceId).trim();
      ttkSalvar();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/auth/tiktok') {
      if (!ttkTemApp() || !ttk.serviceId) return sendJSON(res, 400, { error: 'Preencha App Key, App Secret e Service ID.' });
      res.writeHead(302, { Location: ttkLinkAutorizacao() });
      return res.end();
    }
    if (p === '/callback-tiktok') {
      const code = u.searchParams.get('code');
      if (!code) { res.writeHead(302, { Location: '/?tiktok=erro' }); return res.end(); }
      try {
        await ttkTrocarCode(code);
        await ttkDescobrirLoja();
        res.writeHead(302, { Location: '/?tiktok=ok' });
      } catch (e) {
        res.writeHead(302, { Location: '/?tiktok=erro&msg=' + encodeURIComponent(String(e.message || e)) });
      }
      return res.end();
    }
    if (p === '/api/tiktok/testar' && req.method === 'POST') {
      if (!ttkTemApp() || !ttk.refreshToken) return sendJSON(res, 200, { ok: false, erro: 'Conecte a loja primeiro.' });
      try {
        const loja = await ttkDescobrirLoja();
        return sendJSON(res, 200, { ok: true, loja: loja.name || ttk.loja });
      } catch (e) { return sendJSON(res, 200, { ok: false, erro: String(e.message || e) }); }
    }
    if (p === '/api/tiktok/desconectar' && req.method === 'POST') {
      ttk = { appKey: ttk.appKey, appSecret: ttk.appSecret, serviceId: ttk.serviceId, accessToken: '', refreshToken: '', expiraEm: 0, shopId: '', shopCipher: '', loja: '' };
      ttkSalvar();
      return sendJSON(res, 200, { ok: true });
    }

    // ===== Shopee: credenciais, autorização da loja e conexão =====
    if (p === '/api/shopee' && req.method === 'GET') {
      return sendJSON(res, 200, {
        temApp: shpTemApp(), conectada: shpConectada(),
        partnerId: shp.partnerId || '', temKey: !!shp.partnerKey,
        shopId: shp.shopId || '', loja: shp.loja || '', regiao: shp.regiao || 'br',
        redirect: (ML.redirectUri || '').replace(/\/callback$/, '') + '/callback-shopee',
      });
    }
    if (p === '/api/shopee' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.partnerId != null) shp.partnerId = String(b.partnerId).trim();
      if (b.partnerKey) shp.partnerKey = String(b.partnerKey).trim();
      if (b.regiao) shp.regiao = String(b.regiao).trim();
      shpSalvar();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/auth/shopee') {
      if (!shpTemApp()) return sendJSON(res, 400, { error: 'Preencha Partner ID e Partner Key antes de conectar.' });
      const base = (ML.redirectUri || '').replace(/\/callback$/, '') || `http://localhost:${PORT}`;
      res.writeHead(302, { Location: shpLinkAutorizacao(base + '/callback-shopee') });
      return res.end();
    }
    if (p === '/callback-shopee') {
      const code = u.searchParams.get('code');
      const shopId = u.searchParams.get('shop_id');
      if (!code || !shopId) { res.writeHead(302, { Location: '/?shopee=erro' }); return res.end(); }
      try {
        await shpTrocarCode(code, shopId);
        try {
          const info = await shpApi('/api/v2/shop/get_shop_info');
          shp.loja = (info.shop_name || (info.response || {}).shop_name || '') + '';
          shpSalvar();
        } catch { /* nome da loja é só enfeite */ }
        res.writeHead(302, { Location: '/?shopee=ok' });
      } catch (e) {
        res.writeHead(302, { Location: '/?shopee=erro&msg=' + encodeURIComponent(String(e.message || e)) });
      }
      return res.end();
    }
    if (p === '/api/shopee/desconectar' && req.method === 'POST') {
      shp = { partnerId: shp.partnerId, partnerKey: shp.partnerKey, shopId: '', accessToken: '', refreshToken: '', expiraEm: 0, regiao: shp.regiao, loja: '' };
      shpSalvar();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/shopee/testar' && req.method === 'POST') {
      if (!shpConectada()) return sendJSON(res, 200, { ok: false, erro: 'Conecte a loja primeiro.' });
      try {
        const info = await shpApi('/api/v2/shop/get_shop_info');
        const nome = info.shop_name || (info.response || {}).shop_name || 'Shopee';
        shp.loja = nome; shpSalvar();
        return sendJSON(res, 200, { ok: true, loja: nome });
      } catch (e) { return sendJSON(res, 200, { ok: false, erro: String(e.message || e) }); }
    }

    // Diagnóstico: mostra o que cada endpoint da Amazon devolve, sem expor chaves
    // nem dados do comprador. Serve para achar o motivo quando algo não vem.
    if (p === '/api/amazon/diagnostico') {
      const de = u.searchParams.get('from') || new Date(Date.now() - 7 * 864e5).toISOString();
      const ate = u.searchParams.get('to') || new Date(Date.now() - 120000).toISOString();
      const out = { periodo: { de, ate } };
      try {
        const j = await amzApi('/orders/v0/orders?' + new URLSearchParams({
          MarketplaceIds: amz.marketplaceId, CreatedAfter: de, CreatedBefore: ate, MaxResultsPerPage: '20',
        }).toString());
        const lista = (j.payload || {}).Orders || [];
        out.pedidos = { ok: true, total: lista.length };
        if (lista[0]) {
          const o = lista[0];
          out.pedidos.campos = Object.keys(o);
          out.pedidos.exemplo = {
            AmazonOrderId: o.AmazonOrderId, PurchaseDate: o.PurchaseDate, OrderStatus: o.OrderStatus,
            FulfillmentChannel: o.FulfillmentChannel, ShipmentServiceLevelCategory: o.ShipmentServiceLevelCategory,
            ShippingAddress: undefined, OrderType: o.OrderType, NumberOfItemsShipped: o.NumberOfItemsShipped,
            NumberOfItemsUnshipped: o.NumberOfItemsUnshipped, IsPremiumOrder: o.IsPremiumOrder,
            IsBusinessOrder: o.IsBusinessOrder, EasyShipShipmentStatus: o.EasyShipShipmentStatus,
            SupplySourceId: o.SupplySourceId, FulfillmentInstruction: o.FulfillmentInstruction,
            OrderTotal: o.OrderTotal, SalesChannel: o.SalesChannel,
          };
          // itens do primeiro pedido (para saber se temos SKU e título)
          try {
            const it = await amzApi('/orders/v0/orders/' + o.AmazonOrderId + '/orderItems');
            const itens = ((it.payload || {}).OrderItems) || [];
            out.itens = { ok: true, total: itens.length, campos: itens[0] ? Object.keys(itens[0]) : [] };
          } catch (e) { out.itens = { ok: false, erro: String(e.message || e) }; }
        }
      } catch (e) { out.pedidos = { ok: false, erro: String(e.message || e) }; }

      try {
        const j = await amzApi('/finances/v0/financialEvents?' + new URLSearchParams({
          PostedAfter: de, PostedBefore: ate, MaxResultsPerPage: '100',
        }).toString());
        const ev = ((j.payload || {}).FinancialEvents) || {};
        out.financeiro = {
          ok: true,
          grupos: Object.keys(ev).filter((k) => Array.isArray(ev[k]) && ev[k].length).map((k) => k + '=' + ev[k].length),
          envios: (ev.ShipmentEventList || []).length,
        };
        const s = (ev.ShipmentEventList || [])[0];
        if (s) {
          const item = (s.ShipmentItemList || [])[0] || {};
          out.financeiro.exemplo = {
            AmazonOrderId: s.AmazonOrderId, PostedDate: s.PostedDate,
            SellerSKU: item.SellerSKU,
            cobrancas: (item.ItemChargeList || []).map((c) => c.ChargeType + '=' + ((c.ChargeAmount || {}).CurrencyAmount)),
            taxas: (item.ItemFeeList || []).map((f) => f.FeeType + '=' + ((f.FeeAmount || {}).CurrencyAmount)),
          };
        }
      } catch (e) { out.financeiro = { ok: false, erro: String(e.message || e) }; }

      return sendJSON(res, 200, out);
    }
    if (p === '/api/amazon/desconectar' && req.method === 'POST') {
      amz = { clientId: '', clientSecret: '', refreshToken: '', marketplaceId: AMZ_MERCADO_BR, regiao: 'na' };
      amzToken = { valor: '', expiraEm: 0 };
      amzSalvar();
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
      const from = u.searchParams.get('from') || inicioDoMesBR();
      const to = u.searchParams.get('to') || agoraBR();
      const data = await buildDashboard({ from, to });
      return sendJSON(res, 200, data);
    }
    if (p === '/api/sales') {
      const from = u.searchParams.get('from') || inicioDoMesBR();
      const to = u.searchParams.get('to') || agoraBR();
      const conectadas = contasConectadas();
      if (!conectadas.length && !amzConectada() && !shpConectada() && !ttkConectada()) return sendJSON(res, 200, { sales: demoSales(), demo: true });
      // se o filtro pedir um canal específico, busca só nele
      const filtro = u.searchParams.get('canal');
      const alvo = ehContaML(filtro) ? conectadas.filter((c) => c === filtro) : (filtro === 'amz' ? [] : conectadas);
      let sales = [];
      const erros = [];
      for (const conta of alvo) {
        try { sales = sales.concat(await mlListSales(from, to, conta)); }
        catch (e) { erros.push(`${CONTAS_ML[conta].nome}: ${String(e.message || e)}`); }
      }
      if (amzConectada() && (!filtro || filtro === 'all' || filtro === 'amz')) {
        amzAviso = '';
        try {
          sales = sales.concat(await amzListSales(from, to));
          if (amzAviso) erros.push('Amazon: ' + amzAviso);
        } catch (e) { erros.push('Amazon: ' + String(e.message || e)); }
      }
      if (shpConectada() && (!filtro || filtro === 'all' || filtro === 'shp')) {
        try { sales = sales.concat(await shpListSales(from, to)); }
        catch (e) { erros.push('Shopee: ' + String(e.message || e)); }
      }
      if (ttkConectada() && (!filtro || filtro === 'all' || filtro === 'tik')) {
        try { sales = sales.concat(await ttkListSales(from, to)); }
        catch (e) { erros.push('TikTok Shop: ' + String(e.message || e)); }
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
