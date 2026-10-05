import { useApi, type Rango } from '../api';
import { Estado, Tarjeta } from '../components/ui';
import { Candado, useAcceso, type Nivel } from '../acceso';
import { num } from '../format';

interface Plan {
  nivel: Nivel;
  contacto: string | null;
  niveles: { clave: Nivel; nombre: string; historialDias: number | null; maxUsuarios: number | null }[];
  funciones: { clave: string; titulo: string; pagina: string | null; nivel: Nivel }[];
  proximamente: { titulo: string; nivel: Nivel }[];
}

const ORDEN: Nivel[] = ['basico', 'intermedio', 'full'];
const rango = (n: Nivel) => ORDEN.indexOf(n);

const SECCIONES: [string | null, string][] = [
  ['resumen', 'Resumen'],
  ['agenda', 'Agenda'],
  ['capacidad', 'Capacidad'],
  ['profesionales', 'Profesionales'],
  ['mi-agenda', 'Mi agenda (profesionales)'],
  ['campanas', 'Campañas'],
  ['chatbot', 'Chatbot'],
  ['pacientes', 'Pacientes'],
  ['lista-espera', 'Lista de espera'],
  ['marketing', 'Marketing'],
  ['alertas', 'Alertas'],
  [null, 'Descargas'],
];

const historialTxt = (d: number | null) => (d === null ? 'Completo, desde ago-2025' : d >= 365 ? `Últimos ${Math.round(d / 30.4)} meses` : `Últimos ${d} días`);
const usuariosTxt = (u: number | null) => (u === null ? 'Sin límite' : `${num(u)} ${u === 1 ? 'usuario' : 'usuarios'}`);

export default function MiPlan(_: { rango: Rango }) {
  const { data, error, cargando } = useApi<Plan>('/api/plan');
  const { yo } = useAcceso();

  if (!data) return <Estado cargando={cargando} error={error} hayDatos={false} />;
  const actual = data.niveles.find((n) => n.clave === data.nivel)!;
  const siguiente = data.niveles.find((n) => rango(n.clave) === rango(data.nivel) + 1);
  const mensaje = encodeURIComponent(
    `Hola, quiero información sobre el plan ${siguiente?.nombre ?? actual.nombre} del panel de reportes del Centro de Orientación.`,
  );

  return (
    <>
      <section className="card plan-actual">
        <div>
          <div className="etiqueta">Su plan actual</div>
          <div className="plan-nombre">{actual.nombre}</div>
          <p className="ayuda" style={{ margin: 0 }}>
            Historial: {historialTxt(actual.historialDias).toLowerCase()} · Usuarios: {usuariosTxt(actual.maxUsuarios).toLowerCase()}
            {yo?.vistaPrevia ? ' · (vista previa)' : ''}
          </p>
        </div>
        {siguiente && data.contacto && (
          <a className="boton boton-primario" href={`https://wa.me/${data.contacto}?text=${mensaje}`} target="_blank" rel="noreferrer">
            Quiero el plan {siguiente.nombre}
          </a>
        )}
      </section>

      <Tarjeta titulo="Qué incluye cada plan" ayuda="Las funciones con candado en el menú y en las pantallas se habilitan al cambiar de plan, sin perder ninguna configuración.">
        <div className="tabla-wrap">
          <table className="tabla-planes">
            <thead>
              <tr>
                <th />
                {data.niveles.map((n) => (
                  <th key={n.clave} className={n.clave === data.nivel ? 'actual' : ''}>
                    {n.nombre}
                    {n.clave === data.nivel && <div className="plan-tuyo">Su plan</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Historial consultable</td>
                {data.niveles.map((n) => <td key={n.clave} className={n.clave === data.nivel ? 'actual' : ''}>{historialTxt(n.historialDias)}</td>)}
              </tr>
              <tr>
                <td>Usuarios con acceso</td>
                {data.niveles.map((n) => <td key={n.clave} className={n.clave === data.nivel ? 'actual' : ''}>{usuariosTxt(n.maxUsuarios)}</td>)}
              </tr>
              {SECCIONES.map(([pagina, titulo]) => {
                const fs = data.funciones.filter((f) => f.pagina === pagina);
                if (!fs.length) return null;
                return [
                  <tr key={`s-${titulo}`} className="seccion">
                    <td colSpan={data.niveles.length + 1}>{titulo}</td>
                  </tr>,
                  ...fs.map((f) => (
                    <tr key={f.clave}>
                      <td>{f.titulo}</td>
                      {data.niveles.map((n) => (
                        <td key={n.clave} className={`marca ${n.clave === data.nivel ? 'actual' : ''}`}>
                          {rango(n.clave) >= rango(f.nivel) ? <span className="si">✓</span> : <span className="no">—</span>}
                        </td>
                      ))}
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      </Tarjeta>

      {data.proximamente.length > 0 && (
        <Tarjeta titulo="En desarrollo" ayuda="Funciones que se están construyendo y que se sumarán al plan indicado.">
          <ul className="lista-simple">
            {data.proximamente.map((p) => (
              <li key={p.titulo}>
                <span>{p.titulo}</span>
                <span className="ayuda" style={{ margin: 0, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  {rango(data.nivel) < rango(p.nivel) && <Candado />}
                  Plan {data.niveles.find((n) => n.clave === p.nivel)?.nombre}
                </span>
              </li>
            ))}
          </ul>
        </Tarjeta>
      )}

      {!data.contacto && siguiente && <p className="nota">Para cambiar de plan, comuníquese con su proveedor del panel.</p>}
    </>
  );
}
