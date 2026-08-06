/**
 * DEVE-RODAR-HOJE — porteiro da agenda semanal (Agente 2)
 *
 * Regra: roda segunda, quinta e domingo.
 * Se SEGUNDA cair em feriado nacional, pula pra terça (1 dia depois).
 *
 * Sai com código 0 = "roda hoje" · código 1 = "não roda hoje".
 * Chamado pelo rodada.sh antes de acionar os agentes.
 * O feriado é CALCULADO (não é lista fixa) — funciona pra qualquer ano
 * sem precisar eu atualizar isso depois. Cobre feriados NACIONAIS.
 * Feriado estadual/municipal (se um dia quiser) precisa somar à mão.
 */

const TZ = 'America/Sao_Paulo'; // fixo em UTC-3, Brasil não usa horário de verão desde 2019

function hojeBrasil() {
  const agora = new Date();
  const offsetMs = 3 * 60 * 60 * 1000; // UTC-3
  const local = new Date(agora.getTime() - offsetMs);
  return {
    ano: local.getUTCFullYear(),
    mes: local.getUTCMonth() + 1,
    dia: local.getUTCDate(),
    diaSemana: local.getUTCDay(), // 0=domingo, 1=segunda ... 6=sabado
  };
}

/** yyyy-mm-dd, sem depender de timezone do processo */
const chave = (ano, mes, dia) =>
  `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return { ano, mes, dia };
}

function somaDias({ ano, mes, dia }, n) {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + n);
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

/** Feriados nacionais fixos + móveis (baseados na Páscoa) do ano dado. */
function feriadosNacionais(ano) {
  const pas = pascoa(ano);
  const fixos = [
    [1, 1],   // Confraternização Universal
    [4, 21],  // Tiradentes
    [5, 1],   // Dia do Trabalho
    [9, 7],   // Independência
    [10, 12], // Nossa Senhora Aparecida
    [11, 2],  // Finados
    [11, 15], // Proclamação da República
    [11, 20], // Consciência Negra
    [12, 25], // Natal
  ].map(([mes, dia]) => chave(ano, mes, dia));

  const carnaval = somaDias(pas, -47);           // terça de carnaval
  const sextaSanta = somaDias(pas, -2);          // sexta-feira santa
  const corpusChristi = somaDias(pas, 60);       // corpus christi

  const moveis = [carnaval, sextaSanta, corpusChristi].map((d) => chave(d.ano, d.mes, d.dia));

  return new Set([...fixos, ...moveis]);
}

function ehFeriado(ano, mes, dia) {
  return feriadosNacionais(ano).has(chave(ano, mes, dia));
}

// ---------------------------------------------------------------- decisão

const hoje = hojeBrasil();
const { ano, mes, dia, diaSemana } = hoje;

const SEGUNDA = 1, TERCA = 2, QUINTA = 4, DOMINGO = 0;

let roda = false;
let motivo = '';

if (diaSemana === SEGUNDA) {
  if (ehFeriado(ano, mes, dia)) {
    roda = false;
    motivo = `segunda-feira (${chave(ano, mes, dia)}) é feriado nacional — pulando, roda amanhã (terça)`;
  } else {
    roda = true;
    motivo = 'segunda-feira, dia normal de agenda';
  }
} else if (diaSemana === QUINTA) {
  roda = true;
  motivo = 'quinta-feira, dia normal de agenda';
} else if (diaSemana === DOMINGO) {
  roda = true;
  motivo = 'domingo, dia normal de agenda';
} else if (diaSemana === TERCA) {
  const ontem = somaDias({ ano, mes, dia }, -1);
  if (ehFeriado(ontem.ano, ontem.mes, ontem.dia)) {
    roda = true;
    motivo = `terça-feira de reposição — segunda (${chave(ontem.ano, ontem.mes, ontem.dia)}) foi feriado`;
  } else {
    roda = false;
    motivo = 'terça-feira, fora da agenda (segunda não foi feriado)';
  }
} else {
  roda = false;
  motivo = 'fora da agenda (agenda: segunda, quinta, domingo — com desvio de feriado)';
}

console.log(`[deve-rodar-hoje] ${chave(ano, mes, dia)} — ${roda ? 'RODA' : 'NAO RODA'} — ${motivo}`);
process.exit(roda ? 0 : 1);
