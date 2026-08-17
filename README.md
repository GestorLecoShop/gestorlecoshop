# Leco Shop · Painel de Vendas com dados ao vivo do Mercado Livre

Painel próprio de vendas e DRE que puxa os pedidos reais da sua conta do
Mercado Livre pela API oficial. Amazon, Shopee, Magalu e TikTok Shop entram nas
próximas fases, no mesmo painel.

Feito para ser simples: **você não precisa editar nenhum arquivo** — tudo é pela tela.
Roda no seu computador, é **100% seu** e **sem mensalidade**.

---

## Passo 1 — Instalar o Node.js (uma vez só)

Baixe a versão **LTS** em https://nodejs.org e instale (avançar, avançar, concluir).
É o motor que faz o painel funcionar.

## Passo 2 — Abrir o painel

Dê **dois cliques** em **`INICIAR (clique aqui).bat`**.
Vai abrir uma janela preta e o navegador em `http://localhost:3000`.
(Para fechar o painel depois, é só fechar a janela preta.)

> Na primeira abertura o painel mostra **dados de exemplo** (aviso amarelo). Normal.

## Passo 3 — Conectar sua conta do Mercado Livre

1. No painel, clique em **Conectar Mercado Livre** (ou no menu **Configurações**).
2. Cole o **App ID (Client ID)** e o **Client Secret** do seu app do ML.
3. Copie a **Redirect URI** que aparece na tela e cole no seu app do ML
   (em developers.mercadolivre.com.br → seu app → *Editar* → *URIs de redirect*).
4. Clique em **Salvar e conectar** → autorize na sua conta → pronto: dados reais.

> **Onde pego Client ID e Secret?** developers.mercadolivre.com.br → *Suas aplicações*.
> Se ainda não tem um app, crie um (leva ~5 min); em permissões deixe **leitura**.
> O Secret fica salvo só no seu PC e nunca é enviado para fora.

## Passo 4 — Preencher os custos (para o Lucro ficar exato)

A API do ML entrega faturamento, comissões, fretes e taxas — mas **não sabe o
custo do seu produto nem seu imposto**. Em **Configurações → Custos por produto**,
seus produtos aparecem numa lista; preencha o **custo unitário** e o **imposto**
de cada um e clique em **Salvar custos**. (Já vêm valores estimados — ajuste os reais.)

---

Pronto. Sempre que quiser ver as vendas, é só dar dois cliques no **INICIAR**.
O login do ML se renova sozinho (acesso de 6h, refresh de 6 meses). Se um dia
expirar, clique em *Reconectar*.

## O que já funciona (Fase 1 — Mercado Livre)
- Conexão pela tela (sem editar arquivos) e renovação automática do token.
- Pedidos pagos do período → faturamento, comissão e frete → **Líquido**.
- Custo e imposto por SKU (pela tela) → **Lucro Bruto** e **Lucro Líquido**.
- Curva ABC automática, tabela de produtos, DRE em cascata e gráficos.

## Próximas fases
- **Ads do ML** (para descontar o investimento em anúncios no DRE).
- **Amazon → Shopee → Magalu → TikTok Shop**: cada um vira um canal novo no mesmo painel.
- Série diária real e seletor de conta (Leco / LDM SC).
- Opcional: hospedar na nuvem para atualizar sozinho 24/7 (quando quiser).

## Arquivos (você não precisa mexer neles)
```
INICIAR (clique aqui).bat   Abre o painel
server.js                   Motor (API do ML + cálculo do DRE)
public/index.html           O painel
costs.json                  Custos por SKU (editados pela tela)
.env                        Suas credenciais (salvas pela tela)
demo-data.json              Dados de exemplo do modo demonstração
```

## Se algo der errado
- **Janela preta fecha na hora** → Node não instalado (Passo 1) ou reinicie o PC após instalar.
- **Erro no login do ML** → a Redirect URI no app não está idêntica à que o painel mostra.
- **Conecta mas fica zerado** → não há vendas *pagas* no período; troque o filtro no topo.
- **Lucro estranho** → ajuste os custos reais em Configurações → Custos.
