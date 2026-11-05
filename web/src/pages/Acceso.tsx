import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ErrorApi, enviarJson } from '../api';
import { CampoContrasena, InputContrasena } from '../components/CampoContrasena';
import logo from '../assets/logo-ips.webp';

// Pantalla de acceso: inicio de sesión y recuperación de contraseña por código (RF-01 a RF-18).
// Reglas: la contraseña NUNCA se guarda aquí (D2); el token de recuperación vive solo en el estado de React; los
// mensajes son los mismos exista o no la cuenta.

type Paso = 'login' | 'correo' | 'codigo' | 'nueva';

const USUARIO_RECORDADO = 'panel.usuario_recordado';
/** Vigencia del código y espera para pedir otro: los mismos valores que aplica el servidor (OTP en configuracion.ts). */
const VIGENCIA_CODIGO_S = 15 * 60;
const REENVIO_S = 60;

function leerUsuarioRecordado(): string {
  try {
    return localStorage.getItem(USUARIO_RECORDADO) ?? '';
  } catch {
    return '';
  }
}

function guardarUsuarioRecordado(usuario: string | null) {
  try {
    if (usuario) localStorage.setItem(USUARIO_RECORDADO, usuario);
    else localStorage.removeItem(USUARIO_RECORDADO);
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Ofrece la credencial al gestor del navegador, si lo soporta. Es una mejora: nunca debe romper el ingreso. */
async function ofrecerAlGestor(usuario: string, contrasena: string) {
  try {
    const PC = (window as unknown as { PasswordCredential?: new (datos: { id: string; password: string; name?: string }) => Credential }).PasswordCredential;
    if (PC && navigator.credentials) await navigator.credentials.store(new PC({ id: usuario, password: contrasena, name: usuario }));
  } catch {
    /* no existe en todos los navegadores */
  }
}

function mensajeDe(e: unknown): string {
  return e instanceof ErrorApi || e instanceof Error ? e.message : 'No se pudo completar la solicitud. Intente de nuevo.';
}

function Marco({ children }: { children: ReactNode }) {
  return (
    <div className="pantalla-centro">
      <main className="acceso" aria-labelledby="acceso-titulo">
        <img className="acceso-logo" src={logo} alt="Centro de Orientación" width={64} height={64} />
        <h1 id="acceso-titulo">Centro de Orientación</h1>
        <p className="acceso-sub">Panel de reportes</p>
        {children}
      </main>
    </div>
  );
}

export default function Acceso({ onEntrar }: { onEntrar: () => void }) {
  const [paso, setPaso] = useState<Paso>('login');
  const [aviso, setAviso] = useState<string | null>(null);
  const [correo, setCorreo] = useState('');
  // Token de restablecimiento: solo en el estado de React (nunca en localStorage ni sessionStorage).
  const [token, setToken] = useState<string | null>(null);
  const [solicitadoAt, setSolicitadoAt] = useState(0);
  // Por qué la persona volvió al paso del correo (el código venció o ya se usó).
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null);

  const volverAlLogin = useCallback((mensaje: string | null = null) => {
    setToken(null);
    setErrorCorreo(null);
    setAviso(mensaje);
    setPaso('login');
  }, []);

  if (paso === 'login') return <Login aviso={aviso} usuarioInicial={correo} onEntrar={onEntrar} onOlvido={() => (setAviso(null), setPaso('correo'))} />;
  if (paso === 'correo') {
    return <PedirCorreo correoInicial={correo} errorInicial={errorCorreo} onVolver={() => volverAlLogin()} onEnviado={(c) => (setCorreo(c), setErrorCorreo(null), setSolicitadoAt(Date.now()), setPaso('codigo'))} />;
  }
  if (paso === 'codigo') {
    return (
      <PedirCodigo
        correo={correo}
        solicitadoAt={solicitadoAt}
        onReenviado={() => setSolicitadoAt(Date.now())}
        onVolver={() => setPaso('correo')}
        onValidado={(t) => (setToken(t), setPaso('nueva'))}
      />
    );
  }
  return <NuevaContrasena correo={correo} token={token ?? ''} onVolver={() => volverAlLogin()} onListo={() => volverAlLogin('Contraseña actualizada. Ya puede iniciar sesión.')} onTokenInvalido={(mensaje) => (setToken(null), setErrorCorreo(mensaje), setPaso('correo'))} />;
}

// ------------------------------------------------------------------------------------------------ login
function Login({ aviso, usuarioInicial, onEntrar, onOlvido }: { aviso: string | null; usuarioInicial: string; onEntrar: () => void; onOlvido: () => void }) {
  const recordado = leerUsuarioRecordado();
  const [usuario, setUsuario] = useState(recordado || usuarioInicial);
  const [contrasena, setContrasena] = useState('');
  const [recordar, setRecordar] = useState(!!recordado);
  const [mantener, setMantener] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const refUsuario = useRef<HTMLInputElement>(null);

  // Foco inicial: en la contraseña si ya hay un usuario recordado; si no, en el usuario.
  useEffect(() => {
    if (recordado) document.getElementById('acceso-clave')?.focus();
    else refUsuario.current?.focus();
  }, [recordado]);

  const entrar = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado) return;
    setOcupado(true);
    setError(null);
    const id = usuario.trim();
    try {
      await enviarJson('POST', '/api/auth/login', { usuario: id, contrasena, mantener });
      guardarUsuarioRecordado(recordar ? id : null);
      await ofrecerAlGestor(id, contrasena);
      setContrasena('');
      onEntrar();
    } catch (err) {
      // Un error no borra el usuario, sí la contraseña.
      setContrasena('');
      setError(mensajeDe(err));
      setOcupado(false);
      document.getElementById('acceso-clave')?.focus();
    }
  };

  return (
    <Marco>
      <form onSubmit={entrar} method="post" action="#" className="acceso-form">
        {aviso && <p className="acceso-ok" role="status">{aviso}</p>}
        <div className="campo">
          <label htmlFor="acceso-usuario">Usuario o correo</label>
          <input
            id="acceso-usuario"
            ref={refUsuario}
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
          />
        </div>
        <InputContrasena id="acceso-clave" valor={contrasena} onCambio={setContrasena} etiqueta="Contraseña" autoComplete="current-password" />
        <label className="casilla">
          <input type="checkbox" checked={recordar} onChange={(e) => setRecordar(e.target.checked)} /> Recordar mi usuario en este equipo
        </label>
        <label className="casilla">
          <input type="checkbox" checked={mantener} onChange={(e) => setMantener(e.target.checked)} /> Mantener la sesión iniciada
        </label>
        <p className="campo-ayuda">No la use en equipos compartidos.</p>
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" className="boton boton-primario acceso-boton" disabled={ocupado || !usuario.trim() || !contrasena}>
          {ocupado ? 'Entrando…' : 'Iniciar sesión'}
        </button>
        <button type="button" className="enlace-boton" onClick={onOlvido}>¿Olvidó su contraseña?</button>
      </form>
    </Marco>
  );
}

// -------------------------------------------------------------------------------------------- recuperación
function PedirCorreo({ correoInicial, errorInicial, onVolver, onEnviado }: { correoInicial: string; errorInicial: string | null; onVolver: () => void; onEnviado: (correo: string) => void }) {
  const [correo, setCorreo] = useState(correoInicial);
  const [error, setError] = useState<string | null>(errorInicial);
  const [ocupado, setOcupado] = useState(false);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      await enviarJson('POST', '/api/auth/recuperar/solicitar', { correo: correo.trim() });
      // Siempre se pasa al paso siguiente: la respuesta no dice si el correo está registrado.
      onEnviado(correo.trim());
    } catch (err) {
      setError(mensajeDe(err));
      setOcupado(false);
    }
  };

  return (
    <Marco>
      <form onSubmit={enviar} className="acceso-form">
        <h2 className="acceso-paso">Recuperar su contraseña</h2>
        <p className="campo-ayuda">Escriba el correo de su cuenta. Le enviaremos un código de 6 dígitos.</p>
        <div className="campo">
          <label htmlFor="acceso-correo">Correo</label>
          <input id="acceso-correo" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required autoFocus value={correo} onChange={(e) => setCorreo(e.target.value)} />
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" className="boton boton-primario acceso-boton" disabled={ocupado || !correo.trim()}>{ocupado ? 'Enviando…' : 'Enviar código'}</button>
        <button type="button" className="enlace-boton" onClick={onVolver}>Volver</button>
      </form>
    </Marco>
  );
}

const formatoTiempo = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function PedirCodigo({ correo, solicitadoAt, onReenviado, onVolver, onValidado }: {
  correo: string;
  solicitadoAt: number;
  onReenviado: () => void;
  onVolver: () => void;
  onValidado: (token: string) => void;
}) {
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [ahora, setAhora] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const transcurrido = Math.floor((ahora - solicitadoAt) / 1000);
  const hastaReenvio = Math.max(0, REENVIO_S - transcurrido);
  const vigencia = Math.max(0, VIGENCIA_CODIGO_S - transcurrido);

  // El código se acepta con espacios o guiones al pegarlo ("123 456"): solo cuentan los dígitos.
  const cambiar = (v: string) => setCodigo(v.replace(/\D/g, '').slice(0, 6));

  const verificar = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado || codigo.length !== 6) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await enviarJson<{ token: string }>('POST', '/api/auth/recuperar/verificar', { correo, codigo });
      onValidado(r.token);
    } catch (err) {
      setError(mensajeDe(err));
      setCodigo('');
      setOcupado(false);
    }
  };

  const reenviar = async () => {
    setError(null);
    setInfo(null);
    try {
      await enviarJson('POST', '/api/auth/recuperar/solicitar', { correo });
      onReenviado();
      setCodigo('');
      setInfo('Si el correo está registrado, recibirá un código nuevo en unos minutos. El anterior ya no sirve.');
    } catch (err) {
      setError(mensajeDe(err));
    }
  };

  return (
    <Marco>
      <form onSubmit={verificar} className="acceso-form">
        <h2 className="acceso-paso">Escriba el código</h2>
        <p className="campo-ayuda">Si el correo está registrado, recibirá un código en unos minutos. Revise también la carpeta de correo no deseado.</p>
        <div className="campo">
          <label htmlFor="acceso-codigo">Código de 6 dígitos</label>
          <input
            id="acceso-codigo"
            className="acceso-codigo"
            name="otp"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="one-time-code"
            autoFocus
            required
            value={codigo}
            onChange={(e) => cambiar(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              cambiar(e.clipboardData.getData('text'));
            }}
          />
        </div>
        <p className="campo-ayuda" aria-live="off">{vigencia > 0 ? `El código vale ${formatoTiempo(vigencia)} más.` : 'El código venció. Pida uno nuevo.'}</p>
        {info && <p className="acceso-ok" role="status">{info}</p>}
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" className="boton boton-primario acceso-boton" disabled={ocupado || codigo.length !== 6}>{ocupado ? 'Verificando…' : 'Continuar'}</button>
        <button type="button" className="enlace-boton" disabled={hastaReenvio > 0} onClick={reenviar}>
          {hastaReenvio > 0 ? `Reenviar código en ${hastaReenvio} s` : 'Reenviar código'}
        </button>
        <button type="button" className="enlace-boton" onClick={onVolver}>Volver</button>
      </form>
    </Marco>
  );
}

function NuevaContrasena({ correo, token, onVolver, onListo, onTokenInvalido }: { correo: string; token: string; onVolver: () => void; onListo: () => void; onTokenInvalido: (mensaje: string) => void }) {
  const [nueva, setNueva] = useState('');
  const [confirmacion, setConfirmacion] = useState('');
  const [valida, setValida] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const alValidar = useCallback((ok: boolean) => setValida(ok), []);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado || !valida) return;
    setOcupado(true);
    setError(null);
    try {
      await enviarJson('POST', '/api/auth/recuperar/restablecer', { token, nueva });
      onListo();
    } catch (err) {
      // El token vencido o usado obliga a empezar de nuevo; un error de política o de historial deja corregir sin perderlo.
      if (err instanceof ErrorApi && err.codigo === 'token') {
        onTokenInvalido(mensajeDe(err));
        return;
      }
      setError(mensajeDe(err));
      setOcupado(false);
    }
  };

  return (
    <Marco>
      <form onSubmit={guardar} className="acceso-form">
        <h2 className="acceso-paso">Elija su nueva contraseña</h2>
        {/* Usuario oculto: así el gestor del navegador actualiza la contraseña guardada en vez de crear otra. */}
        <input type="text" name="username" autoComplete="username" value={leerUsuarioRecordado() || correo} readOnly className="sr-only" aria-hidden="true" tabIndex={-1} />
        <CampoContrasena valor={nueva} onCambio={setNueva} confirmacion={confirmacion} onConfirmacion={setConfirmacion} onValidez={alValidar} />
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" className="boton boton-primario acceso-boton" disabled={ocupado || !valida}>{ocupado ? 'Guardando…' : 'Guardar contraseña'}</button>
        <button type="button" className="enlace-boton" onClick={onVolver}>Cancelar</button>
      </form>
    </Marco>
  );
}
