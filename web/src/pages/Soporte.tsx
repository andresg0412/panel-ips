import { useState } from 'react';
import { cambiarVistaPrevia, enviarJson, useApi, type Rango } from '../api';
import { Estado, Kpi, ListaConteo, Tabla, Tarjeta, type Columna } from '../components/ui';
import { Pestanas, usePestana } from '../incidentes';
import { useAcceso, type Nivel } from '../acceso';
import { fecha, fechaHora, num } from '../format';

// Consola del rol soporte. Solo la ve German; el cliente nunca llega aquí (el servidor rechaza /api/soporte/*).

type Vista = 'alertas' | 'licencia' | 'usuarios' | 'actividad' | 'incidentes';

export default function Soporte(_: { rango: Rango }) {
  const [vista, setVista] = usePestana<Vista>(['alertas', 'licencia', 'usuarios', 'actividad', 'incidentes'], 'alertas');
  return (
    <>
      <Pestanas<Vista>
        opciones={[
          ['alertas', 'Alertas técnicas'],
          ['licencia', 'Licencia y vista previa'],
          ['usuarios', 'Usuarios y roles'],
          ['actividad', 'Actividad'],
          ['incidentes', 'Incidentes de datos'],
        ]}
        valor={vista}
        onCambio={setVista}
      />
      {vista === 'alertas' && <AlertasTecnicas />}
      {vista === 'licencia' && <Licencia />}
      {vista === 'usuarios' && <Usuarios />}
      {vista === 'actividad' && <Actividad />}
      {vista === 'incidentes' && <Incidentes />}
    </>
  );
}

// ------------------------------------------------------------------------------------- alertas
interface AlertaTecnica {
  id: number;
  clave: string;
  grupo: string;
  severidad: 'alta' | 'media' | 'baja';
  titulo: string;
  detalle: string | null;
  impacto: string | null;
  enlace: string | null;
  estado: 'activa' | 'revisada' | 'silenciada' | 'resuelta';
  primera_vez: string;
  ultima_vez: string;
  silenciada_hasta: string | null;
  resuelta_at: string | null;
  resuelta_auto: boolean | null;
  nota: string | null;
  actualizado_por: string | null;
}

interface DatosAlertas {
  abiertas: AlertaTecnica[];
  resueltas: AlertaTecnica[];
  vigilante: {
    ultima_ejecucion: string | null;
    duracion_ms: number | null;
    comprobaciones: { nombre: string; grupo: string; ok: boolean; ms: number; error?: string }[];
  };
}

const GRUPO: Record<string, string> = {
  disponibilidad: 'Disponibilidad',
  despliegue: 'Despliegue',
  integraciones: 'Integraciones',
  lista_espera: 'Lista de espera',
  panel: 'Panel',
};
const COLOR_SEV: Record<string, string> = { alta: 'var(--critical)', media: 'var(--warning)', baja: 'var(--s-other)' };
const ESTADO: Record<string, string> = { activa: 'Activa', revisada: 'Revisada', silenciada: 'Silenciada', resuelta: 'Resuelta' };

function duracion(desde: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(`${desde}-05:00`)) / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} días`;
}

function TarjetaAlertaTecnica({ a, onCambio }: { a: AlertaTecnica; onCambio: () => void }) {
  const [nota, setNota] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cambiar = async (estado: string, horas?: number) => {
    setOcupado(true);
    setError(null);
    try {
      await enviarJson('POST', `/api/soporte/alertas/${a.id}`, { estado, ...(nota.trim() ? { nota: nota.trim() } : {}), ...(horas ? { horas } : {}) });
      setNota('');
      onCambio();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOcupado(false);
    }
  };
  return (
    <div className={`alerta-tecnica estado-${a.estado}`} style={{ borderLeftColor: COLOR_SEV[a.severidad] }}>
      <div className="alerta-cabeza">
        <span className="etiqueta-grupo">{GRUPO[a.grupo] ?? a.grupo}</span>
        <span className="etiqueta-sev" style={{ color: COLOR_SEV[a.severidad] }}>{a.severidad === 'alta' ? 'Alta' : a.severidad === 'media' ? 'Media' : 'Baja'}</span>
        <span className="etiqueta-estado">
          {ESTADO[a.estado]}
          {a.estado === 'silenciada' && a.silenciada_hasta ? ` hasta ${fechaHora(a.silenciada_hasta)}` : ''}
        </span>
      </div>
      <div className="alerta-titulo">{a.titulo}</div>
      {a.detalle && <div className="ayuda" style={{ margin: '2px 0' }}>{a.detalle}</div>}
      {a.impacto && <div className="alerta-impacto"><b>Impacto y qué revisar:</b> {a.impacto}</div>}
      <div className="nota" style={{ marginTop: 4 }}>
        Desde {fechaHora(a.primera_vez)} ({duracion(a.primera_vez)}) · vista por última vez {fechaHora(a.ultima_vez)}
        {a.nota ? ` · Nota: ${a.nota}` : ''}
        {a.actualizado_por ? ` · ${a.actualizado_por}` : ''}
      </div>
      <div className="alerta-acciones">
        {a.enlace && <a className="boton" href={a.enlace}>Investigar</a>}
        <input className="boton" placeholder="Nota (opcional)" value={nota} maxLength={500} onChange={(e) => setNota(e.target.value)} />
        {a.estado !== 'revisada' && <button className="boton" disabled={ocupado} onClick={() => cambiar('revisada')}>Marcar revisada</button>}
        {a.estado !== 'activa' && <button className="boton" disabled={ocupado} onClick={() => cambiar('activa')}>Reactivar</button>}
        <select className="boton" disabled={ocupado} value="" onChange={(e) => e.target.value && cambiar('silenciada', Number(e.target.value))}>
          <option value="">Silenciar…</option>
          <option value="1">1 hora</option>
          <option value="8">8 horas</option>
          <option value="24">1 día</option>
          <option value="168">7 días</option>
        </select>
        <button className="boton" disabled={ocupado} onClick={() => cambiar('resuelta')}>Resolver</button>
      </div>
      {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

const COLS_RESUELTAS: Columna<AlertaTecnica>[] = [
  { clave: 'resuelta_at', titulo: 'Resuelta', formato: fechaHora },
  { clave: 'grupo', titulo: 'Grupo', formato: (v) => GRUPO[v] ?? v },
  { clave: 'titulo', titulo: 'Alerta', envolver: true },
  { clave: 'primera_vez', titulo: 'Duró', formato: (_v, f) => tramo(f.primera_vez, f.resuelta_at) },
  { clave: 'resuelta_auto', titulo: 'Cómo', formato: (v, f) => (v ? 'Sola (dejó de ocurrir)' : `Manual${f.actualizado_por ? ` (${f.actualizado_por})` : ''}`) },
];

function tramo(a: string, b: string | null) {
  if (!b) return '—';
  const min = Math.round((Date.parse(`${b}-05:00`) - Date.parse(`${a}-05:00`)) / 60_000);
  return min < 60 ? `${Math.max(min, 0)} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} días`;
}

function AlertasTecnicas() {
  const { data, error, cargando, recargar } = useApi<DatosAlertas>('/api/soporte/alertas', 60_000);
  const [revisando, setRevisando] = useState(false);
  const revisar = async () => {
    setRevisando(true);
    try {
      await enviarJson('POST', '/api/soporte/vigilante/ejecutar');
      recargar();
    } finally {
      setRevisando(false);
    }
  };
  const activas = data?.abiertas.filter((a) => a.estado === 'activa') ?? [];
  const otras = data?.abiertas.filter((a) => a.estado !== 'activa') ?? [];
  const fallas = data?.vigilante.comprobaciones.filter((c) => c.error) ?? [];

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Alertas activas" actual={activas.length} />
            <Kpi etiqueta="De severidad alta" actual={activas.filter((a) => a.severidad === 'alta').length} />
            <Kpi etiqueta="Revisadas o silenciadas" actual={otras.length} />
            <Kpi etiqueta="Resueltas (30 días)" actual={data.resueltas.length} />
          </div>
          <Tarjeta
            titulo="Alertas activas"
            ayuda="El vigilante revisa cada 5 minutos. Una alerta se cierra sola cuando la condición desaparece; si la resuelve a mano y el problema sigue, vuelve a abrirse."
            accion={<button className="boton" disabled={revisando} onClick={revisar}>{revisando ? 'Revisando…' : 'Revisar ahora'}</button>}
          >
            {activas.length ? (
              activas.map((a) => <TarjetaAlertaTecnica key={a.id} a={a} onCambio={recargar} />)
            ) : (
              <div className="estado"><span className="punto" style={{ background: 'var(--good)' }} />✓ Sin alertas técnicas activas.</div>
            )}
          </Tarjeta>
          {otras.length > 0 && (
            <Tarjeta titulo="Revisadas y silenciadas" ayuda="Siguen ocurriendo. Se cierran solas cuando la condición desaparece.">
              {otras.map((a) => <TarjetaAlertaTecnica key={a.id} a={a} onCambio={recargar} />)}
            </Tarjeta>
          )}
          <Tarjeta
            titulo="Comprobaciones del vigilante"
            ayuda={
              data.vigilante.ultima_ejecucion
                ? `Última revisión: ${fechaHora(data.vigilante.ultima_ejecucion)} (${num(data.vigilante.duracion_ms)} ms).`
                : 'Todavía no ha corrido ninguna revisión.'
            }
          >
            {data.vigilante.comprobaciones.length ? (
              <ul className="lista-simple">
                {data.vigilante.comprobaciones.map((c) => (
                  <li key={c.nombre}>
                    <span>
                      <span className="punto-inline" style={{ background: c.error ? 'var(--warning)' : c.ok ? 'var(--good)' : 'var(--critical)' }} />
                      {c.nombre} <span style={{ color: 'var(--muted)' }}>· {GRUPO[c.grupo] ?? c.grupo}</span>
                      {c.error && <div className="nota" style={{ margin: 0 }}>No se pudo comprobar: {c.error}</div>}
                    </span>
                    <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{c.error ? 'error' : c.ok ? 'bien' : 'con alerta'} · {num(c.ms)} ms</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ayuda">El detalle aparece después de la primera revisión desde que arrancó el panel.</p>
            )}
            {fallas.length > 0 && <p className="nota">Las comprobaciones con error no cierran alertas de su grupo hasta que vuelvan a funcionar.</p>}
          </Tarjeta>
          <Tarjeta titulo="Resueltas en los últimos 30 días">
            <Tabla filas={data.resueltas} columnas={COLS_RESUELTAS} vacio="Ninguna alerta resuelta en los últimos 30 días" />
          </Tarjeta>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------ licencia
interface DatosLicencia {
  licencia: { nivel: Nivel; contacto_whatsapp: string | null; nota: string | null; actualizado_at: string; actualizado_por: string | null };
  historial: { nivel_anterior: string | null; nivel_nuevo: string; nota: string | null; cambiado_por: string | null; cambiado_at: string }[];
  usuariosPermitidos: number;
  maxUsuarios: number | null;
}

const NIVELES: { clave: Nivel; nombre: string; resumen: string }[] = [
  { clave: 'basico', nombre: 'Básico', resumen: 'Lo esencial del día a día. 90 días de historial, 1 usuario, sin descargas.' },
  { clave: 'intermedio', nombre: 'Intermedio', resumen: 'Metas, comparaciones, embudos, alertas y descargas CSV. 12 meses, 4 usuarios.' },
  { clave: 'full', nombre: 'Full', resumen: 'Todo, incluido el historial completo, listados para contactar y lo que se agregue al plan.' },
];

function Licencia() {
  const { data, error, cargando, recargar } = useApi<DatosLicencia>('/api/soporte/licencia');
  const { yo } = useAcceso();
  const [nota, setNota] = useState('');
  const [contacto, setContacto] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [vNivel, setVNivel] = useState<string>('');
  const [vRol, setVRol] = useState<string>('');

  const guardar = async (cuerpo: Record<string, unknown>, ok: string) => {
    setMsg(null);
    try {
      await enviarJson('PUT', '/api/soporte/licencia', cuerpo);
      setMsg(ok);
      setNota('');
      recargar();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    }
  };
  const cambiarNivel = (n: (typeof NIVELES)[number]) => {
    if (!confirm(`¿Cambiar el panel al plan ${n.nombre}? El cliente lo verá en menos de un minuto.`)) return;
    void guardar({ nivel: n.clave, ...(nota.trim() ? { nota: nota.trim() } : {}) }, `Plan cambiado a ${n.nombre}.`);
  };

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tarjeta
            titulo="Plan del cliente"
            ayuda={`Último cambio: ${fechaHora(data.licencia.actualizado_at)}${data.licencia.actualizado_por ? ` por ${data.licencia.actualizado_por}` : ''}. Usuarios habilitados: ${data.usuariosPermitidos}${data.maxUsuarios === null ? '' : ` de ${data.maxUsuarios}`}.`}
          >
            <div className="planes-elegir">
              {NIVELES.map((n) => (
                <div key={n.clave} className={`plan-opcion ${data.licencia.nivel === n.clave ? 'actual' : ''}`}>
                  <div className="plan-nombre">{n.nombre}</div>
                  <p className="ayuda">{n.resumen}</p>
                  {data.licencia.nivel === n.clave ? (
                    <span className="estado"><span className="punto" style={{ background: 'var(--good)' }} />Plan actual</span>
                  ) : (
                    <button className="boton" onClick={() => cambiarNivel(n)}>Cambiar a {n.nombre}</button>
                  )}
                </div>
              ))}
            </div>
            <div className="filtros" style={{ marginTop: 12 }}>
              <input style={{ flex: 1, minWidth: 220 }} placeholder="Nota del cambio (p. ej., fin del período de prueba)" value={nota} maxLength={500} onChange={(e) => setNota(e.target.value)} />
            </div>
            {msg && <p className="nota">{msg}</p>}
          </Tarjeta>

          <Tarjeta titulo="Contacto para cambiar de plan" ayuda="Número de WhatsApp (con indicativo, solo dígitos) al que lleva el botón de la pantalla Mi plan. Vacío: no se muestra el botón.">
            <div className="filtros">
              <input
                placeholder="573001234567"
                value={contacto ?? data.licencia.contacto_whatsapp ?? ''}
                maxLength={20}
                onChange={(e) => setContacto(e.target.value.replace(/\D/g, ''))}
              />
              <button className="boton" disabled={contacto === null} onClick={() => guardar({ contacto_whatsapp: contacto ?? '' }, 'Contacto guardado.').then(() => setContacto(null))}>
                Guardar
              </button>
            </div>
          </Tarjeta>

          <Tarjeta titulo="Vista previa" ayuda="Vea el panel exactamente como lo vería el cliente con otro plan o con otro rol. Solo afecta a esta pestaña de su navegador.">
            <div className="filtros">
              <select value={vNivel} onChange={(e) => setVNivel(e.target.value)}>
                <option value="">Plan actual del cliente</option>
                {NIVELES.map((n) => <option key={n.clave} value={n.clave}>Plan {n.nombre}</option>)}
              </select>
              <select value={vRol} onChange={(e) => setVRol(e.target.value)}>
                <option value="">Rol Dirección</option>
                {Object.entries(yo?.roles ?? {}).filter(([k]) => k !== 'soporte' && k !== 'direccion').map(([k, v]) => <option key={k} value={k}>Rol {v}</option>)}
              </select>
              <button className="boton boton-primario" onClick={() => cambiarVistaPrevia({ nivel: vNivel || data.licencia.nivel, rol: vRol || 'direccion' })}>Ver como cliente</button>
            </div>
          </Tarjeta>

          <Tarjeta titulo="Historial de cambios de plan">
            <Tabla
              filas={data.historial}
              columnas={[
                { clave: 'cambiado_at', titulo: 'Fecha', formato: fechaHora },
                { clave: 'nivel_anterior', titulo: 'Antes', formato: (v) => NIVELES.find((n) => n.clave === v)?.nombre ?? '—' },
                { clave: 'nivel_nuevo', titulo: 'Después', formato: (v) => NIVELES.find((n) => n.clave === v)?.nombre ?? v },
                { clave: 'cambiado_por', titulo: 'Por' },
                { clave: 'nota', titulo: 'Nota', envolver: true },
              ]}
              vacio="Sin cambios desde la instalación (plan inicial: Full)"
            />
          </Tarjeta>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------ usuarios
interface UsuarioFila {
  usuario: string;
  rol: string;
  nombre: string | null;
  correo: string | null;
  prioridad: number;
  activo: boolean;
  profesional: string | null;
  enPlan: boolean;
  ultimo: string | null;
  visitas_7d: number;
  consultas_7d: number;
  exportaciones_30d: number;
}

function FilaUsuario({ u, roles, profesionales, onGuardado }: { u: UsuarioFila; roles: Record<string, string>; profesionales: string[]; onGuardado: () => void }) {
  const [f, setF] = useState({ rol: u.rol, nombre: u.nombre ?? '', correo: u.correo ?? '', prioridad: u.prioridad, activo: u.activo, profesional: u.profesional ?? '' });
  const [msg, setMsg] = useState<string | null>(null);
  const cambiado =
    f.rol !== u.rol || f.nombre !== (u.nombre ?? '') || f.correo !== (u.correo ?? '') || f.prioridad !== u.prioridad || f.activo !== u.activo || f.profesional !== (u.profesional ?? '');
  // El vínculo con un profesional de la agenda solo tiene efecto en el rol Profesional ("Mi agenda").
  const opciones = f.profesional && !profesionales.includes(f.profesional) ? [f.profesional, ...profesionales] : profesionales;
  const guardar = async () => {
    setMsg(null);
    try {
      await enviarJson('PUT', `/api/soporte/usuarios/${encodeURIComponent(u.usuario)}`, f);
      onGuardado();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <tr>
      <td><b>{u.usuario}</b>{msg && <div className="nota" style={{ color: 'var(--critical)' }}>{msg}</div>}</td>
      <td>
        <select className="boton" value={f.rol} onChange={(e) => setF({ ...f, rol: e.target.value })}>
          {Object.entries(roles).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </td>
      <td><input className="boton" style={{ width: 130 }} value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></td>
      <td><input className="boton" style={{ width: 190 }} value={f.correo} onChange={(e) => setF({ ...f, correo: e.target.value })} /></td>
      <td className="num"><input className="boton" type="number" min={0} max={999} style={{ width: 64 }} value={f.prioridad} onChange={(e) => setF({ ...f, prioridad: Number(e.target.value) })} /></td>
      <td>
        {f.rol === 'profesional' ? (
          <select className="boton" style={{ maxWidth: 210 }} value={f.profesional} onChange={(e) => setF({ ...f, profesional: e.target.value })} aria-label="Profesional de la agenda">
            <option value="">Sin vincular</option>
            {opciones.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : (
          <span className="nota">—</span>
        )}
      </td>
      <td><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} aria-label="Activo" /></td>
      <td>{u.enPlan ? <span style={{ color: 'var(--up)' }}>Sí</span> : <span style={{ color: 'var(--down)' }} title="El plan no alcanza para este usuario (ver prioridad)">No</span>}</td>
      <td>{u.ultimo ? fechaHora(u.ultimo) : '—'}</td>
      <td className="num">{num(u.visitas_7d)}</td>
      <td className="num">{num(u.exportaciones_30d)}</td>
      <td><button className="boton" disabled={!cambiado} onClick={guardar}>Guardar</button></td>
    </tr>
  );
}

function Usuarios() {
  const { data, error, cargando, recargar } = useApi<{ filas: UsuarioFila[]; maxUsuarios: number | null }>('/api/soporte/usuarios');
  const profs = useApi<{ filas: { nombre: string }[] }>('/api/soporte/profesionales');
  const profesionales = (profs.data?.filas ?? []).map((p) => p.nombre);
  const { yo } = useAcceso();
  const roles = yo?.roles ?? {};
  const [nuevo, setNuevo] = useState({ usuario: '', rol: 'analista' });
  const [msg, setMsg] = useState<string | null>(null);
  const crear = async () => {
    setMsg(null);
    try {
      await enviarJson('PUT', `/api/soporte/usuarios/${encodeURIComponent(nuevo.usuario.trim())}`, { rol: nuevo.rol });
      setNuevo({ usuario: '', rol: 'analista' });
      recargar();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tarjeta
            titulo="Usuarios y roles"
            ayuda={`El usuario y la contraseña se crean en nginx (skill desplegar-droplet); aquí se asigna su rol. Prioridad: si el plan limita el número de usuarios${data.maxUsuarios === null ? '' : ` (hoy ${data.maxUsuarios})`}, entran primero los de número menor. Soporte no cuenta en el límite.`}
          >
            <div className="tabla-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Usuario</th><th>Rol</th><th>Nombre</th><th>Correo</th><th className="num">Prioridad</th><th>Profesional (Mi agenda)</th><th>Activo</th><th>En el plan</th>
                    <th>Último acceso</th><th className="num">Pantallas 7 d</th><th className="num">Descargas 30 d</th><th />
                  </tr>
                </thead>
                <tbody>
                  {data.filas.map((u) => <FilaUsuario key={`${u.usuario}-${u.rol}-${u.prioridad}-${u.activo}-${u.profesional ?? ''}`} u={u} roles={roles} profesionales={profesionales} onGuardado={recargar} />)}
                </tbody>
              </table>
            </div>
          </Tarjeta>
          <Tarjeta titulo="Agregar usuario" ayuda="Primero cree el usuario en nginx (.htpasswd-panel-ips); si no tiene rol aquí, al entrar verá un aviso de que no tiene acceso.">
            <div className="filtros">
              <input placeholder="usuario" value={nuevo.usuario} maxLength={40} onChange={(e) => setNuevo({ ...nuevo, usuario: e.target.value })} />
              <select value={nuevo.rol} onChange={(e) => setNuevo({ ...nuevo, rol: e.target.value })}>
                {Object.entries(roles).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button className="boton" disabled={!/^[A-Za-z0-9._-]{2,40}$/.test(nuevo.usuario.trim())} onClick={crear}>Agregar</button>
            </div>
            {msg && <p className="nota" style={{ color: 'var(--critical)' }}>{msg}</p>}
          </Tarjeta>
        </>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------------- actividad
interface DatosActividad {
  filas: { at: string; usuario: string | null; rol: string | null; tipo: string; ruta: string | null; detalle: string | null; status: number | null; ms: number | null; vista_previa: boolean }[];
  pantallas: { clave: string; n: number }[];
  porDia: { fecha: string; usuarios: number; visitas: number }[];
  lentas: { clave: string; n: number; ms_promedio: number; ms_max: number; errores: number }[];
}

const TIPO: Record<string, string> = { api: 'Consulta', visita: 'Pantalla', exportacion: 'Descarga', configuracion: 'Configuración', acceso_denegado: 'Acceso denegado' };

function Actividad() {
  const [usuario, setUsuario] = useState('');
  const [tipo, setTipo] = useState('visita');
  const [dias, setDias] = useState('7');
  const url = `/api/soporte/actividad?${new URLSearchParams({ dias, ...(usuario ? { usuario } : {}), ...(tipo ? { tipo } : {}) })}`;
  const { data, error, cargando } = useApi<DatosActividad>(url, 60_000);
  const usuarios = useApi<{ filas: UsuarioFila[] }>('/api/soporte/usuarios');

  return (
    <>
      <div className="filtros">
        <select value={usuario} onChange={(e) => setUsuario(e.target.value)}>
          <option value="">Todos los usuarios</option>
          {(usuarios.data?.filas ?? []).map((u) => <option key={u.usuario} value={u.usuario}>{u.usuario}</option>)}
        </select>
        <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
          <option value="">Todo</option>
          {Object.entries(TIPO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={dias} onChange={(e) => setDias(e.target.value)}>
          {['1', '7', '30', '90', '180'].map((d) => <option key={d} value={d}>Últimos {d} {d === '1' ? 'día' : 'días'}</option>)}
        </select>
      </div>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <div className="grid g2">
            <Tarjeta titulo="Pantallas más vistas" ayuda="Sin contar la vista previa.">
              <ListaConteo items={data.pantallas.map((p) => ({ clave: p.clave, etiqueta: p.clave, n: p.n }))} />
            </Tarjeta>
            <Tarjeta titulo="Uso por día" ayuda="Personas distintas del cliente que entraron y pantallas que abrieron (sin soporte).">
              <ListaConteo items={[...data.porDia].reverse().slice(0, 14).map((d) => ({ clave: d.fecha, etiqueta: `${fecha(d.fecha)} · ${d.usuarios} ${d.usuarios === 1 ? 'persona' : 'personas'}`, n: d.visitas }))} />
            </Tarjeta>
          </div>
          {data.lentas.length > 0 && (
            <Tarjeta titulo="Consultas lentas o con error" ayuda="Endpoints que tardaron más de 2 s o respondieron con error en el período.">
              <Tabla
                filas={data.lentas}
                columnas={[
                  { clave: 'clave', titulo: 'Endpoint' },
                  { clave: 'n', titulo: 'Consultas', num: true },
                  { clave: 'ms_promedio', titulo: 'Promedio (ms)', num: true },
                  { clave: 'ms_max', titulo: 'Máximo (ms)', num: true },
                  { clave: 'errores', titulo: 'Errores', num: true },
                ]}
              />
            </Tarjeta>
          )}
          <Tarjeta titulo="Registro" ayuda="Últimos 300 eventos con los filtros elegidos.">
            <Tabla
              filas={data.filas}
              columnas={[
                { clave: 'at', titulo: 'Cuándo', formato: fechaHora },
                { clave: 'usuario', titulo: 'Usuario', formato: (v, f) => `${v ?? '—'}${f.vista_previa ? ' (vista previa)' : ''}` },
                { clave: 'tipo', titulo: 'Tipo', formato: (v) => TIPO[v] ?? v },
                { clave: 'ruta', titulo: 'Qué' },
                { clave: 'detalle', titulo: 'Detalle', envolver: true },
                { clave: 'status', titulo: 'Estado', num: true, formato: (v) => (v === null ? '—' : String(v)) },
                { clave: 'ms', titulo: 'ms', num: true },
              ]}
              vacio="Sin actividad con estos filtros"
            />
          </Tarjeta>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------- incidentes
interface IncidenteFila {
  id: number;
  area: string;
  desde: string;
  hasta: string;
  titulo: string;
  descripcion: string;
  creado_por: string | null;
}

const AREAS: Record<string, string> = {
  general: 'General',
  agenda: 'Agenda',
  whatsapp: 'WhatsApp',
  conversaciones: 'Conversaciones',
  eventos: 'Eventos',
  trazabilidad: 'Trazabilidad',
};

const VACIO = { area: 'general', desde: '', hasta: '', titulo: '', descripcion: '' };

function Incidentes() {
  const { data, error, cargando, recargar } = useApi<{ filas: IncidenteFila[] }>('/api/soporte/incidentes');
  const [form, setForm] = useState<typeof VACIO & { id?: number }>(VACIO);
  const [msg, setMsg] = useState<string | null>(null);
  const valido = form.desde && form.hasta && form.titulo.trim().length >= 3 && form.descripcion.trim().length >= 3;

  const guardar = async () => {
    setMsg(null);
    const { id, ...cuerpo } = form;
    try {
      await enviarJson(id ? 'PUT' : 'POST', id ? `/api/soporte/incidentes/${id}` : '/api/soporte/incidentes', { ...cuerpo, titulo: cuerpo.titulo.trim(), descripcion: cuerpo.descripcion.trim() });
      setForm(VACIO);
      setMsg(cuerpo.area === 'agenda' || cuerpo.area === 'general' ? 'Guardado. Las franjas y comparaciones se actualizan ya; el cálculo de citas "confiables" se actualiza al reiniciar el panel.' : 'Guardado.');
      recargar();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    }
  };
  const eliminar = async (i: IncidenteFila) => {
    if (!confirm(`¿Eliminar el incidente "${i.titulo}"?`)) return;
    await enviarJson('DELETE', `/api/soporte/incidentes/${i.id}`);
    recargar();
  };

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      <Tarjeta
        titulo={form.id ? 'Editar incidente' : 'Registrar un incidente'}
        ayuda="Períodos en que el sistema no registró bien la información. El cliente los ve sombreados en los gráficos y en la pantalla Alertas, y el Resumen no compara contra ellos."
      >
        <div className="filtros">
          <select value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })}>
            {Object.entries(AREAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="date" value={form.desde} onChange={(e) => setForm({ ...form, desde: e.target.value })} aria-label="Desde" />
          <input type="date" value={form.hasta} min={form.desde} onChange={(e) => setForm({ ...form, hasta: e.target.value })} aria-label="Hasta" />
          <input style={{ flex: 1, minWidth: 200 }} placeholder="Título" value={form.titulo} maxLength={120} onChange={(e) => setForm({ ...form, titulo: e.target.value })} />
        </div>
        <div className="filtros">
          <input style={{ flex: 1 }} placeholder="Descripción para el cliente" value={form.descripcion} maxLength={500} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} />
          <button className="boton boton-primario" disabled={!valido} onClick={guardar}>{form.id ? 'Guardar cambios' : 'Registrar'}</button>
          {form.id && <button className="boton" onClick={() => setForm(VACIO)}>Cancelar</button>}
        </div>
        {msg && <p className="nota">{msg}</p>}
      </Tarjeta>
      {data && (
        <Tarjeta titulo="Incidentes registrados">
          <Tabla
            filas={data.filas}
            columnas={[
              { clave: 'area', titulo: 'Área', formato: (v) => AREAS[v] ?? v },
              { clave: 'desde', titulo: 'Desde', formato: fecha },
              { clave: 'hasta', titulo: 'Hasta', formato: fecha },
              { clave: 'titulo', titulo: 'Título', envolver: true },
              { clave: 'descripcion', titulo: 'Descripción', envolver: true },
              {
                clave: 'id',
                titulo: '',
                formato: (_v, f) => (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button className="boton" onClick={() => setForm({ id: f.id, area: f.area, desde: f.desde, hasta: f.hasta, titulo: f.titulo, descripcion: f.descripcion })}>Editar</button>
                    <button className="boton" onClick={() => eliminar(f)}>Eliminar</button>
                  </span>
                ),
              },
            ]}
            vacio="Sin incidentes registrados"
          />
        </Tarjeta>
      )}
    </>
  );
}
