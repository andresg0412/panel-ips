import { useEffect, useState } from 'react';
import { useApi, type Rango } from '../api';
import { Pestanas, usePestana } from '../incidentes';
import PacientesPanorama from './PacientesPanorama';
import PacientesRetencion from './PacientesRetencion';
import { Estado, Tabla, Tarjeta, type Columna } from '../components/ui';
import { etiqueta, fecha, fechaHora, hora } from '../format';

interface Resultado {
  paciente_id: string;
  nombre_completo: string;
  tipo_documento: string | null;
  numero_documento: string;
  telefono_norm: string | null;
  edad: number | null;
  convenio: string | null;
}
interface Ficha {
  paciente: Record<string, string | number | null>;
  citas: Record<string, string | null>[];
  timeline: Record<string, string | null>[];
  listaEspera: Record<string, string | number | null>[];
}

const COLS_RES: Columna<Resultado>[] = [
  { clave: 'nombre_completo', titulo: 'Nombre' },
  { clave: 'numero_documento', titulo: 'Documento', formato: (v, f) => `${f.tipo_documento ?? ''} ${v}`.trim() },
  { clave: 'telefono_norm', titulo: 'Teléfono' },
  { clave: 'edad', titulo: 'Edad', num: true },
  { clave: 'convenio', titulo: 'Convenio' },
];
const COLS_CITA: Columna<Record<string, string | null>>[] = [
  { clave: 'fecha_cita', titulo: 'Fecha', formato: (v, f) => `${fecha(v)} ${hora(f.hora_cita)}` },
  { clave: 'estado_agenda', titulo: 'Estado' },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'tipo_consulta', titulo: 'Tipo' },
  { clave: 'administradora', titulo: 'Convenio' },
];
const COLS_TL: Columna<Record<string, string | null>>[] = [
  { clave: 'cuando', titulo: 'Cuándo', formato: fechaHora },
  { clave: 'fuente', titulo: 'Fuente', formato: etiqueta },
  { clave: 'tipo', titulo: 'Qué pasó', formato: etiqueta },
  { clave: 'flujo', titulo: 'Trámite', formato: (v) => (v ? etiqueta(v) : '—') },
  { clave: 'resultado', titulo: 'Resultado', formato: (v) => (v ? etiqueta(v) : '—') },
  { clave: 'campana', titulo: 'Campaña', formato: (v) => (v ? etiqueta(v) : '—') },
];

const CAMPOS: [string, string][] = [
  ['numero_documento', 'Documento'],
  ['telefono_norm', 'Teléfono'],
  ['email', 'Correo'],
  ['edad', 'Edad'],
  ['convenio', 'Convenio'],
  ['administradora', 'Administradora'],
  ['regimen', 'Régimen'],
  ['registrado', 'Registrado en el sistema'],
];

export default function Pacientes({ rango }: { rango: Rango }) {
  const [vista, setVista] = usePestana<'panorama' | 'retencion' | 'buscar'>(['panorama', 'retencion', 'buscar'], 'panorama');
  return (
    <>
      <Pestanas
        opciones={[
          ['panorama', 'Panorama'],
          ['retencion', 'Retención y actividad'],
          ['buscar', 'Buscar un paciente'],
        ]}
        valor={vista}
        onCambio={setVista}
      />
      {vista === 'panorama' && <PacientesPanorama rango={rango} />}
      {vista === 'retencion' && <PacientesRetencion />}
      {vista === 'buscar' && <BuscarPaciente />}
    </>
  );
}

function BuscarPaciente() {
  const [texto, setTexto] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [id, setId] = useState<string | null>(null);

  // Espera a que se deje de escribir antes de buscar.
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(texto.trim()), 400);
    return () => clearTimeout(t);
  }, [texto]);

  const res = useApi<{ filas: Resultado[] }>(busqueda.length >= 3 ? `/api/pacientes/buscar?q=${encodeURIComponent(busqueda)}` : null);
  const ficha = useApi<Ficha>(id ? `/api/pacientes/${id}` : null);

  return (
    <>
      <Tarjeta titulo="Buscar paciente" ayuda="Por número de documento, teléfono o nombre.">
        <div className="filtros">
          <input style={{ minWidth: 320 }} placeholder="Ej.: 1098765432, 3001234567 o María Pérez" value={texto} onChange={(e) => setTexto(e.target.value)} autoFocus />
        </div>
        {busqueda.length >= 3 && (
          <>
            <Estado cargando={res.cargando} error={res.error} hayDatos={!!res.data} />
            {res.data && <Tabla filas={res.data.filas} columnas={COLS_RES} alFila={(f) => setId(f.paciente_id)} vacio="No se encontraron pacientes" />}
          </>
        )}
      </Tarjeta>

      {id && (
        <>
          <Estado cargando={ficha.cargando} error={ficha.error} hayDatos={!!ficha.data} />
          {ficha.data && (
            <>
              <Tarjeta titulo={String(ficha.data.paciente.nombre_completo ?? 'Paciente')}>
                <div className="datos-paciente">
                  {CAMPOS.map(([k, t]) => (
                    <div key={k}>
                      <span>{t}</span>
                      {k === 'registrado' ? fecha(ficha.data!.paciente[k]) : String(ficha.data!.paciente[k] ?? '—')}
                    </div>
                  ))}
                  <div>
                    <span>Lista de espera</span>
                    {ficha.data.listaEspera.length === 0
                      ? 'No inscrito'
                      : ficha.data.listaEspera.map((l) => `${etiqueta(l.estado_inscripcion)} (${l.especialidad ?? ''})`).join(', ')}
                  </div>
                </div>
              </Tarjeta>
              <Tarjeta titulo="Citas" ayuda="Últimas 200.">
                <Tabla filas={ficha.data.citas} columnas={COLS_CITA} nombreCsv="citas_paciente" vacio="Sin citas registradas" />
              </Tarjeta>
              <Tarjeta titulo="Historial de contacto" ayuda="Mensajes, conversaciones con el bot y cambios de citas (últimos 300 eventos). No incluye el texto de los mensajes.">
                <Tabla filas={ficha.data.timeline} columnas={COLS_TL} vacio="Sin actividad registrada" />
              </Tarjeta>
            </>
          )}
        </>
      )}
    </>
  );
}
