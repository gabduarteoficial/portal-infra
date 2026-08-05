# INFRA — Portal Produção

Stack completa da VPS. Alvo: **Ubuntu 24.04 LTS**, KVM 1 (1 vCPU · 4 GB · 50 GB).

## Arquivos
| Arquivo | O que é |
|---|---|
| `install.sh` | Instalador completo e idempotente |
| `schema.sql` | 6 tabelas + 2 views + seed das temperaturas |
| `bot.mjs` | Bot do Telegram — inclui `@claude now` |
| `lib/db.mjs` | Conexão, Telegram e motor de temperatura |
| `agentes/radar-eventos.mjs` | Agente 1 — coleta bruta, teto de 100 pesquisas |
| `agentes/analista-materias.mjs` | Agente 2 — as 100 e as 10 |

## Instalação

**1. Criar a VPS com `Ubuntu` (24.04 LTS).**

**2. Subir os arquivos** (do seu PC, dentro da pasta `infra`):
```bash
scp -r install.sh schema.sql bot.mjs lib agentes root@SEU_IP:/root/
```

**3. Rodar:**
```bash
ssh root@SEU_IP
sed -i 's/\r$//' install.sh && bash install.sh
```
Leva de 10 a 20 minutos (o Supabase baixa ~2 GB de imagens Docker).

**4. Preencher as chaves:**
```bash
nano /opt/portal-producao/.env
```
- `TELEGRAM_BOT_TOKEN` → `@BotFather`
- `TELEGRAM_OWNER_ID` → `@userinfobot`
- `ANTHROPIC_API_KEY` → console.anthropic.com

**5. Ligar e testar:**
```bash
systemctl restart portal-bot
```
No Telegram: `@claude ajuda` → depois `@claude now`.

## O comando `@claude now`
Dispara a rodada na hora, sem esperar a meia-noite. O bot roda como usuário
sem privilégio; uma regra em `/etc/sudoers.d/portal-rodada` autoriza **apenas**
`systemctl start portal-rodada.service` — nada mais. Se já houver rodada em
andamento, o bot recusa em vez de empilhar.

## A cadeia
```
00:00 BRT (ou @claude now)
   └─ portal-rodada.timer → rodada.sh
        ├─ radar-eventos.mjs   coleta 24h, ≤100 pesquisas, grava cru
        │                      → log_execucao.concluido = true
        └─ analista-materias.mjs  lê o banco, ranqueia, manda no Telegram
```
Se o radar falhar, o `rodada.sh` **não** executa o analista.

## Supabase
Self-hosted em `/opt/supabase` (repositório oficial). O Studio **não está
exposto** — abra por túnel SSH:
```bash
ssh -L 8000:localhost:8000 root@SEU_IP
```
Depois `http://localhost:8000` (usuário `portal`, senha impressa no fim do install).

**Memória é o ponto apertado.** A stack completa come ~2,5–3,5 GB; por isso o
instalador cria **4 GB de swap** e afina o Postgres. Acompanhe com `free -h`.
Se ficar pesado, o caminho é subir para 2 vCPU / 8 GB — ou desligar serviços que
você não usa:
```bash
cd /opt/supabase
docker compose stop realtime storage imgproxy vector
```
Nada no Portal Produção depende deles.

## Comandos do dia a dia
```bash
systemctl status portal-bot
journalctl -u portal-bot -f
tail -f /opt/portal-producao/logs/rodada.log
systemctl list-timers portal-rodada.timer
systemctl start portal-rodada
cd /opt/supabase && docker compose ps
free -h
```

## Rodar o instalador de novo
É idempotente: preserva `.env`, o banco e as chaves do Supabase. Rode de novo
depois de atualizar `schema.sql`, `bot.mjs` ou os agentes.
