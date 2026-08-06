/**
 * AGENTE 2 — SELETOR DE LINKS (versão enxuta)
 *
 * Diferença pro Agente 1 (congelado na tag agente-v1-analise-completa):
 *   - NÃO lê a matéria inteira. Só olha título + resumo de busca.
 *   - NÃO escreve análise longa (sem "cruzamento de fontes",
 *     "o que aconteceu", "leitura pro produtor"). Você lê a matéria
 *     e faz essa parte na sua cabeça, depois de clicar no link.
 *   - Roda num modelo mais barato (Haiku) — tarefa de ranquear título
 *     não precisa do "cérebro" caro do Opus.
 *   - Entrega: as 100 numa tabela com nota, e os 10 melhores com
 *     link + 1 linha do motivo. Você decide o resto na mão.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db, telegram, lerTemperaturas, agora } from '../lib/db.mjs';

const client = new Anthropic();
const MODEL = 'claude-haiku-4-5'; // tarefa leve (ranquear título/resumo) — não precisa de modelo caro
const CORTE = Number(process.env.NOTA_CORTE || 45);

// ---------------------------------------------------------------- gatilho

async function rodadaDoDia() {
  const { rows } = await db.query(
    `select id, concluido, rodou_em, noticias_gravadas, perfil_temperatura
       from log_execucao
      where rodou_em >= now() - interval '24 hours'
      order by rodou_em desc limit 1`
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- prompt

const SISTEMA = `Você é o SELETOR DE LINKS do Portal Produção — versão enxuta do analista.

Você recebe até 100 notícias coletadas SÓ por título e resuminho de busca (ninguém leu a matéria inteira ainda). Sua tarefa é ESCOLHER OS 10 LINKS mais promissores pro Gabriel abrir e ler ele mesmo — não é escrever análise, é RANQUEAR.

O portal é sobre QUEM PRODUZ eventos, não sobre quem canta. Leitor-núcleo: produtor de 600 a 1.000 pessoas, em Marília e nos DDDs 014 e 018.

PONTUAÇÃO (0 a 100) — baseada só no que dá pra ver no título/resumo:
- Proximidade geográfica ........................ 30 (C1=30 · C2=24 · C3=21 · C4=12 · C5=6)
- Relevância pro produtor de 600–1.000 (pelo título) 25
- Ênfase de estilo OU tipo de evento ............. 15 (funk, sertanejo, pagode, trap, eletrônica OU universitário, corrida)
- Nicho de risco/interesse alto (pelo título) .... 15 (cancelamento, calote, violência, arma, assédio, cachê)
- Ineditismo (não é a mesma notícia repetida em N portais) 10
- Fonte parece confiável (portal conhecido vs rede social) 5

PENALIDADES:
-40 evento gospel (fora do escopo)
-20 título vago demais pra saber do que se trata
-15 sem data reconhecível
-10 fonte é só rede social sem nenhum portal cobrindo

NOTA DE CORTE: ${CORTE}. Se menos de 10 passarem, entregue menos de 10 e diga isso claramente.

REGRAS INVIOLÁVEIS:
1. Você está julgando só pelo título/resumo — não invente detalhe que não está ali.
2. Gospel não é nicho do portal.
3. O motivo de cada escolha do Top 10 tem que ser 1 linha, direto, sem inventar conteúdo da matéria que você não leu.
4. Diga quando o lote do dia veio fraco. Não force 10 escolhas boas se não tiver 10 boas.`;

const SCHEMA = {
  type: 'object',
  properties: {
    avaliacoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'Número de referência da notícia na lista enviada' },
          nota: { type: 'integer' },
          no_top10: { type: 'boolean' },
          posicao_ranking: { type: ['integer', 'null'] },
          motivo: { type: 'string', description: '1 linha, só pra quem tá no Top 10 — pra quem não tá, deixe vazio' },
        },
        required: ['ref', 'nota', 'no_top10', 'posicao_ranking', 'motivo'],
        additionalProperties: false,
      },
    },
    lote_fraco: { type: 'boolean' },
    observacao: { type: 'string', description: 'Uma linha sobre o lote do dia — o que faltou, o que veio forte' },
  },
  required: ['avaliacoes', 'lote_fraco', 'observacao'],
  additionalProperties: false,
};

// ---------------------------------------------------------------- main

async function main() {
  console.log(`[${agora()}] seletor-de-links (v2) iniciando`);

  const rodada = await rodadaDoDia();
  if (!rodada || !rodada.concluido) {
    const msg = `<b>SELEÇÃO BLOQUEADA</b>\nRadar ainda não terminou (ou não rodou hoje).\n` +
      (rodada ? `Rodada de ${new Date(rodada.rodou_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} está com concluido=false.` : 'Nenhuma rodada nas últimas 24h.');
    console.log(msg);
    await telegram(msg);
    await db.end();
    return;
  }

  const { rows: noticias } = await db.query(
    `select * from noticias
      where coletado_em >= now() - interval '24 hours'
      order by coletado_em desc`
  );

  if (!noticias.length) {
    await telegram(`<b>BANCO VAZIO</b> — ${agora()}\nO radar rodou mas não gravou nada nesta janela.`);
    await db.end();
    return;
  }

  const { mapa: temp } = await lerTemperaturas();
  const enfase = Object.entries(temp).filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`).join(' · ') || 'perfil neutro';

  const payload = noticias.map((n, i) => ({
    ref: i + 1,
    titulo: n.titulo_original,
    resumo: n.texto_bruto, // aqui já é só o resuminho de busca, não a matéria inteira
    veiculo: n.veiculo,
    tipo_fonte: n.tipo_fonte,
    url: n.url_fonte,
    data_ocorrido: n.data_ocorrido,
    evento: n.evento, cidade: n.cidade, uf: n.uf, camada_geo: n.camada_geo,
    artistas: n.artistas, estilo: n.estilo_musical,
    tipo_evento: n.tipo_evento, nichos: n.nichos, sentimento: n.sentimento,
  }));

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: SISTEMA,
    messages: [{
      role: 'user',
      content: `Ranqueie as ${payload.length} notícias coletadas (só título/resumo de busca, ninguém leu a matéria).

PERFIL DE TEMPERATURA ATIVO:
${enfase}
Aplique como reforço no critério correspondente. Gospel continua fora do escopo mesmo com temperatura.

Pontue TODAS. Marque no_top10=true e posicao_ranking (1 a 10) só nas melhores que passarem de ${CORTE}. Motivo só pras do Top 10.

NOTÍCIAS:
${JSON.stringify(payload)}`,
    }],
  });

  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    await telegram(`<b>SELEÇÃO RECUSADA</b>\nCategoria: ${msg.stop_details?.category ?? '?'}`);
    await db.end();
    return;
  }

  const texto = msg.content.find((b) => b.type === 'text')?.text ?? '{}';
  const r = JSON.parse(texto);
  const avaliacoes = (r.avaliacoes ?? []).sort((a, b) => b.nota - a.nota);

  for (const a of avaliacoes) {
    const n = noticias[a.ref - 1];
    if (!n) continue;
    await db.query(
      `insert into analises (noticia_id, nota, posicao_ranking, no_top10, justificativa)
       values ($1,$2,$3,$4,$5)`,
      [n.id, a.nota, a.posicao_ranking, a.no_top10, a.motivo ?? '']
    );
  }

  // ---------------------------------------------------------- PARTE 1
  const conta = (campo) => {
    const m = {};
    for (const n of noticias) {
      const v = Array.isArray(n[campo]) ? n[campo] : [n[campo]];
      for (const x of v) if (x) m[x] = (m[x] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' | ') || '—';
  };

  let p1 = `<b>LINKS DO DIA</b> — ${agora()}\n` +
    `Total coletado: <b>${noticias.length}</b>\n\n` +
    `<b>RESUMO</b>\n` +
    `Camada: ${conta('camada_geo')}\n` +
    `Estilo: ${conta('estilo_musical')}\n` +
    `Tipo:   ${conta('tipo_evento')}\n` +
    `Nicho:  ${conta('nichos')}\n\n` +
    `<b>TABELA DOS ${noticias.length} LINKS</b>\n<pre>`;

  avaliacoes.forEach((a, i) => {
    const n = noticias[a.ref - 1];
    if (!n) return;
    p1 += `${String(i + 1).padStart(3)} ${String(a.nota).padStart(3)} ${(n.evento || '?').slice(0, 26).padEnd(26)} ${(n.cidade || '?').slice(0, 14).padEnd(14)} C${n.camada_geo} ${(n.veiculo || '').slice(0, 16)}\n`;
  });
  p1 += '</pre>';
  await telegram(p1);

  // ---------------------------------------------------------- PARTE 2
  const top = avaliacoes.filter((a) => a.no_top10).sort((a, b) => (a.posicao_ranking ?? 99) - (b.posicao_ranking ?? 99));

  let p2 = `<b>OS ${top.length} LINKS ESCOLHIDOS</b>\n`;
  if (r.lote_fraco) p2 += `<i>⚠ Lote fraco hoje: menos de 10 passaram da nota ${CORTE}.</i>\n`;
  p2 += `<i>${r.observacao || ''}</i>\n\n`;

  for (const a of top) {
    const n = noticias[a.ref - 1];
    if (!n) continue;
    p2 +=
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>#${a.posicao_ranking} — NOTA ${a.nota}/100</b>\n` +
      `${n.evento || n.titulo_original}\n` +
      `${n.cidade}/${n.uf} · Camada ${n.camada_geo} · ${n.veiculo}\n` +
      `${a.motivo}\n` +
      `👉 ${n.url_fonte}\n\n`;
  }

  p2 += `━━━━━━━━━━━━━━━━━━━━\n<i>Lembra: ninguém leu a matéria ainda. Clica, lê, e faz o cruzamento de fonte na hora.</i>`;
  await telegram(p2);

  console.log(`[${agora()}] seleção concluída: ${avaliacoes.length} avaliadas, ${top.length} escolhidos`);
  await db.end();
}

main().catch(async (e) => {
  console.error('FALHA:', e);
  await telegram(`<b>SELETOR-DE-LINKS FALHOU</b>\n${e.message}`);
  await db.end().catch(() => {});
  process.exit(1);
});
