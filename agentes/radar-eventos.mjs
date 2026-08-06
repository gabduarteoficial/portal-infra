/**
 * AGENTE 2 — RADAR-EVENTOS (versão enxuta, só link)
 *
 * Diferença pro Agente 1 (congelado na tag agente-v1-analise-completa):
 *   - NÃO entra nas páginas (sem web_fetch) — só busca e pega
 *     título + resuminho que já vem pronto na busca. Bem mais barato.
 *   - Roda 3x/semana (seg/qui/dom, com desvio de feriado — ver
 *     deve-rodar-hoje.mjs), não todo dia.
 *   - Janela de coleta é DINÂMICA: cobre o tempo desde a última rodada
 *     que deu certo, não um "últimas 24h" fixo — assim não perde
 *     notícia nos dias que ele não roda.
 *   - Muitos campos (porte, produtora, cachê, versão oficial x público)
 *     ficam em branco de propósito — isso exige ler a matéria inteira,
 *     e é exatamente o que a leitura leve não faz. Fica pra você ler
 *     na hora de abrir o link.
 */
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import { db, telegram, lerTemperaturas, aplicarTemp, agora } from '../lib/db.mjs';

const client = new Anthropic();
const MODEL = 'claude-sonnet-5'; // mais barato que Opus, sobra pra tarefa de busca+classificação
const TETO = Number(process.env.TETO_PESQUISAS_DIA || 100);

// ---------------------------------------------------------------- frentes

const C1 = 'Marília, Garça, Vera Cruz, Pompéia, Oriente, Álvaro de Carvalho, Lupércio, Gália, Echaporã, Ocauçu, Júlio Mesquita, Alvinlândia';
const C2 = 'Bauru, Jaú, Botucatu, Lins, Ourinhos, Assis, Avaré, Lençóis Paulista, Agudos, Bariri, Barra Bonita, Piraju, Santa Cruz do Rio Pardo, Tupã, Cândido Mota, Paraguaçu Paulista, Duartina, Pederneiras, São Manuel, Igaraçu do Tietê';
const C3 = 'Presidente Prudente, Araçatuba, Birigui, Penápolis, Andradina, Adamantina, Dracena, Tupi Paulista, Osvaldo Cruz, Rancharia, Martinópolis, Álvares Machado, Pirapozinho, Mirandópolis, Ilha Solteira, Valparaíso, Guararapes, Santa Fé do Sul, Teodoro Sampaio, Presidente Epitácio, Presidente Venceslau';
const C4 = 'Ribeirão Preto, São José do Rio Preto, Araraquara, São Carlos, Campinas, Sorocaba, Franca, Barretos, Jaguariúna, Piracicaba, Limeira, Rio Claro, Catanduva, Votuporanga, Jales, Fernandópolis';

const FRENTES = [
  { id: 'c1_marilia', camada: 1, orcamento: 20, alvo: `Marília e entorno: ${C1}` },
  { id: 'c2_014',     camada: 2, orcamento: 20, alvo: `DDD 014: ${C2}` },
  { id: 'c3_018',     camada: 3, orcamento: 20, alvo: `DDD 018: ${C3}` },
  { id: 'c4_sp',      camada: 4, orcamento: 12, alvo: `Interior de SP: ${C4}` },
  { id: 'c5_brasil',  camada: 5, orcamento: 10, alvo: 'Brasil: capitais e grandes festivais; decisão judicial, Procon, norma nova, acidente estrutural, calote de cachê' },
  { id: 'tematico',   camada: 0, orcamento: 12, alvo: 'Busca temática nacional SEM cidade fixa. Reserve pelo menos 4 pesquisas para EVENTO UNIVERSITÁRIO (atlética, calourada, formatura, open bar, intercursos) e EVENTO DE CORRIDA (corrida de rua, meia maratona, kit, percurso, cronometragem)' },
  { id: 'redes',      camada: 0, orcamento: 6,  alvo: 'Repercussão pública: relatos, vídeos, avaliações, Reclame Aqui, reviews de espaço de evento' },
];

// ---------------------------------------------------------------- janela dinâmica

/** Cobre o tempo desde a última rodada que deu certo (+ margem de 2h). Mínimo 24h, teto 7 dias. */
async function janelaDinamica() {
  const { rows } = await db.query(
    `select rodou_em from log_execucao where concluido = true order by rodou_em desc limit 1`
  );
  if (!rows.length) return 24;
  const horas = (Date.now() - new Date(rows[0].rodou_em).getTime()) / 3_600_000;
  return Math.min(Math.max(Math.ceil(horas) + 2, 24), 168);
}

// ---------------------------------------------------------------- prompt

const SISTEMA = `Você é o RADAR-EVENTOS (versão enxuta) do Portal Produção — portal de nicho sobre BASTIDORES do mercado de eventos brasileiro.

MISSÃO: buscar acontecimentos recentes e devolver LINK + TÍTULO + RESUMO CURTO — exatamente o que aparece no resultado da busca. Você NÃO entra na página, NÃO lê a matéria inteira, NÃO inventa dado que não está no título/resumo.

NICHOS (taxonomia fixa): producao, cancelamento, reembolso, atraso_palco, transito, violencia_assedio, arma_fogo, atraso_pagamento, reclamacao_equipe, rider, avaliacao

BLOQUEIO DURO:
- agenda cultural, "o que fazer no fim de semana", calendário sazonal
- matéria fora da janela de tempo informada no pedido
- EVENTO GOSPEL (fora do escopo do portal)
- fofoca de celebridade sem ligação com produção

REGRAS INVIOLÁVEIS:
1. resumo_busca = o texto que APARECEU na busca (título/trecho). Nunca invente, nunca complete com o que você "acha" que a matéria diz.
2. Campos que exigem ler a matéria inteira (quem produziu, porte de público, se tem versão oficial) você NÃO tem como saber só pelo título — deixe em branco/lacuna, não chute.
3. NUNCA invente URL, veículo ou data.
4. Se não achar nada relevante numa frente, devolva lista vazia — não force resultado pra preencher.`;

const SCHEMA = {
  type: 'object',
  properties: {
    noticias: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titulo_original: { type: 'string' },
          resumo_busca: { type: 'string', description: 'O trecho/resumo que já veio no resultado da busca — NÃO é o texto completo da matéria' },
          url_fonte: { type: 'string' },
          veiculo: { type: 'string' },
          tipo_fonte: { type: 'string', enum: ['portal', 'oficial', 'rede_social', 'review', 'dado_publico'] },
          data_ocorrido: { type: 'string', description: 'yyyy-mm-dd — deixe vazio se não der pra saber só pelo título/resumo' },
          evento: { type: 'string' },
          cidade: { type: 'string' },
          uf: { type: 'string' },
          ddd: { type: 'string', enum: ['014', '018', 'outro'] },
          camada_geo: { type: 'integer' },
          artistas: { type: 'array', items: { type: 'string' } },
          estilo_musical: { type: 'array', items: { type: 'string', enum: ['funk','sertanejo','pagode','trap','eletronica','rock','mpb','forro','rap','axe','pop','outros','nao_identificado'] } },
          tipo_evento: { type: 'string', enum: ['universitario','corrida','peao_rodeio','festival','balada','micareta_bloco','show_fechado','feira_expo','corporativo','outros','nao_identificado'] },
          nichos: { type: 'array', items: { type: 'string', enum: ['producao','cancelamento','reembolso','atraso_palco','transito','violencia_assedio','arma_fogo','atraso_pagamento','reclamacao_equipe','rider','avaliacao'] } },
          sentimento: { type: 'string', enum: ['positivo', 'negativo', 'neutro'] },
          lacunas: { type: 'string', description: 'sempre mencione: coleta feita só por título/resumo de busca, sem ler a matéria inteira' },
        },
        required: ['titulo_original','resumo_busca','url_fonte','veiculo','tipo_fonte','data_ocorrido','evento','cidade','uf','ddd','camada_geo','artistas','estilo_musical','tipo_evento','nichos','sentimento','lacunas'],
        additionalProperties: false,
      },
    },
  },
  required: ['noticias'],
  additionalProperties: false,
};

// ---------------------------------------------------------------- orçamento

function orcamentoAjustado(temp) {
  const chaveCamada = { c1_marilia: 'c1_marilia', c2_014: 'c2_014', c3_018: 'c3_018', c4_sp: 'c4_sp', c5_brasil: 'c5_brasil' };
  const pesos = FRENTES.map((f) => {
    const t = chaveCamada[f.id] ? (temp[chaveCamada[f.id]] ?? 0) : 0;
    return { ...f, peso: Math.max(0, aplicarTemp(f.orcamento, t)) };
  });
  const soma = pesos.reduce((a, f) => a + f.peso, 0) || 1;
  let alocado = 0;
  const out = pesos.map((f) => {
    const n = Math.max(1, Math.round((f.peso / soma) * TETO));
    alocado += n;
    return { ...f, orcamento: n };
  });
  const delta = TETO - alocado;
  if (delta !== 0) {
    const maior = out.reduce((a, b) => (b.orcamento > a.orcamento ? b : a));
    maior.orcamento = Math.max(1, maior.orcamento + delta);
  }
  return out;
}

// ---------------------------------------------------------------- coleta

async function coletarFrente(frente, temp, horasJanela) {
  const enfase = Object.entries(temp)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`)
    .join(' · ') || 'perfil neutro';

  const prompt = `Busque acontecimentos das ÚLTIMAS ${horasJanela} HORAS no mercado de eventos (essa janela cobre o tempo desde a última rodada — pode ser mais que 24h porque o robô só roda 3x por semana).

FRENTE: ${frente.alvo}

ORÇAMENTO: no máximo ${frente.orcamento} pesquisas nesta frente. Não ultrapasse.

PERFIL DE TEMPERATURA ATIVO (ajuste de ênfase definido pelo Gabriel):
${enfase}
Temperatura positiva = busque mais desse conteúdo. Negativa = busque menos. Isso NÃO libera nada bloqueado no escopo.

Busque em português, com e sem acento. Priorize a imprensa regional:
014 — giromarilia.com.br, jornaldamanhamarilia.com.br, diariodenoticiasmarilia.com.br, acidadenoticia.com.br, visaonoticias.com, odiademarilia.com.br, marilianoticia.com.br, sampi.net.br/bauru, marilia.sp.gov.br
018 — portalprudentino.com.br, grandeprudente.com.br, diariodeprudente.com, thmais.com.br, aracatuba.sp.gov.br
Institucional — g1 regional, Procon-SP, Corpo de Bombeiros, Diário Oficial, Portal da Transparência municipal.

NÃO entre nas páginas. Use só o que aparece no resultado da busca (título + resumo). Devolva SOMENTE acontecimentos dentro da janela de tempo. Lista vazia é resposta válida.`;

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system: SISTEMA,
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: frente.orcamento },
    ],
    messages: [{ role: 'user', content: prompt }],
  });

  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') {
    return { noticias: [], gastas: 0, erro: `recusa: ${msg.stop_details?.category ?? '?'}` };
  }

  const gastas = msg.usage?.server_tool_use?.web_search_requests ?? frente.orcamento;
  const texto = msg.content.find((b) => b.type === 'text')?.text ?? '{"noticias":[]}';

  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    return { noticias: [], gastas, erro: 'JSON inválido na frente ' + frente.id };
  }
  return { noticias: dados.noticias ?? [], gastas, erro: null };
}

// ---------------------------------------------------------------- gravação

const hash = (n) =>
  crypto.createHash('sha256').update((n.titulo_original || '') + (n.resumo_busca || '').slice(0, 300)).digest('hex');

async function gravar(n, camadaPadrao) {
  const h = hash(n);

  const dup = await db.query(
    `select 1 from noticias
      where url_fonte = $1
         or (hash_conteudo = $2 and coletado_em >= now() - interval '7 days')
      limit 1`,
    [n.url_fonte, h]
  );
  if (dup.rowCount) return 'duplicata';

  const data = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

  const lacunaCompleta = `${n.lacunas || ''} · coleta leve (Agente 2): sem leitura da matéria — porte, produtora, versão oficial e mídia não verificados`.trim();

  const { rows } = await db.query(
    `insert into noticias (
       data_ocorrido, titulo_original, texto_bruto, url_fonte,
       veiculo, tipo_fonte, evento, cidade, uf, ddd, camada_geo,
       artistas, estilo_musical, tipo_evento, nichos,
       sentimento, lacunas, hash_conteudo, status
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'bruto'
     )
     on conflict (url_fonte) do nothing
     returning id`,
    [
      data(n.data_ocorrido), n.titulo_original, n.resumo_busca, n.url_fonte, n.veiculo, n.tipo_fonte,
      n.evento, n.cidade, n.uf, n.ddd, n.camada_geo || camadaPadrao || 5,
      n.artistas ?? [], n.estilo_musical ?? [], n.tipo_evento, n.nichos ?? [],
      n.sentimento, lacunaCompleta, h,
    ]
  );
  return rows.length ? 'gravada' : 'duplicata';
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`[${agora()}] radar-eventos (v2, so link) iniciando`);

  const { mapa: temp } = await lerTemperaturas();
  const horasJanela = await janelaDinamica();
  const frentes = orcamentoAjustado(temp);

  const { rows: [log] } = await db.query(
    `insert into log_execucao (perfil_temperatura, concluido) values ($1, false) returning id`,
    [JSON.stringify(temp)]
  );

  let gastas = 0, gravadas = 0, duplicatas = 0;
  const erros = [], naoVarridas = [];

  for (const frente of frentes) {
    if (gastas >= TETO) { naoVarridas.push(frente.id); continue; }

    const restante = TETO - gastas;
    const f = { ...frente, orcamento: Math.min(frente.orcamento, restante) };

    try {
      const r = await coletarFrente(f, temp, horasJanela);
      gastas += r.gastas;
      if (r.erro) erros.push(r.erro);

      for (const n of r.noticias) {
        const st = await gravar(n, f.camada);
        if (st === 'gravada') gravadas++;
        else duplicatas++;
      }
      console.log(`  ${f.id}: ${r.noticias.length} itens · ${r.gastas} pesquisas`);
    } catch (e) {
      erros.push(`${f.id}: ${e.message}`);
      console.error(`  ${f.id} ERRO:`, e.message);
    }
  }

  await db.query(
    `update log_execucao
        set pesquisas_gastas=$1, noticias_gravadas=$2, duplicatas_descartadas=$3,
            frentes_nao_varridas=$4, erros=$5, concluido=true
      where id=$6`,
    [gastas, gravadas, duplicatas, naoVarridas, erros, log.id]
  );

  const resumo = await db.query(
    `select camada_geo, count(*)::int n from noticias
      where coletado_em >= now() - interval '24 hours' group by camada_geo order by camada_geo`
  );

  await telegram(
    `<b>RADAR-EVENTOS</b> (v2, só link) — ${agora()}\n` +
    `Janela coberta: últimas <b>${horasJanela}h</b> (dinâmica, cobre desde a última rodada)\n\n` +
    `Pesquisas: <b>${gastas}/${TETO}</b>\n` +
    `Notícias gravadas: <b>${gravadas}</b>\n` +
    `Duplicatas descartadas: ${duplicatas}\n\n` +
    `Por camada: ${resumo.rows.map((r) => `C${r.camada_geo}: ${r.n}`).join(' | ') || '—'}\n` +
    (naoVarridas.length ? `\nFrentes não varridas: ${naoVarridas.join(', ')}\n` : '') +
    (erros.length ? `\n⚠ Erros:\n${erros.map((e) => '  ' + e).join('\n')}\n` : '') +
    `\n<b>concluido = true</b> → analista liberado`
  );

  console.log(`[${agora()}] radar concluído: ${gravadas} gravadas, ${gastas} pesquisas`);
  await db.end();
}

main().catch(async (e) => {
  console.error('FALHA:', e);
  await telegram(`<b>RADAR-EVENTOS FALHOU</b>\n${e.message}`);
  await db.end().catch(() => {});
  process.exit(1);
});
