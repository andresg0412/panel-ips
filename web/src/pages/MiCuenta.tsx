import { useCallback, useState, type FormEvent } from 'react';
import { enviarJson, useApi, type Rango } from '../api';
import { useAcceso } from '../acceso';
import { CampoContrasena, InputContrasena } from '../components/CampoContrasena';
import { Estado, Tabla, Tarjeta } from '../components/ui';
import { fechaHora } from '../format';

// "Mi cuenta": datos de la persona, cambio de contraseña y sesiones abiertas. Es de todos los roles y planes.

interface SesionFila {
  id: string;
  actual: boolean;
  creada: string;
  ultimaActividad: string;
  ip: string | null;
  equipo: string;
  mantener: boolean;
}

export default function MiCuenta(_: { rango: Rango }) {
  const { yo } = useAcceso();
  if (!yo) return null;
  return (
    <>
      <Tarjeta titulo="Sus datos" ayuda="Para cambiar su nombre, su correo o su rol, comuníquese con soporte.">
        <dl className="datos-cuenta">
          <dt>Usuario</dt><dd>{yo.usuario}</dd>
          <dt>Nombre</dt><dd>{yo.nombre ?? '—'}</dd>
          <dt>Correo</dt><dd>{yo.correo ?? <span className="nota">Sin correo: no podrá recuperar su contraseña por correo.</span>}</dd>
          <dt>Rol</dt><dd>{yo.rolNombre ?? '—'}</dd>
          <dt>Último acceso</dt><dd>{yo.ultimoAcceso ? fechaHora(yo.ultimoAcceso) : 'Este es su primer acceso registrado'}</dd>
        </dl>
      </Tarjeta>
      {yo.autenticacion === 'sesion' && (
        <>
          <CambiarContrasena usuario={yo.usuario ?? ''} />
          <SesionesActivas />
        </>
      )}
    </>
  );
}

function CambiarContrasena({ usuario }: { usuario: string }) {
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [confirmacion, setConfirmacion] = useState('');
  const [valida, setValida] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const alValidar = useCallback((v: boolean) => setValida(v), []);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado || !valida || !actual) return;
    setOcupado(true);
    setError(null);
    setOk(false);
    try {
      await enviarJson('POST', '/api/auth/contrasena', { actual, nueva });
      setActual('');
      setNueva('');
      setConfirmacion('');
      setOk(true);
    } catch (err) {
      // Los errores del servidor (contraseña actual incorrecta, ya usada, muy común…) se muestran bajo el formulario.
      setError((err as Error).message);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Tarjeta titulo="Cambiar contraseña" ayuda="Al cambiarla se cierran sus demás sesiones y le enviaremos un aviso por correo.">
      <form onSubmit={guardar} className="acceso-form form-cuenta">
        <input type="text" name="username" autoComplete="username" value={usuario} readOnly className="sr-only" aria-hidden="true" tabIndex={-1} />
        <InputContrasena valor={actual} onCambio={setActual} etiqueta="Contraseña actual" autoComplete="current-password" nombre="current-password" />
        <CampoContrasena valor={nueva} onCambio={setNueva} confirmacion={confirmacion} onConfirmacion={setConfirmacion} onValidez={alValidar} />
        {error && <div className="error" role="alert">{error}</div>}
        {ok && <p className="acceso-ok" role="status">Su contraseña cambió. Cerramos sus demás sesiones.</p>}
        <button type="submit" className="boton boton-primario" disabled={ocupado || !valida || !actual}>{ocupado ? 'Guardando…' : 'Cambiar contraseña'}</button>
      </form>
    </Tarjeta>
  );
}

function SesionesActivas() {
  const { data, error, cargando, recargar } = useApi<{ filas: SesionFila[] }>('/api/auth/sesiones');
  const [msg, setMsg] = useState<string | null>(null);

  const cerrar = async (s: SesionFila) => {
    setMsg(null);
    try {
      await enviarJson('DELETE', `/api/auth/sesiones/${s.id}`);
      recargar();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const cerrarOtras = async () => {
    setMsg(null);
    try {
      const r = await enviarJson<{ cerradas: number }>('POST', '/api/auth/sesiones/cerrar-otras');
      setMsg(r.cerradas ? (r.cerradas === 1 ? 'Se cerró 1 sesión.' : `Se cerraron ${r.cerradas} sesiones.`) : 'No había otras sesiones abiertas.');
      recargar();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const hayOtras = (data?.filas ?? []).some((f) => !f.actual);

  return (
    <Tarjeta
      titulo="Sesiones activas"
      ayuda="Los equipos donde su cuenta está abierta ahora. Si no reconoce alguno, ciérrelo y cambie su contraseña."
      accion={<button className="boton" disabled={!hayOtras} onClick={cerrarOtras}>Cerrar las demás</button>}
    >
      <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />
      {data && (
        <Tabla
          filas={data.filas}
          columnas={[
            { clave: 'equipo', titulo: 'Equipo', formato: (v, f) => `${v}${f.actual ? ' (esta sesión)' : ''}` },
            { clave: 'ip', titulo: 'Dirección', formato: (v) => v ?? '—' },
            { clave: 'creada', titulo: 'Inició', formato: fechaHora },
            { clave: 'ultimaActividad', titulo: 'Última actividad', formato: fechaHora },
            { clave: 'mantener', titulo: 'Tipo', formato: (v) => (v ? 'Mantenida' : 'Normal') },
            { clave: 'id', titulo: '', formato: (_v, f) => (f.actual ? '' : <button className="boton" onClick={() => cerrar(f)}>Cerrar</button>) },
          ]}
          vacio="No hay sesiones abiertas"
        />
      )}
      {msg && <p className="nota">{msg}</p>}
    </Tarjeta>
  );
}
