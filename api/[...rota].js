// Um único proxy para todas as rotas /api/* do bot.
// A Vercel (plano Hobby) só aceita 12 funções por projeto, por isso
// em vez de um ficheiro por rota usamos este.
const BOT_URL = process.env.BOT_URL || "http://node.modz.ink:25504";

// Rotas que o painel pode chamar. Ao criar uma rota nova no bot, acrescenta aqui.
const PERMITIDAS = new Set([
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
    const opts = { method: req.method, signal: ctrl.signal };
    if (req.method === "POST") {
      opts.headers = { "Content-Type": "application/json" };
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
