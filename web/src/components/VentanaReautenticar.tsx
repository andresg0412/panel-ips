import { useState, type FormEvent } from 'react';
import { enviarJson } from '../api';
import { InputContrasena } from './CampoContrasena';

/**
 * Pide de nuevo la contraseña antes de una acción sensible (D6), por ejemplo lanzar un envío a pacientes. La
 * confirmación vale 10 minutos en el servidor; quien la pide reintenta la acción en `onConfirmada`.
 */
export default function VentanaReautenticar({ motivo, onConfirmada, onCancelar }: { motivo: string; onConfirmada: () => void; onCancelar: () => void }) {
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const confirmar = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado || !contrasena) return;
    setOcupado(true);
    setError(null);
    try {
      await enviarJson('POST', '/api/auth/reautenticar', { contrasena });
      setContrasena('');
      onConfirmada();
    } catch (err) {
      setContrasena('');
      setError((err as Error).message);
      setOcupado(false);
    }
  };

  return (
    <div className="ventana-velo">
      <form className="ventana" onSubmit={confirmar} role="dialog" aria-modal="true" aria-labelledby="reautenticar-titulo">
        <h2 id="reautenticar-titulo">Confirme su contraseña</h2>
        <p className="campo-ayuda">{motivo}</p>
        <InputContrasena valor={contrasena} onCambio={setContrasena} etiqueta="Contraseña" autoComplete="current-password" nombre="current-password" autoFocus />
        {error && <div className="error" role="alert">{error}</div>}
        <div className="ventana-acciones">
          <button type="submit" className="boton boton-primario" disabled={ocupado || !contrasena}>{ocupado ? 'Confirmando…' : 'Confirmar'}</button>
          <button type="button" className="boton" onClick={onCancelar}>Cancelar</button>
        </div>
      </form>
    </div>
  );
}
