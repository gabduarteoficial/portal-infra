/**
 * AGENTE 1 — RADAR-EVENTOS
 * Coleta bruta das últimas 24h. Teto de 100 pesquisas escritas/dia.
 * Não reescreve, não cria pasta, não publica. Grava cru no Supabase.
 *
 * Spec: ../../agentes/radar-eventos.md
 */
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import { db, telegram, lerTemperaturas, aplicarTemp, agora } from '../lib/db.mjs';

const client = new Anthropic();
const MODEL = 'claude-opus-5';
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

// ---------------------------------------------------------------- prompt

const SISTEMA = `Você é o RADAR-EVENTOS, coletor bruto do Portal Produção — portal de nicho sobre BASTIDORES do mercado de eventos brasileiro.

MISSÃO: coletar acontecimentos das ÚLTIMAS 24 HORAS e devolver os dados CRUS. Você NÃO reescreve, NÃO opina, NÃO sugere pauta, NÃO publica.

NICHOS (taxonomia fixa — use exatamente estes códigos):
producao, cancelamento, reembolso, atraso_palco, transito, violencia_assedio, arma_fogo, atraso_pagamento, reclamacao_equipe, rider, avaliacao

TEMAS QUE CAEM NOS NICHOS: alvará, AVCB, interdição, embargo, acessibilidade/PCD, fila, catraca, cashless, som alto/multa de ruído, cancelamento por chuva, preço de bar, segurança privada, cachê, contrato, ECAD, meia-entrada, cambista, golpe de ingresso, patrocínio, Lei Rouanet, PROAC, camarim, backstage.

BLOQUEIO DURO — NUNCA colete:
- agenda cultural, "o que fazer no fim de semana", calendário sazonal
- qualquer matéria com mais de 24 horas
- release puro de assessoria sem fato novo
- opinião/coluna/editorial sem fato datado
- EVENTO GOSPEL (fora do escopo do portal). Se aparecer de carona e o fato central for de produção (palco cedeu, calote, interdição, arma), grave com estilo_musical=["outros"].
- fofoca de celebridade sem ligação com produção

REGRAS INVIOLÁVEIS:
1. texto_bruto = o conteúdo COMO VEIO da fonte. Não reescreva, não resuma, não melhore.
2. NUNCA invente fonte, URL, citação, número de público ou crédito de foto.
3. Público estimado só com base (nota oficial > boletim PM/Bombeiros > capacidade licenciada > lotação declarada). Sem base: publico_estimado=null, porte_publico="nao_informado" e registre em lacunas.
4. NUNCA nomeie pessoa física em caso criminal quando a fonte não a nomeou.
5. Rede social entra com tipo_fonte="rede_social" — é repercussão, não fato.
6. Registre a URL das imagens e vídeos. NUNCA baixe. Crédito não declarado = "nao_identificado".
7. Se não encontrar nada, devolva lista vazia. NÃO invente para preencher.`;

const SCHEMA = {
  type: 'object',
  properties: {
    noticias: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titulo_original: { type: 'string' },
          texto_bruto: { type: 'string', description: 'Conteúdo cru da fonte, sem reescrita' },
          url_fonte: { type: 'string' },
          veiculo: { type: 'string' },
          tipo_fonte: { type: 'string', enum: ['portal', 'oficial', 'rede_social', 'review', 'dado_publico'] },
          data_ocorrido: { type: 'string', description: 'yyyy-mm-dd' },
          data_publicacao_fonte: { type: 'string', description: 'ISO 8601 ou vazio' },
          evento: { type: 'string' },
          cidade: { type: 'string' },
          uf: { type: 'string' },
          ddd: { type: 'string', enum: ['014', '018', 'outro'] },
          camada_geo: { type: 'integer' },
          local_evento: { type: 'string' },
          artistas: { type: 'array', items: { type: 'string' } },
          estilo_musical: { type: 'array', items: { type: 'string', enum: ['funk','sertanejo','pagode','trap','eletronica','rock','mpb','forro','rap','axe','pop','outros','nao_identificado'] } },
          tipo_evento: { type: 'string', enum: ['universitario','corrida','peao_rodeio','festival','balada','micareta_bloco','show_fechado','feira_expo','corporativo','outros','nao_identificado'] },
          porte_produtor: { type: 'string', enum: ['pequeno','medio','grande','grande_produtora','nao_identificado'] },
          produtora: { type: 'string' },
          ticketeira: { type: 'string' },
          nichos: { type: 'array', items: { type: 'string', enum: ['producao','cancelamento','reembolso','atraso_palco','transito','violencia_assedio','arma_fogo','atraso_pagamento','reclamacao_equipe','rider','avaliacao'] } },
          porte_publico: { type: 'string', enum: ['micro','pequeno','medio','grande','mega','nao_informado'] },
          publico_estimado: { type: ['integer', 'null'] },
          publico_e_estimativa: { type: 'boolean' },
          sentimento: { type: 'string', enum: ['positivo', 'negativo', 'neutro'] },
          tem_versao_oficial: { type: 'boolean' },
          tem_registro_publico: { type: 'boolean' },
          lacunas: { type: 'string' },
          midias: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                tipo: { type: 'string', enum: ['imagem', 'video', 'print_rede', 'audio'] },
                credito: { type: 'string' },
                legenda_original: { type: 'string' },
                origem: { type: 'string' },
              },
              required: ['url', 'tipo', 'credito', 'legenda_original', 'origem'],
              additionalProperties: false,
            },
          },
        },
        required: ['titulo_original','texto_bruto','url_fonte','veiculo','tipo_fonte','data_ocorrido','data_publicacao_fonte','evento','cidade','uf','ddd','camada_geo','local_evento','artistas','estilo_musical','tipo_evento','porte_produtor','produtora','ticketeira','nichos','porte_publico','publico_estimado','publico_e_estimativa','sentimento','tem_versao_oficial','tem_registro_publico','lacunas','midias'],
        additionalProperties: false,
      },
    },
  },
  required: ['noticias'],
  additionalProperties: false,
};

// ---------------------------------------------------------------- orçamento

/** Redistribui as 100 pesquisas conforme a temperatura das camadas. */
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
  // ajusta sobra/estouro na maior frente
  const delta = TETO - alocado;
  if (delta !== 0) {
    const maior = out.reduce((a, b) => (b.orcamento > a.orcamento ? b : a));
    maior.orcamento = Math.max(1, maior.orcamento + delta);
  }
  return out;
}

// ---------------------------------------------------------------- coleta

async function coletarFrente(frente, temp) {
  const enfase = Object.entries(temp)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`)
    .join(' · ') || 'perfil neutro';

  const prompt = `Colete acontecimentos das ÚLTIMAS 24 HORAS no mercado de eventos.

FRENTE: ${frente.alvo}

ORÇAMENTO: no máximo ${frente.orcamento} pesquisas nesta frente. Não ultrapasse.

PERFIL DE TEMPERATURA ATIVO (ajuste de ênfase definido pelo Gabriel):
${enfase}
Temperatura positiva = busque mais desse conteúdo. Negativa = busque menos. Isso NÃO libera nada bloqueado no escopo.

Busque em português, com e sem acento. Priorize a imprensa regional:
014 — giromarilia.com.br, jornaldamanhamarilia.com.br, diariodenoticiasmarilia.com.br, acidadenoticia.com.br, visaonoticias.com, odiademarilia.com.br, marilianoticia.com.br, sampi.net.br/bauru, marilia.sp.gov.br
018 — portalprudentino.com.br, grandeprudente.com.br, diariodeprudente.com, thmais.com.br, aracatuba.sp.gov.br
Institucional — g1 regional, Procon-SP, Corpo de Bombeiros, Diário Oficial, Portal da Transparência municipal.

Devolva SOMENTE acontecimentos datados das últimas 24h. Lista vazia é resposta válida e correta quando não houver nada.`;

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system: SISTEMA,
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: frente.orcamento },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: Math.ceil(frente.orcamento / 2) },
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
  crypto.createHash('sha256').update((n.titulo_original || '') + (n.texto_bruto || '').slice(0, 500)).digest('hex');

async function gravar(n, camadaPadrao) {
  const h = hash(n);

  const dup = await db.query(
    `select 1 from noticias
      where url_fonte = $1
         or (hash_conteudo = $2 and coletado_em >= now() - interval '72 hours')
      limit 1`,
    [n.url_fonte, h]
  );
  if (dup.rowCount) return 'duplicata';

  const data = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

  const { rows } = await db.query(
    `insert into noticias (
       data_ocorrido, data_publicacao_fonte, titulo_original, texto_bruto, url_fonte,
       veiculo, tipo_fonte, evento, cidade, uf, ddd, camada_geo, local_evento,
       artistas, estilo_musical, tipo_evento, porte_produtor, produtora, ticketeira,
       nichos, porte_publico, publico_estimado, publico_e_estimativa, sentimento,
       tem_versao_oficial, tem_registro_publico, lacunas, hash_conteudo, status
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
       $20,$21,$22,$23,$24,$25,$26,$27,$28,'bruto'
     )
     on conflict (url_fonte) do nothing
     returning id`,
    [
      data(n.data_ocorrido),
      n.data_publicacao_fonte || null,
      n.titulo_original, n.texto_bruto, n.url_fonte, n.veiculo, n.tipo_fonte,
      n.evento, n.cidade, n.uf, n.ddd,
      n.camada_geo || camadaPadrao || 5,
      n.local_evento,
      n.artistas ?? [], n.estilo_musical ?? [], n.tipo_evento, n.porte_produtor,
      n.produtora, n.ticketeira, n.nichos ?? [], n.porte_publico,
      n.publico_estimado, n.publico_e_estimativa ?? false, n.sentimento,
      n.tem_versao_oficial ?? false, n.tem_registro_publico ?? false,
      n.lacunas ?? '', h,
    ]
  );
  if (!rows.length) return 'duplicata';

  for (const m of n.midias ?? []) {
    await db.query(
      `insert into midias (noticia_id, url, tipo, credito, legenda_original, origem)
       values ($1,$2,$3,$4,$5,$6)`,
      [rows[0].id, m.url, m.tipo, m.credito || 'nao_identificado', m.legenda_original || '', m.origem || '']
    );
  }
  return 'gravada';
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`[${agora()}] radar-eventos iniciando`);

  const { mapa: temp } = await lerTemperaturas();
  const frentes = orcamentoAjustado(temp);

  const { rows: [log] } = await db.query(
    `insert into log_execucao (perfil_temperatura, concluido) values ($1, false) returning id`,
    [JSON.stringify(temp)]
  );

  let gastas = 0, gravadas = 0, duplicatas = 0, midias = 0;
  const erros = [], naoVarridas = [];

  for (const frente of frentes) {
    if (gastas >= TETO) { naoVarridas.push(frente.id); continue; }

    const restante = TETO - gastas;
    const f = { ...frente, orcamento: Math.min(frente.orcamento, restante) };

    try {
      const r = await coletarFrente(f, temp);
      gastas += r.gastas;
      if (r.erro) erros.push(r.erro);

      for (const n of r.noticias) {
        const st = await gravar(n, f.camada);
        if (st === 'gravada') { gravadas++; midias += (n.midias ?? []).length; }
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
    `<b>RADAR-EVENTOS</b> — ${agora()}\n\n` +
    `Pesquisas: <b>${gastas}/${TETO}</b>\n` +
    `Notícias gravadas: <b>${gravadas}</b>\n` +
    `Duplicatas descartadas: ${duplicatas}\n` +
    `Mídias registradas: ${midias}\n\n` +
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
