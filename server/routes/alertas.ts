import type { FastifyInstance } from 'fastify';
import { query, queryApp, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { MODO_LEGADO, claveCache, registrarActividad } from '../acceso.js';
import { hoyBogota, leerRango, sumarDias } from '../params.js';
import { incidentes } from '../incidentes.js';
import { HOY } from '../sql.js';
import { PROGRAMACION, ejecuciones } from '../sql2.js';

export interface Alerta {
  alerta: string;
  severidad: 'alta' | 'media';
  titulo: string;
  detalle: string;
  /** Distingue ocurrencias de la misma regla (campaña, día) para el seguimiento de soporte. */
  instancia?: string;
}

/** Pantalla del panel donde se investiga cada regla. */
export const ENLACE_ALERTA: Record<string, string> = {
  campana_no_corrio: '#/campanas?t=ejecuciones',
  campana_sin_envios: '#/campanas?t=ejecuciones',
  fallo_envio_alto: '#/campanas',
  scraper_sin_actualizar: '#/alertas',
  bot_sin_conversaciones: '#/chatbot',
  errores_bot: '#/alertas',
};

export const claveAlerta = (a: Alerta) => `${a.alerta}${a.instancia ? `:${a.instancia}` : ''}`;

/** Alertas que alguien del cliente marcó como revisadas: siguen visibles, pero no cuentan en el número. */
async function revisadas(): Promise<Map<string, { por: string; at: string }>> {
  if (MODO_LEGADO) return new Map();
  try {
    const filas = await queryApp<{ clave: string; revisada_por: string; revisada_at: string }>(
      `SELECT clave, revisada_por, to_char(revisada_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS revisada_at
         FROM panel.alertas_cliente_revisadas`,
    );
    return new Map(filas.map((f) => [f.clave, { por: f.revisada_por, at: f.revisada_at }]));
  } catch {
    return new Map();
  }
}

/** Alertas activas con su clave, su enlace y si ya se revisaron. */
export async function alertasConEstado() {
  const [activas, rev] = await Promise.all([conCache('alertas', alertasActivas, 60_000, 0), revisadas()]);
  return activas.map((a) => {
    const clave = claveAlerta(a);
    return { ...a, clave, enlace: ENLACE_ALERTA[a.alerta] ?? '#/alertas', revisada: rev.get(clave) ?? null };
  });
}

// Errores de envío: la mayor de dos fuentes (envios_whatsapp puede faltar, como del 1 al 3 de octubre de 2026,
// y los eventos legacy del bot registran 'no_enviado'). Cada fuente cuenta solo con al menos 20 envíos ese día.
const FALLO_DIARIO = `
  env AS (
    SELECT fecha_bogota AS fecha, count(*) AS envios,
           count(*) FILTER (WHERE estado IN ('rechazado_api', 'failed')) AS fallidos
      FROM bi.fact_envios WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla' GROUP BY 1
  ),
  leg AS (
    SELECT fecha_bogota AS fecha, count(*) AS envios,
           count(*) FILTER (WHERE meta_estado = 'no_enviado' OR meta_resultado = 'error') AS fallidos
      FROM bi.fact_eventos
     WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_evento LIKE 'campahna%' AND coalesce(meta_estado, '') <> 'finalizado'
     GROUP BY 1
  )`;

/**
 * Alertas operativas activas en este momento (SIS-01). Reglas del catálogo:
 * A1 campaña programada que no corrió (30 min de gracia; daily solo L-S);
 * A2 campaña que procesó citas y no envió ninguna;
 * A3 más del 20 % de envíos fallidos hoy o ayer (≥ 50 % = alta);
 * A4 la agenda lleva más de 3 h sin actualizarse en horario hábil (L-S, 9-21 h);
 * A5 cero conversaciones un día hábil después del mediodía;
 * A6 más de 10 eventos de error del bot en el día.
 */
export async function alertasActivas(): Promise<Alerta[]> {
  const [ahora, ejecHoy, fallos, agenda, sesiones, errores] = await Promise.all([
    queryOne<{ hoy: string; hora: string; dow: number; festivo: boolean }>(
      `SELECT ${HOY}::text AS hoy, to_char(now() AT TIME ZONE 'America/Bogota', 'HH24:MI') AS hora,
              extract(isodow FROM now() AT TIME ZONE 'America/Bogota')::int AS dow,
              coalesce((SELECT es_festivo FROM bi.dim_fecha WHERE fecha = ${HOY}), false) AS festivo`,
    ),
    query<{ campana: string; corridas: number; procesadas: number; exitosos: number; errores: number }>(
      `WITH ${ejecuciones('$1')}
       SELECT campana, count(*) AS corridas, coalesce(sum(procesadas), 0) AS procesadas,
              coalesce(sum(exitosos), 0) AS exitosos, coalesce(sum(errores), 0) AS errores
         FROM ejec WHERE fecha = $1::date GROUP BY 1`,
      [hoyBogota()],
    ),
    query<{ fecha: string; pct: number | null }>(
      `WITH ${FALLO_DIARIO}
       SELECT d::date::text AS fecha,
              round(100.0 * greatest(
                CASE WHEN env.envios >= 20 THEN env.fallidos::numeric / env.envios END,
                CASE WHEN leg.envios >= 20 THEN leg.fallidos::numeric / leg.envios END), 1) AS pct
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN env ON env.fecha = d::date
         LEFT JOIN leg ON leg.fecha = d::date`,
      [sumarDias(hoyBogota(), -1), hoyBogota()],
    ),
    queryOne<{ horas: number | null }>(
      `SELECT round((extract(epoch FROM ((now() AT TIME ZONE 'America/Bogota')
                     - max(greatest(created_at_bogota, updated_at_bogota)))) / 3600.0)::numeric, 1) AS horas
         FROM bi.fact_citas`,
    ),
    queryOne<{ n: number }>(`SELECT count(*) AS n FROM bi.fact_sesiones WHERE fecha_bogota = ${HOY}`),
    queryOne<{ n: number }>(
      `SELECT count(*) AS n FROM bi.fact_eventos WHERE fecha_bogota = ${HOY} AND NOT es_backfill AND tipo_evento ILIKE '%error%'`,
    ),
  ]);

  const alertas: Alerta[] = [];
  const habil = ahora.dow >= 1 && ahora.dow <= 6 && !ahora.festivo;

  for (const p of PROGRAMACION) {
    if (p.soloHabil && ahora.dow === 7) continue;
    const [h, m] = p.hora.split(':').map(Number);
    const limite = `${String(h + (m + 30 >= 60 ? 1 : 0)).padStart(2, '0')}:${String((m + 30) % 60).padStart(2, '0')}`;
    const e = ejecHoy.find((x) => x.campana === p.campana);
    if (!e && ahora.hora > limite) {
      alertas.push({
        alerta: 'campana_no_corrio',
        instancia: `${p.campana}:${ahora.hoy}`,
        severidad: 'alta',
        titulo: `La campaña ${p.campana} no corrió hoy`,
        detalle: `Estaba programada a las ${p.hora} y no hay registro de ejecución.`,
      });
    }
    if (e && e.procesadas > 0 && e.exitosos === 0) {
      alertas.push({
        alerta: 'campana_sin_envios',
        instancia: `${p.campana}:${ahora.hoy}`,
        severidad: 'alta',
        titulo: `La campaña ${p.campana} no envió mensajes`,
        detalle: `Procesó ${e.procesadas} citas y envió 0${e.errores ? `, con ${e.errores} errores` : ' sin registrar errores'}.`,
      });
    }
  }
  for (const f of fallos) {
    if (f.pct !== null && f.pct > 20) {
      alertas.push({
        alerta: 'fallo_envio_alto',
        instancia: f.fecha,
        severidad: f.pct >= 50 ? 'alta' : 'media',
        titulo: `WhatsApp rechazó el ${String(f.pct).replace('.', ',')} % de los envíos`,
        detalle: `Día ${f.fecha}. Más del 20 % de envíos fallidos indica un problema con WhatsApp o con los números.`,
      });
    }
  }
  if (habil && ahora.hora >= '09:00' && ahora.hora <= '21:00' && agenda.horas !== null && agenda.horas > 3) {
    alertas.push({
      alerta: 'scraper_sin_actualizar',
      severidad: 'alta',
      titulo: 'La agenda no se está sincronizando con Globho',
      detalle: `La última actualización fue hace ${String(agenda.horas).replace('.', ',')} horas; normalmente se actualiza cada hora.`,
    });
  }
  if (habil && ahora.hora > '12:00' && sesiones.n === 0) {
    alertas.push({
      alerta: 'bot_sin_conversaciones',
      severidad: 'media',
      titulo: 'El bot no ha tenido conversaciones hoy',
      detalle: 'Cero conversaciones después del mediodía en un día hábil. Puede que el bot esté caído.',
    });
  }
  if (errores.n > 10) {
    alertas.push({
      alerta: 'errores_bot',
      severidad: 'media',
      titulo: `${errores.n} errores del bot hoy`,
      detalle: 'Más de 10 eventos de error en el día. Revise el detalle en "Errores del bot".',
    });
  }
  return alertas.sort((a, b) => (a.severidad === b.severidad ? 0 : a.severidad === 'alta' ? -1 : 1));
}

export default async function rutasAlertas(app: FastifyInstance) {
  // Liviano: lo consulta la cabecera cada minuto. Cuenta solo las que nadie ha revisado.
  app.get('/api/alertas/conteo', async () => {
    const a = await alertasConEstado();
    const pendientes = a.filter((x) => !x.revisada);
    return { n: pendientes.length, altas: pendientes.filter((x) => x.severidad === 'alta').length };
  });

  app.get('/api/alertas', async () => ({
    activas: await alertasConEstado(),
    incidentes: incidentes(),
  }));

  // Dirección y Operación marcan una alerta como revisada (o deshacen la marca).
  app.post(
    '/api/alertas/revisar',
    {
      schema: {
        body: {
          type: 'object',
          required: ['clave', 'revisada'],
          additionalProperties: false,
          properties: { clave: { type: 'string', minLength: 3, maxLength: 120 }, revisada: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const b = req.body as { clave: string; revisada: boolean };
      if (b.revisada) {
        await queryApp(
          `INSERT INTO panel.alertas_cliente_revisadas (clave, revisada_por) VALUES ($1, $2)
           ON CONFLICT (clave) DO UPDATE SET revisada_por = EXCLUDED.revisada_por, revisada_at = now()`,
          [b.clave, req.contexto!.usuario],
        );
      } else {
        await queryApp(`DELETE FROM panel.alertas_cliente_revisadas WHERE clave = $1`, [b.clave]);
      }
      registrarActividad(req.contexto, { tipo: 'configuracion', ruta: 'alerta_cliente', detalle: `${b.clave} → ${b.revisada ? 'revisada' : 'pendiente'}`, status: 200, ms: null });
      return { ok: true };
    },
  );

  // SIS-02: salud diaria de los datos. Cinco series que muestran cuándo dejó de llegar algo.
  app.get('/api/alertas/salud', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => ({
      dias: await query(
        `WITH ${FALLO_DIARIO},
         ses AS (SELECT fecha_bogota AS fecha, count(*) AS n FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2 GROUP BY 1),
         reg AS (SELECT created_at_bogota::date AS fecha, count(*) AS n FROM bi.fact_citas
                  WHERE created_at_bogota >= $1::date AND created_at_bogota < $2::date + 1 GROUP BY 1),
         act AS (SELECT updated_at_bogota::date AS fecha, count(*) AS n FROM bi.fact_citas
                  WHERE updated_at_bogota >= $1::date AND updated_at_bogota < $2::date + 1 GROUP BY 1),
         err AS (SELECT fecha_bogota AS fecha, count(*) AS n FROM bi.fact_eventos
                  WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_evento ILIKE '%error%' GROUP BY 1)
         SELECT d::date AS fecha,
                greatest(coalesce(env.envios, 0), coalesce(leg.envios, 0)) AS envios,
                round(100.0 * greatest(
                  CASE WHEN env.envios >= 20 THEN env.fallidos::numeric / env.envios END,
                  CASE WHEN leg.envios >= 20 THEN leg.fallidos::numeric / leg.envios END), 1) AS pct_fallo,
                coalesce(ses.n, 0) AS sesiones,
                coalesce(reg.n, 0) AS citas_registradas,
                coalesce(act.n, 0) AS citas_actualizadas,
                coalesce(err.n, 0) AS errores
           FROM generate_series($1::date, $2::date, interval '1 day') d
           LEFT JOIN env ON env.fecha = d::date
           LEFT JOIN leg ON leg.fecha = d::date
           LEFT JOIN ses ON ses.fecha = d::date
           LEFT JOIN reg ON reg.fecha = d::date
           LEFT JOIN act ON act.fecha = d::date
           LEFT JOIN err ON err.fecha = d::date
          ORDER BY 1`,
        [r.desde, r.hasta],
      ),
    }), 300_000);
  });
}
