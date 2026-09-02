# Painel Automático — Megas Express

Site estático simples (1 arquivo `index.html`) que mostra o painel de controle
da venda automática, ligado na API do bot (`http://project.metahosting.shop:2006`).

## Passo a passo — GitHub

1. Cria uma conta no [github.com](https://github.com) se ainda não tiver.
2. Cria um repositório novo (botão verde "New repository"), nome sugerido:
   `megas-painel-web`. Deixa **público ou privado**, tanto faz.
3. No teu computador/celular, dentro dessa pasta (`megas-painel-web`), roda:

```bash
git init
git add .
git commit -m "primeira versao do painel"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/megas-painel-web.git
git push -u origin main
```

(troca `SEU-USUARIO` pelo teu nome de usuário do GitHub)

## Passo a passo — Vercel

1. Entra em [vercel.com](https://vercel.com) e faz login **com a tua conta do GitHub**
   (assim ele já enxerga os teus repositórios).
2. Clica em **Add New → Project**.
3. Escolhe o repositório `megas-painel-web` que você acabou de subir.
4. Não precisa mudar nenhuma configuração (é HTML puro, sem build) — clica em **Deploy**.
5. Em ~30 segundos ele te dá uma URL tipo `https://megas-painel-web.vercel.app`.

Pronto — esse link já é o teu painel, funcionando de qualquer lugar.

## Atualizações depois

Toda vez que você (ou eu) mudar o `index.html`, é só repetir:

```bash
git add .
git commit -m "descricao da mudanca"
git push
```

O Vercel detecta o push sozinho e atualiza o site em segundos, sem precisar
fazer nada no painel da Vercel.
