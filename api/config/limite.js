// Mantido à parte porque o endereço tem duas partes (/api/config/limite)
// e o proxy geral [...rota].js só apanha endereços de uma parte.
// 👇 O MESMO endereço do bot deste cliente que pôs em api/[...rota].js
const BOT_URL = process.env.BOT_URL || "http://node.modz.ink:25503";
const BOT_SECRET = process.env.BOT_SHARED_SECRET || "";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "método não permitido" });
  }
  try {
    const r = await fetch(`${BOT_URL}/api/config/limite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(req.headers["x-sessao"] ? { "x-sessao": String(req.headers["x-sessao"]) } : {}),
        ...(BOT_SECRET ? { "x-bot-secret": BOT_SECRET } : {}),
      },
      body: JSON.stringify(req.body ?? {}),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ erro: "bot indisponível", detalhe: String(e) });
  }
};
