import { conRango, useApi, type Rango } from '../api';
import { Estado, Kpi, ListaConteo, Tabla, Tarjeta, type Columna } from '../components/ui';
import { etiqueta, fecha, fechaHora, hora } from '../format';

type Conteo = { clave: string; n: number };
interface Cupo {
  detectado: string;
  fecha_cita: string;
  hora_cita: string;
  estado: string;
  profesional: string | null;
  especialidad: string | null;
  asignado_a: string | null;
  motivo_cierre: string | null;
}
interface Oferta {
  enviada: string | null;
  respondida: string | null;
  estado: string;
  paciente: string | null;
  fecha_cita: string | null;
  hora_cita: string | null;
  profesional: string | null;
  posicion_en_fila: number | null;
}
interface Ejecucion {
  iniciada: string;
  campana_tipo: string;
  estado: string;
  total_evaluadas: number;
  total_elegibles: number;
  enviadas: number;
  errores: number;
  motivo_fin: string | null;
}
interface Datos {
  inscripcionesHoy: Conteo[];
  inscripciones: Conteo[];
  cupos: Conteo[];
  ofertas: Conteo[];
  invitaciones: Conteo[];
  cuposRecientes: Cupo[];
  ofertasRecientes: Oferta[];
  ejecuciones: Ejecucion[];
}

const lista = (c: Conteo[]) => c.map((x) => ({ clave: x.clave, etiqueta: etiqueta(x.clave), n: x.n }));
const suma = (c: Conteo[]) => c.reduce((s, x) => s + x.n, 0);
const de = (c: Conteo[], clave: string) => c.find((x) => x.clave === clave)?.n ?? 0;
const cita = (v: string | null, f: { hora_cita: string | null }) => (v ? `${fecha(v)} ${hora(f.hora_cita)}` : '—');

const COLS_CUPO: Columna<Cupo>[] = [
  { clave: 'detectado', titulo: 'Liberado', formato: fechaHora },
  { clave: 'fecha_cita', titulo: 'Cita disponible', formato: cita },
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'estado', titulo: 'Estado', formato: etiqueta, csv: etiqueta },
  { clave: 'asignado_a', titulo: 'Asignado a' },
];
const COLS_OFERTA: Columna<Oferta>[] = [
  { clave: 'enviada', titulo: 'Enviada', formato: fechaHora },
  { clave: 'paciente', titulo: 'Paciente' },
  { clave: 'fecha_cita', titulo: 'Cupo ofrecido', formato: cita },
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'posicion_en_fila', titulo: 'Puesto en la fila', num: true },
  { clave: 'estado', titulo: 'Resultado', formato: etiqueta, csv: etiqueta },
  { clave: 'respondida', titulo: 'Respondió', formato: fechaHora },
];
const COLS_EJEC: Columna<Ejecucion>[] = [
  { clave: 'iniciada', titulo: 'Fecha', formato: fechaHora },
  { clave: 'campana_tipo', titulo: 'Tipo', formato: etiqueta, csv: etiqueta },
  { clave: 'total_evaluadas', titulo: 'Citas revisadas', num: true },
  { clave: 'total_elegibles', titulo: 'Elegibles', num: true },
  { clave: 'enviadas', titulo: 'Invitaciones enviadas', num: true },
  { clave: 'errores', titulo: 'Errores', num: true },
  { clave: 'estado', titulo: 'Estado', formato: etiqueta, csv: etiqueta },
];

export default function ListaEspera({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Datos>(conRango('/api/lista-espera', rango), 60_000);

  return (
    <>
      <div className="aviso">
        La lista de espera funciona desde el 30 de septiembre de 2026. Cuando una cita se cancela, el sistema ofrece ese cupo a pacientes inscritos que tienen una cita más lejana.
      </div>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Inscritos activos hoy" actual={de(data.inscripcionesHoy, 'activa')} />
            <Kpi etiqueta="Nuevas inscripciones" actual={suma(data.inscripciones)} />
            <Kpi etiqueta="Cupos liberados" actual={suma(data.cupos)} />
            <Kpi etiqueta="Ofertas enviadas" actual={suma(data.ofertas)} />
            <Kpi etiqueta="Ofertas aceptadas" actual={de(data.ofertas, 'aceptada')} />
            <Kpi etiqueta="Invitaciones a inscribirse" actual={suma(data.invitaciones)} />
          </div>
          <div className="grid g3">
            <Tarjeta titulo="Inscripciones del período" ayuda="Estado actual de cada inscripción.">
              <ListaConteo items={lista(data.inscripciones)} total={suma(data.inscripciones)} />
            </Tarjeta>
            <Tarjeta titulo="Cupos liberados" ayuda="Qué pasó con cada cupo que dejó una cancelación.">
              <ListaConteo items={lista(data.cupos)} total={suma(data.cupos)} />
            </Tarjeta>
            <Tarjeta titulo="Ofertas de cupo" ayuda="Respuesta de los pacientes a las ofertas.">
              <ListaConteo items={lista(data.ofertas)} total={suma(data.ofertas)} />
            </Tarjeta>
          </div>
          <Tarjeta titulo="Cupos liberados recientes">
            <Tabla filas={data.cuposRecientes} columnas={COLS_CUPO} nombreCsv="cupos_liberados" />
          </Tarjeta>
          <Tarjeta titulo="Ofertas recientes">
            <Tabla filas={data.ofertasRecientes} columnas={COLS_OFERTA} nombreCsv="ofertas_cupo" />
          </Tarjeta>
          <Tarjeta titulo="Campañas de invitación" ayuda="Envíos que invitan a pacientes con citas lejanas a inscribirse en la lista de espera.">
            <Tabla filas={data.ejecuciones} columnas={COLS_EJEC} nombreCsv="invitaciones" vacio="Aún no se han ejecutado campañas de invitación en este período" />
          </Tarjeta>
        </>
      )}
    </>
  );
}
