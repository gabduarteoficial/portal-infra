/**
 * PORTAL PRODUÇÃO — bot do Telegram (camada de controle)
 *
 * Comandos (com @claude na frente, ou direto no privado):
 *   @claude funk +40 mega -30   → ajusta temperatura (-100 a +100)
 *   @claude now                 → DISPARA A RODADA AGORA (sem esperar 00:00)
 *   @claude temperatura         → mostra o perfil ativo
 *   @claude reset               → zera tudo
 *   @claude perfil salvar <nome> | perfil usar <nome> | perfis
 *   @claude status              → última rodada do radar
 *   @claude top10 | @claude 100 → reenvia a análise do dia
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { db, agora } from './lib/db.mjs';

const execAsync = promisify(exec);

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = String(process.env.TELEGRAM_OWNER_ID || '');
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN || !OWNER) {
  console.error('Faltando TELEGRAM_BOT_TOKEN ou TELEGRAM_OWNER_ID no .env');
  process.exit(1);
}

/** Chaves fora do escopo — travas da seção 6-B.4 do ESCOPO. */
const TRAVAS = new Set([
  'gospel', 'agenda', 'agenda_cultural', 'fim_de_semana', 'sazonal',
  'janela', '24h', 'teto', 'corte',
]);

const tg = (method, payload) =>
  fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

const responder = (chatId, texto) =>
  tg('sendMessage', { chat_id: chatId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true });

const sinal = (v) => (v > 0 ? `+${v}` : String(v));

// ---------------------------------------------------------------- comandos

async function mostrarTemperatura(chatId) {
  const { rows } = await db.query(
    `select chave, dimensao, valor from temperaturas order by dimensao, chave`
  );
  const porDim = {};
  for (const r of rows) (porDim[r.dimensao] ??= []).push(r);

  let out = '<b>PERFIL DE TEMPERATURA ATIVO</b>\n';
  for (const [dim, itens] of Object.entries(porDim)) {
    const ativos = itens.filter((i) => i.valor !== 0);
    out += `\n<b>${dim}</b>\n` +
      (ativos.length
        ? ativos.map((i) => `  ${i.chave}: <b>${sinal(i.valor)}</b>`).join('\n') + '\n'
        : '  (tudo neutro)\n');
  }
  return responder(chatId, out + '\n<i>Só aparece detalhado o que está fora de 0.</i>');
}

async function ajustar(chatId, pares, quem) {
  const ok = [], erro = [], travado = [];

  for (const [chave, valorStr] of pares) {
    const valor = parseInt(valorStr, 10);
    if (TRAVAS.has(chave)) { travado.push(chave); continue; }
    if (Number.isNaN(valor) || valor < -100 || valor > 100) {
      erro.push(`${chave} (fora de -100..+100)`); continue;
    }
    const r = await db.query(
      `update temperaturas set valor=$1, atualizado_em=now(), atualizado_por=$2
        where chave=$3 returning chave`,
      [valor, quem, chave]
    );
    r.rowCount ? ok.push(`${chave}: ${sinal(valor)}`) : erro.push(`${chave} (chave desconhecida)`);
  }

  let out = '';
  if (ok.length) out += `<b>Ajustado</b>\n${ok.map((s) => '  ' + s).join('\n')}\n\n`;
  if (travado.length) out += `<b>Bloqueado — trava do escopo</b>\n${travado.map((s) => '  ' + s).join('\n')}\n<i>Fora do escopo do portal. Não aceita temperatura.</i>\n\n`;
  if (erro.length) out += `<b>Não reconhecido</b>\n${erro.map((s) => '  ' + s).join('\n')}\n`;

  return responder(chatId, out || 'Nada pra ajustar. Ex.: <code>@claude funk +40</code>');
}

/** @claude now — dispara a rodada imediatamente. */
async function rodarAgora(chatId) {
  try {
    const { stdout } = await execAsync('systemctl is-active portal-rodada.service || true');
    if (stdout.trim() === 'activating' || stdout.trim() === 'active') {
      return responder(chatId, '⏳ Já tem uma rodada em andamento. Aguarde ela terminar.');
    }
  } catch { /* is-active retorna != 0 quando inativo; segue */ }

  try {
    // Marca "forçar" pra rodada.sh pular a checagem de dia (seg/qui/dom).
    // Não precisa de sudo — o bot já roda como o mesmo usuário que a rodada.
    await execAsync('touch /opt/portal-producao/.forcar-rodada');
    await execAsync('sudo -n /usr/bin/systemctl start portal-rodada.service');
    return responder(
      chatId,
      `🚀 <b>Rodada disparada</b> — ${agora()}\n\n` +
      `O radar vai coletar (janela dinâmica, teto de 100 pesquisas) e o seletor entra em seguida.\n` +
      `Você recebe o log do radar e depois os 100 links + os 10 escolhidos.\n\n` +
      `<i>Disparo manual sempre roda, mesmo fora do dia de agenda (seg/qui/dom). Costuma levar de 5 a 20 minutos.</i>`
    );
  } catch (e) {
    return responder(chatId, `❌ Não consegui disparar: <code>${e.message}</code>`);
  }
}

async function resetar(chatId, quem) {
  await db.query(`update temperaturas set valor=0, atualizado_em=now(), atualizado_por=$1`, [quem]);
  return responder(chatId, 'Temperatura zerada. Tudo voltou ao padrão do escopo.');
}

async function salvarPerfil(chatId, nome) {
  const { rows } = await db.query(`select chave, valor from temperaturas`);
  const config = Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  await db.query(
    `insert into perfis_temperatura (nome, config) values ($1,$2)
       on conflict (nome) do update set config=excluded.config, criado_em=now()`,
    [nome, JSON.stringify(config)]
  );
  return responder(chatId, `Perfil <b>${nome}</b> salvo.`);
}

async function usarPerfil(chatId, nome, quem) {
  const { rows } = await db.query(`select config from perfis_temperatura where nome=$1`, [nome]);
  if (!rows.length) return responder(chatId, `Perfil <b>${nome}</b> não existe.`);
  for (const [chave, valor] of Object.entries(rows[0].config)) {
    await db.query(
      `update temperaturas set valor=$1, atualizado_em=now(), atualizado_por=$2 where chave=$3`,
      [valor, quem, chave]
    );
  }
  return responder(chatId, `Perfil <b>${nome}</b> aplicado.`);
}

async function listarPerfis(chatId) {
  const { rows } = await db.query(`select nome from perfis_temperatura order by criado_em desc`);
  return responder(chatId, rows.length
    ? '<b>Perfis salvos</b>\n' + rows.map((r) => '  ' + r.nome).join('\n')
    : 'Nenhum perfil salvo ainda.');
}

async function status(chatId) {
  const { rows } = await db.query(
    `select rodou_em, pesquisas_gastas, noticias_gravadas, duplicatas_descartadas, concluido, erros
       from log_execucao order by rodou_em desc limit 1`
  );
  if (!rows.length) return responder(chatId, 'O radar ainda não rodou nenhuma vez.');
  const r = rows[0];
  return responder(chatId,
    `<b>ÚLTIMA RODADA</b>\n` +
    `Quando: ${new Date(r.rodou_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n` +
    `Pesquisas: ${r.pesquisas_gastas}/100\n` +
    `Notícias gravadas: ${r.noticias_gravadas}\n` +
    `Duplicatas: ${r.duplicatas_descartadas}\n` +
    `Concluído: ${r.concluido ? 'sim — analista liberado' : 'NÃO'}\n` +
    (r.erros?.length ? `\n⚠ ${r.erros.join('\n⚠ ')}` : ''));
}

async function reenviarTop10(chatId) {
  const { rows } = await db.query(`select * from v_top10_hoje`);
  if (!rows.length) return responder(chatId, 'Nenhum Top 10 registrado ainda.');
  return responder(chatId, '<b>ÚLTIMO TOP 10</b>\n\n' + rows.map((r) =>
    `<b>#${r.posicao_ranking} — ${r.nota}/100</b>\n${r.evento} — ${r.cidade}/${r.uf} (C${r.camada_geo})\n` +
    `${r.justificativa}\n👉 ${r.url_fonte}`
  ).join('\n\n'));
}

async function reenviarCem(chatId) {
  // v2: roda 3x/semana, não fixa em "últimas 24h" — pega a ÚLTIMA rodada
  // de análise que existir (janela de 2h cobre a duração de uma rodada).
  const { rows } = await db.query(
    `select a.nota, n.evento, n.cidade, n.uf, n.camada_geo, n.tipo_evento, n.veiculo
       from analises a join noticias n on n.id = a.noticia_id
      where a.analisado_em >= (select max(analisado_em) from analises) - interval '2 hours'
      order by a.nota desc`
  );
  if (!rows.length) return responder(chatId, 'Nenhuma análise registrada ainda.');
  return responder(chatId,
    `<b>TODOS OS ${rows.length} DA ÚLTIMA RODADA</b>\n<pre>` +
    rows.map((r, i) =>
      `${String(i + 1).padStart(3)} ${String(r.nota).padStart(3)} ${(r.evento || '?').slice(0, 26).padEnd(26)} ${(r.cidade || '?').slice(0, 14).padEnd(14)} C${r.camada_geo} ${(r.tipo_evento || '').slice(0, 12)}`
    ).join('\n') + '</pre>');
}

const ajuda = (chatId) => responder(chatId,
  `<b>PORTAL PRODUÇÃO — comandos</b> (Agente 2 — só link)\n\n` +
  `Agenda automática: <b>segunda, quinta e domingo</b> às 00:00 BRT.\n` +
  `Se segunda cair em feriado nacional, pula pra terça.\n\n` +
  `<code>@claude now</code>  🚀 dispara a rodada AGORA (fura a agenda)\n` +
  `<code>@claude funk +40 mega -30</code>  temperatura (-100 a +100)\n` +
  `<code>@claude temperatura</code>  perfil ativo\n` +
  `<code>@claude reset</code>  zera tudo\n` +
  `<code>@claude perfil salvar casa</code> / <code>perfil usar casa</code> / <code>perfis</code>\n` +
  `<code>@claude status</code>  última rodada\n` +
  `<code>@claude top10</code> / <code>@claude 100</code>  reenvia a última seleção de links\n\n` +
  `<i>Esse agente só entrega LINKS — sem ler a matéria inteira. Você abre e lê. Travas do escopo (gospel, teto de 100 buscas, corte 45) não aceitam ajuste.</i>`);

// ---------------------------------------------------------------- roteador

async function processar(m) {
  const chatId = m.chat.id;
  const from = String(m.from?.id || '');
  const texto = (m.text || '').trim();
  if (from !== OWNER || !texto) return;

  const limpo = texto.replace(/^\/?@?claude\b/i, '').replace(/^\/\w+/, '').trim();
  const args = limpo.split(/\s+/).filter(Boolean);
  const cmd = (args[0] || '').toLowerCase();

  if (!limpo || cmd === 'ajuda' || cmd === 'help') return ajuda(chatId);
  if (cmd === 'now' || cmd === 'rodar' || cmd === 'agora') return rodarAgora(chatId);
  if (cmd === 'temperatura' || cmd === 'temp') return mostrarTemperatura(chatId);
  if (cmd === 'reset') return resetar(chatId, from);
  if (cmd === 'status') return status(chatId);
  if (cmd === 'perfis') return listarPerfis(chatId);
  if (cmd === 'top10' || cmd === 'top') return reenviarTop10(chatId);
  if (cmd === '100' || cmd === 'todas') return reenviarCem(chatId);

  if (cmd === 'perfil') {
    const [, acao, nome] = args;
    if (acao?.toLowerCase() === 'salvar' && nome) return salvarPerfil(chatId, nome);
    if (acao?.toLowerCase() === 'usar' && nome) return usarPerfil(chatId, nome, from);
    return responder(chatId, 'Use: <code>@claude perfil salvar &lt;nome&gt;</code> ou <code>perfil usar &lt;nome&gt;</code>');
  }

  const pares = [];
  for (let i = 0; i < args.length - 1; i += 2) pares.push([args[i].toLowerCase(), args[i + 1]]);
  if (pares.length) return ajustar(chatId, pares, from);

  return responder(chatId, 'Não entendi. Manda <code>@claude ajuda</code>.');
}

// ---------------------------------------------------------------- polling

let offset = 0;
async function loop() {
  console.log(`[${agora()}] bot do Portal Produção no ar`);
  for (;;) {
    try {
      const data = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`).then((r) => r.json());
      for (const up of data.result || []) {
        offset = up.update_id + 1;
        if (up.message) await processar(up.message).catch((e) => console.error('handler:', e));
      }
    } catch (e) {
      console.error('polling:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
loop();
