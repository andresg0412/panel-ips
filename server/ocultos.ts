// Identidades ocultas: teléfonos y documentos (personal interno, números de prueba) cuyos datos no se muestran en
// ninguna pantalla del panel. No se borra nada de la base: el bot y el backend siguen funcionando igual con ellos.
//
// Cómo se aplica: `query()` (db.ts) pasa cada consulta por `reescribirConsulta`, que cambia cada lectura de una fuente
// con datos de pacientes (`FROM bi.fact_citas c`, `JOIN ofertas_cupo o`...) por una subconsulta filtrada
// (`FROM (SELECT * FROM bi.fact_citas WHERE <no oculto>) AS c`). Así ninguna ruta tiene que acordarse del filtro,
// incluidas las que se agreguen después. bi.v_embudo_flujo viene agregada por sesión: se reemplaza por su misma
// definición (030_bi_schema.sql) calculada sobre las fuentes ya filtradas.
//
// Las identidades viven en panel.identidades_ocultas (tipo 'telefono' | 'documento'); de ellas se derivan, con el rol
// de lectura, los pacientes (por documento o celular) y las citas (por paciente, documento o celular). Se recalculan al
// arrancar y cada 10 minutos. Los valores se insertan en el SQL como literales: solo pasan los que cumplen
// [A-Za-z0-9] (ids cortos, documentos, teléfonos), así que no hay forma de inyectar SQL desde esa tabla.
import { pool, poolApp } from './db.js';

interface Ocultos {
  telefonos: string[];
  /** chat_stats.id_usuario guarda el teléfono con y sin el 57. */
  idsUsuario: string[];
  documentos: string[];
  pacientes: string[];
  citas: string[];
}

const VACIO: Ocultos = { telefonos: [], idsUsuario: [], documentos: [], pacientes: [], citas: [] };
let actual: Ocultos = VACIO;

const SEGURO = /^[A-Za-z0-9]{1,30}$/;
const seguros = (vals: unknown[]) => [...new Set(vals.map((v) => String(v ?? '').trim()).filter((v) => SEGURO.test(v)))];

/** 3XXXXXXXXX o 573XXXXXXXXX → 573XXXXXXXXX (igual que normalizar_telefono de la BD); otro formato se deja en dígitos. */
function normalizarTelefono(v: string): string {
  const d = v.replace(/\D/g, '');
  return /^3\d{9}$/.test(d) ? `57${d}` : d;
}

export function hayOcultos(): boolean {
  return actual.telefonos.length + actual.documentos.length + actual.pacientes.length > 0;
}

/** Cuántas identidades y registros derivados se están ocultando (para soporte y los logs). */
export function resumenOcultos() {
  const o = actual;
  return { telefonos: o.telefonos.length, documentos: o.documentos.length, pacientes: o.pacientes.length, citas: o.citas.length };
}

/**
 * PANEL_IDENTIDADES_OCULTAS (opcional): 'telefono:573001112233,documento:123' — se suma a la tabla. Sirve para un
 * panel local sin DATABASE_URL_APP.
 */
function desdeEntorno(): { tipo: string; valor: string }[] {
  return (process.env.PANEL_IDENTIDADES_OCULTAS ?? '')
    .split(',')
    .map((p) => p.trim().split(':'))
    .filter((p) => p.length === 2 && (p[0] === 'telefono' || p[0] === 'documento'))
    .map(([tipo, valor]) => ({ tipo, valor }));
}

export async function recargarOcultos(log: (m: string) => void = () => {}): Promise<void> {
  const rows = [...desdeEntorno()];
  if (poolApp) {
    const r = await poolApp.query<{ tipo: string; valor: string }>(`SELECT tipo, valor FROM panel.identidades_ocultas`);
    rows.push(...r.rows);
  }
  const telefonos = seguros(rows.filter((r) => r.tipo === 'telefono').map((r) => normalizarTelefono(r.valor)));
  const documentos = seguros(rows.filter((r) => r.tipo === 'documento').map((r) => r.valor));
  if (!telefonos.length && !documentos.length) {
    actual = VACIO;
    return;
  }
  // Consultas directas al pool (sin reescribir): son las que definen qué se oculta.
  const pac = await pool.query<{ paciente_id: string }>(
    `SELECT paciente_id FROM bi.dim_paciente WHERE numero_documento = ANY($1::text[]) OR telefono_norm = ANY($2::text[])`,
    [documentos, telefonos],
  );
  const pacientes = seguros(pac.rows.map((r) => r.paciente_id));
  const cit = await pool.query<{ agenda_id: string }>(
    `SELECT agenda_id FROM bi.fact_citas
      WHERE paciente_id = ANY($1::text[]) OR documento_paciente = ANY($2::text[]) OR telefono_norm = ANY($3::text[])`,
    [pacientes, documentos, telefonos],
  );
  const citas = seguros(cit.rows.map((r) => r.agenda_id));
  const idsUsuario = seguros([...telefonos, ...telefonos.filter((t) => /^57\d{10}$/.test(t)).map((t) => t.slice(2))]);
  actual = { telefonos, idsUsuario, documentos, pacientes, citas };
  log(`Identidades ocultas: ${telefonos.length} teléfono(s), ${documentos.length} documento(s) → ${pacientes.length} paciente(s), ${citas.length} cita(s)`);
}

const literal = (vals: string[]) => `ARRAY[${vals.map((v) => `'${v}'`).join(',')}]::text[]`;
const fuera = (col: string, vals: string[]) => (vals.length ? `NOT coalesce(${col}::text = ANY(${literal(vals)}), false)` : null);

/** Condición "no oculto" de cada fuente con datos de pacientes (columnas verificadas en producción). */
const CONDICIONES: Record<string, (o: Ocultos) => (string | null)[]> = {
  // Citas: basta el id (la lista se calculó por paciente, documento y celular); telefono_norm aquí es una función por fila.
  'bi.fact_citas': (o) => [fuera('agenda_id', o.citas)],
  'bi.fact_envios': (o) => [fuera('telefono_norm', o.telefonos), fuera('paciente_id', o.pacientes), fuera('documento', o.documentos), fuera('agenda_id', o.citas)],
  'bi.fact_eventos': (o) => [
    fuera('telefono_norm', o.telefonos), fuera('id_usuario', o.idsUsuario), fuera('paciente_id', o.pacientes),
    fuera('documento', o.documentos), fuera('agenda_id', o.citas),
  ],
  'bi.fact_sesiones': (o) => [fuera('telefono_norm', o.telefonos), fuera('paciente_id', o.pacientes), fuera('documento', o.documentos)],
  'bi.dim_paciente': (o) => [fuera('paciente_id', o.pacientes)],
  'bi.dim_contacto': (o) => [fuera('telefono_norm', o.telefonos), fuera('paciente_id', o.pacientes), fuera('documento', o.documentos)],
  'bi.fact_cita_estados': (o) => [fuera('agenda_id', o.citas)],
  'bi.fact_lista_espera': (o) => [fuera('paciente_id', o.pacientes), fuera('cita_actual_id', o.citas)],
  'bi.v_timeline_paciente': (o) => [fuera('telefono_norm', o.telefonos), fuera('paciente_id', o.pacientes), fuera('documento', o.documentos)],
  chat_stats: (o) => [fuera('telefono_norm', o.telefonos), fuera('id_usuario', o.idsUsuario), fuera('paciente_id', o.pacientes), fuera('documento', o.documentos), fuera('agenda_id', o.citas)],
  cupos_liberados: (o) => [fuera('cita_origen_id', o.citas), fuera('asignado_a_paciente_id', o.pacientes)],
  ofertas_cupo: (o) => [fuera('paciente_id', o.pacientes)],
  lista_espera: (o) => [fuera('paciente_id', o.pacientes), fuera('cita_actual_id', o.citas)],
  invitaciones_lista_espera: (o) => [fuera('paciente_id', o.pacientes), fuera('telefono_envio', o.telefonos), fuera('agenda_id', o.citas)],
};

/** bi.v_embudo_flujo (030_bi_schema.sql) sobre fuentes que después se filtran; catalogo_pasos → bi.dim_paso. */
const EMBUDO_FLUJO = `(
  WITH ev AS (
    SELECT DISTINCT c.sesion_id, c.flujo, c.paso
    FROM chat_stats c
    WHERE c.sesion_id IS NOT NULL AND c.paso IS NOT NULL
  )
  SELECT s.fecha_bogota, ev.flujo, ev.paso, cp.orden, cp.es_final, s.es_backfill,
         COUNT(DISTINCT ev.sesion_id) AS sesiones_llegaron,
         COUNT(DISTINCT ev.sesion_id) FILTER (WHERE s.ultimo_paso = ev.paso) AS sesiones_terminaron_ahi,
         COUNT(DISTINCT ev.sesion_id) FILTER (WHERE s.ultimo_paso = ev.paso AND s.estado_calc = 'abandonada') AS sesiones_abandonaron_ahi
  FROM ev
  JOIN bi.fact_sesiones s ON s.sesion_id = ev.sesion_id
  LEFT JOIN bi.dim_paso cp ON cp.paso = ev.paso
  GROUP BY s.fecha_bogota, ev.flujo, ev.paso, cp.orden, cp.es_final, s.es_backfill
)`;

const PALABRAS_SQL =
  'WHERE|GROUP|ORDER|LIMIT|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|ON|USING|UNION|HAVING|WINDOW|OFFSET|FETCH|FOR|EXCEPT|INTERSECT|NATURAL|LATERAL|TABLESAMPLE|AND|OR|SELECT|RETURNING';
const nombres = (lista: string[]) => lista.map((n) => n.replace('.', '\\.')).join('|');
const reFuente = (lista: string[]) =>
  new RegExp(`\\b(FROM|JOIN)(\\s+)(${nombres(lista)})\\b(?!\\.)(?:(\\s+)(?:AS\\s+)?(?!(?:${PALABRAS_SQL})\\b)([a-z_][a-z0-9_]*))?`, 'gi');
const RE_FUENTES = reFuente(Object.keys(CONDICIONES));
const RE_EMBUDO = reFuente(['bi.v_embudo_flujo']);

/** Reescribe una consulta para que no lea filas de identidades ocultas. Sin identidades, la deja igual. */
export function reescribirConsulta(sql: string, o: Ocultos = actual): string {
  if (o.telefonos.length + o.documentos.length + o.pacientes.length === 0) return sql;
  const conEmbudo = sql.replace(RE_EMBUDO, (_m, kw: string, esp: string, _n: string, _e?: string, alias?: string) => `${kw}${esp}${EMBUDO_FLUJO} AS ${alias ?? 'v_embudo_flujo'}`);
  return conEmbudo.replace(RE_FUENTES, (_m, kw: string, esp: string, nombre: string, _e?: string, alias?: string) => {
    const clave = nombre.toLowerCase();
    const condiciones = (CONDICIONES[clave]?.(o) ?? []).filter((c): c is string => !!c);
    if (!condiciones.length) return _m;
    return `${kw}${esp}(SELECT * FROM ${clave} WHERE ${condiciones.join(' AND ')}) AS ${alias ?? clave.split('.').pop()}`;
  });
}

/** Solo para pruebas. */
export function _fijarOcultosParaPruebas(o: Partial<Ocultos>) {
  actual = { ...VACIO, ...o };
}
