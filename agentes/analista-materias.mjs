/**
 * AGENTE 2 — ANALISTA-MATERIAS
 * Roda SÓ depois que o radar concluir. Lê o banco, mostra as 100 e escolhe as 10.
 * Não cria pasta, não reescreve para publicação, não publica.
 *
 * Spec: ../../agentes/analista-materias.md
 */
import Anthropic from '@anthropic-ai/sdk';
import { db, telegram, lerTemperaturas, agora } from '../lib/db.mjs';

const client = new Anthropic();
const MODEL = 'claude-opus-5';
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

const SISTEMA = `Você é o ANALISTA-MATERIAS do Portal Produção. Você é o olho crítico: o radar é braço, você é cabeça.

O portal é sobre QUEM PRODUZ, não sobre quem canta. Leitor-núcleo: produtor de eventos de 600 a 1.000 pessoas, em Marília e nos DDDs 014 e 018.

PONTUAÇÃO (0 a 100):
- Relevância para produtor de 600–1.000 ......... 25
- Proximidade geográfica ........................ 20 (C1=20 · C2=16 · C3=14 · C4=8 · C5=4)
- Força do cruzamento (versão oficial x público). 15
- Ineditismo .................................... 12
- Densidade de bastidor (camarim/cachê/rider/equipe) 10
- Ênfase de estilo OU tipo de evento ............. 8 (funk, sertanejo, pagode, trap, eletrônica OU universitário, corrida)
- Eixo produtor identificado ..................... 7 (reincidente pontua mais)
- Qualidade da mídia ............................. 5
- Escalada institucional (Procon/MP/Justiça/bombeiros) 3

PENALIDADES (subtrai direto):
-40 evento gospel sem fato de produção independente do estilo (na prática elimina)
-30 fonte única em tema de risco (violência, arma, assédio, calote)
-25 produtor grande / grande produtora SEM a ponte para o produtor de 800
-25 pessoa física nomeada sem fonte oficial (marcar revisao_manual=true)
-20 só release de assessoria, sem contraponto
-15 sem data confirmada do ocorrido
-10 porte nao_informado sem base para estimar
-10 produtor/produtora não identificável e sem lacuna declarada

NOTA DE CORTE: ${CORTE}. Se menos de 10 passarem, entregue menos de 10 e explique. NUNCA complete a lista com item fraco.

EIXOS DE ANÁLISE: camarim, backstage, cachê, rider, cancelamento, reembolso, trânsito/acesso, atraso de pagamento, arma de fogo, assédio, golpes, reclamação de equipe, avaliações, produtoras, artistas, tipo de evento, notícia positiva, notícia negativa.

PORTE DO PRODUTOR: pequeno (até 1.000 — pessoa física, atlética, coletivo, dono de bar) · medio (1.000–10.000) · grande (10.000+, regional) · grande_produtora (nacional: Live Nation, Opus, T4F, Rock World, XP Music, Bras Rodeo).

REGRAS INVIOLÁVEIS:
1. Rede social é repercussão, NUNCA fato.
2. Violência, arma, assédio, calote: fonte oficial OU 2 portais independentes. Abaixo disso → penalidade e vai para "de olho", não para o Top 10.
3. NUNCA nomeie pessoa física em caso criminal sem fonte oficial.
4. NUNCA invente fonte, número, citação ou crédito.
5. Divergência entre fontes vai INTEIRA para o relatório. Escolher versão é decisão do Gabriel.
6. Gospel não é nicho do portal.
7. Toda notícia responde "quem produziu". Se não dá, vira lacuna declarada.
8. NÃO sugira legenda, capa ou roteiro de post — não é sua função.
9. Diga quando o dia foi fraco. Ranking sem candidato bom é ranking mentiroso.`;

const SCHEMA = {
  type: 'object',
  properties: {
    avaliacoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'O número de referência da notícia na lista enviada' },
          nota: { type: 'integer' },
          no_top10: { type: 'boolean' },
          posicao_ranking: { type: ['integer', 'null'] },
          eixos_ativados: { type: 'array', items: { type: 'string' } },
          porte_produtor: { type: 'string' },
          produtora_reincidente: { type: 'boolean' },
          revisao_manual: { type: 'boolean' },
          justificativa: { type: 'string', description: 'Por que está (ou não está) no Top 10. 1 a 2 linhas.' },
          o_que_aconteceu: { type: 'string', description: 'Factual, 2 a 4 linhas. Só para os do Top 10; vazio para os demais.' },
          cruzamento: { type: 'string', description: 'Versão oficial / versão do público / onde divergem / dado duro. Só Top 10.' },
          leitura_produtor: { type: 'string', description: 'O que um produtor de 600 a 1.000 aprende com isso. Só Top 10.' },
          lacunas: { type: 'string' },
        },
        required: ['ref','nota','no_top10','posicao_ranking','eixos_ativados','porte_produtor','produtora_reincidente','revisao_manual','justificativa','o_que_aconteceu','cruzamento','leitura_produtor','lacunas'],
        additionalProperties: false,
      },
    },
    de_olho: { type: 'array', items: { type: 'string' }, description: 'Fora do Top 10 mas de olho: item — o que falta — quando reconferir' },
    silencio_relevante: { type: 'string', description: 'O que o banco NÃO trouxe hoje e por que isso importa' },
    dia_fraco: { type: 'boolean' },
  },
  required: ['avaliacoes', 'de_olho', 'silencio_relevante', 'dia_fraco'],
  additionalProperties: false,
};

// ---------------------------------------------------------------- main

async function main() {
  console.log(`[${agora()}] analista-materias iniciando`);

  const rodada = await rodadaDoDia();
  if (!rodada || !rodada.concluido) {
    const msg = `<b>ANÁLISE BLOQUEADA</b>\nRadar ainda não terminou (ou não rodou hoje).\n` +
      (rodada ? `Rodada de ${new Date(rodada.rodou_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} está com concluido=false.` : 'Nenhuma rodada nas últimas 24h.');
    console.log(msg);
    await telegram(msg);
    await db.end();
    return;
  }

  const { rows: noticias } = await db.query(
    `select n.*, count(m.id)::int qtd_midia,
            (select count(*)::int from noticias x
              where x.produtora = n.produtora and x.produtora is not null and x.produtora <> ''
                and x.coletado_em >= now() - interval '90 days') as ocorrencias_produtora
       from noticias n
       left join midias m on m.noticia_id = n.id
      where n.coletado_em >= now() - interval '24 hours'
      group by n.id
      order by n.coletado_em desc`
  );

  if (!noticias.length) {
    await telegram(`<b>BANCO VAZIO</b> — ${agora()}\nO radar rodou mas não gravou nada nas últimas 24h.`);
    await db.end();
    return;
  }

  const { mapa: temp } = await lerTemperaturas();
  const enfase = Object.entries(temp).filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`).join(' · ') || 'perfil neutro';

  // payload compacto — texto_bruto truncado só para a análise (o banco mantém o cru)
  const payload = noticias.map((n, i) => ({
    ref: i + 1,
    titulo: n.titulo_original,
    texto: (n.texto_bruto || '').slice(0, 1500),
    veiculo: n.veiculo,
    tipo_fonte: n.tipo_fonte,
    url: n.url_fonte,
    data_ocorrido: n.data_ocorrido,
    evento: n.evento, cidade: n.cidade, uf: n.uf, camada_geo: n.camada_geo,
    local: n.local_evento, artistas: n.artistas, estilo: n.estilo_musical,
    tipo_evento: n.tipo_evento, porte_produtor: n.porte_produtor,
    produtora: n.produtora, ocorrencias_produtora_90d: n.ocorrencias_produtora,
    ticketeira: n.ticketeira, nichos: n.nichos,
    porte_publico: n.porte_publico, publico: n.publico_estimado,
    e_estimativa: n.publico_e_estimativa, sentimento: n.sentimento,
    tem_versao_oficial: n.tem_versao_oficial, tem_registro_publico: n.tem_registro_publico,
    lacunas: n.lacunas, qtd_midia: n.qtd_midia,
  }));

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh', format: { type: 'json_schema', schema: SCHEMA } },
    system: SISTEMA,
    messages: [{
      role: 'user',
      content: `Analise as ${payload.length} notícias coletadas nas últimas 24h.

PERFIL DE TEMPERATURA ATIVO (ajuste de peso definido pelo Gabriel):
${enfase}
Aplique como multiplicador no critério correspondente: peso_final = peso_base × (1 + temperatura/100).
Temperatura NÃO fura trava do escopo: gospel, agenda cultural, janela de 24h, teto de 100 e a nota de corte ${CORTE} continuam valendo.

Pontue TODAS as ${payload.length}. Marque no_top10=true e preencha posicao_ranking (1 a 10) apenas nas melhores que passarem de ${CORTE}.
Para as do Top 10, preencha o_que_aconteceu, cruzamento e leitura_produtor. Para as demais, deixe esses campos vazios.

NOTÍCIAS:
${JSON.stringify(payload)}`,
    }],
  });

  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    await telegram(`<b>ANÁLISE RECUSADA</b>\nCategoria: ${msg.stop_details?.category ?? '?'}`);
    await db.end();
    return;
  }

  const texto = msg.content.find((b) => b.type === 'text')?.text ?? '{}';
  const r = JSON.parse(texto);
  const avaliacoes = (r.avaliacoes ?? []).sort((a, b) => b.nota - a.nota);

  // grava no banco
  for (const a of avaliacoes) {
    const n = noticias[a.ref - 1];
    if (!n) continue;
    await db.query(
      `insert into analises (noticia_id, nota, posicao_ranking, no_top10, eixos_ativados,
                             porte_produtor, produtora_reincidente, justificativa, lacunas)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [n.id, a.nota, a.posicao_ranking, a.no_top10, a.eixos_ativados ?? [],
       a.porte_produtor, a.produtora_reincidente ?? false, a.justificativa ?? '', a.lacunas ?? '']
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

  let p1 = `<b>BANCO DO DIA</b> — ${agora()}\n` +
    `Total coletado: <b>${noticias.length}</b> | Mídias: ${noticias.reduce((a, n) => a + n.qtd_midia, 0)}\n\n` +
    `<b>RESUMO POR CORTE</b>\n` +
    `Camada:   ${conta('camada_geo')}\n` +
    `Porte:    ${conta('porte_publico')}\n` +
    `Estilo:   ${conta('estilo_musical')}\n` +
    `Tipo:     ${conta('tipo_evento')}\n` +
    `Produtor: ${conta('porte_produtor')}\n` +
    `Nicho:    ${conta('nichos')}\n` +
    `Tom:      ${conta('sentimento')}\n\n` +
    `<b>TABELA DAS ${noticias.length}</b>\n<pre>`;

  avaliacoes.forEach((a, i) => {
    const n = noticias[a.ref - 1];
    if (!n) return;
    p1 += `${String(i + 1).padStart(3)} ${String(a.nota).padStart(3)} ${(n.evento || '?').slice(0, 26).padEnd(26)} ${(n.cidade || '?').slice(0, 14).padEnd(14)} C${n.camada_geo} ${(n.porte_publico || '').slice(0, 6).padEnd(6)} ${(n.tipo_evento || '').slice(0, 12).padEnd(12)} ${(n.veiculo || '').slice(0, 14)}\n`;
  });
  p1 += '</pre>';

  await telegram(p1);

  // ---------------------------------------------------------- PARTE 2
  const top = avaliacoes.filter((a) => a.no_top10).sort((a, b) => (a.posicao_ranking ?? 99) - (b.posicao_ranking ?? 99));

  let p2 = `<b>AS ${top.length} ESCOLHIDAS</b>\n`;
  if (r.dia_fraco) p2 += `<i>⚠ Dia fraco: menos de 10 notícias passaram da nota ${CORTE}.</i>\n`;
  p2 += '\n';

  for (const a of top) {
    const n = noticias[a.ref - 1];
    if (!n) continue;
    p2 +=
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>#${a.posicao_ranking} — NOTA ${a.nota}/100</b>\n` +
      `Evento: ${n.evento}\nCidade: ${n.cidade}/${n.uf} · Camada ${n.camada_geo}\n` +
      `Porte: ${n.porte_publico}${n.publico_estimado ? ` (~${n.publico_estimado}${n.publico_e_estimativa ? ', estimativa' : ''})` : ''}\n` +
      `Estilo: ${(n.estilo_musical ?? []).join(', ') || '—'} · Tipo: ${n.tipo_evento} · Tom: ${n.sentimento}\n` +
      `Nicho(s): ${(n.nichos ?? []).join(', ')}\n` +
      `Artista(s): ${(n.artistas ?? []).join(', ') || '—'} · Ticketeira: ${n.ticketeira || '—'}\n\n` +
      `<b>QUEM PRODUZIU</b>\n${n.produtora || 'não identificado'} · porte: ${a.porte_produtor}\n` +
      (a.produtora_reincidente ? `⚠ reincidente: ${n.ocorrencias_produtora} ocorrências em 90 dias\n` : '') +
      `\n<b>O QUE ACONTECEU</b>\n${a.o_que_aconteceu}\n` +
      `\n<b>EIXOS</b>\n${(a.eixos_ativados ?? []).join(' · ')}\n` +
      `\n<b>CRUZAMENTO</b>\n${a.cruzamento}\n` +
      `\n<b>POR QUE ESTÁ NO TOP 10</b>\n${a.justificativa}\n` +
      `\n<b>LEITURA PARA PRODUTOR DE 600 A 1.000</b>\n${a.leitura_produtor}\n` +
      `\n<b>LACUNAS</b>\n${a.lacunas || '—'}\n` +
      `\n<b>MÍDIA</b>: ${n.qtd_midia} arquivo(s)\n` +
      `<b>FONTE</b>: ${n.veiculo} — ${n.url_fonte}\n` +
      (a.revisao_manual ? `\n🚩 REVISÃO MANUAL: pessoa física citada sem fonte oficial\n` : '');
  }

  p2 += `\n━━━━━━━━━━━━━━━━━━━━\n<b>FORA DO TOP 10 MAS DE OLHO</b>\n` +
    ((r.de_olho ?? []).map((x) => '· ' + x).join('\n') || '—') +
    `\n\n<b>O QUE O BANCO NÃO TROUXE HOJE</b>\n${r.silencio_relevante || '—'}`;

  await telegram(p2);

  console.log(`[${agora()}] analista concluído: ${avaliacoes.length} avaliadas, ${top.length} no top`);
  await db.end();
}

main().catch(async (e) => {
  console.error('FALHA:', e);
  await telegram(`<b>ANALISTA-MATERIAS FALHOU</b>\n${e.message}`);
  await db.end().catch(() => {});
  process.exit(1);
});
