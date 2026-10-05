import { useCallback, useMemo, useState } from 'react';
import { conRango, getJson, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, pivotar } from '../components/series';
import { Pestanas, useMarcas, usePestana, useSombras } from '../incidentes';
import { Bloqueado, Restringido, useAcceso } from '../acceso';
import CampanasEfecto, { CalendarioEjecuciones } from './CampanasEfecto';
import CampanasDesempeno from './CampanasDesempeno';
import { confirmarDescargaPersonal, descargarCsv, Estado, Tabla, Tarjeta, type Columna } from '../components/ui';
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
interface Calidad {
  errores: { codigo: string; error: string; n: number; desde: string; hasta: string }[];
  telefonos: { pacientes: number; sin_telefono_valido: number; no_movil: number };
  compartidos: { numeros: number; pacientes: number };
}
interface TelefonoInvalido {
  nombre_completo: string;
  tipo_documento: string | null;
  numero_documento: string;
  numero_contacto: string | null;
  email: string | null;
  registrado: string | null;
  problema: string;
}

const COLS_ERROR: Columna<Calidad['errores'][number]>[] = [
  { clave: 'error', titulo: 'Error de WhatsApp', envolver: true },
  { clave: 'codigo', titulo: 'Código' },
  { clave: 'n', titulo: 'Envíos', num: true },
  { clave: 'desde', titulo: 'Desde', formato: fecha },
  { clave: 'hasta', titulo: 'Hasta', formato: fecha },
];
const COLS_TEL: Columna<TelefonoInvalido>[] = [
  { clave: 'nombre_completo', titulo: 'Paciente' },
  { clave: 'tipo_documento', titulo: 'Tipo doc.' },
  { clave: 'numero_documento', titulo: 'Documento' },
  { clave: 'numero_contacto', titulo: 'Teléfono registrado' },
  { clave: 'email', titulo: 'Correo' },
  { clave: 'problema', titulo: 'Problema' },
];

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
  {
    clave: 'citas_confirmadas',
    titulo: 'Confirmaron la cita',
    num: true,
    formato: (v, f) => (v ? `${num(v)} (${pct(v, f.enviados, 0)})` : '—'),
    csv: (v) => String(v ?? 0),
  },
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

function CampanasResultados({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Datos>(conRango('/api/campanas', rango), 60_000);
  const { puede } = useAcceso();
  const exportarPersonales = puede('exportar.personales');
  const calidad = useApi<Calidad>(puede('campanas.calidad') ? conRango('/api/campanas/calidad', rango) : null, 300_000);
  const sombras = useSombras(['whatsapp', 'trazabilidad']);
  const marcas = useMarcas(rango, ['whatsapp', 'trazabilidad'], data?.entregaDesde);
  const [exportandoTel, setExportandoTel] = useState(false);
  const [campana, setCampana] = useState('');
  const [respuesta, setRespuesta] = useState('');
  const [pagina, setPagina] = useState(1);
  const [exportando, setExportando] = useState(false);

  const filtros = { campana, respuesta };
  const urlEnvios = conRango('/api/campanas/envios', rango, { ...filtros, pagina, tam: TAM });
  const envios = useApi<{ filas: Envio[]; total: number }>(puede('campanas.detalle') ? urlEnvios : null, 60_000);

  const grupos = useMemo(() => {
    const presentes = new Set((data?.serie ?? []).map((s) => s.campana).filter(Boolean) as string[]);
    const g = PRINCIPALES.filter((c) => presentes.has(c));
    return [...presentes].some((c) => !PRINCIPALES.includes(c)) ? [...g, 'Otras'] : g;
  }, [data]);

  const opcion = useCallback(() => {
    const filas = data!.serie.map((s) => ({ ...s, campana: s.campana && !PRINCIPALES.includes(s.campana) ? 'Otras' : s.campana }));
    const { periodos, series } = pivotar(filas, 'campana', 'enviados', grupos);
    // El color se asigna por el código de campaña; después se traduce el nombre visible.
    const opt = barrasApiladas(periodos, series, data!.rango.grano, sombras) as any;
    opt.series.forEach((s: any) => (s.name = s.name === 'Otras' ? 'Otras' : etiqueta(s.name)));
    return opt;
  }, [data, grupos, sombras]);

  const exportarTelefonos = async () => {
    if (!confirmarDescargaPersonal('el listado de pacientes con teléfono a corregir')) return;
    setExportandoTel(true);
    try {
      const d = await getJson<{ filas: TelefonoInvalido[] }>('/api/campanas/telefonos-invalidos');
      descargarCsv('pacientes_telefono_a_corregir', d.filas, COLS_TEL, true);
    } finally {
      setExportandoTel(false);
    }
  };


  const exportar = async () => {
    if (!confirmarDescargaPersonal('el detalle de mensajes enviados (hasta 5.000)')) return;
    setExportando(true);
    try {
      const d = await getJson<{ filas: Envio[] }>(conRango('/api/campanas/envios', rango, { ...filtros, pagina: 1, tam: 5000 }));
      descargarCsv(`envios_${rango.desde}_${rango.hasta}`, d.filas, COLS_ENVIO, true);
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
          <Tarjeta
            titulo="Resultados por campaña"
            marcas={marcas}
            ayuda={`Confirmaron: respondieron "confirmo" o la cita pasó a confirmada después del mensaje. ${
              data.entregaDesde ? `Entregados y leídos se conocen desde el ${fecha(data.entregaDesde)}.` : ''
            }`}
          >
            <Tabla filas={data.porCampana} columnas={COLS_CAMPANA} nombreCsv={`campanas_${rango.desde}_${rango.hasta}`} />
          </Tarjeta>
          <Tarjeta titulo="Mensajes enviados por campaña">
            <Grafico opcion={opcion} />
          </Tarjeta>
        </>
      )}

      {!puede('campanas.calidad') && <Bloqueado clave="campanas.calidad" titulo="Errores de envío y calidad de los teléfonos" />}
      {calidad.data && (
        <div className="grid g2">
          <Tarjeta titulo="Errores de envío" ayuda="Mensajes que WhatsApp no entregó en el período, por motivo.">
            <Tabla filas={calidad.data.errores} columnas={COLS_ERROR} vacio="Sin errores de envío en este período" />
          </Tarjeta>
          <Tarjeta
            titulo="Calidad de los teléfonos"
            ayuda="Estado actual. Un paciente sin teléfono válido no recibe recordatorios."
            accion={
              exportarPersonales ? (
                <button className="boton" disabled={exportandoTel} onClick={exportarTelefonos}>
                  {exportandoTel ? 'Preparando…' : 'Descargar para corregir'}
                </button>
              ) : undefined
            }
          >
            <div className="cifras">
              <div className="cifra">
                <div className="n">{num(calidad.data.telefonos.sin_telefono_valido)}</div>
                <div className="t">pacientes sin teléfono válido</div>
              </div>
              <div className="cifra">
                <div className="n">{num(calidad.data.telefonos.no_movil)}</div>
                <div className="t">con un número que no es celular colombiano</div>
              </div>
              <div className="cifra">
                <div className="n">{num(calidad.data.compartidos.numeros)}</div>
                <div className="t">números compartidos por {num(calidad.data.compartidos.pacientes)} pacientes (familias)</div>
              </div>
            </div>
            <p className="nota">De {num(calidad.data.telefonos.pacientes)} pacientes registrados.</p>
          </Tarjeta>
        </div>
      )}


      <Restringido clave="campanas.detalle" titulo="Detalle de mensajes">
      <Tarjeta
        titulo="Detalle de mensajes"
        marcas={[{ tipo: 'personales' }]}
        ayuda="Cada mensaje enviado, a quién y qué pasó después."
        accion={exportarPersonales ? <button className="boton" disabled={exportando || total === 0} onClick={exportar}>{exportando ? 'Preparando…' : 'Descargar CSV (hasta 5.000)'}</button> : undefined}
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
      </Restringido>
    </>
  );
}

type VistaCampanas = 'resultados' | 'efecto' | 'desempeno' | 'ejecuciones';

export default function Campanas({ rango }: { rango: Rango }) {
  const [vista, setVista] = usePestana<VistaCampanas>(['resultados', 'efecto', 'desempeno', 'ejecuciones'], 'resultados');
  const { puede } = useAcceso();
  const bloqueadas = ([['efecto', 'campanas.efecto'], ['ejecuciones', 'campanas.ejecuciones']] as const).filter(([, f]) => !puede(f)).map(([v]) => v as VistaCampanas);
  // Desempeño reúne tres funciones del plan Full: se bloquea solo si no tiene ninguna.
  if (!['campanas.rankings', 'campanas.tiempos', 'campanas.fatiga'].some(puede)) bloqueadas.push('desempeno');
  return (
    <>
      <Pestanas<VistaCampanas>
        bloqueadas={bloqueadas}
        opciones={[
          ['resultados', 'Resultados'],
          ['efecto', 'Efecto en las citas'],
          ['desempeno', 'Desempeño'],
          ['ejecuciones', 'Ejecuciones'],
        ]}
        valor={vista}
        onCambio={setVista}
      />
      {vista === 'resultados' && <CampanasResultados rango={rango} />}
      {vista === 'efecto' && (bloqueadas.includes('efecto') ? <Bloqueado clave="campanas.efecto" titulo="Efecto de las campañas en las citas" alto={280} /> : <CampanasEfecto rango={rango} />)}
      {vista === 'desempeno' && <CampanasDesempeno rango={rango} />}
      {vista === 'ejecuciones' && bloqueadas.includes('ejecuciones') && <Bloqueado clave="campanas.ejecuciones" titulo="Ejecuciones de las campañas" alto={280} />}
      {vista === 'ejecuciones' && !bloqueadas.includes('ejecuciones') && (
        <Tarjeta
          titulo="Ejecuciones de las campañas"
          ayuda="Cada cuadro es una campaña en un día (últimos 35 días del período). Pase el cursor para ver cuántas citas procesó y cuántos mensajes envió."
        >
          <CalendarioEjecuciones rango={rango} />
        </Tarjeta>
      )}
    </>
  );
}
