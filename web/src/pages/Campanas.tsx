import { useCallback, useMemo, useState } from 'react';
import { conRango, getJson, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, pivotar } from '../components/series';
import { descargarCsv, Estado, Tabla, Tarjeta, type Columna } from '../components/ui';
import { etiqueta, fecha, fechaHora, hora, num, pct } from '../format';

interface FilaCampana {
  campana: string;
  dias: number;
  enviados: number;
  fallidos: number;
  entregados: number;
  leidos: number;
  respondieron: number;
  respondieron_tarde: number;
  no_respondieron: number;
  pendientes: number;
  citas_confirmadas: number;
  citas_canceladas: number;
}
interface Datos {
  rango: { grano: string };
  porCampana: FilaCampana[];
  serie: { periodo: string; campana: string | null; enviados: number }[];
  entregaDesde: string | null;
}
interface Envio {
  enviado: string;
  campana: string;
  nombre_paciente: string | null;
  documento_paciente: string | null;
  telefono_norm: string | null;
  estado: string;
  entregado: boolean;
  leido: boolean;
  estado_respuesta: string;
  respondido: string | null;
  fecha_cita: string | null;
  hora_cita: string | null;
  estado_cita_actual: string | null;
  cita_confirmada_despues: boolean;
  cita_cancelada_despues: boolean;
  error_titulo: string | null;
}

const PRINCIPALES = ['execute', 'reminder', 'daily', 'recuperacion', 'conasistencia'];
const si = (v: boolean) => (v ? 'Sí' : '—');

const COLS_CAMPANA: Columna<FilaCampana>[] = [
  { clave: 'campana', titulo: 'Campaña', formato: etiqueta, csv: etiqueta },
  { clave: 'dias', titulo: 'Días con envíos', num: true },
  { clave: 'enviados', titulo: 'Enviados', num: true },
  { clave: 'fallidos', titulo: 'Fallidos', num: true },
  { clave: 'leidos', titulo: 'Leídos', num: true },
  {
    clave: 'respondieron',
    titulo: 'Respondieron',
    num: true,
    formato: (_v, f) => `${num(f.respondieron + f.respondieron_tarde)} (${pct(f.respondieron + f.respondieron_tarde, f.enviados, 0)})`,
    csv: (_v, f) => String(f.respondieron + f.respondieron_tarde),
    orden: (f) => f.respondieron + f.respondieron_tarde,
  },
  { clave: 'citas_confirmadas', titulo: 'Confirmaron la cita', num: true },
  { clave: 'citas_canceladas', titulo: 'Cancelaron la cita', num: true },
];

const COLS_ENVIO: Columna<Envio>[] = [
  { clave: 'enviado', titulo: 'Enviado', formato: fechaHora, csv: (v) => String(v ?? '') },
  { clave: 'campana', titulo: 'Campaña', formato: etiqueta, csv: etiqueta },
  { clave: 'nombre_paciente', titulo: 'Paciente' },
  { clave: 'documento_paciente', titulo: 'Documento' },
  { clave: 'telefono_norm', titulo: 'Teléfono' },
  { clave: 'leido', titulo: 'Leído', formato: si, csv: si },
  { clave: 'estado_respuesta', titulo: 'Respuesta', formato: etiqueta, csv: etiqueta },
  { clave: 'fecha_cita', titulo: 'Cita', formato: (v, f) => (v ? `${fecha(v)} ${hora(f.hora_cita)}` : '—'), csv: (v, f) => (v ? `${v} ${hora(f.hora_cita)}` : '') },
  { clave: 'estado_cita_actual', titulo: 'Estado actual de la cita' },
  { clave: 'cita_confirmada_despues', titulo: 'Confirmó', formato: si, csv: si },
  { clave: 'error_titulo', titulo: 'Error' },
];

const TAM = 50;

export default function Campanas({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Datos>(conRango('/api/campanas', rango), 60_000);
  const [campana, setCampana] = useState('');
  const [respuesta, setRespuesta] = useState('');
  const [pagina, setPagina] = useState(1);
  const [exportando, setExportando] = useState(false);

  const filtros = { campana, respuesta };
  const urlEnvios = conRango('/api/campanas/envios', rango, { ...filtros, pagina, tam: TAM });
  const envios = useApi<{ filas: Envio[]; total: number }>(urlEnvios, 60_000);

  const grupos = useMemo(() => {
    const presentes = new Set((data?.serie ?? []).map((s) => s.campana).filter(Boolean) as string[]);
    const g = PRINCIPALES.filter((c) => presentes.has(c));
    return [...presentes].some((c) => !PRINCIPALES.includes(c)) ? [...g, 'Otras'] : g;
  }, [data]);

  const opcion = useCallback(() => {
    const filas = data!.serie.map((s) => ({ ...s, campana: s.campana && !PRINCIPALES.includes(s.campana) ? 'Otras' : s.campana }));
    const { periodos, series } = pivotar(filas, 'campana', 'enviados', grupos);
    // El color se asigna por el código de campaña; después se traduce el nombre visible.
    const opt = barrasApiladas(periodos, series, data!.rango.grano) as any;
    opt.series.forEach((s: any) => (s.name = s.name === 'Otras' ? 'Otras' : etiqueta(s.name)));
    return opt;
  }, [data, grupos]);

  const exportar = async () => {
    setExportando(true);
    try {
      const d = await getJson<{ filas: Envio[] }>(conRango('/api/campanas/envios', rango, { ...filtros, pagina: 1, tam: 5000 }));
      descargarCsv(`envios_${rango.desde}_${rango.hasta}`, d.filas, COLS_ENVIO);
    } finally {
      setExportando(false);
    }
  };

  const total = envios.data?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / TAM));

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          {data.entregaDesde && (
            <div className="aviso">
              WhatsApp informa si un mensaje fue entregado o leído solo desde el {fecha(data.entregaDesde)}. Antes de esa fecha solo se sabe si el envío fue aceptado.
            </div>
          )}
          <Tarjeta titulo="Resultados por campaña" ayuda="Confirmaron/cancelaron: el paciente cambió el estado de su cita después de recibir el mensaje.">
            <Tabla filas={data.porCampana} columnas={COLS_CAMPANA} nombreCsv={`campanas_${rango.desde}_${rango.hasta}`} />
          </Tarjeta>
          <Tarjeta titulo="Mensajes enviados por campaña">
            <Grafico opcion={opcion} />
          </Tarjeta>
        </>
      )}

      <Tarjeta
        titulo="Detalle de mensajes"
        ayuda="Cada mensaje enviado, a quién y qué pasó después."
        accion={<button className="boton" disabled={exportando || total === 0} onClick={exportar}>{exportando ? 'Preparando…' : 'Descargar CSV (hasta 5.000)'}</button>}
      >
        <div className="filtros">
          <select value={campana} onChange={(e) => (setCampana(e.target.value), setPagina(1))}>
            <option value="">Todas las campañas</option>
            {(data?.porCampana ?? []).map((c) => <option key={c.campana} value={c.campana}>{etiqueta(c.campana)}</option>)}
          </select>
          <select value={respuesta} onChange={(e) => (setRespuesta(e.target.value), setPagina(1))}>
            <option value="">Cualquier respuesta</option>
            {['respondio', 'respondio_tarde', 'no_respondio', 'pendiente', 'no_aplica'].map((r) => <option key={r} value={r}>{etiqueta(r)}</option>)}
          </select>
        </div>
        <Estado cargando={envios.cargando} error={envios.error} hayDatos={!!envios.data} />
        {envios.data && (
          <>
            <Tabla filas={envios.data.filas} columnas={COLS_ENVIO} />
            <div className="tabla-pie">
              <span>{num(total)} mensajes · página {pagina} de {paginas}</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="boton" disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>Anterior</button>
                <button className="boton" disabled={pagina >= paginas} onClick={() => setPagina((p) => p + 1)}>Siguiente</button>
              </span>
            </div>
          </>
        )}
      </Tarjeta>
    </>
  );
}
