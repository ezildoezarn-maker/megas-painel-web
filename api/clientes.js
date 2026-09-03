const BOT_URL = "http://project.metahosting.shop:2006";

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(`${BOT_URL}/api/clientes`);
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ erro: "bot indisponível", detalhe: String(e) });
  }
}
