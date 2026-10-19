/* Painel Megas Express — controlo de acesso no navegador.
   Corre no <head> de TODAS as páginas (menos entrar.html para o redirecionamento).
   - sem sessão  -> manda para /entrar.html
   - junta o cabeçalho x-sessao a todos os pedidos /api/*
   - se o bot disser "sessão expirada" ou "aluguer não pago" -> mostra o bloqueio
   - esconde o que não é do perfil (fornecedor não vê as funções de revendedor)
   O controlo a sério é feito no bot; isto só trata da parte visual. */
(function () {
  var K = 'mx_sessao';
  var WHATSAPP_SUPORTE = '258875189774';
  var PERFIS = { fornecedor: 'Fornecedor', revendedor: 'Revendedor' };
  // itens do menu que só existem para REVENDEDOR (clientes finais, SMS, recargas, avisos a grupos)
  var SO_REVENDEDOR = ['smsat', 'inativos', 'recargas', 'gruposaviso', 'smsmassa', 'smsexp', 'associar'];
  var SO_FORNECEDOR = []; // reservado para funções novas do modo fornecedor

  function ler() { try { return JSON.parse(localStorage.getItem(K) || 'null'); } catch (e) { return null; } }
  function guardar(s) { try { localStorage.setItem(K, JSON.stringify(s)); } catch (e) {} }
  function limpar() { try { localStorage.removeItem(K); } catch (e) {} }
  function pagina() { return (location.pathname.split('/').pop() || 'index.html').toLowerCase(); }

  var sessao = ler();
  var naEntrada = pagina() === 'entrar.html';
  var valida = sessao && sessao.token && (!sessao.exp || sessao.exp > Date.now());

  if (!naEntrada && !valida) { limpar(); location.replace('/entrar.html'); return; }

  function sair(motivo) {
    limpar();
    location.replace('/entrar.html' + (motivo ? '?m=' + encodeURIComponent(motivo) : ''));
  }
  window.painelSair = function () { sair(''); };
  window.painelSessao = function () { return ler(); };

  // ---------- fetch com sessão ----------
  var fetch0 = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    var u = typeof url === 'string' ? url : (url && url.url) || '';
    var ehApi = /(^|\/)api\//.test(u) && !/\/api\/login(\?|$)/.test(u);
    if (ehApi) {
      var s = ler();
      if (s && s.token) {
        opts = opts || {};
        var h = new Headers(opts.headers || {});
        h.set('x-sessao', s.token);
        opts.headers = h;
      }
    }
    var p = fetch0(url, opts);
    if (!ehApi) return p;
    return p.then(function (r) {
      if (r.status === 401 || r.status === 403) {
        r.clone().json().then(function (j) {
          if (j && j.erro === 'sessao') sair('Sessão expirada. Entre de novo.');
          else if (j && j.erro === 'aluguer') mostrarBloqueio(j.perfil, j.msg);
        }).catch(function () {});
      }
      return r;
    });
  };

  // ---------- bloqueio por aluguer ----------
  function mostrarBloqueio(perfil, msg) {
    if (document.getElementById('mxBloqueio')) return;
    var nome = PERFIS[perfil] || 'este perfil';
    var d = document.createElement('div');
    d.id = 'mxBloqueio';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0d1117;color:#e8ecf1;display:flex;align-items:center;justify-content:center;padding:24px;font-family:Segoe UI,Roboto,sans-serif;text-align:center';
    d.innerHTML = '<div style="max-width:340px">' +
      '<div style="font-size:48px">🔒</div>' +
      '<h2 style="margin:12px 0 8px;font-size:20px">' + (perfil === 'bot' ? 'Aluguer do bot terminou' : 'Aluguer de ' + nome + ' não pago') + '</h2>' +
      '<p style="color:#8b96a5;font-size:14px;line-height:1.5;margin-bottom:20px">' + (msg || 'Pague o aluguer para voltar a usar este perfil.') + '</p>' +
      '<a href="https://wa.me/' + WHATSAPP_SUPORTE + '?text=' + encodeURIComponent('Olá, quero pagar o aluguer ' + (perfil === 'bot' ? 'do bot' : 'de ' + nome)) + '" target="_blank" style="display:block;background:#3ddc84;color:#0d1117;font-weight:600;padding:12px;border-radius:10px;text-decoration:none;margin-bottom:10px">Pagar pelo WhatsApp</a>' +
      '<button id="mxTrocar" style="width:100%;background:#161b22;color:#e8ecf1;border:1px solid #262d3a;padding:12px;border-radius:10px;font-size:14px;cursor:pointer">Entrar com outro perfil</button>' +
      '</div>';
    document.body.appendChild(d);
    document.getElementById('mxTrocar').onclick = function () { sair(''); };
  }

  // ---------- parte visual do perfil ----------
  function aplicar() {
    var s = ler();
    if (!s) return;
    var perfil = s.perfil;

    // etiqueta no topo: "Megas Express · Fornecedor"
    document.querySelectorAll('.topbar .tag').forEach(function (t) {
      t.textContent = 'Megas Express · ' + (PERFIS[perfil] || '');
    });

    // esconde o que não é do perfil
    var esconder = perfil === 'fornecedor' ? SO_REVENDEDOR : SO_FORNECEDOR;
    esconder.forEach(function (a) {
      document.querySelectorAll('[data-acao="' + a + '"]').forEach(function (el) { el.hidden = true; el.style.display = 'none'; });
    });

    // dono: atalho para a página Contas no menu
    var drawer = document.getElementById('drawer');
    if (drawer && s.admin && !document.getElementById('mxContas')) {
      var b = document.createElement('button');
      b.className = 'drawer-item'; b.id = 'mxContas';
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Contas e alugueres';
      b.onclick = function () { location.href = '/contas.html'; };
      var primeiro = drawer.querySelector('.drawer-item');
      if (primeiro) drawer.insertBefore(b, primeiro); else drawer.appendChild(b);
    }

    // aviso de aluguer a acabar (3 dias ou menos)
    if (!s.admin && s.dias != null && s.dias <= 3 && !document.getElementById('mxAviso') && document.querySelector('.wrap')) {
      var av = document.createElement('div');
      av.id = 'mxAviso';
      av.style.cssText = 'background:#2a2110;border:1px solid #f5a623;color:#f5a623;border-radius:10px;padding:10px 12px;font-size:12px;margin-bottom:12px';
      av.textContent = '⏳ O seu aluguer de ' + (PERFIS[perfil] || '') + ' acaba em ' + s.dias + ' dia(s). Pague para não perder o acesso.';
      var w = document.querySelector('.wrap');
      w.insertBefore(av, w.children[1] || null);
    }
  }

  // ---------- confere a sessão de vez em quando (o aluguer pode acabar com o app aberto) ----------
  function conferir() {
    var s = ler();
    if (!s || !s.token) return;
    fetch('/api/sessao').then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        if (x.r.ok && x.j && x.j.ok && x.j.perfil) {
          var n = ler();
          if (n) { n.dias = x.j.dias; n.ate = x.j.ate; n.nome = x.j.nome || n.nome; guardar(n); }
        }
      }).catch(function () {});
  }

  window.__mxAcesso = { guardar: guardar, ler: ler, limpar: limpar, PERFIS: PERFIS };

  if (!naEntrada) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', aplicar); else aplicar();
    setTimeout(conferir, 1500);
    setInterval(conferir, 60000);
  }
})();