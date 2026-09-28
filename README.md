# Painel Automático — Megas Express

Site estático com 5 telas (Painel, Telefones, Configurações, Histórico, Novo Pedido)
ligado na API do bot em http://server.apexhosting.cloud:2006.

## Estrutura
- `index.html` — Painel (liga/desliga venda automática + resumo do dia)
- `telefones.html` — Status dos SIMs (operadora, MB, transferências hoje)
- `configuracoes.html` — Editar limites e MB disponível por SIM
- `historico.html` — Histórico de compras agrupado por cliente
- `pedido.html` — Criar pedido manual (protegido por PIN)
- `manifest.json` + `icon-192.png` + `icon-512.png` — pra instalar como app (PWA)
- `api/` — funções proxy da Vercel que repassam pro bot (evita bloqueio https/http)

## Atualizar depois
Sempre que mudar algo, sobe pro GitHub (upload direto ou git push) — a Vercel
detecta e atualiza sozinha em segundos.
