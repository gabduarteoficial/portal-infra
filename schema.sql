-- =====================================================================
-- PORTAL PRODUÇÃO — schema do banco
-- PostgreSQL 16+
-- Idempotente: pode rodar quantas vezes quiser
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- noticias — registro bruto coletado pelo radar-eventos
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS noticias (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    coletado_em             timestamptz NOT NULL DEFAULT now(),
    data_ocorrido           date,
    data_publicacao_fonte   timestamptz,

    titulo_original         text,
    texto_bruto             text,            -- conteudo cru, SEM reescrita
    url_fonte               text UNIQUE,
    veiculo                 text,
    tipo_fonte              text CHECK (tipo_fonte IN
                              ('portal','oficial','rede_social','review','dado_publico')),

    evento                  text,
    cidade                  text,
    uf                      text,
    ddd                     text,
    camada_geo              smallint CHECK (camada_geo BETWEEN 1 AND 5),
    local_evento            text,

    artistas                text[],
    estilo_musical          text[],
    tipo_evento             text,
    porte_produtor          text CHECK (porte_produtor IN
                              ('pequeno','medio','grande','grande_produtora','nao_identificado')),
    produtora               text,
    ticketeira              text,
    nichos                  text[],

    porte_publico           text CHECK (porte_publico IN
                              ('micro','pequeno','medio','grande','mega','nao_informado')),
    publico_estimado        integer,
    publico_e_estimativa    boolean DEFAULT false,

    sentimento              text CHECK (sentimento IN ('positivo','negativo','neutro')),
    tem_versao_oficial      boolean DEFAULT false,
    tem_registro_publico    boolean DEFAULT false,
    lacunas                 text,

    hash_conteudo           text,
    status                  text NOT NULL DEFAULT 'bruto'
);

CREATE INDEX IF NOT EXISTS idx_noticias_coletado   ON noticias (coletado_em DESC);
CREATE INDEX IF NOT EXISTS idx_noticias_hash       ON noticias (hash_conteudo);
CREATE INDEX IF NOT EXISTS idx_noticias_produtora  ON noticias (produtora);
CREATE INDEX IF NOT EXISTS idx_noticias_camada     ON noticias (camada_geo);
CREATE INDEX IF NOT EXISTS idx_noticias_tipo_ev    ON noticias (tipo_evento);
CREATE INDEX IF NOT EXISTS idx_noticias_estilo     ON noticias USING gin (estilo_musical);
CREATE INDEX IF NOT EXISTS idx_noticias_nichos     ON noticias USING gin (nichos);

-- ---------------------------------------------------------------------
-- midias — imagens e videos da materia (SO a URL, nunca o arquivo)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS midias (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    noticia_id       uuid NOT NULL REFERENCES noticias(id) ON DELETE CASCADE,
    url              text NOT NULL,
    tipo             text CHECK (tipo IN ('imagem','video','print_rede','audio')),
    credito          text DEFAULT 'nao_identificado',
    legenda_original text,
    origem           text
);

CREATE INDEX IF NOT EXISTS idx_midias_noticia ON midias (noticia_id);

-- ---------------------------------------------------------------------
-- log_execucao — o semaforo da cadeia radar -> analista
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS log_execucao (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rodou_em                timestamptz NOT NULL DEFAULT now(),
    pesquisas_gastas        integer DEFAULT 0,
    noticias_gravadas       integer DEFAULT 0,
    duplicatas_descartadas  integer DEFAULT 0,
    frentes_nao_varridas    text[],
    erros                   text[],
    perfil_temperatura      jsonb,
    concluido               boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_log_rodou ON log_execucao (rodou_em DESC);

-- ---------------------------------------------------------------------
-- analises — resultado do analista-materias
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analises (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    noticia_id              uuid NOT NULL REFERENCES noticias(id) ON DELETE CASCADE,
    nota                    integer,
    posicao_ranking         integer,
    no_top10                boolean DEFAULT false,
    eixos_ativados          text[],
    porte_produtor          text,
    produtora_reincidente   boolean DEFAULT false,
    justificativa           text,
    lacunas                 text,
    analisado_em            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analises_noticia ON analises (noticia_id);
CREATE INDEX IF NOT EXISTS idx_analises_top10   ON analises (analisado_em DESC, no_top10);

-- ---------------------------------------------------------------------
-- temperaturas — controle via Telegram (-100 a +100)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS temperaturas (
    chave           text PRIMARY KEY,
    dimensao        text NOT NULL CHECK (dimensao IN
                      ('estilo','tipo_evento','nicho','camada','porte_publico','porte_produtor','tom')),
    valor           integer NOT NULL DEFAULT 0 CHECK (valor BETWEEN -100 AND 100),
    atualizado_em   timestamptz NOT NULL DEFAULT now(),
    atualizado_por  text
);

-- ---------------------------------------------------------------------
-- perfis_temperatura — conjuntos salvos
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS perfis_temperatura (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome       text UNIQUE NOT NULL,
    config     jsonb NOT NULL,
    criado_em  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- SEED — todas as chaves de temperatura em 0 (neutro)
-- Gospel NAO entra: esta fora do escopo, nao e ajustavel.
-- =====================================================================
INSERT INTO temperaturas (chave, dimensao, valor) VALUES
    ('funk','estilo',0), ('sertanejo','estilo',0), ('pagode','estilo',0),
    ('trap','estilo',0), ('eletronica','estilo',0), ('rock','estilo',0),
    ('rap','estilo',0), ('forro','estilo',0), ('mpb','estilo',0),
    ('axe','estilo',0), ('pop','estilo',0),

    ('universitario','tipo_evento',0), ('corrida','tipo_evento',0),
    ('peao_rodeio','tipo_evento',0),   ('festival','tipo_evento',0),
    ('balada','tipo_evento',0),        ('micareta','tipo_evento',0),
    ('corporativo','tipo_evento',0),

    ('producao','nicho',0),          ('cancelamento','nicho',0),
    ('reembolso','nicho',0),         ('atraso_palco','nicho',0),
    ('transito','nicho',0),          ('violencia_assedio','nicho',0),
    ('arma_fogo','nicho',0),         ('atraso_pagamento','nicho',0),
    ('reclamacao_equipe','nicho',0), ('rider','nicho',0),
    ('avaliacao','nicho',0),

    ('c1_marilia','camada',0), ('c2_014','camada',0), ('c3_018','camada',0),
    ('c4_sp','camada',0),      ('c5_brasil','camada',0),

    ('micro','porte_publico',0),  ('pequeno','porte_publico',0),
    ('medio','porte_publico',0),  ('grande','porte_publico',0),
    ('mega','porte_publico',0),

    ('prod_pequeno','porte_produtor',0), ('prod_medio','porte_produtor',0),
    ('prod_grande','porte_produtor',0),  ('grande_produtora','porte_produtor',0),

    ('positivo','tom',0), ('negativo','tom',0)
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------
-- View de conveniencia: o Top 10 da rodada mais recente
-- v2: nao roda mais todo dia (seg/qui/dom), entao "ultimas 24h" quebraria
-- em qualquer dia sem rodada. Em vez disso, pega a ULTIMA rodada de
-- analise que existir (janela de 2h cobre a duracao de uma rodada).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_top10_hoje AS
SELECT a.posicao_ranking, a.nota, n.evento, n.cidade, n.uf, n.camada_geo,
       n.porte_publico, n.porte_produtor, n.produtora, n.estilo_musical,
       n.tipo_evento, n.nichos, n.veiculo, n.url_fonte, a.justificativa
FROM analises a
JOIN noticias n ON n.id = a.noticia_id
WHERE a.no_top10 = true
  AND a.analisado_em >= (SELECT max(analisado_em) FROM analises) - interval '2 hours'
ORDER BY a.posicao_ranking;

-- ---------------------------------------------------------------------
-- View: produtoras reincidentes nos ultimos 90 dias
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_produtoras_reincidentes AS
SELECT produtora,
       count(*)                        AS ocorrencias,
       array_agg(DISTINCT cidade)      AS cidades,
       max(coletado_em)                AS ultima_ocorrencia
FROM noticias
WHERE coletado_em >= now() - interval '90 days'
  AND produtora IS NOT NULL
  AND produtora <> ''
GROUP BY produtora
HAVING count(*) > 1
ORDER BY ocorrencias DESC;
