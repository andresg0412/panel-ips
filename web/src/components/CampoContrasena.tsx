import { useEffect, useId, useState } from 'react';
// Las mismas reglas que aplica el servidor (aquí solo ayudan): el archivo no importa nada y se comparte tal cual.
import { REQUISITOS } from '../../../server/auth/politica';

type Estado = 'pendiente' | 'falta' | 'cumple';

const SIMBOLO: Record<Estado, string> = { pendiente: '○', falta: '✗', cumple: '✓' };
// El estado nunca se comunica solo por color: lleva símbolo y texto (RF-25).
const TEXTO_ESTADO: Record<Estado, string> = { pendiente: 'pendiente', falta: 'falta', cumple: 'cumplido' };

function Fila({ estado, texto }: { estado: Estado; texto: string }) {
  return (
    <li className={`req req-${estado}`}>
      <span className="req-simbolo" aria-hidden="true">{SIMBOLO[estado]}</span>
      <span>{texto}</span>
      <span className="sr-only"> — {TEXTO_ESTADO[estado]}</span>
    </li>
  );
}

/** Campo de contraseña con botón de mostrar u ocultar. */
export function InputContrasena({ valor, onCambio, etiqueta, autoComplete, id, nombre, requerido = true, autoFocus }: {
  valor: string;
  onCambio: (v: string) => void;
  etiqueta: string;
  autoComplete: 'current-password' | 'new-password';
  id?: string;
  nombre?: string;
  requerido?: boolean;
  autoFocus?: boolean;
}) {
  const auto = useId();
  const idCampo = id ?? auto;
  const [ver, setVer] = useState(false);
  const [mayusculas, setMayusculas] = useState(false);
  return (
    <div className="campo">
      <label htmlFor={idCampo}>{etiqueta}</label>
      <div className="campo-clave">
        <input
          id={idCampo}
          name={nombre ?? 'password'}
          type={ver ? 'text' : 'password'}
          value={valor}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={requerido}
          // Sin tope visible menor a 128: pegar una frase larga debe funcionar.
          onChange={(e) => onCambio(e.target.value)}
          // Bloq Mayús: se detecta al teclear (RF-02); no se guarda nada de lo escrito.
          onKeyUp={(e) => setMayusculas(e.getModifierState?.('CapsLock') ?? false)}
          onBlur={() => setMayusculas(false)}
          spellCheck={false}
          autoCapitalize="none"
        />
        <button type="button" className="boton" onClick={() => setVer((v) => !v)} aria-pressed={ver} aria-label={ver ? `Ocultar ${etiqueta.toLowerCase()}` : `Mostrar ${etiqueta.toLowerCase()}`}>
          {ver ? 'Ocultar' : 'Ver'}
        </button>
      </div>
      {mayusculas && <p className="campo-aviso" role="status">Bloq Mayús está activado.</p>}
    </div>
  );
}

/**
 * Contraseña nueva con confirmación y la lista visual de requisitos (RF-20 a RF-25). Gris con ○ mientras el campo está
 * vacío; después, rojo con ✗ si falta y verde con ✓ si cumple. `onValidez` avisa si TODO se cumple y las dos coinciden.
 * El servidor valida de nuevo y además rechaza claves comunes y las que contienen el usuario.
 */
export function CampoContrasena({ valor, onCambio, confirmacion, onConfirmacion, onValidez, etiqueta = 'Nueva contraseña' }: {
  valor: string;
  onCambio: (v: string) => void;
  confirmacion: string;
  onConfirmacion: (v: string) => void;
  onValidez: (ok: boolean) => void;
  etiqueta?: string;
}) {
  const normal = valor.normalize('NFKC');
  const vacio = valor.length === 0;
  const estados = REQUISITOS.map((r) => ({ clave: r.clave, texto: r.texto, estado: (vacio ? 'pendiente' : r.cumple(normal) ? 'cumple' : 'falta') as Estado }));
  const coincide: Estado = confirmacion.length === 0 ? 'pendiente' : valor.length > 0 && confirmacion === valor ? 'cumple' : 'falta';
  const todo = estados.every((e) => e.estado === 'cumple') && coincide === 'cumple';

  useEffect(() => {
    onValidez(todo);
  }, [todo, onValidez]);

  return (
    <>
      <InputContrasena valor={valor} onCambio={onCambio} etiqueta={etiqueta} autoComplete="new-password" nombre="new-password" />
      <ul className="requisitos" aria-live="polite" aria-label="Requisitos de la contraseña">
        {estados.map((e) => <Fila key={e.clave} estado={e.estado} texto={e.texto} />)}
      </ul>
      <InputContrasena valor={confirmacion} onCambio={onConfirmacion} etiqueta="Confirmar contraseña" autoComplete="new-password" nombre="confirm-password" />
      <ul className="requisitos" aria-live="polite" aria-label="Confirmación de la contraseña">
        <Fila estado={coincide} texto="Las contraseñas coinciden" />
      </ul>
    </>
  );
}
