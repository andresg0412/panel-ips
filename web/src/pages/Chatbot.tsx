import { useCallback, useState } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico, { base, token } from '../components/Grafico';
import { barrasApiladas, ranking } from '../components/series';
import { Estado, Kpi, Tabla, Tarjeta, type Columna } from '../components/ui';
import { DIAS, etiqueta, fecha, num, pct } from '../format';
import { AvisoIncidentes, useSombras } from '../incidentes';

type Conteo = { clave: string; n: number };
interface Datos {
  rango: { grano: string };
  kpis: {
    sesiones: number;
    personas: number;
    abandonadas: number;
    mediana_min: number | null;
    mensajes_promedio: number | null;
    fuera_horario: number;
    derivadas_fuera_horario: number;
  };
  conversion: { clave: string; entraron: number; lograron: number; derivadas: number }[];
  serie: { periodo: string; completadas: number; abandonadas: number }[];
  resultado: Conteo[];
  primerFlujo: Conteo[];
  motivoFin: Conteo[];
  mapaCalor: { dia: number; hora: number; n: number }[];
}
interface Paso {
  paso: string;
  descripcion: string | null;
  llegaron: number;
  terminaron: number;
  abandonaron: number;
}

/** 'agendar.s08_fechas' → 'Fechas'. Se usa cuando el catálogo de pasos no trae una descripción legible. */
function nombrePaso(p: Paso): string {
  if (p.descripcion && !/\.ts$/.test(p.descripcion)) return p.descripcion;
  const h = p.paso.replace(/^[^.]*\./, '').replace(/^[a-z]+\d+_/, '').replace(/_/g, ' ');
  return h.charAt(0).toUpperCase() + h.slice(1);
}

const FLUJOS = ['agendar', 'cancelar', 'reprogramar', 'campana_respuesta', 'lista_espera'];

const COLS_PASO: Columna<Paso>[] = [
  { clave: 'descripcion', titulo: 'Paso', formato: (_v, f) => nombrePaso(f), csv: (_v, f) => nombrePaso(f) },
  { clave: 'llegaron', titulo: 'Llegaron', num: true },
  { clave: 'abandonaron', titulo: 'Abandonaron aquí', num: true },
  { clave: 'terminaron', titulo: 'Terminaron aquí', num: true },
];

export default function Chatbot({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Datos>(conRango('/api/chatbot', rango), 60_000);
  const [flujo, setFlujo] = useState('agendar');
  const embudo = useApi<{ pasos: Paso[]; datosDesde: string | null }>(conRango('/api/chatbot/embudo', rango, { flujo }), 120_000);
  const sombras = useSombras(['conversaciones']);

  const optSerie = useCallback(
    () => barrasApiladas(data!.serie.map((s) => s.periodo), { Completadas: data!.serie.map((s) => s.completadas), Abandonadas: data!.serie.map((s) => s.abandonadas) }, data!.rango.grano, sombras),
    [data, sombras],
  );
  const optResultado = useCallback(() => ranking(data!.resultado.map((r) => ({ nombre: etiqueta(r.clave), valor: r.n }))), [data]);
  const optFlujo = useCallback(() => ranking(data!.primerFlujo.slice(0, 10).map((r) => ({ nombre: etiqueta(r.clave), valor: r.n }))), [data]);

  // Mapa de calor día × hora: magnitud en una sola rampa secuencial (azul claro → oscuro).
  const optCalor = useCallback(() => {
    const b = base() as Record<string, any>;
    const horas = Array.from({ length: 24 }, (_, h) => `${h}:00`);
    const valores = data!.mapaCalor.map((c) => [c.hora, 7 - c.dia, c.n]);
    const max = Math.max(1, ...data!.mapaCalor.map((c) => c.n));
    return {
      ...b,
      legend: { show: false },
      grid: { ...b.grid, top: 8, bottom: 48 },
      tooltip: { ...b.tooltip, formatter: (p: any) => `${DIAS[7 - p.value[1]]} ${p.value[0]}:00 – <b>${num(p.value[2])}</b> conversaciones` },
      xAxis: { ...b.xAxis, type: 'category', data: horas, splitArea: { show: false } },
      yAxis: { ...b.yAxis, type: 'category', data: DIAS.slice(1).reverse(), splitLine: { show: false } },
      visualMap: {
        min: 0, max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120,
        inRange: { color: [token('seq-0'), token('seq-1'), token('seq-2'), token('seq-3'), token('seq-4')] },
        textStyle: { color: token('muted') },
      },
      series: [{ type: 'heatmap', data: valores, itemStyle: { borderColor: token('surface'), borderWidth: 2, borderRadius: 3 } }],
    };
  }, [data]);

  const k = data?.kpis;

  return (
    <>
      <AvisoIncidentes rango={rango} areas={['conversaciones']} compara={false} />
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && k && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Conversaciones" actual={k.sesiones} />
            <Kpi etiqueta="Personas distintas" actual={k.personas} />
            <Kpi etiqueta="Abandonadas" valor={pct(k.abandonadas, k.sesiones)} actual={null} />
            <Kpi etiqueta="Duración típica" valor={k.mediana_min === null ? '—' : `${String(k.mediana_min).replace('.', ',')} min`} actual={null} />
            <Kpi etiqueta="Fuera del horario de recepción" valor={pct(k.fuera_horario, k.sesiones, 0)} actual={null} />
          </div>
          <Tarjeta
            titulo="¿Cuántos logran lo que vinieron a hacer?"
            ayuda="De las conversaciones que entraron a cada trámite, cuántas terminaron con el trámite hecho. El resto abandonó, pidió un asesor o no encontró lo que buscaba."
          >
            <div className="cifras">
              {data.conversion.map((c) => (
                <div className="cifra" key={c.clave}>
                  <div className="n">{pct(c.lograron, c.entraron, 0)}</div>
                  <div className="t">
                    <b>{etiqueta(c.clave)}</b>: {num(c.lograron)} de {num(c.entraron)} conversaciones
                    {c.derivadas > 0 ? ` · ${num(c.derivadas)} pasaron a un asesor` : ''}
                  </div>
                </div>
              ))}
            </div>
            {data.conversion.some((c) => c.clave === 'agendar' && c.entraron > 0 && c.lograron / c.entraron < 0.3) && (
              <p className="nota">
                Agendar convierte poco. Una causa conocida: el registro de pacientes nuevos por el bot falla desde septiembre de 2025, así que solo agendan
                pacientes ya registrados. Vea el recorrido paso a paso más abajo para saber dónde se quedan.
              </p>
            )}
            {k.derivadas_fuera_horario > 0 && (
              <p className="nota">{num(k.derivadas_fuera_horario)} personas pidieron un asesor fuera de horario y no pudieron ser atendidas en el momento.</p>
            )}
          </Tarjeta>
          <Tarjeta titulo="Conversaciones por período">
            <Grafico opcion={optSerie} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="¿Cómo terminaron?" ayuda="Resultado de cada conversación.">
              <Grafico opcion={optResultado} alto={280} />
            </Tarjeta>
            <Tarjeta titulo="¿A qué vinieron?" ayuda="Primer trámite que eligieron en la conversación.">
              <Grafico opcion={optFlujo} alto={280} />
            </Tarjeta>
          </div>
          <Tarjeta titulo="¿Cuándo escriben?" ayuda="Conversaciones iniciadas por día de la semana y hora (Colombia).">
            <Grafico opcion={optCalor} alto={300} />
          </Tarjeta>
        </>
      )}
      <Tarjeta
        titulo="Recorrido paso a paso"
        ayuda={embudo.data?.datosDesde ? `Dónde se quedan los pacientes dentro de un trámite. Datos detallados desde el ${fecha(embudo.data.datosDesde)}.` : 'Dónde se quedan los pacientes dentro de un trámite.'}
        accion={
          <select className="boton" value={flujo} onChange={(e) => setFlujo(e.target.value)}>
            {FLUJOS.map((f) => <option key={f} value={f}>{etiqueta(f)}</option>)}
          </select>
        }
      >
        <Estado cargando={embudo.cargando} error={embudo.error} hayDatos={!!embudo.data} />
        {embudo.data && <Tabla filas={embudo.data.pasos} columnas={COLS_PASO} nombreCsv={`recorrido_${flujo}`} vacio="Sin conversaciones de este trámite en el período" />}
      </Tarjeta>
    </>
  );
}
