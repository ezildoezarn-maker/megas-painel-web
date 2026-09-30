// Mantido à parte porque o endereço tem duas partes (/api/config/limite)
// e o proxy geral [...rota].js só apanha endereços de uma parte.
const BOT_URL = process.env.BOT_URL || "http://node.modz.ink:25503";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "método não permitido" });
  }
  try {
    const r = await fetch(`${BOT_URL}/api/config/limite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ erro: "bot indisponível", detalhe: String(e) });
  }
};
