#!/usr/bin/env bash
# =====================================================================
#  PORTAL PRODUÇÃO — instalador da VPS
#  Alvo: Ubuntu 24.04 LTS · KVM 1 (1 vCPU / 4 GB / 50 GB)
#
#  Instala: Docker, swap 4 GB, Supabase self-hosted, Node 22,
#           schema, bot do Telegram, os dois agentes,
#           timer 00:00 BRT, sudoers do @claude now, firewall.
#
#  Uso:  sudo bash install.sh
#  Idempotente: pode rodar de novo.
# =====================================================================
set -euo pipefail

APP_USER="portal"
APP_DIR="/opt/portal-producao"
SUPA_DIR="/opt/supabase"
DB_NAME="postgres"
NODE_MAJOR="22"
TZ_ALVO="America/Sao_Paulo"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ok  %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  !!  %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Rode como root:  sudo bash install.sh"; exit 1; }
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------
log "1/11  Sistema, timezone e swap"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw fail2ban \
                       unattended-upgrades jq unzip openssl postgresql-client
timedatectl set-timezone "$TZ_ALVO"

# Swap de 4 GB — a stack do Supabase é pesada para 4 GB de RAM.
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -qw vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  ok "swap de 4 GB ativo"
else
  ok "swap já existe"
fi
ok "timezone = $(timedatectl show -p Timezone --value)"

# ---------------------------------------------------------------------
log "2/11  Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

# ---------------------------------------------------------------------
log "3/11  Usuário e pastas"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  adduser --system --group --home "$APP_DIR" --shell /bin/bash "$APP_USER"
fi
usermod -aG docker "$APP_USER" || true
mkdir -p "$APP_DIR"/{agentes,lib,logs}
ok "usuário $APP_USER · pasta $APP_DIR"

# ---------------------------------------------------------------------
log "4/11  Supabase self-hosted"
if [[ ! -d "$SUPA_DIR/docker" ]]; then
  rm -rf /tmp/supabase-src
  git clone --depth 1 https://github.com/supabase/supabase /tmp/supabase-src -q
  mkdir -p "$SUPA_DIR"
  cp -r /tmp/supabase-src/docker/. "$SUPA_DIR/"
  rm -rf /tmp/supabase-src
  ok "repositório do Supabase copiado"
else
  ok "Supabase já instalado — preservado"
fi

if [[ ! -f "$SUPA_DIR/.env" ]]; then
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  JWT_SECRET="$(openssl rand -hex 32)"
  DASH_PASS="$(openssl rand -base64 18 | tr -d '/+=')"

  # Chaves anon/service assinadas com o JWT_SECRET
  b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  jwt() {
    local payload_role="$1"
    local header='{"alg":"HS256","typ":"JWT"}'
    local iat exp payload h p sig
    iat=$(date +%s); exp=$((iat + 315360000))   # 10 anos
    payload="{\"role\":\"${payload_role}\",\"iss\":\"supabase\",\"iat\":${iat},\"exp\":${exp}}"
    h=$(printf '%s' "$header"  | b64)
    p=$(printf '%s' "$payload" | b64)
    sig=$(printf '%s' "${h}.${p}" | openssl dgst -binary -sha256 -hmac "$JWT_SECRET" | b64)
    printf '%s.%s.%s' "$h" "$p" "$sig"
  }
  ANON_KEY="$(jwt anon)"
  SERVICE_KEY="$(jwt service_role)"

  cp "$SUPA_DIR/.env.example" "$SUPA_DIR/.env"
  set_env() { grep -q "^$1=" "$SUPA_DIR/.env" \
    && sed -i "s|^$1=.*|$1=$2|" "$SUPA_DIR/.env" \
    || echo "$1=$2" >> "$SUPA_DIR/.env"; }

  set_env POSTGRES_PASSWORD   "$POSTGRES_PASSWORD"
  set_env JWT_SECRET          "$JWT_SECRET"
  set_env ANON_KEY            "$ANON_KEY"
  set_env SERVICE_ROLE_KEY    "$SERVICE_KEY"
  set_env DASHBOARD_USERNAME  "portal"
  set_env DASHBOARD_PASSWORD  "$DASH_PASS"
  set_env SECRET_KEY_BASE     "$(openssl rand -hex 32)"
  set_env VAULT_ENC_KEY       "$(openssl rand -hex 16)"
  set_env POOLER_TENANT_ID    "portal"
  set_env STUDIO_DEFAULT_ORGANIZATION "Portal Producao"
  set_env STUDIO_DEFAULT_PROJECT      "portal-producao"

  ok "Supabase .env gerado (senha do Studio: $DASH_PASS)"
else
  POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' "$SUPA_DIR/.env" | cut -d= -f2-)"
  DASH_PASS="$(grep '^DASHBOARD_PASSWORD=' "$SUPA_DIR/.env" | cut -d= -f2-)"
  ok "Supabase .env preservado"
fi

# Postgres afinado para 4 GB / 1 vCPU
mkdir -p "$SUPA_DIR/volumes/db"
cat > "$SUPA_DIR/volumes/db/99-portal-tuning.sql" <<'SQL'
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '768MB';
ALTER SYSTEM SET work_mem = '8MB';
ALTER SYSTEM SET maintenance_work_mem = '64MB';
ALTER SYSTEM SET max_connections = '60';
SQL

log "     subindo a stack (pode levar alguns minutos na primeira vez)"
( cd "$SUPA_DIR" && docker compose pull -q && docker compose up -d )

log "     aguardando o Postgres aceitar conexão"
# Porta 5432 é o pooler (supavisor), não o Postgres nu — exige usuário no
# formato "postgres.<tenant>" (tenant = POOLER_TENANT_ID acima).
for i in $(seq 1 60); do
  if PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p 5432 -U postgres.portal -d postgres -qc 'select 1' >/dev/null 2>&1; then
    ok "postgres respondendo"; break
  fi
  [[ $i -eq 60 ]] && { echo "Postgres não subiu. Veja: cd $SUPA_DIR && docker compose logs db"; exit 1; }
  sleep 5
done

# ---------------------------------------------------------------------
log "5/11  Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
ok "node $(node -v)"

# ---------------------------------------------------------------------
log "6/11  Código da aplicação"
cp "$SRC_DIR/bot.mjs"                       "$APP_DIR/bot.mjs"
cp "$SRC_DIR/schema.sql"                    "$APP_DIR/schema.sql"
cp "$SRC_DIR/lib/db.mjs"                    "$APP_DIR/lib/db.mjs"
cp "$SRC_DIR/agentes/radar-eventos.mjs"     "$APP_DIR/agentes/radar-eventos.mjs"
cp "$SRC_DIR/agentes/analista-materias.mjs" "$APP_DIR/agentes/analista-materias.mjs"

cat > "$APP_DIR/package.json" <<'JSON'
{
  "name": "portal-producao",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@anthropic-ai/sdk": "^0.70.0",
    "pg": "^8.13.0"
  }
}
JSON

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" npm install --prefix "$APP_DIR" --silent --omit=dev
ok "dependências instaladas"

# ---------------------------------------------------------------------
log "7/11  Arquivo .env da aplicação"
if [[ ! -f "$APP_DIR/.env" ]]; then
  cat > "$APP_DIR/.env" <<ENV
# ---- banco (Supabase self-hosted, localhost) ----
DATABASE_URL=postgresql://postgres.portal:${POSTGRES_PASSWORD}@127.0.0.1:5432/${DB_NAME}

# ---- Telegram (PREENCHER) ----
# Token: fale com @BotFather   |   Seu ID: fale com @userinfobot
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=

# ---- Claude API (PREENCHER) ----
ANTHROPIC_API_KEY=

# ---- parâmetros do escopo ----
TETO_PESQUISAS_DIA=100
JANELA_HORAS=24
NOTA_CORTE=45
TZ=${TZ_ALVO}
ENV
  ok ".env criado"
else
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://postgres.portal:${POSTGRES_PASSWORD}@127.0.0.1:5432/${DB_NAME}|" "$APP_DIR/.env"
  ok ".env preservado (DATABASE_URL sincronizado)"
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# ---------------------------------------------------------------------
log "8/11  Schema do banco"
PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres.portal -d "$DB_NAME" \
  -q -v ON_ERROR_STOP=1 -f "$APP_DIR/schema.sql"
TABELAS=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres.portal -d "$DB_NAME" -tAc \
  "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';")
ok "$TABELAS tabelas no schema public"

# ---------------------------------------------------------------------
log "9/11  Script da rodada"
cat > "$APP_DIR/rodada.sh" <<'SH'
#!/usr/bin/env bash
# Cadeia diária: radar coleta → analista lê e ranqueia.
set -uo pipefail
cd /opt/portal-producao
echo "===== rodada $(date -Is) ====="

node agentes/radar-eventos.mjs
STATUS_RADAR=$?

if [[ $STATUS_RADAR -ne 0 ]]; then
  echo "radar falhou (exit $STATUS_RADAR) — analista NÃO será executado"
  exit $STATUS_RADAR
fi

node agentes/analista-materias.mjs
echo "===== fim $(date -Is) ====="
SH
chmod +x "$APP_DIR/rodada.sh"
chown "$APP_USER:$APP_USER" "$APP_DIR/rodada.sh"
ok "rodada.sh pronto"

# ---------------------------------------------------------------------
log "10/11  systemd, sudoers e logrotate"

cat > /etc/systemd/system/portal-bot.service <<UNIT
[Unit]
Description=Portal Producao - bot do Telegram
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node ${APP_DIR}/bot.mjs
Restart=always
RestartSec=10
StandardOutput=append:${APP_DIR}/logs/bot.log
StandardError=append:${APP_DIR}/logs/bot.log
MemoryMax=384M

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/portal-rodada.service <<UNIT
[Unit]
Description=Portal Producao - rodada diaria (radar + analista)
After=network-online.target docker.service

[Service]
Type=oneshot
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${APP_DIR}/rodada.sh
TimeoutStartSec=5400
StandardOutput=append:${APP_DIR}/logs/rodada.log
StandardError=append:${APP_DIR}/logs/rodada.log
UNIT

cat > /etc/systemd/system/portal-rodada.timer <<UNIT
[Unit]
Description=Dispara a rodada todo dia as 00:00 (America/Sao_Paulo)

[Timer]
OnCalendar=*-*-* 00:00:00
Persistent=true
Unit=portal-rodada.service

[Install]
WantedBy=timers.target
UNIT

# Permite ao bot disparar SÓ este serviço, sem senha (comando @claude now)
cat > /etc/sudoers.d/portal-rodada <<SUDO
${APP_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl start portal-rodada.service
SUDO
chmod 440 /etc/sudoers.d/portal-rodada
visudo -cf /etc/sudoers.d/portal-rodada >/dev/null

cat > /etc/logrotate.d/portal-producao <<ROT
${APP_DIR}/logs/*.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
ROT

systemctl daemon-reload
systemctl enable --now portal-rodada.timer
ok "timer ativo · sudoers do @claude now instalado"

if grep -q '^TELEGRAM_BOT_TOKEN=.\+' "$APP_DIR/.env"; then
  systemctl enable --now portal-bot.service
  ok "bot iniciado"
else
  systemctl enable portal-bot.service >/dev/null
  warn "bot NÃO iniciado — falta preencher TELEGRAM_BOT_TOKEN no .env"
fi

# ---------------------------------------------------------------------
log "11/11  Firewall e segurança"
ufw --force reset >/dev/null
ufw default deny incoming  >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH          >/dev/null
ufw --force enable         >/dev/null
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
ok "ufw (só SSH) · fail2ban · updates automáticos"

warn "O Studio do Supabase NÃO está exposto. Para abrir, use túnel SSH do seu PC:"
warn "    ssh -L 8000:localhost:8000 root@SEU_IP    →  http://localhost:8000"

# =====================================================================
cat <<FIM

=====================================================================
  INSTALAÇÃO CONCLUÍDA
=====================================================================

  App:        ${APP_DIR}
  Supabase:   ${SUPA_DIR}
  Studio:     http://localhost:8000 (via túnel SSH)
              usuário: portal   senha: ${DASH_PASS}
  Timezone:   $(timedatectl show -p Timezone --value)

  FALTA VOCÊ FAZER:

  1) Token do bot com @BotFather no Telegram
  2) Seu ID numérico com @userinfobot
  3) Chave da API em console.anthropic.com
  4) sudo nano ${APP_DIR}/.env
  5) sudo systemctl restart portal-bot
  6) No Telegram: "@claude ajuda" e depois "@claude now"

  COMANDOS ÚTEIS:
     systemctl status portal-bot
     journalctl -u portal-bot -f
     tail -f ${APP_DIR}/logs/rodada.log
     systemctl list-timers portal-rodada.timer
     systemctl start portal-rodada          # roda na mão
     cd ${SUPA_DIR} && docker compose ps     # saúde do Supabase
     free -h                                 # memória (fique de olho)

=====================================================================
FIM
