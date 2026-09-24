const BOT = 'http://project.metahosting.shop:2006';

// rotas cujo caminho no bot é diferente do caminho no site
const ROTAS = {
  '/api/push-subscribe': '/webhook/push-subscribe'
};

module.exports = async (req, res) => {
  try {
    const caminho = req.url.split('?')[0];
    const destino = ROTAS[caminho] || req.url;
    const temCorpo = !['GET', 'HEAD'].includes(req.method);

    const r = await fetch(BOT + destino, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: temCorpo ? JSON.stringify(req.body ?? {}) : undefined
    });

    const texto = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(texto);
  } catch (e) {
    res.status(502).json({ erro: 'bot indisponível', detalhe: String(e) });
  }
};
