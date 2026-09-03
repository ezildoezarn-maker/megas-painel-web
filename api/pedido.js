const BOT_URL = "http://project.metahosting.shop:2006";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "método não permitido" });
  }
  try {
    const r = await fetch(`${BOT_URL}/api/pedido`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ erro: "bot indisponível", detalhe: String(e) });
  }
}
