import { useCallback, useState, type FormEvent } from 'react';
import { enviarJson } from '../api';
import { CampoContrasena } from '../components/CampoContrasena';

/**
 * Contraseña temporal (la generó soporte): hasta cambiarla no se puede ver ninguna pantalla (RF-09). No pide la
 * contraseña actual porque la persona acaba de escribirla para entrar.
 */
export default function CambioObligatorio({ usuario, onListo, onSalir }: { usuario: string; onListo: () => void; onSalir: () => void }) {
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
      await enviarJson('POST', '/api/auth/contrasena', { nueva });
      onListo();
    } catch (err) {
      setError((err as Error).message);
      setOcupado(false);
    }
  };

  return (
    <div className="pantalla-centro">
      <section className="acceso" aria-labelledby="cambio-titulo">
        <h1 id="cambio-titulo">Elija su contraseña</h1>
        <p className="campo-ayuda">La contraseña que usó para entrar es temporal. Para continuar, elija una propia que solo usted conozca.</p>
        <form onSubmit={guardar} className="acceso-form">
          {/* Usuario oculto: así el gestor del navegador guarda la contraseña nueva para esta cuenta. */}
          <input type="text" name="username" autoComplete="username" value={usuario} readOnly className="sr-only" aria-hidden="true" tabIndex={-1} />
          <CampoContrasena valor={nueva} onCambio={setNueva} confirmacion={confirmacion} onConfirmacion={setConfirmacion} onValidez={alValidar} />
          {error && <div className="error" role="alert">{error}</div>}
          <button type="submit" className="boton boton-primario acceso-boton" disabled={ocupado || !valida}>{ocupado ? 'Guardando…' : 'Guardar y continuar'}</button>
          <button type="button" className="enlace-boton" onClick={onSalir}>Cerrar sesión</button>
        </form>
      </section>
    </div>
  );
}
