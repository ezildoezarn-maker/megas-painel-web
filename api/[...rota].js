// Um único proxy para todas as rotas /api/* do bot.
// A Vercel (plano Hobby) só aceita 12 funções por projeto, por isso
// em vez de um ficheiro por rota usamos este.
// 👇👇👇  COLOQUE AQUI O ENDEREÇO DO BOT DESTE CLIENTE (servidor:porta, com http:// e sem "/" no fim)  👇👇👇
const BOT_URL = process.env.BOT_URL || "http://node.modz.ink:25503";
// Se o bot usar BOT_SHARED_SECRET, ponha o mesmo segredo na Vercel (Environment Variables → BOT_SHARED_SECRET).
const BOT_SECRET = process.env.BOT_SHARED_SECRET || "";

// Rotas que o painel pode chamar. Ao criar uma rota nova no bot, acrescenta aqui.
const PERMITIDAS = new Set([
  // acesso por perfil (entrada, sessão, contas e alugueres)
  "login",
  "sessao",
  "contas",
  "contas-acao",
  "status",
  "auto-venda",
  "resumo",
  "eventos",
  "telefones-status",
  "config",
  "config/limite",
  "clientes",
  "cliente-historico",
  "pedido",
  "disparo",
  "fila",
  "fila-acao",
  "lucro",
  "semana",
  "tabela",
  "alertas",
  "push-chave",
  "push-inscrever",
  "push-teste",
  "inativos",
  "recargas",
  "sms-massa",
  "sms-expiracao",
  "sms-conversas",
  "grupos-aviso",
]);

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ erro: "método não permitido" });
  }

  if (BOT_URL.includes("COLOQUE-AQUI")) {
    return res.status(500).json({ erro: "BOT_URL por configurar", msg: "Edite api/[...rota].js e ponha o endereço do bot do cliente na linha BOT_URL." });
  }

  // Lê a rota do próprio endereço pedido (não depende do nome do ficheiro)
  const alvo = new URL(req.url, "http://localhost");
  let rota = decodeURIComponent(alvo.pathname).replace(/^\/api\//, "").replace(/\/+$/, "");

  if (!PERMITIDAS.has(rota)) {
    return res.status(404).json({ erro: "rota não encontrada", rota });
  }

  // Repassa a query string (ex.: ?numero=...) sem o parâmetro interno "rota"
  alvo.searchParams.delete("rota");
  const qs = alvo.searchParams.toString();
  const url = `${BOT_URL}/api/${rota}${qs ? "?" + qs : ""}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const opts = { method: req.method, signal: ctrl.signal, headers: {} };
    // sessão do utilizador (ecrã de entrada) e segredo partilhado com o bot
    if (req.headers["x-sessao"]) opts.headers["x-sessao"] = String(req.headers["x-sessao"]);
    if (BOT_SECRET) opts.headers["x-bot-secret"] = BOT_SECRET;
    if (req.method === "POST") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(req.body ?? {});
    }
    const r = await fetch(url, opts);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ erro: "bot indisponível", detalhe: String(e) });
  } finally {
    clearTimeout(timer);
  }
};
