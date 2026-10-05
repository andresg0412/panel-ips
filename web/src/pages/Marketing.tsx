import { useCallback, useMemo } from 'react';
import { useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas } from '../components/series';
import { Estado, Kpi, Tabla, Tarjeta, type Columna } from '../components/ui';
import { useMesesConfiables, useSombras } from '../incidentes';
import { etiqueta, num, pct } from '../format';

interface Marketing {
  alcance: { mes: string; personas: number; respondieron: number }[];
  telefonos: { pacientes: number; con_celular: number; respondieron_alguna_vez: number };
  segmentos: { estado: string; especialidad: string; tipo_pago: string; pacientes: number; contactables: number; contactados_30d: number }[];
}

const COLS_SEG: Columna<Marketing['segmentos'][number]>[] = [
  { clave: 'estado', titulo: 'Estado', formato: (v) => (v === 'en_riesgo' ? 'En riesgo' : 'Inactivo'), csv: (v) => String(v) },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'tipo_pago', titulo: 'Pago', formato: etiqueta, csv: etiqueta },
  { clave: 'pacientes', titulo: 'Pacientes', num: true },
  { clave: 'contactables', titulo: 'Con celular válido', num: true },
  { clave: 'contactados_30d', titulo: 'Ya recibieron recuperación (30 d)', num: true },
  {
    clave: 'contactables',
    titulo: 'Disponibles para contactar',
    num: true,
    formato: (_v, f) => num(Math.max(f.contactables - f.contactados_30d, 0)),
    csv: (_v, f) => String(Math.max(f.contactables - f.contactados_30d, 0)),
    orden: (f) => f.contactables - f.contactados_30d,
  },
];

export default function Marketing(_: { rango: Rango }) {
  const { data, error, cargando } = useApi<Marketing>('/api/marketing');
  const sombras = useSombras(['whatsapp']);
  const alcance = useMemo(() => (data?.alcance ?? []).filter((m) => m.mes >= '2025-08'), [data]);

  const optAlcance = useCallback(
    () =>
      barrasApiladas(
        alcance.map((m) => m.mes),
        { Respondieron: alcance.map((m) => m.respondieron), 'Solo recibieron': alcance.map((m) => Math.max(m.personas - m.respondieron, 0)) },
        'month',
        sombras,
      ),
    [alcance, sombras],
  );

  const confiables = useMesesConfiables()(alcance.map((m) => m.mes));
  const ultimos = alcance.filter((m) => confiables.includes(m.mes));
  const promPersonas = ultimos.length ? Math.round(ultimos.reduce((s, m) => s + m.personas, 0) / ultimos.length) : null;
  const t = data?.telefonos;
  const riesgo = (data?.segmentos ?? []).filter((s) => s.estado === 'en_riesgo');
  const disponiblesRiesgo = riesgo.reduce((s, x) => s + Math.max(x.contactables - x.contactados_30d, 0), 0);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && t && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Personas alcanzadas por WhatsApp al mes" valor={promPersonas === null ? undefined : `${num(promPersonas)}`} actual={promPersonas} comparacion="" />
            <Kpi etiqueta="Pacientes con celular válido" valor={pct(t.con_celular, t.pacientes, 0)} actual={null} />
            <Kpi etiqueta="Personas que alguna vez respondieron" actual={t.respondieron_alguna_vez} />
            <Kpi etiqueta="Pacientes en riesgo que se pueden contactar" actual={disponiblesRiesgo} />
          </div>
          <Tarjeta
            titulo="Alcance de WhatsApp por mes"
            ayuda="Personas distintas que recibieron al menos un mensaje de campaña, y cuántas respondieron. De abril a julio de 2026 los mensajes no llegaron (incidente)."
          >
            <Grafico opcion={optAlcance} alto={280} />
          </Tarjeta>
          <Tarjeta
            titulo="Segmentos para invitar a volver"
            ayuda="Pacientes en riesgo o inactivos, por especialidad y forma de pago. No cuenta a quienes ya recibieron un mensaje de recuperación en los últimos 30 días. En salud mental, recontactar exige cuidado: conviene validar el texto y la frecuencia con la IPS."
          >
            <Tabla filas={data.segmentos} columnas={COLS_SEG} nombreCsv="segmentos_recuperacion" />
            <p className="nota">
              Para descargar la lista de pacientes en riesgo con sus datos de contacto, use Pacientes → Retención y actividad.
            </p>
          </Tarjeta>
        </>
      )}
    </>
  );
}
