require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const { connect, mostrarMarca, SESSIONS_DIR, proximaSessao } = require('./connect');
const { messageHandler, processarFilaComprovativos, filaComprovativos } = require("./messageHandler");
const { lerPedidos, salvarPedidos, adicionarPedido, atualizarPedido } = require("./pedidos");
const { enviarParaMacroDroid } = require("./services/macroDroidService");
const { getReiniciarSessao, setReiniciarSessao } = require("./reiniciarState");
const { iniciarScheduler, pararScheduler, salvarCompra } = require('./verificador_expiracao');
const GRUPO_ADMIN = "120363410541252028@g.us";
const { 
  enviarSMS, 
  registrarSMSRecebido, 
  registrarSMSEnviado, 
  buscarGrupoDaoPessoa,
  buscarNomeDaPessoa,
  lerRanking,
  registrarCompraRanking,
  obterStatsRankingDia   // 👈 novo
} = require('./sms');
const { iniciarSchedulerSemanal, pararSchedulerSemanal } = require('./scheduler_semanal');

const webpush = require('web-push');

const VAPID_PUBLIC_KEY = "BIY94-5djM1GtFHgvFu_kK8lEDJMvhrOLgea1roj1miEsRpo7EYbeLdfoEXpCQWXyVyAkkrPfAC-Ocs7GWfSErw";
const VAPID_PRIVATE_KEY = "MSY2WM0UJNmTSW9qf0amjVVQOQDC0iXTqcB9aDSZ2Dc";

webpush.setVapidDetails(
  "mailto:admin@megasexpress.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const app = express();
app.use(express.json());

// Camada extra de segurança: se a variável de ambiente BOT_SHARED_SECRET estiver definida,
// as rotas /api/* só aceitam pedidos com o mesmo segredo no cabeçalho x-bot-secret
// (o proxy da Vercel envia-o). Sem a variável, tudo funciona como antes.
const BOT_SHARED_SECRET = process.env.BOT_SHARED_SECRET || '';
app.use('/api', (req, res, next) => {
  if (!BOT_SHARED_SECRET) return next();
  const a = Buffer.from(String(req.headers['x-bot-secret'] || ''));
  const b = Buffer.from(BOT_SHARED_SECRET);
  if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) return next();
  return res.status(401).json({ erro: 'não autorizado' });
});

const { macroUrl } = require("./macrodroidLinks");

const PORT = process.env.PORT || 2006
const WEBHOOK_TOKEN = "a1b2c3d4e5f6g7h8i9j0k";
const MACRODROID_URL = macroUrl(1, "PEDIDOS");
const MACRODROID_URL_TELEFONE2 = macroUrl(2, "PEDIDOS");
const MACRODROID_URL_TELEFONE3 = macroUrl(3, "PEDIDOS");



// 📂 Caminho do arquivo dentro da pasta "data"
const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const configFile = path.join(dataDir, "config_global.json");

function lerConfigGlobal() {
  if (!fs.existsSync(configFile)) {
    return { mbSims: null, historico: [] };
  }
  return JSON.parse(fs.readFileSync(configFile, "utf-8"));
}

function salvarConfigGlobal(config) {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}
// 🔹 Arquivos principais
const CHAVES_FILE = path.join(dataDir, "chaves.json");
const CHAVES_USADAS_FILE = path.join(dataDir, "chaves_usadas.json");

// ========== 📁 CAMINHOS DOS ARQUIVOS DE REGISTRO ==========
const COMPRAS_REGISTRADAS_PATH = path.join(dataDir, "compras_registradas.txt");
const MOVIMENTOS_FALHA_PATH = path.join(dataDir, "movimentos_falha.txt");
const RESUMO_DIA_PATH = path.join(dataDir, "resumo_dia.json");

// ========== 📅 AGENDADOR RESUMO 23:59 (horário de Moçambique) ==========
const OFFSET_MAPUTO_MS = 2 * 60 * 60 * 1000; // Africa/Maputo = UTC+2 (sem horário de verão)

let resumoAgendado = false;

// Retorna um Date cujos campos getUTC* representam o relógio de parede de Maputo,
// independente do timezone configurado no servidor.
function obterDataMaputo(baseDate = new Date()) {
  return new Date(baseDate.getTime() + OFFSET_MAPUTO_MS);
}

// Calcula o próximo alvo de 23:59 (hora de Maputo) como timestamp UTC real
function calcularProximoAlvo23h59() {
  const maputoAgora = obterDataMaputo();
  const y = maputoAgora.getUTCFullYear();
  const m = maputoAgora.getUTCMonth();
  const d = maputoAgora.getUTCDate();

  // 23:59 em Maputo (UTC+2) equivale a 21:59 em UTC, no mesmo dia
  return new Date(Date.UTC(y, m, d, 23 - 2, 59, 0, 0));
}

async function enviarResumoDia() {
  try {
    let resumo = {};
    try {
      resumo = JSON.parse(fs.readFileSync(RESUMO_DIA_PATH, "utf8"));
    } catch (e) {}

    const sock = await esperarSocket();
    await sock.sendMessage(GRUPO_ADMIN, {
      text:
`___________________________________
🕓 HORA: ${resumo.hora || "23:59"}
📆 DATA: ${resumo.data || "N/A"}
💰 TOTAL VENDIDO: ${resumo.totalVendido || 0}MT
📦 TOTAL MB: ${resumo.totalMB || 0}MB
✅ SUCESSOS: ${resumo.sucessos || 0}
❌ FALHAS: ${resumo.falhas || 0}
___________________________________`
    });
    console.log("📊 Resumo do dia enviado ao grupo");
  } catch (e) {
    console.error("❌ Erro ao enviar resumo:", e.message);
  }
}

function agendarResumoDia() {
  const now = new Date();
  let alvo = calcularProximoAlvo23h59();

  // Se já passou das 23:59 (hora de Maputo), envia agora e agenda para amanhã
  if (now >= alvo) {
    console.log("⚠️ 23:59 (Maputo) já passou — enviando resumo agora...");
    enviarResumoDia();
    alvo = new Date(alvo.getTime() + 24 * 60 * 60 * 1000); // mesmo horário, dia seguinte
  }

  const ms = alvo - now;
  const alvoLabel = new Date(alvo.getTime() + OFFSET_MAPUTO_MS)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  console.log(`📅 Resumo agendado em ${Math.round(ms / 60000)} minutos (${alvoLabel} horário de Maputo)`);

  setTimeout(async () => {
    await enviarResumoDia();
    resumoAgendado = false;
    agendarResumoDia();
  }, ms);
}

function salvarChave(dados) {
  let lista = [];

  // 🔹 Ler arquivo existente
  if (fs.existsSync(CHAVES_FILE)) {
    try {
      const conteudo = fs.readFileSync(CHAVES_FILE, "utf8");
      const parsed = JSON.parse(conteudo);

      // 🔹 Garantir que é array
      if (Array.isArray(parsed)) {
        lista = parsed;
      } else {
        console.log("⚠️ Arquivo chaves.json não era array, recriando...");
        lista = [];
      }
    } catch (err) {
      console.log("⚠️ Erro ao ler chaves.json, recriando arquivo...", err.message);
      lista = [];
    }
  }

  // 🔹 Adicionar novo dado
  lista.push(dados);

  // 🔹 Salvar arquivo atualizado
  try {
    fs.writeFileSync(CHAVES_FILE, JSON.stringify(lista, null, 2));
    console.log("✅ Dados salvos em chaves.json");
  } catch (err) {
    console.log("❌ Erro ao salvar dados em chaves.json:", err.message);
  }
}

const PEDIDOS_PATH = path.join(__dirname, "data", "pedidos.json"); // <-- arquivo na pasta data

const sockets = {};
let globalSocket = null;


function lerJSON(file, def = []) {
  try {
    if (!fs.existsSync(file)) return def;
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return def;
  }
}

// === Funções de log colorido ===
function infoLog(msg) { console.log(`\x1b[36m${msg}\x1b[0m`); }
function successLog(msg) { console.log(`\x1b[32m${msg}\x1b[0m`); }
function warningLog(msg) { console.log(`\x1b[33m${msg}\x1b[0m`); }
function errorLog(msg) { console.log(`\x1b[31m${msg}\x1b[0m`); }

// ==================================================
// ⏳ ESPERAR SOCKET
// ==================================================
function esperarSocket(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      if (globalSocket) return resolve(globalSocket);
      if (Date.now() - start > timeout) return reject(new Error("Timeout aguardando socket"));
      setTimeout(check, 500);
    };

    check();
  });
}

// ==================================================
// 🌐 WEBHOOK PARA ENVIO DE MENSAGEM EXTERNA (DETALHADO)
// ==================================================
app.post('/webhook', async (req, res) => {
  console.log("=======================================");
  console.log("📥 /webhook CHAMADO");
  console.log("🕒 Data:", new Date().toISOString());

  try {

    // 🔎 Mostrar headers
    console.log("📌 Headers recebidos:");
    console.log(req.headers);

    // 🔐 Verificar token
    const tokenRecebido = req.headers['x-token'];
    console.log("🔑 Token recebido:", tokenRecebido);

    if (tokenRecebido !== WEBHOOK_TOKEN) {
      console.log("⛔ Token inválido");
      return res.status(401).json({ erro: 'Não autorizado' });
    }

    // 📦 Mostrar body completo
    console.log("📦 Body completo recebido:");
    console.log(JSON.stringify(req.body, null, 2));

    const { tipo, jid, mensagem } = req.body;

    // 🔎 Mostrar campos separados
    console.log("📌 Tipo:", tipo);
    console.log("📌 JID:", jid);
    console.log("📌 Mensagem:", mensagem);

    if (!tipo || !jid || !mensagem || typeof mensagem !== "string") {
      console.log("⚠️ Dados incompletos ou inválidos");
      return res.status(400).json({ erro: 'Dados incompletos ou inválidos' });
    }

    if (!globalSocket) {
      console.log("❌ Bot não conectado");
      return res.status(500).json({ erro: 'Bot não conectado' });
    }

    if (tipo === 'responder') {
  console.log("📤 Enviando mensagem...");

  // 🔎 VERIFICAR SE É CONFIRMAÇÃO (aceita "Recebeste" antigo e "Recebeu" novo)
  if (/Recebeste|Recebeu/i.test(mensagem)) {
    console.log("📥 Confirmação detectada");

    let chave = null;
    let valor = null;
    let numero = null;
    let nome = null;

    // 🔹 MPESA
    if (/Confirmado\s+[A-Z0-9]{6,}/i.test(mensagem)) {

      chave = mensagem.match(/Confirmado\s+([A-Z0-9]+)/i)?.[1] || null;
      valor = mensagem.match(/Recebeste\s+([\d.]+)MT/i)?.[1] || null;
      numero = mensagem.match(/de\s+(258\d+)/)?.[1] || null;
      nome = mensagem.match(/-\s+([A-Z\s]+)\s+ao/i)?.[1]?.trim() || null;

      console.log("🔹 Tipo: MPESA");
    }

    // 🔹 EMOLA - formato NOVO ("ID Trans:", "Recebeu", sem "conta"/"nome:")
    else if (/ID Trans:/i.test(mensagem)) {

      const matchEmolaNovo = mensagem.match(
        /ID Trans:\s*([A-Z0-9.]+)\.\s*Recebeu\s+([\d.]+)MT\s+de\s+(\d+),\s*([^,]+?)\s+as/i
      );

      if (matchEmolaNovo) {
        chave = matchEmolaNovo[1];
        valor = matchEmolaNovo[2];
        numero = matchEmolaNovo[3];
        nome = matchEmolaNovo[4].trim();
      }

      console.log("🔹 Tipo: EMOLA (novo formato)");
    }

    // 🔹 EMOLA - formato ANTIGO ("ID da transacao:", "Recebeste", "de conta X, nome: Y")
    else if (/ID da transacao:/i.test(mensagem)) {

      const matchEmola = mensagem.match(
        /ID da transacao:\s*([A-Z0-9.]+)\.\s*Recebeste\s+([\d.]+)MT\s+de conta\s+(\d+),\s*nome:\s*([^,]+)\s+as/i
      );

      if (matchEmola) {
        chave = matchEmola[1];
        valor = matchEmola[2];
        numero = matchEmola[3];
        nome = matchEmola[4].trim();
      }

      console.log("🔹 Tipo: EMOLA (formato antigo)");
    }

    const dados = {
      codigo: chave,
      valor: valor,
      numero: numero,
      nome: nome,
      textoOriginal: mensagem,
      data: new Date().toISOString()
    };

    console.log("💾 Salvando confirmação:", dados);

    salvarChave(dados);
  }

  // Envia a mensagem para o grupo
  await globalSocket.sendMessage(jid, { text: mensagem });
  console.log("✅ Mensagem enviada com sucesso para:", jid);

} else {
  console.log("⚠️ Tipo não reconhecido:", tipo);
}

console.log("✅ Finalizado com sucesso");
console.log("=======================================");

res.json({ status: 'ok' });

} catch (e) {
  console.log("🔥 ERRO COMPLETO:");
  console.log(e);
  console.log("=======================================");
  res.status(500).json({ erro: 'Erro interno' });
}
});

const { comFila } = require("./utils/filaPedidos");
const { timers } = require("./timersStore");

const TELEFONES = [
  {
    id: 1,
    nome: "Telefone 1",
    mbKey: "mbSims",
    limiteKey: "limitesEnvio",
    simAtivoKey: "simAtivo",
    url: macroUrl(1, "PEDIDOS"),
    urlLimite: macroUrl(1, "Limite"),
    urlDefinirmb: macroUrl(1, "Definirmb")
  },
  {
    id: 2,
    nome: "Telefone 2",
    mbKey: "mbTelefone2",
    limiteKey: "limitesEnvioTelefone2",
    simAtivoKey: "simAtivoTelefone2",
    url: macroUrl(2, "PEDIDOS"),
    urlLimite: macroUrl(2, "Limite"),
    urlDefinirmb: macroUrl(2, "Definirmb")
  },
  {
    id: 3,
    nome: "Telefone 3",
    mbKey: "mbTelefone3",
    limiteKey: "limitesEnvioTelefone3",
    simAtivoKey: "simAtivoTelefone3",
    url: macroUrl(3, "PEDIDOS"),
    urlLimite: macroUrl(3, "Limite"),
    urlDefinirmb: macroUrl(3, "Definirmb")
  }
];

function verificarTelefone(config, telefone, quantidade) {
  const mb = config[telefone.mbKey];
  const limite = config[telefone.limiteKey];
  if (!mb || !limite) return { configurado: false };

  const sim1MB = Number(mb.sim1) || 0;
  const sim2MB = Number(mb.sim2) || 0;
  const limiteSim1 = Number(limite.sim1) || 0;
  const limiteSim2 = Number(limite.sim2) || 0;
  const sim1OK = sim1MB >= quantidade && limiteSim1 > 0;
  const sim2OK = sim2MB >= quantidade && limiteSim2 > 0;
  const sim1SemMegas = sim1MB < quantidade;
  const sim1SemLimite = limiteSim1 <= 0;
  const sim2SemMegas = sim2MB < quantidade;
  const sim2SemLimite = limiteSim2 <= 0;
  let simAtivo = config[telefone.simAtivoKey] || "SIM1";

  let resultado = { configurado: true, sim1MB, sim2MB, limiteSim1, limiteSim2, sim1OK, sim2OK, sim1SemMegas, sim1SemLimite, sim2SemMegas, sim2SemLimite, simAtivoAntes: simAtivo };

  if (simAtivo === "SIM1") {
    if (sim1OK) { resultado.ok = true; resultado.simEscolhido = "SIM1"; resultado.mudou = false; }
    else if (sim2OK) { resultado.ok = true; resultado.simEscolhido = "SIM2"; resultado.mudou = true; }
    else resultado.ok = false;
  } else {
    if (sim2OK) { resultado.ok = true; resultado.simEscolhido = "SIM2"; resultado.mudou = false; }
    else if (sim1OK) { resultado.ok = true; resultado.simEscolhido = "SIM1"; resultado.mudou = true; }
    else resultado.ok = false;
  }
  return resultado;
}

function msgMudancaSim(telefone, r, simDestino) {
  const simOrigem = r.simAtivoAntes;
  const semMegasOrigem = simOrigem === "SIM1" ? r.sim1SemMegas : r.sim2SemMegas;
  const semLimiteOrigem = simOrigem === "SIM1" ? r.sim1SemLimite : r.sim2SemLimite;
  const mbOrigem = simOrigem === "SIM1" ? r.sim1MB : r.sim2MB;

  if (semMegasOrigem && semLimiteOrigem) {
    return `⚠️ *${simOrigem} INDISPONÍVEL* (${telefone.nome})\n━━━━━━━━━━━━━━\n❌ Megas: ${mbOrigem}MB (insuficiente)\n❌ Limite: esgotado\n━━━━━━━━━━━━━━\n🔄 Alternando para *${simDestino}*...\n⌛ Aguarde, por favor!\n━━━━━━━━━━━━━━\n🛡️ Serviço automático e seguro`;
  } else if (semLimiteOrigem) {
    return `⚠️ LIMITE DO *${simOrigem}* ATINGIDO (${telefone.nome})\n━━━━━━━━━━━━━━\n🔄 TENTANDO *${simDestino}*...\n⌛ Aguarde, por favor!\n━━━━━━━━━━━━━━\n🛡️ Serviço automático e seguro`;
  } else if (semMegasOrigem) {
    return `⚠️ SALDO *${simOrigem}* INSUFICIENTE (${telefone.nome})\n━━━━━━━━━━━━━━\n🔄 TENTANDO *${simDestino}*...\n🛜 Saldo *${simOrigem}*: ${mbOrigem}MB\n━━━━━━━━━━━━━━\n🔒 Serviço automático e seguro`;
  }
  return `🔄 Alternando para *${simDestino}* (${telefone.nome})...`;
}

function msgMudancaTelefone(telefoneAnterior, telefoneNovo) {
  return `📡 *${telefoneAnterior.nome} SEM CAPACIDADE*\n━━━━━━━━━━━━━━\n🔄 Tentando *${telefoneNovo.nome}*...\n⌛ Aguarde, por favor!\n━━━━━━━━━━━━━━\n🛡️ Serviço automático e seguro`;
}

const handlerGatilho = async (req, res) => {
  console.log("📥 /gatilho recebido");
  try {

    // 🕐 Espera enquanto houver qualquer pedido "em curso" no telefone
    let tentativas = 0;
    while (true) {
      const pedidosCheck = lerPedidos();
      const emCurso = pedidosCheck.some(p => p.status === "processando" || p.status === "processado");
      if (!emCurso) break;

      tentativas++;
      if (tentativas > 175) {
        console.log("⚠️ Espera máxima atingida — seguindo mesmo assim para não travar de vez");
        break;
      }

      console.log(`⏳ Pedido em curso no telefone, aguardando... (tentativa ${tentativas})`);
      await new Promise(r => setTimeout(r, 1000));
    }

    // ⏱️ Pausa entre envios (painel → Velocidade)
    const pausaSeg = Number(lerConfigGlobal().pausaEnvios) || 0;
    if (pausaSeg > 0) {
      const ultimaFim = lerPedidos()
        .map(p => new Date(p.dataFinalizacao || 0).getTime() || 0)
        .reduce((a, b) => Math.max(a, b), 0);
      const esperar = ultimaFim + pausaSeg * 1000 - Date.now();
      if (esperar > 0) {
        const ms = Math.min(esperar, pausaSeg * 1000);
        console.log(`⏱️ Pausa de velocidade: ${Math.ceil(ms / 1000)}s`);
        await new Promise(r => setTimeout(r, ms));
      }
    }

    const pedidos = lerPedidos();
    console.log("📂 Total pedidos:", pedidos.length);

    const index = pedidos.findIndex(p => p.status === "pendente");
    if (index === -1) return res.json({ ok: false, msg: "Nenhum pedido pendente" });

    const pedido = pedidos[index];
    const quantidade = Number(pedido.quantidadeMB);
    console.log("📦 Processando:", pedido.pedidoId);

    pedidos[index].status = "processando";
    salvarPedidos(pedidos);

    // compras por SMS não precisam do WhatsApp ligado para receber a confirmação
    const sock = (pedido.grupo && pedido.grupo.includes("@")) ? await esperarSocket() : (globalSocket || await esperarSocket().catch(() => null));

    const isWhatsApp = pedido.grupo && pedido.grupo.includes("@");

    const quotedMsg = isWhatsApp ? {
      key: {
        remoteJid: pedido.grupo,
        fromMe: false,
        id: pedido.stanzaId,
        participant: pedido.participant
      },
      message: pedido.quotedMessage
    } : null;

    const enviarMensagem = async (texto) => {
      if (isWhatsApp) {
        await sock.sendMessage(pedido.grupo, { text: texto }, { quoted: quotedMsg });
      } else if (pedido.enviarSms !== false) {
        await smsEnviarCompra(pedido.grupo, texto, pedido.pedidoId);
      }
    };

    const reabrirPedido = () => {
      const pedidosAtual = lerPedidos();
      const idxAtual = pedidosAtual.findIndex(p => p.pedidoId === pedido.pedidoId);
      if (idxAtual !== -1) {
        pedidosAtual[idxAtual].status = "pendente";
        salvarPedidos(pedidosAtual);
      }
    };

    // ============================================
    // 🔍 ESCOLHER TELEFONE — mantém o atual até ele falhar
    // ============================================
    const config = lerConfigGlobal();
    let telefoneEscolhido = null;
    let simEscolhido = null;
    let resultadoEscolhido = null;
    let telefonesTentados = [];

    // 🔒 Mantém o telefone ativo até ele próprio falhar — não volta sozinho
    // para um telefone anterior só porque ele recuperou megas/limite.
    const telefoneAtivoId = config.telefoneAtivo || TELEFONES[0].id;
    const telefoneAtual = TELEFONES.find(t => t.id === telefoneAtivoId) || TELEFONES[0];

    const rAtual = verificarTelefone(config, telefoneAtual, quantidade);
    telefonesTentados.push({ telefone: telefoneAtual, r: rAtual });

    if (rAtual.configurado && rAtual.ok) {
      // ✅ Telefone atual ainda dá conta — continua nele
      telefoneEscolhido = telefoneAtual;
      simEscolhido = rAtual.simEscolhido;
      resultadoEscolhido = rAtual;
    } else {
      // ❌ Telefone atual esgotou — só agora procura o próximo disponível, em ordem
      for (const telefone of TELEFONES) {
        if (telefone.id === telefoneAtual.id) continue; // já testado acima

        const r = verificarTelefone(config, telefone, quantidade);
        telefonesTentados.push({ telefone, r });

        if (r.configurado && r.ok) {
          telefoneEscolhido = telefone;
          simEscolhido = r.simEscolhido;
          resultadoEscolhido = r;
          break;
        }
      }
    }

    // 💾 Salva qual telefone ficou ativo, para a próxima chamada do /gatilho lembrar
    if (telefoneEscolhido && telefoneEscolhido.id !== telefoneAtivoId) {
      config.telefoneAtivo = telefoneEscolhido.id;
      salvarConfigGlobal(config);
    }

    // ❌ NENHUM TELEFONE CONSEGUE ATENDER
    if (!telefoneEscolhido) {
      let detalhes = "";
      for (const { telefone, r } of telefonesTentados) {
        if (r.configurado) {
          detalhes += `\n📱 *${telefone.nome}*\n┣ SIM1: ${r.sim1MB}MB | Limite: ${r.limiteSim1}\n┗ SIM2: ${r.sim2MB}MB | Limite: ${r.limiteSim2}`;
        } else {
          detalhes += `\n📱 *${telefone.nome}*\n┗ ❌ Sem dados configurados`;
        }
      }

      const msgDetalhada = `❌ NENHUM TELEFONE TEM MEGAS/LIMITE SUFICIENTES\n━━━━━━━━━━━━━━${detalhes}\n━━━━━━━━━━━━━━\n📤 Necessário: ${quantidade}MB\n━━━━━━━━━━━━━━\n🔒 Serviço automático e seguro`;

      try {
        await sock.sendMessage(GRUPO_ADMIN, { text: msgDetalhada });
      } catch (err) {
        console.log("⚠️ Falha ao notificar grupo admin:", err.message);
      }

      reabrirPedido();
      return res.json({ ok: false, msg: "Impossível processar pedido em nenhum telefone" });
    }

    // 🔄 AVISO — mudou de telefone (o "anterior" é sempre o que era o telefoneAtivo antes desta chamada)
    if (telefoneEscolhido.id !== telefoneAtivoId) {
      await enviarMensagem(msgMudancaTelefone(telefoneAtual, telefoneEscolhido));
    }

    if (resultadoEscolhido.mudou) {
      await enviarMensagem(msgMudancaSim(telefoneEscolhido, resultadoEscolhido, simEscolhido));
      config[telefoneEscolhido.simAtivoKey] = simEscolhido;
      salvarConfigGlobal(config);
    }

    let simAtivo = simEscolhido;

    await axios.post(
      telefoneEscolhido.url,
      {
        pedidoId: pedido.pedidoId,
        GrupoId: pedido.grupo,
        codigo: pedido.codigo,
        numero: pedido.numero,
        quantidadeMB: pedido.quantidadeMB,
        valor: pedido.valor,
        cliente: pedido.cliente,
        provedor: pedido.provedor,
        simUsado: simAtivo
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
      }
    );

    const pedidosFinal = lerPedidos();
    const idxFinal = pedidosFinal.findIndex(p => p.pedidoId === pedido.pedidoId);
    if (idxFinal !== -1) {
      pedidosFinal[idxFinal].status = "processado";
      pedidosFinal[idxFinal].dataProcessamento = new Date().toISOString();
      pedidosFinal[idxFinal].simUsado = simAtivo;
      pedidosFinal[idxFinal].telefoneUsado = telefoneEscolhido.id;
      salvarPedidos(pedidosFinal);
    }
    console.log("🟡 Marcado como PROCESSADO:", pedido.pedidoId);

    timers[pedido.pedidoId] = setTimeout(async () => {
      const pedidosNow = lerPedidos();
      const p = pedidosNow.find(p => p.pedidoId === pedido.pedidoId);
      if (p && p.status === "processado") {
        console.log("⚠️ Pedido demorado, ainda sem confirmação:", p.pedidoId);
        try {
          await sock.sendMessage(GRUPO_ADMIN, {
            text: `⚠️ *PEDIDO SEM CONFIRMAÇÃO*\n━━━━━━━━━━━━━━\n📦 Pedido: ${p.pedidoId}\n📱 Número: ${p.numero}\n⏰ Já passou 3 minutos sem /finalizado\n━━━━━━━━━━━━━━\nSe o envio realmente falhou, usa *.reabrir ${p.pedidoId}* para tentar de novo.\nSe o telefone só está lento, aguarda mais um pouco.`
          });
        } catch (e) {
          console.log("⚠️ Falha ao notificar grupo admin:", e.message);
        }
      }
      delete timers[pedido.pedidoId];
    }, 180000);

    res.json({ ok: true, pedidoId: pedido.pedidoId });

  } catch (err) {
    console.log("🔥 Erro /gatilho:", err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
};

app.post("/gatilho", comFila(handlerGatilho));


// ---------- FINALIZADO ----------
app.post("/finalizado", async (req, res) => {
  console.log("📥 /finalizado recebido");
  try {
    const pedidos = lerPedidos();

    const pedidoIdRecebido = req.body?.pedidoId || null;

    let realIndex;
    if (pedidoIdRecebido) {
      realIndex = pedidos.findIndex(p => p.pedidoId === pedidoIdRecebido && p.status === "processado");
    } else {
      const index = [...pedidos].reverse().findIndex(p => p.status === "processado");
      realIndex = index === -1 ? -1 : pedidos.length - 1 - index;
    }

    if (realIndex === -1) return res.json({ ok: false, msg: "Nenhum pedido processado" });

    const pedido = pedidos[realIndex];
    const quantidade = Number(pedido.quantidadeMB);
    const simUsado = pedido.simUsado || "SIM1";

    if (timers[pedido.pedidoId]) {
      clearTimeout(timers[pedido.pedidoId]);
      delete timers[pedido.pedidoId];
      console.log("⏱️ Timeout cancelado para:", pedido.pedidoId);
    }

    // compras por SMS não precisam do WhatsApp ligado para receber a confirmação
    const sock = (pedido.grupo && pedido.grupo.includes("@")) ? await esperarSocket() : (globalSocket || await esperarSocket().catch(() => null));

    const isWhatsApp = pedido.grupo && pedido.grupo.includes("@");

    const quotedMsg = isWhatsApp ? {
      key: {
        remoteJid: pedido.grupo,
        fromMe: false,
        id: pedido.stanzaId,
        participant: pedido.participant
      },
      message: pedido.quotedMessage
    } : null;

    const enviarMensagem = async (texto) => {
      if (isWhatsApp) {
        await sock.sendMessage(pedido.grupo, { text: texto }, { quoted: quotedMsg });
      } else if (pedido.enviarSms !== false) {
        await smsEnviarCompra(pedido.grupo, texto, pedido.pedidoId);
      }
    };

    // 🔻 DESCONTAR MB E DECREMENTAR LIMITE (telefone correto)
    const telefoneInfo = TELEFONES.find(t => t.id === (pedido.telefoneUsado || 1));

    try {
      const config = lerConfigGlobal();

      if (!telefoneInfo) {
        console.log("⚠️ Telefone usado não identificado, usando Telefone 1 por padrão");
      }

      const tInfo = telefoneInfo || TELEFONES[0];
      const mb = config[tInfo.mbKey];
      const limite = config[tInfo.limiteKey];

      if (mb) {
        if (simUsado === "SIM1") {
          mb.sim1 -= quantidade;
        } else {
          mb.sim2 -= quantidade;
        }
        mb.atualizadoEm = new Date().toISOString();
        console.log(`📉 ${quantidade}MB descontados do ${simUsado} (${tInfo.nome})`);
      }

      if (!limite) config[tInfo.limiteKey] = { sim1: 10, sim2: 10 };
      const limiteAtual = config[tInfo.limiteKey];

      if (simUsado === "SIM1" && limiteAtual.sim1 > 0) {
        limiteAtual.sim1 -= 1;
      } else if (simUsado === "SIM2" && limiteAtual.sim2 > 0) {
        limiteAtual.sim2 -= 1;
      }
      console.log(`🔢 Limite ${simUsado} restante (${tInfo.nome}): ${simUsado === "SIM1" ? limiteAtual.sim1 : limiteAtual.sim2}`);

      salvarConfigGlobal(config);

      try {
        await axios.post(
          tInfo.urlLimite,
          { sim1: limiteAtual.sim1, sim2: limiteAtual.sim2 },
          { headers: { "Content-Type": "application/json" }, timeout: 30000 }
        );
        console.log(`📲 MacroDroid Limite atualizado (${tInfo.nome})`);
      } catch (e) {
        console.log(`❌ Erro ao atualizar Limite no MacroDroid (${tInfo.nome}):`, e?.message || e?.code || "Erro desconhecido");
      }

      try {
        await axios.post(
          tInfo.urlDefinirmb,
          { sim1: mb.sim1, sim2: mb.sim2 },
          { headers: { "Content-Type": "application/json" }, timeout: 30000 }
        );
        console.log(`📲 MacroDroid MB atualizado (${tInfo.nome})`);
      } catch (e) {
        console.log(`❌ Erro ao atualizar MB no MacroDroid (${tInfo.nome}):`, e?.message || e?.code || "Erro desconhecido");
      }

    } catch (e) {
      console.log("❌ Erro ao descontar MB/Limite:", e.message);
    }

    const agoraFinal = new Date();
    const dataHoraFinal = agoraFinal.toLocaleString('pt-MZ', {
      timeZone: 'Africa/Maputo',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const mensagem = pedido.origem === "enviar"
      ? `━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ *TRANSFERÊNCIA CONCLUÍDA*
━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 *Número:* ${pedido.numero}
📊 *Pacote:* ${pedido.quantidadeMB}MB
🔖 *Referência:* ${pedido.pedidoId}
⏰ *Data/Hora:* ${dataHoraFinal}

_Processado automaticamente pelo sistema._
━━━━━━━━━━━━━━━━━━━━━━━━`
      : `━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ *TRANSFERÊNCIA CONCLUÍDA*
━━━━━━━━━━━━━━━━━━━━━━━━━━

👤 Cliente: ${pedido.cliente}
📱 Número: ${pedido.numero}
📦 Pacote: ${pedido.quantidadeMB}MB
💰 Valor: ${pedido.valor}MT
🔐 Código: ${pedido.codigo}
📡 SIM: ${simUsado}

Obrigado pela preferência. Volte sempre!
━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    await enviarMensagem(mensagem);


    // ✅ FINALIZAR PEDIDO
    pedidos[realIndex].status = "finalizado";
    pedidos[realIndex].dataFinalizacao = new Date().toISOString();
    salvarPedidos(pedidos);

enviarNotificacaoPush(
      "💰 Nova venda!",
      `${pedido.cliente} comprou ${pedido.quantidadeMB}MB por ${pedido.valor}MT`
    );

    // 🏆 Registar no ranking (invisível — só grava, nunca mostrado no grupo)
    // 🏆 Registar no ranking (só para compras normais — NÃO para pedidos criados via .enviar)
    let senderRanking = null;
    let statsRegistro = null;

    if (pedido.origem !== "enviar") {
      try {
        senderRanking = pedido.numeroComprador || pedido.participant || pedido.numero;
        const compraPorSms = !String(pedido.grupo || '').includes('@');
        const entradas = compraPorSms ? rankingEntradasDoNumero(numeroDoComprador(pedido)) : [];
        if (entradas.length) {
          // compra por SMS: soma nos grupos onde a pessoa já está no ranking, com o nome que ela já tem lá
          for (const e of entradas) {
            registrarCompraRanking(e.grupo, e.chave, e.nome || pedido.cliente || "Cliente", Number(pedido.quantidadeMB) || 0);
            console.log(`🏆 Ranking atualizado (SMS): ${e.chave} (+${pedido.quantidadeMB}MB) no grupo ${e.grupo}`);
          }
        } else {
          statsRegistro = registrarCompraRanking(
            pedido.grupo,
            senderRanking,
            pedido.cliente || "Cliente",
            Number(pedido.quantidadeMB) || 0
          );
          console.log(`🏆 Ranking atualizado: ${senderRanking} (+${pedido.quantidadeMB}MB) no grupo ${pedido.nomeGrupo || pedido.grupo}`);
        }
      } catch (err) {
        console.error("❌ Erro ao registrar ranking:", err.message);
      }
    } else {
      console.log(`⏭️ Pedido ${pedido.pedidoId} veio de .enviar — ranking não registado.`);
    }

    // 🏆 Mensagem de ranking (só para compras normais, não para .enviar do admin)
    if (pedido.origem !== "enviar") {
      try {
        const stats = obterStatsRankingDia(pedido.grupo, senderRanking);

        // Dias sem comprar (>= 2 dias)
        let diasSemComprar = 0;
        if (statsRegistro && statsRegistro.ultimaCompraAnterior) {
          const anterior = new Date(statsRegistro.ultimaCompraAnterior);
          const diffDias = Math.floor((Date.now() - anterior.getTime()) / (1000 * 60 * 60 * 24));
          if (diffDias >= 2) diasSemComprar = diffDias;
        }

        const quantidadeMBExibir = Number(pedido.quantidadeMB);
        const totalSempreGB = (stats.totalSempreMB / 1024).toFixed(2);
        const liderGB = (stats.liderTotalMB / 1024).toFixed(2);

        const numeroMencao = isWhatsApp ? (pedido.participant || senderRanking) : null;
        const jidMencao = numeroMencao
          ? (String(numeroMencao).includes("@") ? numeroMencao : `${numeroMencao}@s.whatsapp.net`)
          : null;
        const mencaoTexto = isWhatsApp
          ? `@${String(numeroMencao).split("@")[0]}`
          : (pedido.cliente || "Cliente");

        let texto = `Obrigado ${mencaoTexto} por comprar *${quantidadeMBExibir}MB!*`;

        // Compras do dia (sempre)
        if (stats.compraNumeroHoje === 1) {
          texto += `\nVocê está fazendo a sua primeira compra do dia!`;
        } else {
          texto += `\nVocê já fez ${stats.compraNumeroHoje} compras hoje.`;
        }

        // Dias sem comprar (>= 2)
        if (diasSemComprar >= 2) {
          texto += `\nHá ${diasSemComprar} dias que você não comprava. Bom tê-lo(a) de volta!`;
        }

        // Líder ou não
        if (stats.ehLider) {
          texto += `\n\nVocê é o comprador nº 1 do grupo, com um total acumulado de ${totalSempreGB}GB!\n🏆 Mantenha a liderança!`;
        } else {
          texto += `\n\nVocê é o comprador nº ${stats.posicaoGeral} do grupo, com um total acumulado de ${totalSempreGB}GB.\nO maior comprador já acumulou ${liderGB}GB.\n🚀 *Rumo ao topo para desbloquear bônus!*`;
        }

        if (isWhatsApp) {
          await sock.sendMessage(pedido.grupo, { text: texto, mentions: [jidMencao] });
        } else if (pedido.enviarSms !== false) {
          /* compra por SMS: sem mensagem de ranking (é só para grupos) */
        }
      } catch (err) {
        console.error("❌ Erro ao enviar mensagem de ranking:", err.message);
      }
    }

    // 📅 Registar compra para lembrete de expiração (24h)
    try {
      const now = new Date();
      const dataCompra = now.toLocaleDateString('pt-MZ', { timeZone: 'Africa/Maputo', day: '2-digit', month: '2-digit', year: 'numeric' });
      const horaCompra = now.toLocaleTimeString('pt-MZ', { timeZone: 'Africa/Maputo', hour: '2-digit', minute: '2-digit' });

      const senderExpiracao = pedido.numeroComprador || pedido.participant || pedido.numero;
      const nomeGrupoExpiracao = pedido.nomeGrupo || pedido.grupo;

      salvarCompra(
        senderExpiracao,
        pedido.grupo,
        nomeGrupoExpiracao,
        `${pedido.quantidadeMB}MB`,
        dataCompra,
        horaCompra,
        pedido.numero,
        pedido.cliente || null 
      );

      console.log(`📅 Compra registada para lembrete de expiração: ${senderExpiracao}`);
    } catch (err) {
      console.error("❌ Erro ao registar compra para expiração:", err.message);
    }
    // ========== 📁 REGISTROS ==========
    try {
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");

      // ⏰ Hora e data corrigidas para o timezone de Moçambique (Africa/Maputo)
      const hora = now.toLocaleTimeString('pt-MZ', {
        timeZone: 'Africa/Maputo',
        hour: '2-digit',
        minute: '2-digit'
      });
      const data = now.toLocaleDateString('pt-MZ', {
        timeZone: 'Africa/Maputo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      // formato YYYY-MM-DD já no timezone certo, para comparações de "hoje"
      const hojeStr = now.toLocaleDateString('sv-SE', { timeZone: 'Africa/Maputo' });

      const carteira = pedido.provedor === "emola" ? "eMola" : "Mpesa";

      const pedidosHoje = lerPedidos().filter(p => {
        const d = p.dataFinalizacao || p.dataCriacao || "";
        return diaMaputo(d) === hojeStr;
      });

      const totalMBHoje = pedidosHoje
        .filter(p => p.status === "finalizado")
        .reduce((acc, p) => acc + Number(p.quantidadeMB || 0), 0);

      const totalVendidoHoje = pedidosHoje
        .filter(p => p.status === "finalizado" || p.status === "falha")
        .reduce((acc, p) => acc + Number(p.valor || 0), 0);

      const sucessosHoje = pedidosHoje.filter(p => p.status === "finalizado").length;
      const falhasHoje = pedidosHoje.filter(p => p.status === "falha").length;

      const numeroCompra = pedidosHoje
        .filter(p => p.status === "finalizado" || p.status === "falha").length;

      const blocoCompra =
`\n━━━━━━━━━━━━━━━━━━

👉 PEDIDO Nr⁰: ${pedido.pedidoId}

📅 DATA: ${data}
🕒 HORA: ${hora}

👤 CLIENTE: ${pedido.cliente}
📱 NÚMERO: ${pedido.numero}

💳 CARTEIRA: ${carteira}
🆔 ID: ${pedido.codigo || "N/A"}

💰 VALOR: ${pedido.valor}MT
📦 MEGAS: ${pedido.quantidadeMB}MB

📶 SIM USADO: ${simUsado}
📊 MB VENDIDOS HOJE: ${totalMBHoje}MB

🎫 COMPRA N⁰: ${numeroCompra}
✅ ESTADO: ✅ CONCLUÍDO

━━━━━━━━━━━━━━━━━━\n`;

      fs.appendFileSync(COMPRAS_REGISTRADAS_PATH, blocoCompra, "utf8");
      console.log("📝 Compra registrada");

      // 💾 Atualizar resumo do dia
      let resumo = {};
      try {
        resumo = JSON.parse(fs.readFileSync(RESUMO_DIA_PATH, "utf8"));
      } catch (e) {}

      resumo.data = data;
      resumo.hora = hora;
      resumo.totalVendido = totalVendidoHoje;
      resumo.totalMB = totalMBHoje;
      resumo.sucessos = sucessosHoje;
      resumo.falhas = falhasHoje;

      fs.writeFileSync(RESUMO_DIA_PATH, JSON.stringify(resumo, null, 2));
      console.log("📊 Resumo do dia atualizado");

    } catch (e) {
      console.error("❌ Erro ao registrar compra:", e.message);
    }
    // ========== FIM REGISTROS ==========

    // 👇 Verificar se há mais pendentes
    const pedidosAtuais = lerPedidos();
    const proximoPendente = pedidosAtuais.find(p => p.status === "pendente");

    if (proximoPendente) {
      console.log("🔄 Há mais pendentes — chamando gatilho automaticamente...");
      setTimeout(async () => {
        try {
          await axios.post(
            `http://localhost:${PORT}/gatilho`,
            {},
            { headers: { "Content-Type": "application/json" }, timeout: 30000 }
          );
          console.log("✅ Próximo pedido enviado ao MacroDroid");
        } catch (err) {
          console.error("❌ Erro ao chamar próximo gatilho:", err?.message || err?.code || "Erro desconhecido");

          try {
            await enviarMensagem(
`⚠️ *ERRO AO PROCESSAR PRÓXIMO PEDIDO*
━━━━━━━━━━━━━━
📦 Pedido: ${proximoPendente.pedidoId}
📱 Número: ${proximoPendente.numero}
❌ Erro: ${err?.message || err?.code || "Erro desconhecido"}
━━━━━━━━━━━━━━
_Use .reiniciar para tentar novamente_`
            );
          } catch (e) {
            console.error("❌ Erro ao notificar:", e.message);
          }

          const reiniciarSessao = getReiniciarSessao();
          if (reiniciarSessao && reiniciarSessao.from) {
            reiniciarSessao.falha++;
            try {
              await sock.sendMessage(reiniciarSessao.from, {
                text:
`❌ *ERRO NO PEDIDO ${reiniciarSessao.atual}/${reiniciarSessao.total}*
━━━━━━━━━━━━━━
📦 Pedido: ${proximoPendente.pedidoId}
📱 Número: ${proximoPendente.numero}
❌ Erro: ${err?.message || err?.code || "Erro desconhecido"}
━━━━━━━━━━━━━━
_Use .reiniciar para tentar novamente_`
              });
            } catch (e) {
              console.error("❌ Erro ao notificar admin:", e.message);
            }
          }
        }
      }, 3000);

    } else {
      console.log("✅ Sem mais pedidos pendentes.");
    }

    // 👇 REINICIAR — avisa admin quando tudo acabar
    const reiniciarSessao = getReiniciarSessao();
    if (reiniciarSessao && reiniciarSessao.from) {
      reiniciarSessao.sucesso++;
      reiniciarSessao.atual++;

      await sock.sendMessage(reiniciarSessao.from, {
        text:
`✅ *Pedido ${reiniciarSessao.atual - 1}/${reiniciarSessao.total} concluído!*
━━━━━━━━━━━━━━
👤 Cliente: ${pedido.cliente}
📱 Número: ${pedido.numero}
📦 Megas: ${pedido.quantidadeMB}MB
💰 Valor: ${pedido.valor}MT
📡 SIM: ${simUsado}
━━━━━━━━━━━━━━`
      });

      if (!proximoPendente) {
        await sock.sendMessage(reiniciarSessao.from, {
          text:
`🎉 *REINÍCIO CONCLUÍDO!*
━━━━━━━━━━━━━━
📋 Total: ${reiniciarSessao.total}
✅ Sucesso: ${reiniciarSessao.sucesso}
❌ Falha: ${reiniciarSessao.falha}
━━━━━━━━━━━━━━
🛡️ Todos os pedidos foram processados!`
        });
        setReiniciarSessao(null);
      }
    }

    res.json({ ok: true, pedidoId: pedido.pedidoId });

  } catch (err) {
    console.error("🔥 Erro /finalizado:", err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});




app.post("/falha", async (req, res) => {
  console.log("📥 /falha recebido");
  try {
    const pedidos = lerPedidos();
    const pedidoIdRecebido = req.body?.pedidoId || null;

    let realIndex;
    if (pedidoIdRecebido) {
      realIndex = pedidos.findIndex(p => p.pedidoId === pedidoIdRecebido && p.status === "processado");
    } else {
      const index = [...pedidos].reverse().findIndex(p => p.status === "processado");
      realIndex = index === -1 ? -1 : pedidos.length - 1 - index;
    }

    if (realIndex === -1) return res.json({ ok: false, msg: "Nenhum pedido processado" });

    const pedido = pedidos[realIndex];
    const simUsado = pedido.simUsado || req.body?.simUsado || "N/A";
    const carteira = pedido.provedor === "emola" ? "eMola" : "Mpesa";

    // ⏱️ Cancelar timeout se existir
    if (timers[pedido.pedidoId]) {
      clearTimeout(timers[pedido.pedidoId]);
      delete timers[pedido.pedidoId];
      console.log("⏱️ Timeout cancelado para:", pedido.pedidoId);
    }

    const sock = (pedido.grupo && pedido.grupo.includes("@")) ? await esperarSocket() : (globalSocket || await esperarSocket().catch(() => null));

const isWhatsApp = pedido.grupo && pedido.grupo.includes("@");

const quotedMsg = isWhatsApp ? {
  key: {
    remoteJid: pedido.grupo,
    fromMe: false,
    id: pedido.stanzaId,
    participant: pedido.participant
  },
  message: pedido.quotedMessage
} : null;

const enviarMensagem = async (texto) => {
  if (isWhatsApp) {
    await sock.sendMessage(pedido.grupo, { text: texto }, { quoted: quotedMsg });
  } else if (pedido.enviarSms !== false) {
    await smsEnviarCompra(pedido.grupo, texto, pedido.pedidoId);
  }
};

    // ❌ Marcar como falha
    pedidos[realIndex].status = "falha";
    pedidos[realIndex].dataFalha = new Date().toISOString();
    salvarPedidos(pedidos);
    console.log("❌ Pedido marcado como falha:", pedido.pedidoId);

// ❌ Mensagem no grupo
    if (pedido.origem === "enviar") {
      await enviarMensagem(
`❌ *FALHA AO ENVIAR (MANUAL)*
━━━━━━━━━━━━━━
📱 Número: ${pedido.numero}
📦 Megas: ${pedido.quantidadeMB}MB
🔖 Referência: ${pedido.pedidoId}
📡 SIM usado: ${simUsado}
━━━━━━━━━━━━━━
⚠️ Envio não foi processado. Use *.reabrir ${pedido.pedidoId}* para tentar novamente.`
      );
    } else {
      await enviarMensagem(
`❌ FALHA NO ENVIO!

━━━━━━━━━━━━━━
👤 Cliente: ${pedido.cliente}
📱 Número: ${pedido.numero}
📦 Megas: ${pedido.quantidadeMB}MB
💰 Valor: ${pedido.valor}MT
🔐 Código: ${pedido.codigo}
📡 SIM usado: ${simUsado}
━━━━━━━━━━━━━━
⚠️ Pedido não foi processado. Entre em contacto com o suporte.`
      );
   }

    // 📁 Registrar em movimentos_falha.txt (só compras reais de clientes)
    if (pedido.origem !== "enviar") {
      try {
        const now = new Date();
        const pad = n => String(n).padStart(2, "0");
        const hora = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const data = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
        const hojeStr = now.toISOString().split("T")[0];

        const pedidosHoje = lerPedidos().filter(p => {
          const d = p.dataFinalizacao || p.dataFalha || p.dataCriacao || "";
          return d.startsWith(hojeStr);
        });

        const totalMBHoje = pedidosHoje
          .filter(p => p.status === "finalizado")
          .reduce((acc, p) => acc + Number(p.quantidadeMB || 0), 0);

        const totalVendidoHoje = pedidosHoje
          .filter(p => p.status === "finalizado" || p.status === "falha")
          .reduce((acc, p) => acc + Number(p.valor || 0), 0);

        const numeroCompra = pedidosHoje
          .filter(p => p.status === "finalizado" || p.status === "falha").length;

        const blocoFalha =
`\n━━━━━━━━━━━━━━━━━━

👉 PEDIDO Nr⁰: ${pedido.pedidoId}

📅 DATA: ${data}
🕒 HORA: ${hora}

👤 CLIENTE: ${pedido.cliente}
📱 NÚMERO: ${pedido.numero}

💳 CARTEIRA: ${carteira}
🆔 ID: ${pedido.codigo || "N/A"}

💰 VALOR: ${pedido.valor}MT
📦 MEGAS: ${pedido.quantidadeMB}MB

📶 SIM USADO: ${simUsado}
📊 MB VENDIDOS HOJE: ${totalMBHoje}MB

🎫 COMPRA N⁰: ${numeroCompra}
✅ ESTADO: ❌ FALHA

━━━━━━━━━━━━━━━━━━\n`;

        fs.appendFileSync(MOVIMENTOS_FALHA_PATH, blocoFalha, "utf8");
        console.log("📝 Falha registrada no arquivo");

        // 💾 Atualizar resumo do dia
        let resumo = {};
        try {
          resumo = JSON.parse(fs.readFileSync(RESUMO_DIA_PATH, "utf8"));
        } catch (e) {}

        resumo.falhas = (resumo.falhas || 0) + 1;
        resumo.hora = hora;
        resumo.data = data;
        resumo.totalVendido = totalVendidoHoje;

        fs.writeFileSync(RESUMO_DIA_PATH, JSON.stringify(resumo, null, 2));

      } catch (e) {
        console.error("❌ Erro ao registrar falha:", e.message);
      }
    } else {
      console.log(`⏭️ Pedido ${pedido.pedidoId} veio de .enviar — não registado em movimentos_falha.txt`);
    }

    // 🔄 Chamar próximo pedido pendente
    const pedidosAtuais = lerPedidos();
    const proximoPendente = pedidosAtuais.find(p => p.status === "pendente");

    if (proximoPendente) {
      console.log("🔄 Há pendentes — chamando próximo gatilho...");
      setTimeout(async () => {
        try {
          await axios.post(
            `http://localhost:${PORT}/gatilho`,
            {},
            { headers: { "Content-Type": "application/json" }, timeout: 30000 }
          );
          console.log("✅ Próximo pedido acionado");
        } catch (err) {
          console.error("❌ Erro ao chamar gatilho:", err?.message);
        }
      }, 3000);
    } else {
      console.log("✅ Sem mais pedidos pendentes.");
    }

    // 👑 Notificar admin se reiniciar ativo
    const reiniciarSessao = getReiniciarSessao();
    if (reiniciarSessao && reiniciarSessao.from) {
      reiniciarSessao.falha++;
      reiniciarSessao.atual++;

      await sock.sendMessage(reiniciarSessao.from, {
        text:
`❌ *Pedido ${reiniciarSessao.atual - 1}/${reiniciarSessao.total} com FALHA!*
━━━━━━━━━━━━━━
👤 Cliente: ${pedido.cliente}
📱 Número: ${pedido.numero}
📦 Megas: ${pedido.quantidadeMB}MB
💰 Valor: ${pedido.valor}MT
📡 SIM: ${simUsado}
━━━━━━━━━━━━━━`
      });

      if (!proximoPendente) {
        await sock.sendMessage(reiniciarSessao.from, {
          text:
`🎉 *REINÍCIO CONCLUÍDO!*
━━━━━━━━━━━━━━
📋 Total: ${reiniciarSessao.total}
✅ Sucesso: ${reiniciarSessao.sucesso}
❌ Falha: ${reiniciarSessao.falha}
━━━━━━━━━━━━━━`
        });
        setReiniciarSessao(null);
      }
    }

    res.json({ ok: true, pedidoId: pedido.pedidoId });

  } catch (err) {
    console.error("🔥 Erro /falha:", err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});


// ===================== PAINEL AUTOMÁTICO — ENDPOINTS =====================

// GET /api/status -> { autoVenda: true/false }
app.get('/api/status', (req, res) => {
  const config = lerConfigGlobal();
  res.json({ autoVenda: config.vendaAutomaticaLigada !== false }); // default true
});

// POST /api/auto-venda -> body: { ligado: true/false }
app.post('/api/auto-venda', (req, res) => {
  const { ligado } = req.body;
  if (typeof ligado !== 'boolean') {
    return res.status(400).json({ erro: 'campo "ligado" precisa ser true ou false' });
  }
  const config = lerConfigGlobal();
  config.vendaAutomaticaLigada = ligado;
  salvarConfigGlobal(config);
  console.log(`[Painel] Venda automática ${ligado ? 'LIGADA' : 'DESLIGADA'}`);
  res.json({ ok: true, autoVenda: ligado });
});

// GET /api/resumo -> { vendasHoje, mbHoje, saldoTotal, telefonesOnline, telefonesTotal }
// GET /api/resumo -> { vendasHoje, mbHoje, saldoTotal, telefonesOnline, telefonesTotal }
app.get('/api/resumo', (req, res) => {
  try {
    const hojeStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Maputo' });

    const pedidosHoje = lerPedidos().filter(p => {
      const d = p.dataFinalizacao || p.dataCriacao || "";
      return diaMaputo(d) === hojeStr;
    });

    const finalizados = pedidosHoje.filter(p => p.status === "finalizado");
    const falhas = pedidosHoje.filter(p => p.status === "falha");

    const mbHoje = finalizados.reduce((acc, p) => acc + Number(p.quantidadeMB || 0), 0);
    const totalVendido = [...finalizados, ...falhas]
      .reduce((acc, p) => acc + Number(p.valor || 0), 0);

    const config = lerConfigGlobal();
    const telefonesOnline = TELEFONES.filter(t => {
      const r = verificarTelefone(config, t, 1); // 1MB só pra testar disponibilidade
      return r.configurado && r.ok;
    }).length;

    res.json({
      vendasHoje: finalizados.length,
      mbHoje,
      saldoTotal: totalVendido,
      telefonesOnline,
      telefonesTotal: TELEFONES.length
    });
  } catch (err) {
    console.error('[Painel] Erro em /api/resumo:', err);
    res.status(500).json({ erro: 'falha ao montar resumo' });
  }
});

// GET /api/eventos -> [{ nome, hora, valor }]  (TODAS as vendas de hoje, sem limite)
app.get('/api/eventos', (req, res) => {
  try {
    const hojeStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Maputo' });

    const eventos = lerPedidos()
      .filter(p => {
        const d = p.dataFinalizacao || p.dataCriacao || "";
        return diaMaputo(d) === hojeStr && (p.status === "finalizado" || p.status === "falha");
      })
      .sort((a, b) => new Date(b.dataFinalizacao) - new Date(a.dataFinalizacao))
      .map(p => ({
        nome: p.cliente || p.numero || '—',
        hora: p.dataFinalizacao
          ? new Date(p.dataFinalizacao).toLocaleTimeString('pt-MZ', {
              timeZone: 'Africa/Maputo', hour: '2-digit', minute: '2-digit'
            })
          : '—',
        valor: p.status === "falha" ? "❌ Falha" : `${p.valor}MT`
      }));

    res.json(eventos);
  } catch (err) {
    console.error('[Painel] Erro em /api/eventos:', err);
    res.status(500).json({ erro: 'falha ao buscar eventos' });
  }
});


// GET /api/telefones -> [{ id, nome, sim1MB, sim2MB, limiteSim1, limiteSim2, simAtivo, disponivel }]
app.get('/api/telefones', (req, res) => {
  try {
    const config = lerConfigGlobal();
    const lista = TELEFONES.map(t => {
      const r = verificarTelefone(config, t, 1);
      return {
        id: t.id,
        nome: t.nome,
        sim1MB: r.sim1MB ?? 0,
        sim2MB: r.sim2MB ?? 0,
        limiteSim1: r.limiteSim1 ?? 0,
        limiteSim2: r.limiteSim2 ?? 0,
        simAtivo: r.simAtivoAntes || 'SIM1',
        disponivel: r.configurado ? !!r.ok : false
      };
    });
    res.json(lista);
  } catch (err) {
    console.error('[Painel] Erro em /api/telefones:', err);
    res.status(500).json({ erro: 'falha ao buscar telefones' });
  }
});


// GET /api/config -> { vendaAutomaticaLigada, telefones: [{ id, nome, limiteSim1, limiteSim2, sim1MB, sim2MB }] }
app.get('/api/config', (req, res) => {
  try {
    const config = lerConfigGlobal();
    const telefones = TELEFONES.map(t => {
      const limite = config[t.limiteKey] || {};
      const mb = config[t.mbKey] || {};
      return {
        id: t.id,
        nome: t.nome,
        limiteSim1: Number(limite.sim1) || 0,
        limiteSim2: Number(limite.sim2) || 0,
        sim1MB: Number(mb.sim1) || 0,
        sim2MB: Number(mb.sim2) || 0
      };
    });
    res.json({
      vendaAutomaticaLigada: config.vendaAutomaticaLigada !== false,
      telefones
    });
  } catch (err) {
    console.error('[Painel] Erro em /api/config:', err);
    res.status(500).json({ erro: 'falha ao buscar configurações' });
  }
});

// POST /api/config/limite -> body: { id, limiteSim1, limiteSim2, sim1MB, sim2MB }
app.post('/api/config/limite', async (req, res) => {
  try {
    const { id, limiteSim1, limiteSim2, sim1MB, sim2MB } = req.body;
    const telefone = TELEFONES.find(t => t.id === Number(id));
    if (!telefone) return res.status(404).json({ erro: 'telefone não encontrado' });

    const config = lerConfigGlobal();

    config[telefone.limiteKey] = {
      sim1: Number(limiteSim1) || 0,
      sim2: Number(limiteSim2) || 0
    };

    config[telefone.mbKey] = {
      sim1: Number(sim1MB) || 0,
      sim2: Number(sim2MB) || 0,
      atualizadoEm: new Date().toISOString()
    };

    salvarConfigGlobal(config);
    console.log(`[Painel] Atualizado — ${telefone.nome}: Limite SIM1=${limiteSim1} SIM2=${limiteSim2} | MB SIM1=${sim1MB} SIM2=${sim2MB}`);

    try {
      await axios.post(
        telefone.urlLimite,
        { sim1: config[telefone.limiteKey].sim1, sim2: config[telefone.limiteKey].sim2 },
        { headers: { "Content-Type": "application/json" }, timeout: 15000 }
      );
    } catch (e) {
      console.log(`❌ Erro ao sincronizar Limite no MacroDroid (${telefone.nome}):`, e?.message);
    }

    try {
      await axios.post(
        telefone.urlDefinirmb,
        { sim1: config[telefone.mbKey].sim1, sim2: config[telefone.mbKey].sim2 },
        { headers: { "Content-Type": "application/json" }, timeout: 15000 }
      );
    } catch (e) {
      console.log(`❌ Erro ao sincronizar MB no MacroDroid (${telefone.nome}):`, e?.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Painel] Erro em /api/config/limite:', err);
    res.status(500).json({ erro: 'falha ao atualizar' });
  }
});

const COMPRAS_GB = [5, 7, 10, 20]; // pacotes em que o dono compra os megas

// GET /api/lucro -> { temCustos, vendas, vendido, mb, custo, lucro, margem, semCusto, custoPorGB, pacotes: [{ mb, valor, vendas, custo }] }
// POST /api/lucro -> body: { custosPacotes?: { "480": 8, "1024": 20 }, custoPorGB?: número >= 0 }
app.get('/api/lucro', (req, res) => {
  try {
    const hojeStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Maputo' });
    const config = lerConfigGlobal();
    const custoPorGB = Number(config.custoPorGB) || 0;
    const custosPacotes = config.custosPacotes || {};
    const tabela = config.tabelaPacotes || {};

    // Custo de um pacote: preço definido para esses MB; se não houver, usa o custo por GB (se definido)
    const custoDe = (mb) => {
      const c = custosPacotes[String(mb)];
      if (c !== undefined && c !== null && Number.isFinite(Number(c))) return Number(c);
      if (custoPorGB > 0) return (mb / 1024) * custoPorGB;
      return null;
    };

    const todos = lerPedidos();
    const finalizadosHoje = todos.filter(p => {
      const d = p.dataFinalizacao || p.dataCriacao || "";
      return diaMaputo(d) === hojeStr && p.status === "finalizado";
    });

    // Preço → MB pela tabela (só preços que aparecem uma vez), para vendas sem MB registado
    const mbPorPreco = {};
    const contaPreco = {};
    for (const [mbK, preco] of Object.entries(tabela)) {
      contaPreco[preco] = (contaPreco[preco] || 0) + 1;
      mbPorPreco[preco] = Number(mbK);
    }

    let vendido = 0, vendidoComCusto = 0, custo = 0, semCusto = 0, mbTotal = 0;
    for (const p of finalizadosHoje) {
      const v = Number(p.valor) || 0;
      let m = Number(p.quantidadeMB) || 0;
      if (!m && contaPreco[v] === 1) m = mbPorPreco[v];
      vendido += v;
      mbTotal += m;
      const c = m > 0 ? custoDe(m) : null; // sem MB conhecidos não dá para calcular o custo
      if (c === null) semCusto++;
      else { vendidoComCusto += v; custo += c; }
    }
    const lucro = vendidoComCusto - custo;
    const margem = vendidoComCusto > 0 ? (lucro / vendidoComCusto) * 100 : 0;
    const r2 = n => Math.round(n * 100) / 100;

    // Pacotes conhecidos: todos os que já foram vendidos + os que já têm custo definido
    const mapa = {};
    for (const p of todos) {
      if (p.status !== 'finalizado') continue;
      const m = Number(p.quantidadeMB) || 0;
      if (!m) continue;
      if (!mapa[m]) mapa[m] = { mb: m, valor: Number(p.valor) || 0, vendas: 0 };
      mapa[m].vendas++;
      mapa[m].valor = Number(p.valor) || mapa[m].valor;
    }
    for (const k of Object.keys(custosPacotes)) {
      const m = Number(k);
      if (m && !mapa[m]) mapa[m] = { mb: m, valor: tabela[String(m)] ?? null, vendas: 0 };
    }
    const pacotes = Object.values(mapa)
      .sort((x, y) => x.mb - y.mb)
      .map(x => ({ ...x, custo: custosPacotes[String(x.mb)] ?? null }));

    res.json({
      temCustos: Object.keys(custosPacotes).length > 0 || custoPorGB > 0,
      tabelaTotal: Object.keys(tabela).length,
      tabela: Object.entries(tabela)
        .map(([mb, preco]) => ({ mb: Number(mb), preco: Number(preco) }))
        .sort((a, b) => a.mb - b.mb),
      custoPorGB,
      custosCompra: config.custosCompra || {},
      compraAtiva: Number(config.compraAtiva) || null,
      vendas: finalizadosHoje.length,
      vendido: r2(vendido),
      mb: mbTotal,
      custo: r2(custo),
      lucro: r2(lucro),
      margem: r2(margem),
      semCusto,
      pacotes
    });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/lucro:', err);
    res.status(500).json({ erro: 'falha ao calcular lucro' });
  }
});

app.post('/api/lucro', (req, res) => {
  try {
    const { custosPacotes, custoPorGB, custosCompra, compraAtiva } = req.body || {};
    const config = lerConfigGlobal();

    if (custosPacotes !== undefined) {
      if (typeof custosPacotes !== 'object' || custosPacotes === null || Array.isArray(custosPacotes)) {
        return res.status(400).json({ erro: 'custosPacotes precisa ser um objeto { MB: custo }' });
      }
      const limpo = {};
      for (const [k, v] of Object.entries(custosPacotes)) {
        const mb = Number(k);
        if (!Number.isInteger(mb) || mb <= 0) {
          return res.status(400).json({ erro: `pacote inválido: ${k}` });
        }
        if (v === null || v === '') continue; // vazio = remove o custo desse pacote
        const c = Number(v);
        if (!Number.isFinite(c) || c < 0 || c > 1000000) {
          return res.status(400).json({ erro: `custo inválido para ${k} MB` });
        }
        limpo[String(mb)] = c;
      }
      config.custosPacotes = limpo;
    }

    // Preço que pagas por cada pacote de compra (5, 7, 10, 20 GB) e qual estás a usar agora
    if (custosCompra !== undefined) {
      if (typeof custosCompra !== 'object' || custosCompra === null || Array.isArray(custosCompra)) {
        return res.status(400).json({ erro: 'custosCompra precisa ser um objeto { GB: preço }' });
      }
      const limpo = {};
      for (const [k, v] of Object.entries(custosCompra)) {
        const gb = Number(k);
        if (!COMPRAS_GB.includes(gb)) return res.status(400).json({ erro: `pacote de compra inválido: ${k} GB` });
        if (v === null || v === '') continue; // vazio = remove
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || n > 1000000) {
          return res.status(400).json({ erro: `preço inválido para ${k} GB` });
        }
        limpo[String(gb)] = n;
      }
      config.custosCompra = limpo;
    }
    if (compraAtiva !== undefined) {
      if (compraAtiva === null || compraAtiva === '') {
        config.compraAtiva = null;
      } else {
        const gb = Number(compraAtiva);
        if (!COMPRAS_GB.includes(gb)) return res.status(400).json({ erro: 'compraAtiva precisa ser 5, 7, 10 ou 20' });
        config.compraAtiva = gb;
      }
    }
    if (custosCompra !== undefined || compraAtiva !== undefined) {
      const gbAtivo = Number(config.compraAtiva);
      if (gbAtivo) {
        const preco = Number((config.custosCompra || {})[String(gbAtivo)]);
        if (!(preco > 0)) {
          return res.status(400).json({ erro: `preenche o preço de compra de ${gbAtivo} GB, que escolheste como em uso` });
        }
        config.custoPorGB = Math.round(preco / gbAtivo * 10000) / 10000; // o lucro usa o custo por GB do pacote em uso
      } else {
        config.custoPorGB = 0;
      }
    }

    if (custoPorGB !== undefined) {
      const n = Number(custoPorGB);
      if (!Number.isFinite(n) || n < 0 || n > 100000) {
        return res.status(400).json({ erro: 'custoPorGB precisa ser um número entre 0 e 100000' });
      }
      config.custoPorGB = n;
    }

    salvarConfigGlobal(config);
    console.log(`[Painel] Custos guardados: ${Object.keys(config.custosPacotes || {}).length} pacote(s), ${Number(config.custoPorGB) || 0} MT/GB`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/lucro:', err);
    res.status(500).json({ erro: 'falha ao guardar custos' });
  }
});

// GET /api/tabela -> { total, pacotes: [{ mb, preco }] }
// POST /api/tabela -> body: { pacotes: [{ mb, preco }] }  (substitui a tabela inteira; [] apaga)
app.get('/api/tabela', (req, res) => {
  try {
    const t = lerConfigGlobal().tabelaPacotes || {};
    const pacotes = Object.entries(t)
      .map(([mb, preco]) => ({ mb: Number(mb), preco: Number(preco) }))
      .sort((a, b) => a.mb - b.mb);
    res.json({ total: pacotes.length, pacotes });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/tabela:', err);
    res.status(500).json({ erro: 'falha ao ler tabela' });
  }
});

app.post('/api/tabela', (req, res) => {
  try {
    const { pacotes } = req.body || {};
    if (!Array.isArray(pacotes) || pacotes.length > 500) {
      return res.status(400).json({ erro: 'pacotes precisa ser uma lista com até 500 itens' });
    }
    const nova = {};
    for (const p of pacotes) {
      const mb = Number(p && p.mb);
      const preco = Number(p && p.preco);
      if (!Number.isInteger(mb) || mb <= 0 || !Number.isFinite(preco) || preco <= 0 || preco > 1000000) {
        return res.status(400).json({ erro: `pacote inválido: ${JSON.stringify(p)}` });
      }
      nova[String(mb)] = preco; // se repetir os MB, vale o último
    }
    const config = lerConfigGlobal();
    config.tabelaPacotes = nova;
    salvarConfigGlobal(config);
    console.log(`[Painel] Tabela de preços guardada: ${Object.keys(nova).length} pacotes`);
    res.json({ ok: true, total: Object.keys(nova).length });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/tabela:', err);
    res.status(500).json({ erro: 'falha ao guardar tabela' });
  }
});

// POST /api/fila-acao -> body: { pedidoId, acao: 'reabrir' | 'cancelar', pin }
app.post('/api/fila-acao', (req, res) => {
  try {
    const { pedidoId, acao, pin } = req.body || {};
    if (pin !== PIN_PEDIDO_MANUAL) {
      return res.status(403).json({ erro: 'PIN incorreto' });
    }
    if (!pedidoId || !['reabrir', 'cancelar'].includes(acao)) {
      return res.status(400).json({ erro: 'precisa de pedidoId e acao (reabrir ou cancelar)' });
    }

    const pedidos = lerPedidos();
    const idx = pedidos.findIndex(p => p.pedidoId === pedidoId);
    if (idx === -1) return res.status(404).json({ erro: 'pedido não encontrado' });

    const p = pedidos[idx];
    if (!['pendente', 'processando', 'processado'].includes(p.status)) {
      return res.status(409).json({ erro: `o pedido já está "${p.status}"` });
    }

    if (acao === 'reabrir') {
      if (p.status === 'pendente') {
        return res.status(409).json({ erro: 'o pedido já está na fila' });
      }
      if (p.status === 'processado') {
        const seg = (Date.now() - new Date(p.dataProcessamento || 0).getTime()) / 1000;
        if (seg < 60) {
          return res.status(409).json({ erro: `Aguarda ${Math.ceil(60 - seg)}s: o telefone ainda pode estar a enviar` });
        }
      }
    }

    // Cancela o aviso de "sem confirmação" deste pedido, se existir
    if (timers[pedidoId]) {
      clearTimeout(timers[pedidoId]);
      delete timers[pedidoId];
    }

    if (acao === 'cancelar') {
      p.status = 'cancelado';
      p.dataCancelamento = new Date().toISOString();
      p.canceladoPor = 'painel';
      salvarPedidos(pedidos);
      console.log(`[Painel] Pedido cancelado: ${pedidoId}`);
      return res.json({ ok: true, status: 'cancelado' });
    }

    p.status = 'pendente';
    p.reaberturas = (p.reaberturas || 0) + 1;
    p.dataReabertura = new Date().toISOString();
    salvarPedidos(pedidos);
    console.log(`[Painel] Pedido reaberto: ${pedidoId}`);

    fetch(`http://localhost:${PORT}/gatilho`, { method: 'POST' }).catch(() => {});
    res.json({ ok: true, status: 'pendente' });
  } catch (err) {
    console.error('[Painel] Erro em /api/fila-acao:', err);
    res.status(500).json({ erro: 'falha ao executar a ação' });
  }
});

// ===================== ALERTA DE SALDO BAIXO =====================
let alertaSaldoAgendado = false;

// Lista os SIMs acompanhados: os que têm MB, têm limite de envio, ou já foram avisados
function saldosSims(config) {
  const limiteMB = Number(config.alertaSaldoMB) || 0;
  const enviados = config.alertasSaldoEnviados || {};
  const sims = [];
  for (const t of TELEFONES) {
    const mbObj = config[t.mbKey];
    if (!mbObj) continue;
    const limObj = config[t.limiteKey] || {};
    for (const n of [1, 2]) {
      const mb = Number(mbObj['sim' + n]) || 0;
      const lim = Number(limObj['sim' + n]) || 0;
      const chave = `${t.id}:SIM${n}`;
      if (!(mb > 0 || lim > 0 || enviados[chave])) continue; // SIM sem uso: ignora
      sims.push({ chave, telefoneId: t.id, nome: t.nome, sim: 'SIM' + n, mb, baixo: limiteMB > 0 && mb < limiteMB });
    }
  }
  return { limiteMB, sims };
}

// Avisa o grupo admin uma vez por SIM quando o saldo desce do limite; volta a avisar só depois de recuperar
async function verificarSaldoBaixo() {
  try {
    const config = lerConfigGlobal();
    const { limiteMB, sims } = saldosSims(config);
    if (limiteMB <= 0) return;

    const enviados = { ...(config.alertasSaldoEnviados || {}) };
    const novos = [];
    let mudou = false;
    for (const s of sims) {
      if (s.baixo && !enviados[s.chave]) novos.push(s);
      if (!s.baixo && enviados[s.chave]) { delete enviados[s.chave]; mudou = true; }
    }

    if (novos.length) {
      let enviouAlgum = false;

      // Canal 1: mensagem no grupo admin (precisa do WhatsApp ligado)
      if (globalSocket) {
        try {
          const linhas = novos.map(s => `📱 ${s.nome} · ${s.sim}: *${s.mb}MB*`).join('\n');
          await globalSocket.sendMessage(GRUPO_ADMIN, {
            text: `⚠️ *SALDO BAIXO*\n━━━━━━━━━━━━━━\n${linhas}\n━━━━━━━━━━━━━━\n🔔 Alerta abaixo de ${limiteMB}MB\n🔒 Serviço automático e seguro`
          });
          enviouAlgum = true;
        } catch (e) {
          console.log('⚠️ Alerta de saldo: falhou o envio ao WhatsApp:', e.message);
        }
      }

      // Canal 2: notificação push nos telemóveis inscritos
      if ((config.pushSubscriptions || []).length > 0) {
        const resumo = novos.map(s => `${s.nome} ${s.sim}: ${s.mb}MB`).join(' · ');
        await enviarNotificacaoPush('⚠️ Saldo baixo', `${resumo} (limite ${limiteMB}MB)`, 'saldo-baixo');
        enviouAlgum = true;
      }

      if (enviouAlgum) {
        novos.forEach(s => { enviados[s.chave] = true; });
        mudou = true;
      }
    }

    if (mudou) {
      const cfg2 = lerConfigGlobal(); // relê para não apagar alterações feitas entretanto
      cfg2.alertasSaldoEnviados = enviados;
      salvarConfigGlobal(cfg2);
    }
  } catch (e) {
    console.log('⚠️ Erro no alerta de saldo:', e.message);
  }
}

// GET /api/alertas -> { limiteMB, sims: [{ telefoneId, nome, sim, mb, baixo }] }
// POST /api/alertas -> body: { limiteMB: 0-100000 }  (0 desliga)
app.get('/api/alertas', (req, res) => {
  try {
    const { limiteMB, sims } = saldosSims(lerConfigGlobal());
    res.json({
      limiteMB,
      sims: sims.map(({ telefoneId, nome, sim, mb, baixo }) => ({ telefoneId, nome, sim, mb, baixo }))
    });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/alertas:', err);
    res.status(500).json({ erro: 'falha ao ler alertas' });
  }
});

app.post('/api/alertas', (req, res) => {
  try {
    const n = Number((req.body || {}).limiteMB);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      return res.status(400).json({ erro: 'limiteMB precisa estar entre 0 e 100000' });
    }
    const config = lerConfigGlobal();
    config.alertaSaldoMB = Math.round(n);
    config.alertasSaldoEnviados = {}; // limite novo: volta a avaliar todos os SIMs
    salvarConfigGlobal(config);
    console.log(`[Painel] Alerta de saldo baixo: ${config.alertaSaldoMB}MB`);
    res.json({ ok: true, limiteMB: config.alertaSaldoMB });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/alertas:', err);
    res.status(500).json({ erro: 'falha ao guardar alerta' });
  }
});

// ===================== PUSH (inscrição pelo painel) =====================
// GET  /api/push-chave    -> { publicKey }
// POST /api/push-inscrever -> body: { subscription, pin }
// POST /api/push-teste     -> body: { pin }
app.get('/api/push-chave', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push-inscrever', (req, res) => {
  try {
    const { subscription, pin } = req.body || {};
    if (pin !== PIN_PEDIDO_MANUAL) return res.status(403).json({ erro: 'PIN incorreto' });

    const ok = subscription
      && typeof subscription.endpoint === 'string'
      && subscription.endpoint.startsWith('https://')
      && subscription.keys && subscription.keys.p256dh && subscription.keys.auth;
    if (!ok) return res.status(400).json({ erro: 'inscrição inválida' });

    const config = lerConfigGlobal();
    const subs = config.pushSubscriptions || [];
    if (!subs.some(s => s.endpoint === subscription.endpoint)) {
      if (subs.length >= 10) return res.status(409).json({ erro: 'limite de 10 telemóveis inscritos' });
      subs.push(subscription);
      config.pushSubscriptions = subs;
      salvarConfigGlobal(config);
      console.log(`[Painel] Nova inscrição push (total: ${subs.length})`);
    }
    res.json({ ok: true, total: subs.length });
  } catch (err) {
    console.error('[Painel] Erro em /api/push-inscrever:', err);
    res.status(500).json({ erro: 'falha ao registar inscrição' });
  }
});

app.post('/api/push-teste', async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (pin !== PIN_PEDIDO_MANUAL) return res.status(403).json({ erro: 'PIN incorreto' });
    const total = (lerConfigGlobal().pushSubscriptions || []).length;
    if (total === 0) return res.status(409).json({ erro: 'nenhum telemóvel inscrito ainda' });
    await enviarNotificacaoPush('🔔 Teste', 'As notificações estão a funcionar.', 'teste');
    res.json({ ok: true, inscritos: total });
  } catch (err) {
    console.error('[Painel] Erro em /api/push-teste:', err);
    res.status(500).json({ erro: 'falha ao enviar teste' });
  }
});

// GET /api/semana -> { dias: [{ data, rotulo, vendas, mb, vendido }], horas: [24], melhorHora, totais, mediaVendas }
app.get('/api/semana', (req, res) => {
  try {
    const tz = 'Africa/Maputo';
    const fmtDia = new Intl.DateTimeFormat('sv-SE', { timeZone: tz });
    const fmtHora = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
    const semana = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

    const dias = [];
    for (let i = 6; i >= 0; i--) {
      const data = fmtDia.format(new Date(Date.now() - i * 86400000));
      dias.push({
        data,
        rotulo: semana[new Date(data + 'T12:00:00Z').getUTCDay()],
        vendas: 0, mb: 0, vendido: 0
      });
    }
    const porData = Object.fromEntries(dias.map(d => [d.data, d]));
    const horas = new Array(24).fill(0);

    for (const p of lerPedidos()) {
      if (p.status !== 'finalizado') continue;
      const quando = new Date(p.dataFinalizacao || p.dataCriacao || 0);
      if (isNaN(quando.getTime())) continue;
      const dia = porData[fmtDia.format(quando)];
      if (!dia) continue;
      dia.vendas++;
      dia.mb += Number(p.quantidadeMB) || 0;
      dia.vendido += Number(p.valor) || 0;
      horas[Number(fmtHora.format(quando)) % 24]++;
    }

    const totais = dias.reduce((t, d) => ({
      vendas: t.vendas + d.vendas, mb: t.mb + d.mb, vendido: t.vendido + d.vendido
    }), { vendas: 0, mb: 0, vendido: 0 });

    const max = Math.max(...horas);
    res.json({
      dias,
      horas,
      melhorHora: max > 0 ? horas.indexOf(max) : null,
      totais,
      mediaVendas: Math.round((totais.vendas / 7) * 10) / 10
    });
  } catch (err) {
    console.error('[Painel] Erro em /api/semana:', err);
    res.status(500).json({ erro: 'falha ao calcular a semana' });
  }
});

// ===================== DIA NO FUSO DE MAPUTO (UTC+2, sem hora de verão) =====================
function diaMaputo(iso) {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return '';
  return new Date(t + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

// GET /api/disparo -> { pausaEnvios, telefoneAtivo, telefones: [{ id, nome, disponivel }] }
// POST /api/disparo -> body: { pausaEnvios?: 0-120, telefoneAtivo?: 1|2|3 }
app.get('/api/disparo', (req, res) => {
  try {
    const config = lerConfigGlobal();
    res.json({
      pausaEnvios: Number(config.pausaEnvios) || 0,
      telefoneAtivo: Number(config.telefoneAtivo) || TELEFONES[0].id,
      telefones: TELEFONES.map(t => {
        const r = verificarTelefone(config, t, 1);
        return { id: t.id, nome: t.nome, disponivel: r.configurado ? !!r.ok : false };
      })
    });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/disparo:', err);
    res.status(500).json({ erro: 'falha ao ler configuração de disparo' });
  }
});

app.post('/api/disparo', (req, res) => {
  try {
    const { pausaEnvios, telefoneAtivo } = req.body || {};
    const config = lerConfigGlobal();

    if (pausaEnvios !== undefined) {
      const n = Number(pausaEnvios);
      if (!Number.isFinite(n) || n < 0 || n > 120) {
        return res.status(400).json({ erro: 'pausaEnvios precisa estar entre 0 e 120 segundos' });
      }
      config.pausaEnvios = Math.round(n);
    }

    if (telefoneAtivo !== undefined) {
      const id = Number(telefoneAtivo);
      if (!TELEFONES.some(t => t.id === id)) {
        return res.status(400).json({ erro: 'telefone inválido' });
      }
      config.telefoneAtivo = id;
    }

    salvarConfigGlobal(config);
    console.log(`[Painel] Disparo: pausa=${config.pausaEnvios || 0}s, telefoneAtivo=${config.telefoneAtivo || TELEFONES[0].id}`);
    res.json({
      ok: true,
      pausaEnvios: Number(config.pausaEnvios) || 0,
      telefoneAtivo: Number(config.telefoneAtivo) || TELEFONES[0].id
    });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/disparo:', err);
    res.status(500).json({ erro: 'falha ao guardar configuração de disparo' });
  }
});

// GET /api/fila -> [{ pedidoId, nome, numero, mb, valor, status, telefone, sim, hora }]
app.get('/api/fila', (req, res) => {
  try {
    const ordem = { processado: 0, processando: 1, pendente: 2 };
    const fila = lerPedidos()
      .filter(p => p.status === 'pendente' || p.status === 'processando' || p.status === 'processado')
      .sort((a, b) => (ordem[a.status] - ordem[b.status]) || (new Date(a.dataCriacao || 0) - new Date(b.dataCriacao || 0)))
      .map(p => ({
        pedidoId: p.pedidoId,
        nome: p.cliente || p.numero || '—',
        numero: p.numero || '',
        mb: Number(p.quantidadeMB) || 0,
        valor: Number(p.valor) || 0,
        status: p.status,
        telefone: p.telefoneUsado || null,
        sim: p.simUsado || null,
        processadoHa: p.dataProcessamento ? Math.max(0, Math.round((Date.now() - new Date(p.dataProcessamento).getTime()) / 1000)) : null,
        hora: p.dataCriacao
          ? new Date(p.dataCriacao).toLocaleTimeString('pt-MZ', { timeZone: 'Africa/Maputo', hour: '2-digit', minute: '2-digit' })
          : '—'
      }));
    res.json(fila);
  } catch (err) {
    console.error('[Painel] Erro em /api/fila:', err);
    res.status(500).json({ erro: 'falha ao buscar fila' });
  }
});

// GET /api/historico -> [{ nome, data, hora, valor }]
app.get('/api/historico', (req, res) => {
  try {
    const eventos = lerPedidos()
      .filter(p => p.status === "finalizado" || p.status === "falha")
      .sort((a, b) => new Date(b.dataFinalizacao || b.dataCriacao) - new Date(a.dataFinalizacao || a.dataCriacao))
      .slice(0, 50)
      .map(p => {
        const d = p.dataFinalizacao || p.dataCriacao;
        const dt = d ? new Date(d) : null;
        return {
          nome: p.cliente || p.numero || '—',
          data: dt ? dt.toLocaleDateString('pt-MZ', { timeZone: 'Africa/Maputo' }) : '—',
          hora: dt ? dt.toLocaleTimeString('pt-MZ', {
            timeZone: 'Africa/Maputo', hour: '2-digit', minute: '2-digit'
          }) : '—',
          valor: p.status === "falha" ? "❌ Falha" : `${p.valor}MT`
        };
      });

    res.json(eventos);
  } catch (err) {
    console.error('[Painel] Erro em /api/historico:', err);
    res.status(500).json({ erro: 'falha ao buscar histórico' });
  }
});


// ⚠️ Troca esse PIN por um número só teu antes de usar
const PIN_PEDIDO_MANUAL = "2";

// POST /api/pedido -> body: { pin, cliente, numero, quantidadeMB, valor, provedor, enviarSms }
app.post('/api/pedido', async (req, res) => {
  try {
    const { pin, cliente, numero, quantidadeMB, valor, provedor, enviarSms } = req.body;

    if (pin !== PIN_PEDIDO_MANUAL) {
      return res.status(403).json({ erro: 'PIN incorreto' });
    }
    if (!numero || !quantidadeMB || !valor) {
      return res.status(400).json({ erro: 'campos obrigatórios: numero, quantidadeMB, valor' });
    }

    const pedidos = lerPedidos();
    const novoPedido = {
      pedidoId: `SITE-${Date.now()}`,
      cliente: cliente || numero,
      numero,
      grupo: numero,
      quantidadeMB: Number(quantidadeMB),
      valor: Number(valor),
      provedor: provedor || 'mpesa',
      codigo: 'MANUAL-SITE',
      status: 'pendente',
      dataCriacao: new Date().toISOString(),
      origem: 'site',
      // SMS de confirmação ao cliente (true por defeito; o painel pode desligar)
      enviarSms: !(enviarSms === false || enviarSms === 'false' || enviarSms === 0 || enviarSms === '0')
    };

    pedidos.push(novoPedido);
    salvarPedidos(pedidos);
    console.log('[Painel] Pedido manual criado pelo site:', novoPedido.pedidoId, novoPedido.enviarSms ? '(com SMS)' : '(sem SMS)');

    fetch(`http://localhost:${PORT}/gatilho`, { method: 'POST' }).catch(() => {});

    res.json({ ok: true, pedidoId: novoPedido.pedidoId });
  } catch (err) {
    console.error('[Painel] Erro em /api/pedido:', err);
    res.status(500).json({ erro: 'falha ao criar pedido' });
  }
});

// GET /api/clientes -> [{ numeroCliente, nome, totalCompras, totalGasto, ultimaCompra }]
app.get('/api/clientes', (req, res) => {
  try {
    const pedidos = lerPedidos().filter(p => p.status === "finalizado" || p.status === "falha");

    const mapa = {};
    for (const p of pedidos) {
      const chave = p.numeroComprador || p.participant || p.numero || p.cliente || 'desconhecido';
      if (!mapa[chave]) {
        mapa[chave] = {
          numeroCliente: chave,
          nome: p.cliente || chave,
          totalCompras: 0,
          totalGasto: 0,
          ultimaDataObj: null
        };
      }
      const c = mapa[chave];
      c.totalCompras += 1;
      if (p.status === "finalizado") c.totalGasto += Number(p.valor) || 0;

      const d = p.dataFinalizacao || p.dataCriacao;
      if (d) {
        const dt = new Date(d);
        if (!c.ultimaDataObj || dt > c.ultimaDataObj) {
          c.ultimaDataObj = dt;
          c.nome = p.cliente || c.nome;
        }
      }
    }

    const clientes = Object.values(mapa)
      .map(c => ({
        numeroCliente: c.numeroCliente,
        nome: c.nome,
        totalCompras: c.totalCompras,
        totalGasto: c.totalGasto,
        ultimaCompra: c.ultimaDataObj
          ? c.ultimaDataObj.toLocaleDateString('pt-MZ', { timeZone: 'Africa/Maputo' })
          : '—'
      }))
      .sort((a, b) => b.totalCompras - a.totalCompras);

    res.json(clientes);
  } catch (err) {
    console.error('[Painel] Erro em /api/clientes:', err);
    res.status(500).json({ erro: 'falha ao buscar clientes' });
  }
});

// ==================================================
// 🔋 RECARGAS POR TELEFONE (registo manual feito no painel)
// GET  /api/recargas -> { mes, telefones, total, lista }
// POST /api/recargas -> body: { pin, telefone, sim, mb, custo?, nota? }  (adiciona)
//                       body: { pin, acao: 'apagar', id }                (apaga)
// Só regista: NÃO mexe no saldo dos SIMs (o saldo vem do MacroDroid).
// ==================================================
const RECARGAS_FILE = path.join(dataDir, "recargas.json");

function lerRecargas() {
  try {
    const l = JSON.parse(fs.readFileSync(RECARGAS_FILE, "utf-8"));
    return Array.isArray(l) ? l : [];
  } catch (e) {
    return [];
  }
}
function salvarRecargas(lista) {
  fs.writeFileSync(RECARGAS_FILE, JSON.stringify(lista, null, 2));
}

app.get('/api/recargas', (req, res) => {
  try {
    const todas = lerRecargas();
    const mesAtual = diaMaputo(new Date().toISOString()).slice(0, 7); // AAAA-MM (Maputo)
    const r2 = n => Math.round(n * 100) / 100;

    const doMes = todas.filter(r => diaMaputo(r.data).slice(0, 7) === mesAtual);
    const telefones = TELEFONES.map(t => {
      const rs = doMes.filter(r => Number(r.telefone) === t.id);
      return {
        id: t.id,
        nome: t.nome,
        recargas: rs.length,
        mb: rs.reduce((a, r) => a + (Number(r.mb) || 0), 0),
        custo: r2(rs.reduce((a, r) => a + (Number(r.custo) || 0), 0))
      };
    });

    const mbTotal = doMes.reduce((a, r) => a + (Number(r.mb) || 0), 0);
    const custoTotal = doMes.reduce((a, r) => a + (Number(r.custo) || 0), 0);
    // custo por GB só com as recargas que têm custo indicado
    const comCusto = doMes.filter(r => Number(r.custo) > 0 && Number(r.mb) > 0);
    const mbComCusto = comCusto.reduce((a, r) => a + Number(r.mb), 0);
    const custoComCusto = comCusto.reduce((a, r) => a + Number(r.custo), 0);

    const lista = todas
      .slice()
      .sort((a, b) => new Date(b.data) - new Date(a.data))
      .slice(0, 30)
      .map(r => {
        const dt = new Date(r.data);
        const tel = TELEFONES.find(t => t.id === Number(r.telefone));
        return {
          id: r.id,
          data: dt.toLocaleDateString('pt-MZ', { timeZone: 'Africa/Maputo' }),
          hora: dt.toLocaleTimeString('pt-MZ', { timeZone: 'Africa/Maputo', hour: '2-digit', minute: '2-digit' }),
          telefone: Number(r.telefone),
          telefoneNome: tel ? tel.nome : `Telefone ${r.telefone}`,
          sim: r.sim || '',
          mb: Number(r.mb) || 0,
          custo: r.custo === null || r.custo === undefined ? null : Number(r.custo),
          nota: r.nota || ''
        };
      });

    res.json({
      mes: mesAtual,
      telefones,
      total: {
        recargas: doMes.length,
        mb: mbTotal,
        custo: r2(custoTotal),
        custoPorGB: mbComCusto > 0 ? r2(custoComCusto / (mbComCusto / 1024)) : null
      },
      lista
    });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/recargas:', err);
    res.status(500).json({ erro: 'falha ao buscar recargas' });
  }
});

app.post('/api/recargas', (req, res) => {
  try {
    const { pin, acao, id, telefone, sim, mb, custo, nota } = req.body || {};
    if (pin !== PIN_PEDIDO_MANUAL) return res.status(403).json({ erro: 'PIN incorreto' });

    const lista = lerRecargas();

    if (acao === 'apagar') {
      const nova = lista.filter(r => r.id !== id);
      if (nova.length === lista.length) return res.status(404).json({ erro: 'recarga não encontrada' });
      salvarRecargas(nova);
      console.log('[Painel] Recarga apagada:', id);
      return res.json({ ok: true });
    }

    const tel = TELEFONES.find(t => t.id === Number(telefone));
    if (!tel) return res.status(400).json({ erro: 'telefone inválido' });

    const mbNum = Number(mb);
    if (!Number.isFinite(mbNum) || mbNum <= 0 || mbNum > 10000000) {
      return res.status(400).json({ erro: 'MB inválidos' });
    }

    let custoNum = null;
    if (custo !== undefined && custo !== null && String(custo).trim() !== '') {
      custoNum = Number(custo);
      if (!Number.isFinite(custoNum) || custoNum < 0) return res.status(400).json({ erro: 'custo inválido' });
    }

    const simLimpo = (sim === 'SIM1' || sim === 'SIM2') ? sim : '';

    const nova = {
      id: `REC-${Date.now()}`,
      data: new Date().toISOString(),
      telefone: tel.id,
      sim: simLimpo,
      mb: Math.round(mbNum),
      custo: custoNum,
      nota: String(nota || '').trim().slice(0, 80)
    };
    lista.push(nova);
    salvarRecargas(lista);
    console.log(`[Painel] Recarga registada — ${tel.nome}${simLimpo ? ' ' + simLimpo : ''}: ${nova.mb}MB${custoNum !== null ? ' por ' + custoNum + 'MT' : ''}`);
    res.json({ ok: true, id: nova.id });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/recargas:', err);
    res.status(500).json({ erro: 'falha ao registar recarga' });
  }
});

// ==================================================
// 📣 SMS EM MASSA  +  ⏳ AVISO DE EXPIRAÇÃO POR SMS
// Os SMS saem pelo mesmo caminho dos outros SMS do bot (enviarSMS).
// Só vão para o número de QUEM COMPROU, nunca para o número que recebeu os megas.
// ==================================================
const SMS_MASSA_HIST_FILE = path.join(dataDir, "sms_massa_historico.json"); // { "258841234567": "ISO do último SMS em massa" }
const SMS_EXPIRACAO_FILE = path.join(dataDir, "sms_expiracao.json");       // { pedidoId: { estado, numero, em, tentativas } }
const SMS_EXPIRACAO_MSG_PADRAO = "Ola {nome}, os seus {mb} comprados no grupo {grupo} para o {numero} expiram as {hora}. Recarregue ate la para nao perder os megas!";
const SMS_SEGMENTOS = ['inativos7', 'inativos15', 'ativos'];

const smsDormir = (ms) => new Promise(r => setTimeout(r, ms));

function smsLerJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (e) { return def; }
}
function smsSalvarJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// Devolve 258 + 9 dígitos, ou '' se não for um telefone (ex.: identificador interno @lid)
function smsNormalizar(v) {
  const str = String(v || '');
  if (/@lid/i.test(str)) return '';
  let d = str.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);                 // 00258841234567
  if (/^08\d{8}$/.test(d)) d = d.slice(1);               // 0841234567
  if (/^8\d{8}$/.test(d)) return '258' + d;
  if (/^258\d{9}$/.test(d)) return d;
  return '';
}

// Número de quem comprou (nunca pedido.numero, que é quem recebe os megas).
// Pedidos por SMS/site não têm "@" no grupo: aí o grupo É o número do cliente.
function numeroDoComprador(p) {
  let n = smsNormalizar(p.numeroComprador) || smsNormalizar(p.participant);
  if (!n && p.grupo && !String(p.grupo).includes('@')) n = smsNormalizar(p.grupo);
  return n;
}

// formato usado no envio (igual ao dos pedidos do site: 84xxxxxxx)
const smsParaEnvio = (n258) => String(n258).slice(3);

// SMS não leva emojis: tira-os do nome (e converte letras "fantasia" tipo 𝓙𝓸𝓪𝓸 para letras normais)
function smsSemEmoji(t) {
  return String(t || '').normalize('NFKC')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu, '')
    .replace(/\s{2,}/g, ' ').trim();
}

function smsPrimeiroNome(nome) {
  return smsSemEmoji(nome).split(/\s+/).find(w => /[A-Za-zÀ-ÿ]/.test(w)) || '';
}

// Nome do grupo onde a compra foi feita (só se for mesmo um nome, não um número ou id)
function smsNomeGrupoLimpo(nomeGrupo) {
  const g = String(nomeGrupo || '');
  if (!g || g.includes('@') || !/[A-Za-zÀ-ÿ]/.test(g)) return '';
  return smsSemEmoji(g).slice(0, 40);
}

function smsRender(tpl, vars) {
  return String(tpl)
    .replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m))
    .replace(/\s+([!,.?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function smsFmtMB(mb) {
  const n = Number(mb) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}GB` : `${n}MB`;
}

// Todos os clientes (compras finalizadas) com dias desde a última compra (fuso de Maputo)
// Envia por SMS a mensagem de uma compra (já simplificada) e deixa no log o que aconteceu
async function smsEnviarCompra(destino, texto, ref) {
  let sms = '';
  try { sms = smsMensagemSimples(texto); } catch (e) { sms = String(texto || '').replace(/[*_━]/g, '').slice(0, 300); console.error('[SMS compra] erro a simplificar:', e && e.message); }
  if (!sms) { console.log(`[SMS compra] ${ref || ''} mensagem interna não enviada ao cliente: ${String(texto).slice(0, 50).replace(/\n/g, ' ')}...`); return false; }
  const ok = await enviarSMS(destino, sms);
  console.log(`[SMS compra] ${ref || ''} para ${destino}: ${ok === false ? 'FALHOU' : 'enviado'} -> ${sms.slice(0, 70)}`);
  return ok !== false ? sms : false;
}

// ---- Mensagens de compra por SMS: curtas e simples (as do WhatsApp têm caixas, emojis, @menções e muito texto) ----
// Devolve '' quando a mensagem não deve ser enviada ao cliente por SMS (avisos internos, ranking, troca de SIM...).
function smsMensagemSimples(texto) {
  const t = String(texto || '');
  const pega = (re) => { const m = t.match(re); return m ? m[1].trim() : ''; };
  const numero = pega(/N[úu]mero:?\*?\s*:?\s*(\d{9})/i);
  const pm = t.match(/(?:Pacote|Megas):?\*?\s*:?\s*([\d.,]+)\s*(GB|MB)/i);
  const pacote = pm ? smsFmtMB(Math.round(parseFloat(pm[1].replace(',', '.')) * (/gb/i.test(pm[2]) ? 1024 : 1))) : '';
  const para = numero ? ` para ${numero}` : '';

  // avisos internos (troca de telefone/SIM, limites): o cliente não precisa de saber
  if (/Alternando|TENTANDO \*|SEM CAPACIDADE|ATINGIDO|INDISPON[ÍI]VEL|SALDO \*.*INSUFICIENTE/i.test(t)) return '';
  // texto do ranking de grupo ("comprador nº X", "Rumo ao topo")
  if (/comprador n[ºo]|Rumo ao topo|compras? hoje|primeira compra do dia/i.test(t)) return '';

  if (/TRANSFER[ÊE]NCIA CONCLU[ÍI]DA/i.test(t)) {
    return `Megas enviados${pacote ? ': ' + pacote : ''}${para}. Obrigado pela preferencia! Megas Express.`;
  }
  if (/PEDIDO EM PROCESSAMENTO|Envio em processamento/i.test(t)) {
    return `Pedido recebido${pacote ? ': ' + pacote : ''}${para}. Estamos a processar, aguarde alguns minutos.`;
  }
  if (/Comprovante processado/i.test(t)) {
    const megas = pega(/Megas dispon[íi]veis:\s*([^\n]+)/i);
    return `Comprovativo recebido!${megas ? ' Tem ' + megas.replace(/[*_]/g, '') + ' por enviar.' : ''} Responda so com o numero que vai receber os megas (84 ou 85...).`;
  }
  if (/j[áa] foi (usado|processado)/i.test(t)) {
    return 'Este comprovativo ja foi usado. Se acha que e engano, responda ATENDENTE.';
  }
  if (/n[ãa]o coincide/i.test(t)) {
    return 'O valor do comprovativo nao coincide com o registado. Uma pessoa vai verificar. Responda ATENDENTE se precisar.';
  }
  if (/nenhum pacote correspondente/i.test(t)) {
    return 'Nao existe pacote para esse valor. Responda TABELA para ver os pacotes.';
  }
  if (/FALHA|ERRO|ocorreu um erro|invalidado|n[ãa]o foi conclu/i.test(t)) {
    return 'Houve um problema com o seu pedido. Uma pessoa vai verificar e responder em breve.';
  }

  // qualquer outra: limpar formatação do WhatsApp
  return t
    .replace(/[━─═_]{3,}/g, ' ')
    .replace(/Adm marcado[^\n]*/gi, '')
    .replace(/_Detalhes:[^\n]*/gi, '')
    .replace(/@\d+/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 320);
}

// ---- Ranking: compras por SMS contam nos mesmos grupos onde a pessoa já está no ranking ----
// Devolve [{ grupo, chave, nome }] com as entradas do ranking que pertencem a este número.
function rankingEntradasDoNumero(num258) {
  const n = smsNormalizar(num258);
  if (!n) return [];
  // todas as formas como esta pessoa já apareceu nos pedidos (número, @lid, jid...)
  const ids = new Set([n, n.slice(3), `${n}@s.whatsapp.net`]);
  for (const p of lerPedidos()) {
    if (numeroDoComprador(p) !== n) continue;
    if (p.numeroComprador) ids.add(String(p.numeroComprador));
    if (p.participant) ids.add(String(p.participant));
  }
  const achadas = [];
  let ranking = {};
  try { ranking = lerRanking() || {}; } catch (e) { return []; }
  for (const [grupo, membros] of Object.entries(ranking)) {
    if (!String(grupo).includes('@g.us')) continue;
    for (const [chave, info] of Object.entries(membros || {})) {
      if (ids.has(chave) || smsNormalizar(chave) === n) {
        achadas.push({ grupo, chave, nome: (info && info.nome) || '' });
        break;
      }
    }
  }
  return achadas;
}

// ---- Nomes vistos nos grupos do WhatsApp (número 258xxxxxxxxx -> nome) ----
const NOMES_FILE = path.join(dataDir, 'nomes_contactos.json');
let nomesCache = null;
const temLetras = (x) => /[A-Za-zÀ-ÿ]/.test(String(x || ''));

function nomesLer() {
  if (!nomesCache) nomesCache = smsLerJSON(NOMES_FILE, {});
  return nomesCache;
}

function nomeRegistar(num, nome) {
  try {
    const n = smsNormalizar(num);
    const nm = String(nome || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!n || !temLetras(nm)) return;
    const mapa = nomesLer();
    if (mapa[n] === nm) return;
    mapa[n] = nm;
    fs.writeFileSync(NOMES_FILE, JSON.stringify(mapa));
  } catch (e) { /* guardar o nome nunca pode atrapalhar uma mensagem */ }
}

// Nome conhecido de um número: 1º o do WhatsApp (grupos), depois o de pedidos antigos (só se tiver letras)
function nomesMapa() {
  const mapa = {};
  for (const p of lerPedidos()) {
    const n = numeroDoComprador(p);
    if (n && temLetras(p.cliente)) mapa[n] = p.cliente;
  }
  return Object.assign(mapa, nomesLer());
}

function smsNomeDe(num) {
  return nomesMapa()[smsNormalizar(num)] || '';
}

function smsListarClientes() {
  const diaM = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Maputo' }); // AAAA-MM-DD
  const paraUTC = (str) => { const [a, m, d] = str.split('-').map(Number); return Date.UTC(a, m - 1, d); };
  const hoje = paraUTC(diaM(new Date()));

  const mapa = {};
  for (const p of lerPedidos()) {
    if (p.status !== 'finalizado') continue;
    const dRef = p.dataFinalizacao || p.dataCriacao;
    if (!dRef || isNaN(new Date(dRef).getTime())) continue;
    const chave = p.numeroComprador || p.participant || p.numero || p.cliente;
    if (!chave) continue;
    if (!mapa[chave]) {
      mapa[chave] = { chave, nome: p.cliente || String(chave), numero: '', totalCompras: 0, totalGasto: 0, ultima: null, ultimoDestino: '' };
    }
    const c = mapa[chave];
    c.totalCompras += 1;
    c.totalGasto += Number(p.valor) || 0;
    const dt = new Date(dRef);
    if (!c.ultima || dt > c.ultima) {
      c.ultima = dt;
      c.nome = p.cliente || c.nome;
      c.ultimoDestino = p.numero || '';
      c.numero = numeroDoComprador(p) || c.numero;
    } else if (!c.numero) {
      c.numero = numeroDoComprador(p);
    }
  }

  const nomesWA = nomesMapa();
  return Object.values(mapa).map(c => ({
    chave: c.chave,
    nome: nomesWA[c.numero] || c.nome,
    numero: c.numero,
    ultimoDestino: c.ultimoDestino,
    dias: Math.round((hoje - paraUTC(diaM(c.ultima))) / 86400000),
    ultima: c.ultima,
    totalCompras: c.totalCompras,
    totalGasto: c.totalGasto
  }));
}

// ---------- SMS EM MASSA ----------
// inativos7 / inativos15: última compra há 7 / 15 dias ou mais · ativos: compraram nos últimos 7 dias
function smsDestinatarios(segmento) {
  const cfg = lerConfigGlobal();
  const cooldownDias = Number(cfg.smsMassaCooldownDias) > 0 ? Number(cfg.smsMassaCooldownDias) : 3;
  const hist = smsLerJSON(SMS_MASSA_HIST_FILE, {});
  const agora = Date.now();
  let semNumero = 0, recentes = 0;
  const vistos = new Set();
  const lista = [];

  const clientes = smsListarClientes().sort((a, b) => b.totalGasto - a.totalGasto || a.dias - b.dias);
  for (const c of clientes) {
    const entra = segmento === 'inativos7' ? c.dias >= 7
      : segmento === 'inativos15' ? c.dias >= 15
      : c.dias < 7;
    if (!entra) continue;
    if (!c.numero) { semNumero++; continue; }
    if (vistos.has(c.numero)) continue;
    vistos.add(c.numero);
    const ult = Date.parse(hist[c.numero] || '');
    if (ult && agora - ult < cooldownDias * 86400000) { recentes++; continue; }
    lista.push({ numero: c.numero, nome: c.nome, dias: c.dias, totalCompras: c.totalCompras, totalGasto: c.totalGasto });
  }
  return { destinatarios: lista.slice(0, 100), totalElegiveis: lista.length, semNumero, recentes, cooldownDias };
}

let smsMassaJob = null;

function smsMassaEstado() {
  if (!smsMassaJob) return null;
  const j = smsMassaJob;
  return {
    id: j.id, segmento: j.segmento, estado: j.estado, total: j.total,
    enviados: j.enviados, falhas: j.falhas,
    restantes: Math.max(j.total - j.enviados - j.falhas, 0),
    iniciadoEm: j.iniciadoEm, fim: j.fim || null,
    ultimoErro: j.ultimoErro || '', aEsperarFila: !!j.aEsperarFila
  };
}

// Dá prioridade aos pedidos: espera (até 60s por SMS) enquanto o telefone está a tratar de pedidos
async function smsAguardarFilaLivre(job) {
  for (let i = 0; i < 30 && job.estado === 'enviando'; i++) {
    const autoLigada = lerConfigGlobal().vendaAutomaticaLigada !== false;
    const ocupado = lerPedidos().some(p =>
      p.status === 'processando' || p.status === 'processado' || (autoLigada && p.status === 'pendente'));
    job.aEsperarFila = ocupado;
    if (!ocupado) return;
    await smsDormir(2000);
  }
  job.aEsperarFila = false;
}

async function smsMassaExecutar(job) {
  const pausaSeg = Math.min(Math.max(Number(lerConfigGlobal().smsMassaPausaSeg ?? 6) || 6, 2), 60);
  console.log(`[SMS massa] A enviar ${job.total} SMS (${job.segmento}), pausa ${pausaSeg}s`);
  for (const d of job.fila) {
    if (job.estado !== 'enviando') break;
    await smsAguardarFilaLivre(job);
    if (job.estado !== 'enviando') break;

    const texto = smsRender(job.mensagem, { nome: smsPrimeiroNome(d.nome), dias: d.dias });
    try {
      const ok = await enviarSMS(smsParaEnvio(d.numero), texto);
      if (ok === false) throw new Error('o envio falhou (ver logs e data/sms_enviados.txt)');
      job.enviados++;
      smsConversaRegistar(d.numero, 'out', texto, 'massa', { soSeExistir: true });
      const hist = smsLerJSON(SMS_MASSA_HIST_FILE, {});
      hist[d.numero] = new Date().toISOString();
      smsSalvarJSON(SMS_MASSA_HIST_FILE, hist);
    } catch (e) {
      job.falhas++;
      job.ultimoErro = String(e && e.message || e).slice(0, 120);
      console.error('[SMS massa] Falha ao enviar:', job.ultimoErro);
    }
    await smsDormir(pausaSeg * 1000);
  }
  if (job.estado === 'enviando') job.estado = 'concluido';
  job.fim = new Date().toISOString();
  console.log(`[SMS massa] Terminado (${job.estado}): ${job.enviados} enviados, ${job.falhas} falhas`);
}

// GET /api/sms-massa?segmento=inativos7|inativos15|ativos
//   -> { segmento, job, destinatarios:[{numero,nome,dias,totalCompras,totalGasto}], totalElegiveis, semNumero, recentes, cooldownDias }
// POST /api/sms-massa -> { pin, acao:'iniciar', segmento, mensagem, excluir:[numeros] }  |  { acao:'parar' }
app.get('/api/sms-massa', (req, res) => {
  try {
    const segmento = SMS_SEGMENTOS.includes(req.query.segmento) ? req.query.segmento : 'inativos7';
    res.json({ segmento, job: smsMassaEstado(), ...smsDestinatarios(segmento) });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/sms-massa:', err);
    res.status(500).json({ erro: 'falha ao preparar o SMS em massa' });
  }
});

app.post('/api/sms-massa', (req, res) => {
  try {
    const { pin, acao, segmento, mensagem, excluir } = req.body || {};

    if (acao === 'parar') {
      if (smsMassaJob && smsMassaJob.estado === 'enviando') {
        smsMassaJob.estado = 'parado';
        console.log('[SMS massa] Parado pelo painel');
      }
      return res.json({ ok: true });
    }

    if (pin !== PIN_PEDIDO_MANUAL) return res.status(403).json({ erro: 'PIN incorreto' });
    if (acao !== 'iniciar') return res.status(400).json({ erro: 'ação inválida' });
    if (smsMassaJob && smsMassaJob.estado === 'enviando') {
      return res.status(409).json({ erro: 'já há um envio em curso' });
    }
    if (gruposAvisoJob && gruposAvisoJob.estado === 'enviando' && gruposAvisoJob.canal === 'sms') {
      return res.status(409).json({ erro: 'há um aviso aos grupos por SMS em curso: espera que acabe' });
    }
    if (!SMS_SEGMENTOS.includes(segmento)) return res.status(400).json({ erro: 'segmento inválido' });

    const texto = String(mensagem || '').trim();
    if (!texto || texto.length > 320) return res.status(400).json({ erro: 'a mensagem tem de ter entre 1 e 320 caracteres' });

    const excl = new Set(Array.isArray(excluir) ? excluir.map(String) : []);
    const fila = smsDestinatarios(segmento).destinatarios.filter(d => !excl.has(d.numero));
    if (!fila.length) return res.status(400).json({ erro: 'não há clientes para enviar' });

    smsMassaJob = {
      id: `SMS-${Date.now()}`, segmento, mensagem: texto, fila,
      total: fila.length, enviados: 0, falhas: 0, estado: 'enviando',
      iniciadoEm: new Date().toISOString(), fim: null, ultimoErro: '', aEsperarFila: false
    };
    smsMassaExecutar(smsMassaJob).catch(e => {
      console.error('[SMS massa] Erro inesperado:', e);
      if (smsMassaJob) { smsMassaJob.estado = 'parado'; smsMassaJob.ultimoErro = String(e && e.message || e).slice(0, 120); }
    });
    res.json({ ok: true, total: fila.length });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/sms-massa:', err);
    res.status(500).json({ erro: 'falha ao iniciar o envio' });
  }
});

// ---------- AVISO DE EXPIRAÇÃO POR SMS ----------
// Quando faltar `avisoMinutos` para os megas expirarem (compra + `validadeHoras`), manda SMS ao COMPRADOR.
// Lê os pedidos finalizados (não depende de registos à parte) e guarda o que já avisou em sms_expiracao.json.
function smsExpiracaoConfig() {
  const c = lerConfigGlobal().smsExpiracao || {};
  const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : def; };
  let validadeHoras = num(c.validadeHoras, 1, 720, 24);
  let avisoMinutos = num(c.avisoMinutos, 5, 720, 60);
  if (avisoMinutos >= validadeHoras * 60) avisoMinutos = Math.min(60, validadeHoras * 60 - 1);
  return {
    ativo: c.ativo === true, // desligado até alguém ligar no painel
    validadeHoras,
    avisoMinutos,
    mensagem: (typeof c.mensagem === 'string' && c.mensagem.trim()) ? c.mensagem.trim().slice(0, 320) : SMS_EXPIRACAO_MSG_PADRAO
  };
}

// Compras ainda dentro da validade, com a hora do aviso e do fim
function smsExpiracaoCandidatos(cfg, agora, log) {
  const validadeMs = cfg.validadeHoras * 3600 * 1000;
  const avisoMs = cfg.avisoMinutos * 60 * 1000;
  const out = [];
  for (const p of lerPedidos()) {
    if (p.status !== 'finalizado' || !p.pedidoId) continue;
    const t = Date.parse(p.dataFinalizacao || '');
    if (!t) continue;
    const expira = t + validadeMs;
    if (expira <= agora) continue;
    out.push({
      id: p.pedidoId,
      numero: numeroDoComprador(p),
      nome: p.cliente || '',
      grupo: p.nomeGrupo || '',
      destino: String(p.numero || '').replace(/\D/g, '').slice(-9),
      mb: Number(p.quantidadeMB) || 0,
      expira,
      avisarEm: expira - avisoMs,
      reg: log[p.pedidoId] || null
    });
  }
  // Se o mesmo número recebeu megas mais de uma vez, só conta a compra mais recente (o aviso é atualizado, não repetido)
  const maisRecente = {};
  for (const c of out) {
    if (c.destino.length === 9 && (!maisRecente[c.destino] || c.expira > maisRecente[c.destino].expira)) maisRecente[c.destino] = c;
  }
  return out.filter(c => c.destino.length !== 9 || maisRecente[c.destino] === c);
}

const smsHoraMaputo = (ms) => new Date(ms).toLocaleTimeString('pt-MZ', { timeZone: 'Africa/Maputo', hour: '2-digit', minute: '2-digit' });

let smsExpiracaoOcupado = false;
async function smsExpiracaoTick() {
  if (smsExpiracaoOcupado) return;
  smsExpiracaoOcupado = true;
  try {
    const cfg = smsExpiracaoConfig();
    if (!cfg.ativo) return;

    const agora = Date.now();
    const log = smsLerJSON(SMS_EXPIRACAO_FILE, {});
    let mudou = false;

    // pendentes: ainda sem aviso e com menos de 3 tentativas
    const pend = [];
    for (const c of smsExpiracaoCandidatos(cfg, agora, log)) {
      if (c.reg && (c.reg.estado === 'enviado' || c.reg.estado === 'sem-numero' || (c.reg.tentativas || 0) >= 3)) continue;
      if (!c.numero) { log[c.id] = { estado: 'sem-numero', em: new Date().toISOString() }; mudou = true; continue; }
      if (c.avisarEm > agora + 15 * 60 * 1000) continue; // longe demais
      pend.push(c);
    }

    // um SMS por comprador: junta compras que vencem quase juntas (até 15 min de diferença)
    const porNumero = {};
    for (const c of pend) (porNumero[c.numero] = porNumero[c.numero] || []).push(c);

    let enviadosNesteCiclo = 0;
    for (const [numero, itens] of Object.entries(porNumero)) {
      if (!itens.some(i => i.avisarEm <= agora)) continue; // nenhuma está na hora ainda
      if (enviadosNesteCiclo >= 8) break;                  // evita rajadas (o resto fica para o próximo minuto)

      const mbTotal = itens.reduce((a, i) => a + i.mb, 0);
      const primeiraExpira = Math.min(...itens.map(i => i.expira));
      // nome do grupo: o da própria compra; se foi por SMS, o do último grupo de WhatsApp onde esta pessoa comprou
      let grupoNome = '';
      for (const i of itens) { grupoNome = smsNomeGrupoLimpo(i.grupo); if (grupoNome) break; }
      if (!grupoNome) {
        const antigos = lerPedidos()
          .filter(p => numeroDoComprador(p) === numero && String(p.grupo || '').includes('@') && smsNomeGrupoLimpo(p.nomeGrupo))
          .sort((a, b) => Date.parse(b.dataCriacao || 0) - Date.parse(a.dataCriacao || 0));
        if (antigos[0]) grupoNome = smsNomeGrupoLimpo(antigos[0].nomeGrupo);
      }
      const destinos = [...new Set(itens.map(i => i.destino).filter(d => d.length === 9))];
      const numerosTxt = destinos.slice(0, 3).join(', ') + (destinos.length > 3 ? ' e outros' : '');
      const nomeCli = smsPrimeiroNome(smsNomeDe(numero) || itens[0].nome);
      const semAc = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // acentos tornam o SMS mais caro
      let modelo = cfg.mensagem;
      if (!destinos.length) modelo = modelo.replace(/\s*para\s+(?:o\s+)?\{numero\}/gi, '');
      if (!grupoNome) modelo = modelo.replace(/\s*(?:no|do|em)\s+grupo\s+\{grupo\}|\s*\{grupo\}/gi, '');
      const texto = smsRender(modelo, {
        mb: smsFmtMB(mbTotal),
        hora: smsHoraMaputo(primeiraExpira).replace(':', 'h'),
        nome: semAc(nomeCli),
        grupo: semAc(grupoNome),
        numero: numerosTxt
      }).replace(/^(\S+)\s*,/, '$1,').replace(/^Ola\s*,/i, 'Ola,');

      try {
        const ok = await enviarSMS(smsParaEnvio(numero), texto);
        if (ok === false) throw new Error('o envio falhou (ver data/sms_enviados.txt)');
        const em = new Date().toISOString();
        for (const i of itens) log[i.id] = { estado: 'enviado', numero, em };
        smsConversaRegistar(numero, 'out', texto, 'aviso', { soSeExistir: true });
        console.log(`[SMS expiração] Aviso enviado a ${numero} (${smsFmtMB(mbTotal)}, expira ${smsHoraMaputo(primeiraExpira)})`);
      } catch (e) {
        for (const i of itens) {
          const t = ((log[i.id] && log[i.id].tentativas) || 0) + 1;
          log[i.id] = { estado: 'erro', numero, em: new Date().toISOString(), tentativas: t };
        }
        console.error('[SMS expiração] Falha ao avisar', numero, '-', e && e.message || e);
      }
      mudou = true;
      enviadosNesteCiclo++;
      await smsDormir(4000);
    }

    if (mudou) {
      // limpa registos com mais de 3 dias
      const limite = agora - 3 * 86400000;
      for (const k of Object.keys(log)) {
        if (Date.parse(log[k].em || '') < limite) delete log[k];
      }
      smsSalvarJSON(SMS_EXPIRACAO_FILE, log);
    }
  } finally {
    smsExpiracaoOcupado = false;
  }
}
setInterval(() => {
  smsExpiracaoTick().catch(e => console.error('[SMS expiração] Erro:', e && e.message || e));
}, 60 * 1000);

// GET /api/sms-expiracao -> { ativo, validadeHoras, avisoMinutos, mensagem, proximos:[...], enviadosHoje, semNumero }
// POST /api/sms-expiracao -> { pin, ativo?, validadeHoras?, avisoMinutos?, mensagem? }
app.get('/api/sms-expiracao', (req, res) => {
  try {
    const cfg = smsExpiracaoConfig();
    const agora = Date.now();
    const log = smsLerJSON(SMS_EXPIRACAO_FILE, {});
    const cands = smsExpiracaoCandidatos(cfg, agora, log);
    const hojeStr = diaMaputo(new Date().toISOString());
    const avisosHoje = new Set(
      Object.values(log).filter(r => r.estado === 'enviado' && diaMaputo(r.em) === hojeStr).map(r => `${r.numero}|${r.em}`)
    );
    const txt = (ms) => new Date(ms).toLocaleString('pt-MZ', { timeZone: 'Africa/Maputo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    const proximos = cands
      .filter(c => c.numero && !(c.reg && c.reg.estado === 'enviado'))
      .sort((a, b) => a.avisarEm - b.avisarEm)
      .slice(0, 10)
      .map(c => ({ nome: c.nome || c.numero, mb: c.mb, avisarEm: txt(c.avisarEm), expiraEm: txt(c.expira) }));

    res.json({
      ...cfg,
      proximos,
      enviadosHoje: avisosHoje.size,
      semNumero: cands.filter(c => !c.numero).length
    });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/sms-expiracao:', err);
    res.status(500).json({ erro: 'falha ao ler o aviso de expiração' });
  }
});

app.post('/api/sms-expiracao', (req, res) => {
  try {
    const { pin, ativo, validadeHoras, avisoMinutos, mensagem } = req.body || {};
    if (pin !== PIN_PEDIDO_MANUAL) return res.status(403).json({ erro: 'PIN incorreto' });

    const novo = { ...smsExpiracaoConfig() };
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') return res.status(400).json({ erro: 'ativo precisa ser true ou false' });
      novo.ativo = ativo;
    }
    if (validadeHoras !== undefined) {
      const n = Number(validadeHoras);
      if (!(n >= 1 && n <= 720)) return res.status(400).json({ erro: 'validade entre 1 e 720 horas' });
      novo.validadeHoras = n;
    }
    if (avisoMinutos !== undefined) {
      const n = Number(avisoMinutos);
      if (!(n >= 5 && n <= 720)) return res.status(400).json({ erro: 'aviso entre 5 e 720 minutos' });
      novo.avisoMinutos = n;
    }
    if (mensagem !== undefined) {
      const m = String(mensagem).trim();
      if (!m || m.length > 320) return res.status(400).json({ erro: 'a mensagem tem de ter entre 1 e 320 caracteres' });
      novo.mensagem = m;
    }
    if (novo.avisoMinutos >= novo.validadeHoras * 60) {
      return res.status(400).json({ erro: 'o aviso tem de ser antes do fim da validade' });
    }

    const config = lerConfigGlobal();
    config.smsExpiracao = novo;
    salvarConfigGlobal(config);

    // o aviso novo substitui o lembrete antigo (verificador_expiracao), para o cliente não receber dois SMS
    if (novo.ativo) {
      pararScheduler();
    } else if (globalSocket) {
      iniciarScheduler(); // volta ao lembrete antigo (só corre com o WhatsApp ligado, como antes)
    }
    console.log(`[Painel] Aviso de expiração por SMS ${novo.ativo ? 'LIGADO' : 'DESLIGADO'} (validade ${novo.validadeHoras}h, aviso ${novo.avisoMinutos}min antes)`);
    res.json({ ok: true, ...novo });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/sms-expiracao:', err);
    res.status(500).json({ erro: 'falha ao guardar' });
  }
});

// ==================================================
// 💬 ATENDIMENTO POR SMS (histórico de conversas + respostas automáticas + resposta manual no painel)
// Só conversa com telemóveis de clientes (84/85...). Códigos curtos e operadoras são ignorados.
// ==================================================
const SMS_CONVERSAS_FILE = path.join(dataDir, "sms_conversas.json");
// { "258841234567": { nome, naoLidas, precisaHumano, ultimaEm, mensagens:[{ d:'in'|'out', t, em, o }] } }
// o = origem: cliente | bot | painel | pedido | massa | aviso

function smsAtendimentoConfig() {
  const c = lerConfigGlobal().smsAtendimento || {};
  const lim = Number(c.limiteHora);
  return {
    ativo: c.ativo !== false, // respostas automáticas ligadas por defeito
    limiteHora: Number.isFinite(lim) && lim >= 1 && lim <= 100 ? Math.round(lim) : 10, // respostas automáticas por hora a cada número
    pagamento: typeof c.pagamento === 'string' ? c.pagamento.trim().slice(0, 160) : '', // ex.: "84xxxxxxx (Nome)" -> vai nas respostas de como pagar
    respostas: smsComandosLimpar(c.respostas) // comandos e respostas personalizados (painel → Atendimento SMS → Comandos)
  };
}

// ---------- COMANDOS E RESPOSTAS PERSONALIZADOS ----------
// { id, palavras:['promo','oferta'], modo:'contem'|'exato', resposta:'...', humano:false, ativo:true }
const SMS_COMANDOS_MAX = 50;

function smsNorm(txt) {
  return String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Valida/normaliza a lista (usada ao ler e ao gravar): descarta o que não tem palavras ou resposta
function smsComandosLimpar(lista) {
  if (!Array.isArray(lista)) return [];
  const out = [];
  for (const c of lista) {
    if (!c || typeof c !== 'object') continue;
    const palavras = [...new Set((Array.isArray(c.palavras) ? c.palavras : [])
      .map(p => String(p || '').trim().slice(0, 40)).filter(p => smsNorm(p)))].slice(0, 10);
    const resposta = String(c.resposta || '').trim().slice(0, 320);
    if (!palavras.length || !resposta) continue;
    out.push({
      id: String(c.id || `c${Date.now()}${out.length}`).slice(0, 40),
      palavras,
      modo: c.modo === 'exato' ? 'exato' : 'contem',
      resposta,
      humano: c.humano === true,
      ativo: c.ativo !== false
    });
    if (out.length >= SMS_COMANDOS_MAX) break;
  }
  return out;
}

// Procura o comando que corresponde à mensagem. Se vários servirem, ganha o "exato" e depois a palavra mais longa.
function smsComandoEncontrar(texto) {
  const t = smsNorm(texto);
  if (!t) return null;
  let melhor = null, melhorPontos = -1;
  for (const c of smsAtendimentoConfig().respostas) {
    if (!c.ativo) continue;
    for (const p of c.palavras) {
      const pn = smsNorm(p);
      if (!pn) continue;
      const bate = c.modo === 'exato' ? t === pn : (' ' + t + ' ').includes(' ' + pn + ' ');
      if (!bate) continue;
      const pontos = (c.modo === 'exato' ? 1000 : 0) + pn.length;
      if (pontos > melhorPontos) { melhor = c; melhorPontos = pontos; }
    }
  }
  return melhor;
}

// {nome} -> primeiro nome do cliente (se o bot o conhece) · {pagamento} -> dados de pagamento · {tabela} -> pacotes e preços
function smsComandoRender(c, num) {
  const cfg = smsAtendimentoConfig();
  const vars = {};
  if (/\{nome\}/.test(c.resposta)) {
    vars.nome = smsPrimeiroNome(smsNomeDe(num));
  }
  if (/\{pagamento\}/.test(c.resposta)) vars.pagamento = cfg.pagamento || '';
  if (/\{tabela\}/.test(c.resposta)) vars.tabela = smsTabelaPacotes().map(x => `${smsFmtMB(x.mb)}=${x.preco}MT`).join(', ');
  return smsRender(c.resposta, vars).replace(/\{\w+\}/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function smsConversaRegistar(numero, dir, texto, origem, opts = {}) {
  try {
    if (!numero) return;
    const dados = smsLerJSON(SMS_CONVERSAS_FILE, {});
    let c = dados[numero];
    if (!c) {
      if (opts.soSeExistir) return; // campanhas só entram em conversas que já existem
      c = dados[numero] = { nome: '', naoLidas: 0, precisaHumano: false, ultimaEm: null, mensagens: [] };
    }
    const agora = new Date().toISOString();
    c.mensagens.push({ d: dir, t: String(texto || '').slice(0, 459), em: agora, o: origem });
    if (c.mensagens.length > 300) c.mensagens = c.mensagens.slice(-300);
    c.ultimaEm = agora;

    const chaves = Object.keys(dados);
    if (chaves.length > 500) { // guarda as 500 conversas mais recentes
      chaves.sort((a, b) => String(dados[a].ultimaEm).localeCompare(String(dados[b].ultimaEm)));
      for (const k of chaves.slice(0, chaves.length - 500)) delete dados[k];
    }
    smsSalvarJSON(SMS_CONVERSAS_FILE, dados);
  } catch (e) {
    console.error('[SMS atendimento] Erro ao registar conversa:', e.message);
  }
}

function smsConversaAtualizar(numero, fn) {
  try {
    const dados = smsLerJSON(SMS_CONVERSAS_FILE, {});
    if (!dados[numero]) return;
    fn(dados[numero]);
    smsSalvarJSON(SMS_CONVERSAS_FILE, dados);
  } catch (e) {
    console.error('[SMS atendimento] Erro ao atualizar conversa:', e.message);
  }
}

const SMS_TXT_MENU = "Megas Express. Responda: TABELA (precos), COMPRAR (como comprar), SALDO (megas por enviar), PEDIDO (estado do ultimo pedido) ou ATENDENTE (falar com uma pessoa).";
const SMS_TXT_HUMANO = "Recebemos o seu pedido de atendimento. Uma pessoa vai responder assim que possivel.";
const SMS_TXT_NAO_PERCEBI = "Recebemos a sua mensagem e uma pessoa vai responder em breve. Para ver precos responda TABELA; para comprar, pague por M-Pesa/eMola e envie o comprovativo completo.";
const SMS_TXT_ANTIGO = "Olá! Envie o comprovativo MPesa ou eMola completo para processar o seu pedido."; // resposta de antes

// Tabela de pacotes: 1º a do bot (data/tabela.json, a que valida os comprovativos); senão a colada no painel
function smsTabelaPacotes() {
  const rawBot = smsLerJSON(path.join(dataDir, 'tabela.json'), {});
  let itens = (Array.isArray(rawBot.texto) ? rawBot.texto : []).map(p => ({
    mb: parseInt(String(p.megas || '').replace(/[^\d]/g, ''), 10),
    preco: parseFloat(String(p.valor || '').replace(/[^\d.]/g, ''))
  })).filter(x => x.mb > 0 && x.preco > 0);
  if (!itens.length) {
    const tabelaPainel = lerConfigGlobal().tabelaPacotes || {};
    itens = Object.entries(tabelaPainel)
      .map(([mb, preco]) => ({ mb: Number(mb), preco: Number(preco) }))
      .filter(x => x.mb > 0 && x.preco > 0);
  }
  return itens.sort((a, b) => a.mb - b.mb);
}

// "Pague X por M-Pesa/eMola (para ...) e envie o comprovativo"
function smsComoPagar(preco) {
  const pag = smsAtendimentoConfig().pagamento;
  return `Pague ${preco ? preco + 'MT ' : ''}por M-Pesa/eMola${pag ? ' para ' + pag : ''} e envie o comprovativo completo por SMS. Depois responda so com o numero que vai receber os megas.`;
}

// Decide a resposta automática. Devolve { resposta, humano } (humano = uma pessoa deve ver esta conversa)
function smsAtendimentoResposta(num, texto) {
  // 0) comandos e respostas personalizados (os teus) têm prioridade sobre as respostas de origem
  const cmd = smsComandoEncontrar(texto);
  if (cmd) {
    return { resposta: smsComandoRender(cmd, num), humano: cmd.humano === true, origem: 'comando', comando: cmd.id };
  }

  const base = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // "2.5gb" / "2,5 gb" -> "2dec5gb" para não perder a vírgula do número
  const t = base.replace(/(\d+)[.,](\d+)/g, '$1dec$2').replace(/[^a-z0-9? ]/g, ' ').replace(/\s+/g, ' ').trim();

  // 1) pedido de atendimento humano
  if (/\b(atendente|humano|suporte|operador)\b|\bfalar com\b|quero (uma )?pessoa/.test(t)) {
    return { resposta: SMS_TXT_HUMANO, humano: true };
  }

  // 2) saldo pendente: comprovativo já aceite, falta o número que vai receber os megas
  if (/\bsaldo\b/.test(t)) {
    const fim = num.slice(3);
    const pend = smsLerJSON(path.join(dataDir, 'saldo.json'), []);
    const meus = (Array.isArray(pend) ? pend : []).filter(s => s && String(s.id || '').replace(/\D/g, '').endsWith(fim));
    if (!meus.length) {
      return { resposta: "Nao tem saldo pendente. Para comprar, pague por M-Pesa/eMola e envie o comprovativo completo.", humano: false };
    }
    const total = meus.reduce((a, s) => a + (Number(s.megas) || 0), 0);
    return { resposta: `Tem ${smsFmtMB(total)} por enviar. Responda so com o numero que vai receber os megas (84 ou 85...).`, humano: false };
  }

  // 3) estado do último pedido (reclamações também chamam uma pessoa)
  const reclama = /(nao recebi|nao chegou|nao entrou|ainda nao|demora|problema|erro|reclam)/.test(t);
  const querEstado = t === 'pedido' || /\b(meu|ultimo|estado do|estado da) pedido\b|\b(estado|status|cade|onde esta|meus megas)\b/.test(t);
  if (reclama || querEstado) {
    const meus = lerPedidos()
      .filter(p => numeroDoComprador(p) === num)
      .sort((a, b) => Date.parse(b.dataFinalizacao || b.dataCriacao || 0) - Date.parse(a.dataFinalizacao || a.dataCriacao || 0));
    const p = meus[0];
    if (!p) {
      return { resposta: "Nao encontrei pedidos neste numero. Para comprar, pague por M-Pesa/eMola e envie o comprovativo completo.", humano: reclama };
    }
    const mb = smsFmtMB(p.quantidadeMB);
    const fim = String(p.numero || '').slice(-3);
    const destino = fim ? ` (numero terminado em ${fim})` : '';
    if (p.status === 'finalizado') {
      const quando = new Date(p.dataFinalizacao || p.dataCriacao).toLocaleString('pt-MZ', { timeZone: 'Africa/Maputo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return { resposta: `Ultimo pedido: ${mb}${destino} concluido em ${quando}.${reclama ? ' Uma pessoa vai verificar consigo.' : ''}`, humano: reclama };
    }
    if (p.status === 'falha') {
      return { resposta: `O seu ultimo pedido de ${mb}${destino} nao foi concluido. Uma pessoa vai verificar e responder.`, humano: true };
    }
    return { resposta: `O seu pedido de ${mb}${destino} esta a ser processado. Aguarde alguns minutos.`, humano: reclama };
  }

  // 4) venda de megas: quantidade ("quero 2GB") ou valor ("tenho 50MT")
  const itens = smsTabelaPacotes();
  const mq = t.match(/(\d+)(?:dec(\d+))?\s*(gb|gbs|giga|gigas|gigabytes?)\b/);
  const mm = t.match(/(\d+)\s*(mb|mbs|megabytes?)\b/) || t.match(/\b(\d{3,5})\s*megas?\b/);
  const mv = t.match(/(\d+)(?:dec(\d+))?\s*(mt|mts|mzn|meticais|metical)\b/);
  const pedeMb = mq ? Math.round(parseFloat(mq[1] + '.' + (mq[2] || '0')) * 1024) : (mm ? parseInt(mm[1], 10) : 0);

  if (pedeMb > 0 && itens.length) {
    const exato = itens.find(x => x.mb === pedeMb);
    if (exato) {
      return { resposta: `${smsFmtMB(exato.mb)} custa ${exato.preco}MT. ${smsComoPagar(exato.preco)}`, humano: false };
    }
    const abaixo = itens.filter(x => x.mb < pedeMb).pop();
    const acima = itens.find(x => x.mb > pedeMb);
    const opcoes = [abaixo, acima].filter(Boolean).map(x => `${smsFmtMB(x.mb)} = ${x.preco}MT`).join(' e ');
    return { resposta: `Nao temos ${smsFmtMB(pedeMb)} exatos. ${opcoes ? 'Temos ' + opcoes + '. ' : ''}Responda TABELA para ver todos os pacotes.`, humano: false };
  }

  if (mv && itens.length) {
    const valor = parseFloat(mv[1] + '.' + (mv[2] || '0'));
    const cabem = itens.filter(x => x.preco <= valor);
    if (cabem.length) {
      const melhor = cabem[cabem.length - 1];
      return { resposta: `Com ${valor}MT pode comprar ${smsFmtMB(melhor.mb)} (custa ${melhor.preco}MT). ${smsComoPagar(melhor.preco)}`, humano: false };
    }
    const barato = itens.slice().sort((a, b) => a.preco - b.preco)[0];
    return { resposta: `O pacote mais barato e ${smsFmtMB(barato.mb)} por ${barato.preco}MT. Responda TABELA para ver todos.`, humano: false };
  }

  // 5) tabela de preços
  if (/\b(tabela|preco|precos|pacote|pacotes|valor|valores|quanto custa|quanto e|promocao|promocoes)\b/.test(t)) {
    const linhas = itens.map(x => `${smsFmtMB(x.mb)} = ${x.preco}MT`);
    if (!linhas.length) {
      return { resposta: "A tabela ainda nao esta disponivel. Uma pessoa vai responder em breve.", humano: true };
    }
    let corpo = 'Tabela Megas Express:';
    let cortou = false;
    for (const l of linhas) {
      if ((corpo + '\n' + l).length > 330) { cortou = true; break; }
      corpo += '\n' + l;
    }
    corpo += cortou ? '\nMais pacotes: responda ATENDENTE.' : '\nPague por M-Pesa/eMola e envie o comprovativo completo.';
    return { resposta: corpo, humano: false };
  }

  // 6) como pagar / como comprar / quero megas
  const comoPagar = /(como (pagar|pago|se paga|compro|comprar)|onde (pago|compro)|para onde|numero (para|de) pag|\bconta\b|mpesa|m pesa|emola|e mola|mkesh|transferir|transferencia|pagamento|\bpagar\b)/.test(t);
  const venda = /\b(comprar|compra|compro|quero|queria|preciso|gostaria|vendem|vende|vendes|megas|mega|gb|giga|gigas|internet|dados|recarga|recarregar|ativar|activar|enviar|mandar|barato|desconto)\b/.test(t);
  if (comoPagar || venda) {
    const pag = smsAtendimentoConfig().pagamento;
    if (comoPagar && !pag) {
      return { resposta: "Vou pedir a uma pessoa para lhe enviar os dados de pagamento. Enquanto isso, responda TABELA para ver os precos.", humano: true };
    }
    const passos = `1) Responda TABELA e escolha o pacote. 2) Pague por M-Pesa/eMola${pag ? ' para ' + pag : ''}. 3) Envie o comprovativo completo por SMS. 4) Responda so com o numero que vai receber os megas.`;
    return { resposta: (comoPagar ? 'Como comprar: ' : 'Temos sim! ') + passos, humano: false };
  }

  // 7) agradecimento
  if (/\b(obrigad[oa]|obg|valeu|agradeco)\b/.test(t)) {
    return { resposta: "De nada! Estamos sempre aqui para ajudar. Megas Express.", humano: false };
  }

  // 8) menu / saudação
  if (/^(menu|ajuda|oi|ola|bom dia|boa tarde|boa noite|\?)$/.test(t) || t.length <= 3) {
    return { resposta: SMS_TXT_MENU, humano: false };
  }

  // 9) não deu para perceber -> uma pessoa deve ver (o cliente fica a saber que vão responder)
  return { resposta: SMS_TXT_NAO_PERCEBI, humano: true };
}

// Chamado pelo /entrada quando o SMS NÃO era um comprovativo nem um número (ou seja, é conversa)
async function smsAtendimentoTratar(num, fromRaw, texto) {
  if (!num) {
    console.log('[SMS atendimento] Remetente não é um telemóvel de cliente, sem resposta:', fromRaw);
    return;
  }

  const cfg = smsAtendimentoConfig();
  let resposta, humano;
  if (!cfg.ativo) {
    resposta = SMS_TXT_ANTIGO; // respostas automáticas desligadas: comportamento de antes
    humano = true;
  } else {
    ({ resposta, humano } = smsAtendimentoResposta(num, texto));
  }

  // trava contra repetições (ex.: outro robô a responder): máximo de respostas do bot por hora a cada número (configurável no painel)
  const dados = smsLerJSON(SMS_CONVERSAS_FILE, {});
  const recentes = ((dados[num] && dados[num].mensagens) || [])
    .filter(m => m.d === 'out' && m.o === 'bot' && Date.now() - Date.parse(m.em) < 3600000).length;

  if (recentes < cfg.limiteHora) {
    try {
      const ok = await enviarSMS(fromRaw, resposta);
      if (ok !== false) smsConversaRegistar(num, 'out', resposta, 'bot');
      else console.error('[SMS atendimento] Falhou o envio da resposta automática a', num);
    } catch (e) {
      console.error('[SMS atendimento] Erro ao responder:', e.message);
    }
  } else {
    console.log(`[SMS atendimento] Limite de ${cfg.limiteHora} respostas automáticas por hora atingido para`, num, '(muda no painel: Atendimento SMS)');
    humano = true;
  }

  if (humano) {
    smsConversaAtualizar(num, c => { c.naoLidas = (c.naoLidas || 0) + 1; c.precisaHumano = true; });
    try {
      await enviarNotificacaoPush('💬 SMS de cliente', `${num.slice(3)}: ${String(texto).slice(0, 80)}`, 'sms-atendimento');
    } catch (e) { /* o push é só um aviso */ }
  }
}

// GET /api/sms-conversas?resumo=1        -> { naoLidas }            (conversas que precisam de resposta)
// GET /api/sms-conversas                 -> { ativo, naoLidas, conversas:[{ numero, nome, ultima, ultimaDir, quando, naoLidas, precisaHumano }] }
// GET /api/sms-conversas?numero=258...   -> { numero, nome, precisaHumano, mensagens:[{ d, t, o, quando }] }
// POST /api/sms-conversas -> { acao:'ler', numero } | { pin, acao:'responder', numero, texto }
//                            | { pin, acao:'config', ativo } | { pin, acao:'apagar', numero }
app.get('/api/sms-conversas', (req, res) => {
  try {
    const dados = smsLerJSON(SMS_CONVERSAS_FILE, {});
    const precisam = Object.values(dados).filter(c => c.precisaHumano && (c.naoLidas || 0) > 0).length;

    if (req.query.resumo) return res.json({ naoLidas: precisam });

    // Testar uma mensagem: mostra a resposta que o bot daria, sem enviar nada nem guardar nada
    if (req.query.testar !== undefined) {
      const msg = String(req.query.testar || '').slice(0, 300);
      if (!msg.trim()) return res.status(400).json({ erro: 'escreve uma mensagem para testar' });
      const r = smsAtendimentoResposta('258000000000', msg); // número fictício: não mostra dados de ninguém
      return res.json({ resposta: r.resposta, humano: !!r.humano, origem: r.origem || 'automatico' });
    }

    const nomes = {};
    Object.assign(nomes, nomesMapa());
    const quando = (iso) => new Date(iso).toLocaleString('pt-MZ', { timeZone: 'Africa/Maputo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    const numero = smsNormalizar(req.query.numero);
    if (req.query.numero) {
      const c = dados[numero];
      if (!c) return res.status(404).json({ erro: 'conversa não encontrada' });
      return res.json({
        numero,
        nome: nomes[numero] || c.nome || '',
        precisaHumano: !!c.precisaHumano,
        mensagens: c.mensagens.slice(-150).map(m => ({ d: m.d, t: m.t, o: m.o, quando: quando(m.em) }))
      });
    }

    const conversas = Object.entries(dados)
      .sort((a, b) => String(b[1].ultimaEm).localeCompare(String(a[1].ultimaEm)))
      .slice(0, 200)
      .map(([n, c]) => {
        const ult = c.mensagens[c.mensagens.length - 1] || {};
        return {
          numero: n,
          nome: nomes[n] || c.nome || '',
          ultima: String(ult.t || '').slice(0, 80),
          ultimaDir: ult.d || '',
          quando: c.ultimaEm ? quando(c.ultimaEm) : '',
          naoLidas: c.naoLidas || 0,
          precisaHumano: !!c.precisaHumano
        };
      });
    const cfgAt = smsAtendimentoConfig();
    res.json({ ativo: cfgAt.ativo, limiteHora: cfgAt.limiteHora, pagamento: cfgAt.pagamento, respostas: cfgAt.respostas, naoLidas: precisam, conversas });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/sms-conversas:', err);
    res.status(500).json({ erro: 'falha ao ler as conversas' });
  }
});

app.post('/api/sms-conversas', async (req, res) => {
  try {
    const { pin, acao, numero, texto, ativo } = req.body || {};

    if (acao === 'ler') { // marcar como lida não precisa de PIN
      const n = smsNormalizar(numero);
      if (!n) return res.status(400).json({ erro: 'número inválido' });
      smsConversaAtualizar(n, c => { c.naoLidas = 0; c.precisaHumano = false; });
      return res.json({ ok: true });
    }

    if (pin !== PIN_PEDIDO_MANUAL) return res.status(403).json({ erro: 'PIN incorreto' });

    if (acao === 'config') {
      if (typeof ativo !== 'boolean') return res.status(400).json({ erro: 'ativo precisa ser true ou false' });
      const novo = { ...smsAtendimentoConfig(), ativo };
      if (req.body.limiteHora !== undefined) {
        const lim = Number(req.body.limiteHora);
        if (!(lim >= 1 && lim <= 100)) return res.status(400).json({ erro: 'o limite por hora tem de ser entre 1 e 100' });
        novo.limiteHora = Math.round(lim);
      }
      if (req.body.pagamento !== undefined) {
        const pag = String(req.body.pagamento || '').trim();
        if (pag.length > 160) return res.status(400).json({ erro: 'os dados de pagamento têm no máximo 160 caracteres' });
        novo.pagamento = pag;
      }
      const config = lerConfigGlobal();
      config.smsAtendimento = novo;
      salvarConfigGlobal(config);
      console.log(`[Painel] Respostas automáticas por SMS ${ativo ? 'LIGADAS' : 'DESLIGADAS'} (limite ${novo.limiteHora}/hora por número)`);
      return res.json({ ok: true, ...novo });
    }

    if (acao === 'respostas') {
      const bruta = req.body.respostas;
      if (!Array.isArray(bruta)) return res.status(400).json({ erro: 'respostas tem de ser uma lista' });
      if (bruta.length > SMS_COMANDOS_MAX) return res.status(400).json({ erro: `no máximo ${SMS_COMANDOS_MAX} comandos` });
      for (const c of bruta) {
        const ps = (Array.isArray(c && c.palavras) ? c.palavras : []).filter(p => smsNorm(p));
        if (!ps.length) return res.status(400).json({ erro: 'cada comando precisa de pelo menos uma palavra (letras ou números)' });
        if (!String((c && c.resposta) || '').trim()) return res.status(400).json({ erro: 'cada comando precisa de uma resposta' });
        if (String(c.resposta).trim().length > 320) return res.status(400).json({ erro: 'a resposta tem no máximo 320 caracteres' });
      }
      const limpa = smsComandosLimpar(bruta);
      const config = lerConfigGlobal();
      config.smsAtendimento = { ...smsAtendimentoConfig(), respostas: limpa };
      salvarConfigGlobal(config);
      console.log(`[Painel] Comandos de atendimento SMS guardados: ${limpa.length}`);
      return res.json({ ok: true, respostas: limpa });
    }

    const n = smsNormalizar(numero);
    if (!n) return res.status(400).json({ erro: 'número inválido' });

    if (acao === 'apagar') {
      const dados = smsLerJSON(SMS_CONVERSAS_FILE, {});
      if (!dados[n]) return res.status(404).json({ erro: 'conversa não encontrada' });
      delete dados[n];
      smsSalvarJSON(SMS_CONVERSAS_FILE, dados);
      return res.json({ ok: true });
    }

    if (acao === 'responder') {
      const msg = String(texto || '').trim();
      if (!msg || msg.length > 320) return res.status(400).json({ erro: 'a mensagem tem de ter entre 1 e 320 caracteres' });
      const ok = await enviarSMS(smsParaEnvio(n), msg);
      if (ok === false) return res.status(502).json({ erro: 'o envio falhou (ver data/sms_enviados.txt)' });
      smsConversaRegistar(n, 'out', msg, 'painel');
      smsConversaAtualizar(n, c => { c.naoLidas = 0; c.precisaHumano = false; });
      return res.json({ ok: true });
    }

    res.status(400).json({ erro: 'ação inválida' });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/sms-conversas:', err);
    res.status(500).json({ erro: 'falha na operação' });
  }
});

// ==================================================
// 📢 AVISO PARA OS GRUPOS (promoções)
// Posta a mensagem nos grupos escolhidos (só os grupos registados e ativos no bot), com a opção de
// marcar todos os membros (todos recebem a notificação). Só avança com o PIN do dono.
// Não manda mensagens privadas a cada membro: isso é a forma mais rápida de o WhatsApp bloquear o número.
// ==================================================
const GRUPOS_FILE = path.join(dataDir, "grupos.json");
const GRUPOS_AVISO_LOG = path.join(dataDir, "grupos_aviso_log.json");

// grupos onde o bot trabalha (grupos.json, preenchido pelos comandos do bot) e se o plano está ativo
function gruposDoBot() {
  const g = smsLerJSON(GRUPOS_FILE, {});
  const agora = Date.now();
  return Object.entries(g)
    .filter(([jid]) => String(jid).endsWith('@g.us'))
    .map(([jid, v]) => ({
      jid,
      nome: (v && v.nome) || '',
      ativo: !!v && v.ativo !== false && !(v.expiraEm && v.expiraEm <= agora)
    }));
}

// nomes e nº de membros vindos do WhatsApp (uma só chamada, guardada 60 s para não abusar)
let gruposMetaCache = { em: 0, dados: {} };
async function gruposMetadados() {
  if (!globalSocket) return null;
  if (Date.now() - gruposMetaCache.em < 60000) return gruposMetaCache.dados;
  try {
    const dados = await globalSocket.groupFetchAllParticipating();
    gruposMetaCache = { em: Date.now(), dados: dados || {} };
    return gruposMetaCache.dados;
  } catch (e) {
    console.error('[Aviso grupos] Não consegui ler os grupos:', e.message);
    return null;
  }
}

let gruposAvisoJob = null;

function gruposAvisoEstado() {
  if (!gruposAvisoJob) return null;
  const j = gruposAvisoJob;
  return {
    id: j.id, estado: j.estado, total: j.total, enviados: j.enviados, falhas: j.falhas,
    restantes: Math.max(j.total - j.enviados - j.falhas, 0),
    atual: j.atual || '', marcarTodos: j.marcarTodos, canal: j.canal || 'grupo',
    aEsperarFila: !!j.aEsperarFila,
    iniciadoEm: j.iniciadoEm, fim: j.fim || null, ultimoErro: j.ultimoErro || ''
  };
}

// Número de telefone (258 + 9 dígitos) de um membro do grupo; '' se o WhatsApp só mostrar o identificador interno (@lid)
async function numeroDeParticipante(p) {
  for (const c of [p.phoneNumber, p.jid, p.id]) {
    const n = smsNormalizar(c);
    if (n) return n;
  }
  const lid = [p.id, p.lid].find(x => /@lid$/i.test(String(x || '')));
  try {
    const mapa = globalSocket && globalSocket.signalRepository && globalSocket.signalRepository.lidMapping;
    if (lid && mapa && typeof mapa.getPNForLID === 'function') {
      return smsNormalizar(await mapa.getPNForLID(lid));
    }
  } catch (e) { /* esta versão do WhatsApp não tem o mapeamento */ }
  return '';
}

// Junta os números de todos os membros dos grupos escolhidos (sem repetir o mesmo número e sem o do próprio bot).
// Não salta ninguém por já ter recebido outro SMS: vão todos os que têm número visível.
async function gruposColetarNumeros(jids) {
  const metas = await gruposMetadados();
  if (!metas) throw new Error('não consegui ler os grupos do WhatsApp');
  const meu = smsNormalizar(globalSocket && globalSocket.user && globalSocket.user.id);
  const vistos = new Set();
  const fila = [];
  let membros = 0, semNumero = 0, duplicados = 0;

  // nomes: o WhatsApp não mostra o nome dos membros ao bot, por isso só se conhece o nome de quem já comprou
  const nomes = {};
  Object.assign(nomes, nomesMapa());

  for (const jid of jids) {
    const meta = metas[jid];
    if (!meta) continue;
    for (const p of (meta.participants || [])) {
      membros++;
      const numero = await numeroDeParticipante(p);
      if (!numero) { semNumero++; continue; }
      if (numero === meu) continue;
      if (vistos.has(numero)) { duplicados++; continue; }
      vistos.add(numero);
      fila.push({ numero, nome: nomes[numero] || '', grupo: meta.subject || jid });
    }
  }
  return { fila, membros, semNumero, duplicados };
}

// Envia o SMS a cada número, devagar, com prioridade aos pedidos (mesmo caminho do SMS em massa)
async function gruposSmsExecutar(job) {
  const pausaSeg = Math.min(Math.max(Number(lerConfigGlobal().smsMassaPausaSeg ?? 6) || 6, 2), 60);
  console.log(`[Aviso grupos/SMS] A enviar ${job.total} SMS, pausa ${pausaSeg}s`);
  for (const d of job.fila) {
    if (job.estado !== 'enviando') break;
    await smsAguardarFilaLivre(job);
    if (job.estado !== 'enviando') break;
    job.atual = d.grupo;
    // {nome} -> primeiro nome (se o bot conhece o cliente); se não conhece, sai sem nome ("Ola {nome}!" fica "Ola!")
    const texto = smsRender(job.mensagem, { nome: smsPrimeiroNome(d.nome) })
      .replace(/\{\w+\}/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([!,.?;:])/g, '$1').trim();
    try {
      const ok = await enviarSMS(smsParaEnvio(d.numero), texto);
      if (ok === false) throw new Error('o envio falhou (ver logs e data/sms_enviados.txt)');
      job.enviados++;
      smsConversaRegistar(d.numero, 'out', texto, 'massa', { soSeExistir: true });
    } catch (e) {
      job.falhas++;
      job.ultimoErro = String(e && e.message || e).slice(0, 120);
      console.error('[Aviso grupos/SMS] Falha ao enviar:', job.ultimoErro);
    }
    await smsDormir(pausaSeg * 1000);
  }
  if (job.estado === 'enviando') job.estado = 'concluido';
  job.atual = '';
  job.fim = new Date().toISOString();
  console.log(`[Aviso grupos/SMS] Terminado (${job.estado}): ${job.enviados} enviados, ${job.falhas} falhas`);

  const log = smsLerJSON(GRUPOS_AVISO_LOG, []);
  log.push({ em: job.fim, canal: 'sms', estado: job.estado, total: job.total, enviados: job.enviados, falhas: job.falhas, grupos: job.gruposTotal, mensagem: job.mensagem.slice(0, 80) });
  smsSalvarJSON(GRUPOS_AVISO_LOG, log.slice(-20));
}

async function gruposAvisoExecutar(job) {
  const pausaCfg = Number(lerConfigGlobal().gruposAvisoPausaSeg);
  console.log(`[Aviso grupos] A enviar a ${job.total} grupo(s)${job.marcarTodos ? ' (marcando todos)' : ''}`);
  for (let i = 0; i < job.fila.length; i++) {
    if (job.estado !== 'enviando') break;
    const g = job.fila[i];
    job.atual = g.nome || g.jid;
    try {
      if (!globalSocket) throw new Error('o WhatsApp do bot não está ligado');
      const conteudo = { text: job.mensagem };
      if (job.marcarTodos) {
        const meta = await globalSocket.groupMetadata(g.jid);
        conteudo.mentions = (meta.participants || []).map(p => p.id);
      }
      await globalSocket.sendMessage(g.jid, conteudo);
      job.enviados++;
    } catch (e) {
      job.falhas++;
      job.ultimoErro = `${g.nome || g.jid}: ${String(e && e.message || e).slice(0, 100)}`;
      console.error('[Aviso grupos] Falha em', g.nome || g.jid, '-', e && e.message || e);
    }
    // pausa entre grupos (8 a 15 s) para não parecer spam
    if (i < job.fila.length - 1 && job.estado === 'enviando') {
      await smsDormir(pausaCfg > 0 ? pausaCfg * 1000 : 8000 + Math.random() * 7000);
    }
  }
  if (job.estado === 'enviando') job.estado = 'concluido';
  job.atual = '';
  job.fim = new Date().toISOString();
  console.log(`[Aviso grupos] Terminado (${job.estado}): ${job.enviados} enviados, ${job.falhas} falhas`);

  const log = smsLerJSON(GRUPOS_AVISO_LOG, []);
  log.push({ em: job.fim, estado: job.estado, total: job.total, enviados: job.enviados, falhas: job.falhas, marcarTodos: job.marcarTodos, mensagem: job.mensagem.slice(0, 80) });
  smsSalvarJSON(GRUPOS_AVISO_LOG, log.slice(-20));
}

// GET /api/grupos-aviso -> { online, grupos:[{ jid, nome, membros, ativo }], job }
// POST /api/grupos-aviso -> { pin, acao:'enviar', grupos:[jid], mensagem, marcarTodos }  |  { acao:'parar' }
app.get('/api/grupos-aviso', async (req, res) => {
  try {
    const metas = await gruposMetadados();
    const grupos = gruposDoBot().map(g => {
      const m = metas && metas[g.jid];
      return {
        jid: g.jid,
        nome: (m && m.subject) || g.nome || g.jid,
        membros: m && Array.isArray(m.participants) ? m.participants.length : null,
        ativo: g.ativo
      };
    }).sort((a, b) => Number(b.ativo) - Number(a.ativo) || a.nome.localeCompare(b.nome));
    res.json({ online: !!globalSocket && metas !== null, grupos, job: gruposAvisoEstado() });
  } catch (err) {
    console.error('[Painel] Erro em GET /api/grupos-aviso:', err);
    res.status(500).json({ erro: 'falha ao ler os grupos' });
  }
});

let gruposAvisoAPreparar = false;

// só grupos registados e com o plano ativo
function gruposEscolhidosValidos(grupos) {
  const permitidos = new Map(gruposDoBot().filter(g => g.ativo).map(g => [g.jid, g]));
  const escolhidos = [...new Set(Array.isArray(grupos) ? grupos : [])].filter(j => permitidos.has(j));
  return { permitidos, escolhidos };
}

const GRUPOS_SMS_MAX = 500; // máximo de SMS por envio

app.post('/api/grupos-aviso', async (req, res) => {
  try {
    const { pin, acao, grupos, mensagem, marcarTodos, canal } = req.body || {};

    if (acao === 'parar') {
      if (gruposAvisoJob && gruposAvisoJob.estado === 'enviando') {
        gruposAvisoJob.estado = 'parado';
        console.log('[Aviso grupos] Parado pelo painel');
      }
      return res.json({ ok: true });
    }

    // Prévia: só conta quantos números receberiam SMS (não envia nada, não mostra números)
    if (acao === 'previa') {
      if (!globalSocket) return res.status(503).json({ erro: 'o WhatsApp do bot não está ligado' });
      const { escolhidos } = gruposEscolhidosValidos(grupos);
      if (!escolhidos.length) return res.status(400).json({ erro: 'escolhe pelo menos um grupo' });
      const r = await gruposColetarNumeros(escolhidos);
      const pausaSeg = Math.min(Math.max(Number(lerConfigGlobal().smsMassaPausaSeg ?? 6) || 6, 2), 60);
      return res.json({
        ok: true, total: r.fila.length, membros: r.membros, semNumero: r.semNumero,
        duplicados: r.duplicados,
        pausaSeg, minutos: Math.ceil(r.fila.length * pausaSeg / 60), maximo: GRUPOS_SMS_MAX
      });
    }

    if (pin !== PIN_PEDIDO_MANUAL) return res.status(403).json({ erro: 'PIN incorreto' });
    if (acao !== 'enviar') return res.status(400).json({ erro: 'ação inválida' });
    if (gruposAvisoAPreparar || (gruposAvisoJob && gruposAvisoJob.estado === 'enviando')) {
      return res.status(409).json({ erro: 'já há um aviso em curso' });
    }
    if (!globalSocket) return res.status(503).json({ erro: 'o WhatsApp do bot não está ligado' });

    const porSms = canal === 'sms';
    const maxChars = porSms ? 320 : 1000;
    let texto = String(mensagem || '').trim();
    if (!texto || texto.length > maxChars) {
      return res.status(400).json({ erro: `a mensagem tem de ter entre 1 e ${maxChars} caracteres` });
    }

    const { permitidos, escolhidos } = gruposEscolhidosValidos(grupos);
    if (!escolhidos.length) return res.status(400).json({ erro: 'escolhe pelo menos um grupo' });
    if (escolhidos.length > 30) return res.status(400).json({ erro: 'no máximo 30 grupos de cada vez' });

    // ---------- Canal 1: SMS a cada membro ----------
    if (porSms) {
      if (smsMassaJob && smsMassaJob.estado === 'enviando') {
        return res.status(409).json({ erro: 'há um SMS em massa em curso: espera que acabe' });
      }
      gruposAvisoAPreparar = true;
      try {
        // no SMS não há negrito nem itálico: tira os * e _ à volta das palavras
        texto = texto.replace(/([*_])(\S(?:[^\n]*?\S)?)\1/g, '$2');

        const r = await gruposColetarNumeros(escolhidos);
        if (!r.fila.length) {
          return res.status(400).json({ erro: `não há números para enviar (${r.semNumero} membros sem número de Moçambique visível)` });
        }
        if (r.fila.length > GRUPOS_SMS_MAX) {
          return res.status(400).json({ erro: `são ${r.fila.length} SMS e o máximo é ${GRUPOS_SMS_MAX} por envio: escolhe menos grupos` });
        }

        gruposAvisoJob = {
          id: `AVISO-SMS-${Date.now()}`, canal: 'sms', mensagem: texto, marcarTodos: false,
          fila: r.fila, total: r.fila.length, gruposTotal: escolhidos.length,
          enviados: 0, falhas: 0, estado: 'enviando', atual: '', aEsperarFila: false,
          iniciadoEm: new Date().toISOString(), fim: null, ultimoErro: ''
        };
      } finally {
        gruposAvisoAPreparar = false;
      }
      gruposSmsExecutar(gruposAvisoJob).catch(e => {
        console.error('[Aviso grupos/SMS] Erro inesperado:', e);
        if (gruposAvisoJob) { gruposAvisoJob.estado = 'parado'; gruposAvisoJob.ultimoErro = String(e && e.message || e).slice(0, 120); }
      });
      return res.json({ ok: true, total: gruposAvisoJob.total, grupos: escolhidos.length });
    }

    // ---------- Canal 2: mensagem publicada no grupo ----------
    const metas = (gruposMetaCache && gruposMetaCache.dados) || {};
    gruposAvisoJob = {
      id: `AVISO-${Date.now()}`, canal: 'grupo',
      mensagem: texto,
      marcarTodos: marcarTodos !== false,
      fila: escolhidos.map(jid => ({ jid, nome: (metas[jid] && metas[jid].subject) || permitidos.get(jid).nome || jid })),
      total: escolhidos.length, enviados: 0, falhas: 0, estado: 'enviando', atual: '',
      iniciadoEm: new Date().toISOString(), fim: null, ultimoErro: ''
    };
    gruposAvisoExecutar(gruposAvisoJob).catch(e => {
      console.error('[Aviso grupos] Erro inesperado:', e);
      if (gruposAvisoJob) { gruposAvisoJob.estado = 'parado'; gruposAvisoJob.ultimoErro = String(e && e.message || e).slice(0, 100); }
    });
    res.json({ ok: true, total: escolhidos.length });
  } catch (err) {
    console.error('[Painel] Erro em POST /api/grupos-aviso:', err);
    res.status(500).json({ erro: 'falha ao iniciar o aviso' });
  }
});

// GET /api/inativos?dias=7 -> [{ nome, numero, numeroTipo, dias, ultimaCompra, totalCompras, totalGasto }]
// Clientes cuja última compra FINALIZADA foi há `dias` dias ou mais (dias contados no fuso de Maputo).
// numero = número de WhatsApp só com dígitos (258...) ou '' se não der para saber.
// numeroTipo = 'comprador' (quem comprou) ou 'destino' (número do último envio, usado só se o comprador não der número).
app.get('/api/inativos', (req, res) => {
  try {
    const minDias = Math.min(Math.max(parseInt(req.query.dias, 10) || 7, 1), 365);
    const lista = [];
    for (const c of smsListarClientes()) {
      if (c.dias < minDias) continue;
      let numero = c.numero;
      let numeroTipo = numero ? 'comprador' : '';
      if (!numero) {
        numero = smsNormalizar(c.ultimoDestino);
        numeroTipo = numero ? 'destino' : '';
      }
      lista.push({
        nome: c.nome,
        numero,
        numeroTipo,
        dias: c.dias,
        ultimaCompra: c.ultima.toISOString(),
        totalCompras: c.totalCompras,
        totalGasto: c.totalGasto
      });
    }
    lista.sort((a, b) => b.totalGasto - a.totalGasto || a.dias - b.dias);
    res.json(lista.slice(0, 100));
  } catch (err) {
    console.error('[Painel] Erro em /api/inativos:', err);
    res.status(500).json({ erro: 'falha ao buscar clientes inativos' });
  }
});

// GET /api/cliente-historico?numero=XXXX -> [{ data, hora, valor, mb, numeroDestino, status }]
app.get('/api/cliente-historico', (req, res) => {
  try {
    const { numero } = req.query;
    if (!numero) return res.status(400).json({ erro: 'parâmetro numero é obrigatório' });

    const historico = lerPedidos()
      .filter(p => {
        const chave = p.numeroComprador || p.participant || p.numero || p.cliente;
        return chave === numero && (p.status === "finalizado" || p.status === "falha");
      })
      .sort((a, b) => new Date(b.dataFinalizacao || b.dataCriacao) - new Date(a.dataFinalizacao || a.dataCriacao))
      .map(p => {
        const d = p.dataFinalizacao || p.dataCriacao;
        const dt = d ? new Date(d) : null;
        return {
          data: dt ? dt.toLocaleDateString('pt-MZ', { timeZone: 'Africa/Maputo' }) : '—',
          hora: dt ? dt.toLocaleTimeString('pt-MZ', {
            timeZone: 'Africa/Maputo', hour: '2-digit', minute: '2-digit'
          }) : '—',
          valor: `${p.valor}MT`,
          mb: p.quantidadeMB ?? '—',
          numeroDestino: p.numero || '—',
          status: p.status === "finalizado" ? "Sucesso" : "Falha"
        };
      });

    res.json(historico);
  } catch (err) {
    console.error('[Painel] Erro em /api/cliente-historico:', err);
    res.status(500).json({ erro: 'falha ao buscar histórico do cliente' });
  }
});

// POST /webhook/dispositivo-info -> body: { telefoneId, operadoraSim1, operadoraSim2, marca, modelo }
app.post('/webhook/dispositivo-info', (req, res) => {
  try {
    const { telefoneId, operadoraSim1, operadoraSim2, marca, modelo } = req.body;

    const telefone = TELEFONES.find(t => t.id === Number(telefoneId));
    if (!telefone) return res.status(404).json({ erro: 'telefone não encontrado' });

    const config = lerConfigGlobal();
    const infoKey = `info_${telefone.mbKey}`;

    config[infoKey] = {
      operadoraSim1: operadoraSim1 || '—',
      operadoraSim2: operadoraSim2 || '—',
      marca: marca || '—',
      modelo: modelo || '—',
      atualizadoEm: new Date().toISOString()
    };

    salvarConfigGlobal(config);
    console.log(`[Painel] Info dispositivo atualizada — ${telefone.nome}: ${marca} ${modelo} | SIM1=${operadoraSim1} SIM2=${operadoraSim2}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Painel] Erro em /webhook/dispositivo-info:', err);
    res.status(500).json({ erro: 'falha ao salvar info do dispositivo' });
  }
});

app.get('/api/telefones-status', (req, res) => {
  try {
    const config = lerConfigGlobal();
    const hojeStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Maputo' });
    const pedidosHoje = lerPedidos().filter(p => {
      const d = p.dataFinalizacao || p.dataCriacao || "";
      return diaMaputo(d) === hojeStr && p.status === "finalizado";
    });

    const lista = TELEFONES.map(t => {
      const infoKey = `info_${t.mbKey}`;
      const info = config[infoKey] || {};
      const r = verificarTelefone(config, t, 1);

      const pedidosDesseTelefone = pedidosHoje.filter(p => (p.telefoneUsado || 1) === t.id);
      const transferSim1 = pedidosDesseTelefone.filter(p => (p.simUsado || 'SIM1') === 'SIM1').length;
      const transferSim2 = pedidosDesseTelefone.filter(p => p.simUsado === 'SIM2').length;

      const limiteDiarioKey = `limiteDiarioSim_${t.mbKey}`;
      const limiteDiario = config[limiteDiarioKey] || { sim1: 10, sim2: 10 };

      return {
        id: t.id,
        nome: t.nome,
        marca: info.marca || '—',
        modelo: info.modelo || '—',
        sim1: {
          operadora: info.operadoraSim1 || '—',
          mbAtual: r.sim1MB ?? 0,
          disponivel: !!(r.configurado && r.ok),
          transferenciasHoje: transferSim1,
          limiteDiario: Number(limiteDiario.sim1) || 10
        },
        sim2: {
          operadora: info.operadoraSim2 || '—',
          mbAtual: r.sim2MB ?? 0,
          disponivel: !!(r.configurado && r.ok),
          transferenciasHoje: transferSim2,
          limiteDiario: Number(limiteDiario.sim2) || 10
        }
      };
    });
    res.json(lista);
  } catch (err) {
    console.error('[Painel] Erro em /api/telefones-status:', err);
    res.status(500).json({ erro: 'falha ao buscar status dos telefones' });
  }
});

app.post('/api/telefones-status/limite-diario', (req, res) => {
  try {
    const { id, limiteSim1, limiteSim2 } = req.body;
    const telefone = TELEFONES.find(t => t.id === Number(id));
    if (!telefone) return res.status(404).json({ erro: 'telefone não encontrado' });

    const config = lerConfigGlobal();
    config[`limiteDiarioSim_${telefone.mbKey}`] = {
      sim1: Number(limiteSim1) || 10,
      sim2: Number(limiteSim2) || 10
    };
    salvarConfigGlobal(config);

    res.json({ ok: true });
  } catch (err) {
    console.error('[Painel] Erro em /api/telefones-status/limite-diario:', err);
    res.status(500).json({ erro: 'falha ao salvar limite diário' });
  }
});

// POST /webhook/push-subscribe -> body: { subscription }
app.post('/webhook/push-subscribe', (req, res) => {
  try {
    const { subscription, pin } = req.body || {};
    if (pin !== PIN_PEDIDO_MANUAL) {
      return res.status(403).json({ erro: 'PIN incorreto' });
    }
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ erro: 'subscription inválida' });
    }

    const config = lerConfigGlobal();
    if (!config.pushSubscriptions) config.pushSubscriptions = [];

    const jaExiste = config.pushSubscriptions.some(s => s.endpoint === subscription.endpoint);
    if (!jaExiste) {
      config.pushSubscriptions.push(subscription);
      salvarConfigGlobal(config);
      console.log(`[Painel] Nova inscrição push registada (total: ${config.pushSubscriptions.length})`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Painel] Erro em /webhook/push-subscribe:', err);
    res.status(500).json({ erro: 'falha ao registar inscrição' });
  }
});

// Função pra enviar notificação pra todos os dispositivos inscritos
async function enviarNotificacaoPush(titulo, corpo, tag) {
  try {
    const config = lerConfigGlobal();
    const subs = config.pushSubscriptions || [];
    if (subs.length === 0) return;

    const payload = JSON.stringify({ title: titulo, body: corpo, tag: tag || undefined });
    const validas = [];

    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
        validas.push(sub);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log('[Painel] Inscrição push expirada, removendo.');
        } else {
          console.error('[Painel] Erro ao enviar push:', err.message);
          validas.push(sub);
        }
      }
    }

    if (validas.length !== subs.length) {
      const cfgAtual = lerConfigGlobal(); // relê: o envio demora e a config pode ter mudado
      cfgAtual.pushSubscriptions = validas;
      salvarConfigGlobal(cfgAtual);
    }
  } catch (err) {
    console.error('[Painel] Erro em enviarNotificacaoPush:', err);
  }
}

// aceita POST (macro) e GET (para testar no navegador: /entrada?from=84XXXXXXX&text=menu)
app.all("/entrada", async (req, res) => {
  console.log("📨 SMS recebido via MacroDroid:", req.method, req.query, req.body || "");
  try {
    // aceita from/text na URL (?from=..&text=..) ou no corpo do pedido
    const from = req.query.from || (req.body && req.body.from);
    const text = req.query.text || (req.body && req.body.text);

    if (!from || !text) return res.sendStatus(200);

    // 💬 só atende telemóveis de clientes (84/85...). Códigos curtos e operadoras (M-Pesa, Vodacom, etc.)
    // são ignorados: não são conversa e não devem ser processados nem receber resposta.
    const numCliente = smsNormalizar(from);
    if (!numCliente) {
      console.log("ℹ️ SMS ignorado (remetente não é telemóvel de cliente):", from);
      return res.json({ ok: true, ignorado: true });
    }
    smsConversaRegistar(numCliente, 'in', text, 'cliente'); // histórico

    const fakeSock = {
      sendMessage: async (to, { text: resposta }) => {
        const enviado = await smsEnviarCompra(from, resposta, 'entrada');
        if (numCliente && enviado) smsConversaRegistar(numCliente, 'out', enviado, 'pedido');
      },
    };

    const fakeMsg = {
      key: {
        remoteJid: from,
        participant: from,
        id: `sms-${Date.now()}`,
        fromMe: false,
      },
      message: { conversation: text },
      pushName: smsNomeDe(numCliente) || from,
    };

    const { processarComprovativo, messageHandler } = require("./messageHandler");

// Verifica se é só um número
const isNumero = /^(84|85)\d{7}$/.test(text.trim());

if (isNumero) {
  // Chama o messageHandler igual ao WhatsApp
  await messageHandler(fakeSock, [fakeMsg]);
} else {
  const processado = await processarComprovativo(
    text, fakeSock, from, from, fakeMsg, false
  );

  if (!processado) {
    // 💬 não era comprovativo: atendimento por SMS (respostas automáticas + conversa no painel)
    await smsAtendimentoTratar(numCliente, from, text);
  }
}

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro no /sms/entrada:", err.message);
    res.sendStatus(500);
  }
});

// ==================================================
// 🚀 MONITORAMENTO AUTOMÁTICO DE M-PESA E E-MOLA
// ==================================================
function iniciarMonitoramentoMpesa() {

  const arquivoMpesa = "./src/mpesa.txt";
  const arquivoEmola = "./src/emola.txt";
  const arquivoSaida = "./data/chaves.json";
  const arquivoUsadas = "./data/chaves_usadas.json";

  infoLog("👨‍💻 Iniciando monitoramento automático de M-Pesa e E-Mola...");

  if (!fs.existsSync(arquivoMpesa)) fs.writeFileSync(arquivoMpesa, "");
  if (!fs.existsSync(arquivoEmola)) fs.writeFileSync(arquivoEmola, "");
  if (!fs.existsSync(arquivoUsadas)) fs.writeFileSync(arquivoUsadas, "[]");

  monitorarArquivo(arquivoMpesa, "M-Pesa");
  monitorarArquivo(arquivoEmola, "E-Mola");

  function monitorarArquivo(caminho, tipo) {
    fs.watchFile(caminho, { interval: 1000 }, async (curr, prev) => {
      if (curr.size <= prev.size) return;

      try {
        const conteudo = await fs.promises.readFile(caminho, "utf8");
        const linhas = conteudo.split("\n").filter(l => l.trim());
        const ultimaLinha = linhas[linhas.length - 1] || "";

        let dados = null;

        if (tipo === "M-Pesa" && ultimaLinha.includes("Confirmado")) {
          dados = extrairDadosMpesa(ultimaLinha);
        }

        if (tipo === "E-Mola" && ultimaLinha.includes("ID da transacao")) {
          dados = extrairDadosEmola(ultimaLinha);
        }

        if (!dados || !dados.codigo || !dados.valor) {
          await fs.promises.writeFile(caminho, "");
          return;
        }

        const usado = await codigoJaExiste(dados.codigo, arquivoSaida, arquivoUsadas);

        if (!usado) {
          const salvo = await salvarTransacao(dados, arquivoSaida);

          if (salvo) {
            successLog(`✅ ${tipo}: ${dados.codigo} salva (${dados.valor}MT)`);
            // 🔹 Integração com messageHandler
            await adicionarFilaAutomatica(dados, tipo);
          }
        } else {
          warningLog(`⚠️ ${tipo}: código ${dados.codigo} já existe.`);
        }

        await fs.promises.writeFile(caminho, "");
      } catch (error) {
        errorLog(`❌ Erro ao processar ${tipo}: ${error.message}`);
      }
    });
  }
}

// ==================================================
// 🔹 Adiciona comprovativo à fila para processar
// ==================================================
async function adicionarFilaAutomatica(dados, tipo) {
  try {
    if (!dados || !dados.codigo || !dados.valor) return;

    const novoItem = {
      tipo: tipo === "M-Pesa" ? "mpesa" : "emola",
      tempo: 25,
      dados: {
        body: gerarMensagemSimulada(dados, tipo),
        from: "120363403554730155@g.us", // ⚠️ colocar grupo real
        sender: dados.remetente?.numero || "AUTOMATICO",
        msg: { key: { id: Date.now() } },
        pushName: dados.remetente?.nome || "Cliente Automático"
      }
    };

    filaComprovativos.push(novoItem);
    console.log(`📌 Fila automática adicionada: ${dados.codigo}`);

    if (globalSocket) {
      await processarFilaComprovativos(globalSocket);
    }
  } catch (err) {
    console.error(`❌ Erro fila automática: ${err.message}`);
  }
}

// ==================================================
// 🔹 Gera mensagem simulada do comprovativo
// ==================================================
function gerarMensagemSimulada(dados, tipo) {
  if (tipo === "M-Pesa") {
    return `Confirmado ${dados.codigo}. Transferiste ${dados.valor}MT`;
  }
  if (tipo === "E-Mola") {
    return `ID da transacao ${dados.codigo}. Transferiste ${dados.valor}MT`;
  }
  return "";
}


// ==================================================
// 🔌 INICIAR BOT
// ==================================================
async function iniciarBot() {
  const { DisconnectReason } = await import('@whiskeysockets/baileys');

  try {
    console.log(`\n🚀 Iniciando bot...`);

    const sock = await connect();
    globalSocket = sock;

    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        if (!messages || !messages[0]?.message) return;
        try {
          for (const m of messages) {
            if (m.key && m.key.fromMe) continue;
            const jid = m.key && String(m.key.remoteJid || '');
            if (!m.pushName || !jid.endsWith('@g.us')) continue;
            const num = await numeroDeParticipante({ phoneNumber: m.key.participantPn, jid: m.key.participantAlt, id: m.key.participant, lid: m.key.participant });
            if (num) nomeRegistar(num, m.pushName);
          }
        } catch (e) { /* ignora */ }
        await messageHandler(sock, messages);
      } catch (err) {
        console.error(`[ERRO MENSAGEM]`, err.message);
      }
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      const code = lastDisconnect?.error?.output?.statusCode;

      if (connection === "connecting") console.log(`🔄 Conectando...`);

      if (connection === "open") {
        console.log(`✅ BOT CONECTADO E PRONTO`);
        globalSocket = sock;
        if (!resumoAgendado) {
          resumoAgendado = true;
          agendarResumoDia();
        }
        
        // 🔻 SCHEDULERS
        iniciarSchedulerSemanal();
        console.log(`✅ Scheduler semanal ativado`);

        if (smsExpiracaoConfig().ativo) {
          pararScheduler();
          console.log(`ℹ️ Lembrete de expiração antigo desligado (o aviso novo por SMS está ligado)`);
        } else {
          iniciarScheduler();
          console.log(`✅ Scheduler de expiração ativado`);
        }

        if (!alertaSaldoAgendado) {
          alertaSaldoAgendado = true;
          setInterval(verificarSaldoBaixo, 60000);
          console.log(`✅ Alerta de saldo baixo ativado`);
        }
      }

      if (connection === "close") {
        console.log(`⚠️ Conexão caiu (${code})`);
        globalSocket = null;

        pararScheduler();

        if (code === 401 || code === DisconnectReason.loggedOut) {
          console.log(`⛔ Sessão encerrada.`);
          return;
        }

        console.log(`🔄 Reiniciando em 5s...`);
        setTimeout(() => iniciarBot(), 5000);
      }
    });

    sock.ev.on('creds.update', () => {});

    setInterval(async () => {
      try { await sock.sendPresenceUpdate('available'); } catch {}
    }, 20000);

    app.listen(PORT, () => {
      console.log(`\n🌐 Servidor rodando na porta ${PORT}`);
    });

  } catch (err) {
    console.error(`❌ Erro ao iniciar:`, err.message);
    setTimeout(() => iniciarBot(), 5000);
  }
}

mostrarMarca();
iniciarBot().catch(err => {
  console.error(`❌ Falha ao iniciar: ${err.message}`);
  console.error(`📍 Stack: ${err.stack}`);
});