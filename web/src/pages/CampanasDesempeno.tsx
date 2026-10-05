// Etapa 3 · Campañas, pestaña "Desempeño" (plan Full): rankings de campañas, tiempos hasta leer y responder
// (CAM-06) y fatiga de mensajes (CAM-09).
import { useCallback, useMemo } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, barrasTasa, lineas } from '../components/series';
import { Estado, ListaConteo, Tabla, Tarjeta, type Columna } from '../components/ui';
import { Restringido } from '../acceso';
import { useMarcas } from '../incidentes';
import { etiqueta, num, pct, ratio, tasaTxt } from '../format';

interface FilaCampana {
  campana: string;
  enviados: number;
  fallidos: number;
  respondieron: number;
  respondieron_tarde: number;
  citas_confirmadas: number;
}

const minutosTxt = (m: number | null | undefined) =>
  m === null || m === undefined ? '—' : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1).replace('.', ',')} h`;

/** Campañas que no piden respuesta: el recordatorio de 2 h y los avisos internos. */
const SIN_RESPUESTA = new Set(['daily', 'aviso_asesor']);
const MIN_ENVIOS = 30;

// ---------------------------------------------------------------------------------------------- rankings
interface Puesto {
  campana: string;
  tasa: number;
  parte: number;
  base: number;
}

function Ranking({ titulo, puestos, pocos, vacio }: { titulo: string; puestos: Puesto[]; pocos: string[]; vacio: string }) {
  return (
    <div className="ranking">
      <h4>{titulo}</h4>
      {puestos.length ? (
        <ol>
          {puestos.map((p) => (
            <li key={p.campana}>
              <span>{etiqueta(p.campana)}</span>
              <span className="v">
                {tasaTxt(p.tasa, 1)}
                <span className="n">{num(p.parte)} de {num(p.base)}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="vacio">{vacio}</p>
      )}
      {pocos.length > 0 && <p className="nota">Con menos de {MIN_ENVIOS} mensajes, fuera del ranking: {pocos.map(etiqueta).join(', ')}.</p>}
    </div>
  );
}

function Rankings({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<{ porCampana: FilaCampana[] }>(conRango('/api/campanas', rango), 60_000);
  const marcas = useMarcas(rango, ['whatsapp', 'trazabilidad']);
  const r = useMemo(() => {
    const filas = data?.porCampana ?? [];
    const armar = (incluir: (f: FilaCampana) => boolean, parte: (f: FilaCampana) => number, base: (f: FilaCampana) => number, asc = false) => {
      const candidatas = filas.filter(incluir);
      const puestos = candidatas
        .filter((f) => base(f) >= MIN_ENVIOS)
        .map((f) => ({ campana: f.campana, parte: parte(f), base: base(f), tasa: parte(f) / base(f) }))
        .sort((a, b) => (asc ? a.tasa - b.tasa : b.tasa - a.tasa));
      const pocos = candidatas.filter((f) => base(f) > 0 && base(f) < MIN_ENVIOS).map((f) => f.campana);
      return { puestos, pocos };
    };
    return {
      efectivas: armar((f) => f.citas_confirmadas > 0 || f.campana === 'execute' || f.campana === 'reminder', (f) => f.citas_confirmadas, (f) => f.enviados),
      respuesta: armar((f) => !SIN_RESPUESTA.has(f.campana), (f) => f.respondieron + f.respondieron_tarde, (f) => f.enviados),
      fallos: armar((f) => f.fallidos > 0, (f) => f.fallidos, (f) => f.enviados + f.fallidos),
    };
  }, [data]);

  return (
    <Tarjeta
      titulo="¿Qué campaña funciona mejor?"
      marcas={marcas}
      ayuda={`Campañas del período ordenadas por resultado. Solo entran las que enviaron al menos ${MIN_ENVIOS} mensajes, para no premiar un buen resultado con pocos casos.`}
    >
      <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />
      {data && (
        <div className="rankings">
          <Ranking titulo="Más efectivas: confirmaron la cita" {...r.efectivas} vacio="Ninguna campaña pidió confirmar citas en el período." />
          <Ranking titulo="Con más respuesta" {...r.respuesta} vacio="Sin campañas que pidan respuesta en el período." />
          <Ranking titulo="Con más fallos de envío" {...r.fallos} vacio="Ninguna campaña tuvo fallos de envío en el período." />
        </div>
      )}
    </Tarjeta>
  );
}

// ---------------------------------------------------------------------------------------------- tiempos
interface Tiempos {
  respuesta: { campana: string; hora: number; enviados: number; acumulado: number }[];
  lectura: { leidos: number; entregados: number; mediana_lectura_min: number | null; mediana_respuesta_min: number | null };
  porCampana: { campana: string; leidos: number; respondidos: number; mediana_lectura_min: number | null; mediana_respuesta_min: number | null }[];
}

const COLS_TIEMPO: Columna<Tiempos['porCampana'][number]>[] = [
  { clave: 'campana', titulo: 'Campaña', formato: etiqueta, csv: etiqueta },
  {
    clave: 'mediana_lectura_min',
    titulo: 'Hasta leer',
    num: true,
    formato: (v, f) => (f.leidos >= 10 ? `${minutosTxt(v)} (${num(f.leidos)})` : '—'),
    csv: (v, f) => (f.leidos >= 10 ? String(v ?? '') : ''),
  },
  {
    clave: 'mediana_respuesta_min',
    titulo: 'Hasta responder',
    num: true,
    formato: (v, f) => (f.respondidos >= 10 ? `${minutosTxt(v)} (${num(f.respondidos)})` : '—'),
    csv: (v, f) => (f.respondidos >= 10 ? String(v ?? '') : ''),
  },
];

function TiemposCampanas({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Tiempos>(conRango('/api/campanas/tiempos', rango), 120_000);
  const marcas = useMarcas(rango, ['whatsapp', 'trazabilidad'], '2026-09-30');

  // CAM-06: % acumulado de respuesta según las horas desde el envío, una curva por campaña.
  const opt = useCallback(() => {
    const filas = data!.respuesta;
    const horas = [...new Set(filas.map((f) => f.hora))].sort((a, b) => a - b);
    const series: Record<string, (number | null)[]> = {};
    for (const c of ['execute', 'reminder', 'recuperacion', 'conasistencia']) {
      const fc = filas.filter((f) => f.campana === c);
      if (!fc.length) continue;
      series[c] = horas.map((h) => {
        const f = fc.find((x) => x.hora === h);
        return f && f.enviados ? f.acumulado / f.enviados : null;
      });
    }
    const o = lineas(horas.map(String), series, 'day', undefined, true) as any;
    o.xAxis.data = horas.map((h) => (h < 24 ? `${h} h` : `${h / 24} d`));
    o.series.forEach((s: any) => (s.name = etiqueta(s.name)));
    return o;
  }, [data]);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <div className="grid g2">
          <Tarjeta
            titulo="¿Cuánto tardan en responder?"
            ayuda="Porcentaje de pacientes que ya respondió según el tiempo transcurrido desde el envío. Sirve para decidir cuánto esperar antes de insistir."
          >
            {data.respuesta.length ? <Grafico opcion={opt} alto={260} /> : <p className="ayuda">Sin envíos que pidan respuesta en este período.</p>}
          </Tarjeta>
          <Tarjeta titulo="Lectura y respuesta por campaña" marcas={marcas} ayuda="Tiempo típico (mediana) desde el envío, y entre paréntesis cuántos casos lo respaldan (mínimo 10). La lectura solo se conoce desde el 30 sep 2026 y solo de quienes tienen activadas las confirmaciones de lectura.">
            <div className="cifras">
              <div className="cifra">
                <div className="n">{minutosTxt(data.lectura.mediana_respuesta_min)}</div>
                <div className="t">tiempo típico hasta responder</div>
              </div>
              <div className="cifra">
                <div className="n">{minutosTxt(data.lectura.mediana_lectura_min)}</div>
                <div className="t">tiempo típico hasta leer</div>
              </div>
              <div className="cifra">
                <div className="n">{tasaTxt(ratio(data.lectura.leidos, data.lectura.entregados), 0)}</div>
                <div className="t">de los entregados aparecen como leídos</div>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <Tabla filas={data.porCampana} columnas={COLS_TIEMPO} vacio="Sin envíos en el período" />
            </div>
          </Tarjeta>
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------------------------- fatiga
interface Fatiga {
  meses: { mes: string; numeros: number; g1: number; g2: number; g4: number; g8: number; maximo: number; promedio: number }[];
  respuesta: { grupo: string; piden: number; respondieron: number }[];
  campanas: { campana: string; mensajes: number }[];
}

const GRUPOS: [string, string][] = [
  ['1', '1 mensaje'],
  ['2-3', '2 a 3 mensajes'],
  ['4-7', '4 a 7 mensajes'],
  ['8+', '8 o más mensajes'],
];

function FatigaMensajes({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Fatiga>(conRango('/api/campanas/fatiga', rango), 300_000);
  const marcas = useMarcas(rango, ['whatsapp', 'trazabilidad']);
  const tot = useMemo(() => {
    const m = data?.meses ?? [];
    return { numeros: m.reduce((s, x) => s + x.numeros, 0), g8: m.reduce((s, x) => s + x.g8, 0), maximo: Math.max(0, ...m.map((x) => x.maximo)) };
  }, [data]);

  const optMeses = useCallback(() => {
    const m = data!.meses;
    return barrasApiladas(
      m.map((x) => x.mes),
      { '1 mensaje': m.map((x) => x.g1), '2 a 3': m.map((x) => x.g2), '4 a 7': m.map((x) => x.g4), '8 o más': m.map((x) => x.g8) },
      'month',
    );
  }, [data]);

  const optRespuesta = useCallback(() => {
    const items = GRUPOS.map(([k, nombre]) => {
      const f = data!.respuesta.find((x) => x.grupo === k);
      return { nombre, parte: f?.respondieron ?? 0, total: f?.piden ?? 0 };
    });
    const piden = items.reduce((s, x) => s + x.total, 0);
    return barrasTasa(items, 30, piden ? items.reduce((s, x) => s + x.parte, 0) / piden : undefined);
  }, [data]);

  const totalFatiga = (data?.campanas ?? []).reduce((s, c) => s + c.mensajes, 0);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (data.meses.length === 0 ? (
        <Tarjeta titulo="¿Le escribimos demasiado a alguien?">
          <p className="vacio">Sin mensajes de campaña en el período.</p>
        </Tarjeta>
      ) : (
        <>
          <Tarjeta
            titulo="¿Le escribimos demasiado a alguien?"
            marcas={marcas}
            ayuda="Cuántos mensajes de campaña recibió cada número de celular en un mes. Un número compartido por una familia recibe los mensajes de todos sus miembros."
          >
            <div className="cifras">
              <div className="cifra">
                <div className="n">{num(tot.g8)}</div>
                <div className="t">veces que un número recibió 8 o más mensajes en un mes ({pct(tot.g8, tot.numeros, 0)})</div>
              </div>
              <div className="cifra">
                <div className="n">{num(tot.maximo)}</div>
                <div className="t">mensajes al mismo número en un mes, como máximo</div>
              </div>
            </div>
            <Grafico opcion={optMeses} alto={240} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta
              titulo="¿Responden menos quienes reciben más?"
              ayuda="Tasa de respuesta a las campañas que piden respuesta, según cuántos mensajes recibió ese número en el mes (1, 2 a 3, 4 a 7, 8 o más). Si baja con el volumen, hay cansancio."
            >
              <Grafico opcion={optRespuesta} alto={220} />
            </Tarjeta>
            <Tarjeta titulo="¿De dónde vienen tantos mensajes?" ayuda="Mensajes enviados a los números que recibieron 8 o más en el mes, por campaña.">
              {totalFatiga ? (
                <ListaConteo items={data.campanas.map((c) => ({ clave: c.campana, etiqueta: etiqueta(c.campana), n: c.mensajes }))} total={totalFatiga} />
              ) : (
                <p className="vacio">Ningún número recibió 8 o más mensajes en un mes del período.</p>
              )}
            </Tarjeta>
          </div>
        </>
      ))}
    </>
  );
}

export default function CampanasDesempeno({ rango }: { rango: Rango }) {
  return (
    <>
      <Restringido clave="campanas.rankings" titulo="¿Qué campaña funciona mejor?">
        <Rankings rango={rango} />
      </Restringido>
      <Restringido clave="campanas.tiempos" titulo="¿Cuánto tardan en leer y responder?">
        <TiemposCampanas rango={rango} />
      </Restringido>
      <Restringido clave="campanas.fatiga" titulo="Fatiga de mensajes">
        <FatigaMensajes rango={rango} />
      </Restringido>
    </>
  );
}
