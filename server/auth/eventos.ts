// Eventos de autenticación (panel.eventos_autenticacion): quién entró, quién falló, quién cambió qué.
// Se escriben de inmediato (no por lotes): son pocos y son evidencia de seguridad.
//
// REGLA: `detalle` y `usuario` jamás llevan una contraseña, un código, un token ni texto que la persona haya
// digitado en el campo de usuario. Si el identificador no existe, `usuario` va NULL (sección 9).
import type { FastifyRequest } from 'fastify';
import { queryApp } from '../db.js';
import { agenteDe, ipDe } from './red.js';

export type TipoEvento =
  | 'login_ok' | 'login_fallido' | 'cuenta_bloqueada' | 'logout' | 'sesion_expirada' | 'sesion_revocada'
  | 'otp_solicitado' | 'otp_fallido' | 'otp_validado' | 'contrasena_cambiada' | 'contrasena_restablecida'
  | 'contrasena_temporal_generada' | 'cuenta_desbloqueada' | 'usuario_desactivado' | 'correo_fallido' | 'acceso_emergencia'
  | 'sesion_verificacion';

export interface EventoAuth {
  tipo: TipoEvento;
  /** Usuario REAL de la cuenta, o null/ausente si el identificador digitado no existe. */
  usuario?: string | null;
  /** Quién lo hizo cuando no fue la propia persona: un usuario de soporte, `consola` o `despliegue`. */
  actor?: string | null;
  ip?: string | null;
  agente?: string | null;
  detalle?: string | null;
}

const DETALLE_MAX = 300;

export async function registrarEvento(e: EventoAuth): Promise<void> {
  try {
    await queryApp(
      `INSERT INTO panel.eventos_autenticacion (tipo, usuario, actor, ip, agente, detalle) VALUES ($1, $2, $3, $4::inet, $5, $6)`,
      [e.tipo, e.usuario ?? null, e.actor ?? null, e.ip ?? null, e.agente ?? null, e.detalle ? e.detalle.slice(0, DETALLE_MAX) : null],
    );
  } catch (err) {
    // Un fallo al auditar nunca debe tumbar el acceso; queda en el log del servidor (solo el mensaje).
    console.error('No se pudo registrar un evento de autenticación:', (err as Error).message);
  }
}

/** Atajo que toma IP y agente de la petición. */
export const eventoDe = (req: FastifyRequest, e: Omit<EventoAuth, 'ip' | 'agente'>) =>
  registrarEvento({ ...e, ip: ipDe(req), agente: agenteDe(req) });
