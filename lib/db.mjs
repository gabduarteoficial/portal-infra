/**
 * Conexão com o Postgres do Supabase (self-hosted, localhost).
 * Usado pelo bot e pelos dois agentes.
 */
import pg from 'pg';

export const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 30_000,
});

export const TZ = 'America/Sao_Paulo';

export const agora = () =>
  new Date().toLocaleString('pt-BR', { timeZone: TZ });

/** Envia mensagem no Telegram. Divide em pedaços de 3.800 chars. */
export async function telegram(texto, { html = true } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_OWNER_ID;
  if (!token || !chat) return;

  const partes = [];
  let resto = texto;
  while (resto.length > 3800) {
    let corte = resto.lastIndexOf('\n', 3800);
    if (corte < 2000) corte = 3800;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte);
  }
  partes.push(resto);

  for (const parte of partes) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: parte,
        parse_mode: html ? 'HTML' : undefined,
        disable_web_page_preview: true,
      }),
    }).catch((e) => console.error('telegram:', e.message));
  }
}

/** Lê o perfil de temperatura ativo como { chave: valor }. */
export async function lerTemperaturas() {
  const { rows } = await db.query(
    `select chave, dimensao, valor from temperaturas`
  );
  const mapa = {};
  for (const r of rows) mapa[r.chave] = r.valor;
  return { mapa, linhas: rows };
}

/** peso_final = peso_base * (1 + temperatura/100) */
export const aplicarTemp = (pesoBase, temp = 0) =>
  pesoBase * (1 + (temp || 0) / 100);
