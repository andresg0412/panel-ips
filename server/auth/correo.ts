// Envío de correo por API HTTPS (no SMTP: los puertos 25/465/587 suelen estar bloqueados en el droplet).
// Adaptado de proyecto-ips/backend/src/services/notificaciones/email.provider.ts, con `fetch` en lugar de axios.
//
// Proveedores: `resend`, `brevo` y `memoria` (solo pruebas: guarda los mensajes en un arreglo; se rechaza con
// NODE_ENV=production). NUNCA hay una llave por defecto en el código. NUNCA se registra la llave, el cuerpo ni el
// destinatario del correo (el cuerpo trae un código de acceso): los errores se resumen como "HTTP 422".
// Sin reintentos: un código que llega tarde no sirve; la persona pide otro.
import { esProduccion } from './configuracion.js';

export interface MensajeCorreo {
  asunto: string;
  texto: string;
  html: string;
  para: string[];
}

export interface ResultadoCorreo {
  ok: boolean;
  /** Resumen sin datos sensibles (p. ej. "HTTP 422"). */
  error?: string;
}

const TIMEOUT_MS = 15_000;
export const REMITENTE_POR_DEFECTO = 'Panel IPS - Centro de Orientación <no-reply@zentrixsolucionesdigitales.com>';

/** Solo para pruebas (proveedor `memoria`). */
export const mensajesEnMemoria: MensajeCorreo[] = [];

const proveedor = () => (process.env.EMAIL_PROVEEDOR ?? '').trim().toLowerCase();
const remitente = () => (process.env.EMAIL_REMITENTE ?? '').trim() || REMITENTE_POR_DEFECTO;

/** `Nombre <correo@dominio>` o `correo@dominio` → { nombre?, correo }. */
export function separarRemitente(valor: string): { nombre?: string; correo: string } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(valor);
  if (m) {
    const nombre = m[1]?.trim();
    return { ...(nombre ? { nombre } : {}), correo: m[2].trim() };
  }
  return { correo: valor.trim() };
}

/** Hay un proveedor utilizable: `resend`/`brevo` con llave, o `memoria` fuera de producción. */
export function correoDisponible(): boolean {
  const p = proveedor();
  if (p === 'memoria') return !esProduccion();
  if (p === 'resend' || p === 'brevo') return !!process.env.EMAIL_API_KEY?.trim();
  return false;
}

const resumirHttp = (status: number) => `HTTP ${status}`;

async function post(url: string, cabeceras: Record<string, string>, cuerpo: unknown): Promise<ResultadoCorreo> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...cabeceras },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, error: resumirHttp(res.status) };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { ok: false, error: `sin respuesta del proveedor (${err.cause?.code ?? err.name})`.slice(0, 120) };
  }
}

export async function enviarCorreo(m: MensajeCorreo): Promise<ResultadoCorreo> {
  if (!correoDisponible()) return { ok: false, error: 'correo no configurado' };
  const p = proveedor();
  if (p === 'memoria') {
    mensajesEnMemoria.push(m);
    return { ok: true };
  }
  const llave = process.env.EMAIL_API_KEY!.trim();
  if (p === 'resend') {
    return post('https://api.resend.com/emails', { Authorization: `Bearer ${llave}` }, { from: remitente(), to: m.para, subject: m.asunto, text: m.texto, html: m.html });
  }
  const r = separarRemitente(remitente());
  return post(
    'https://api.brevo.com/v3/smtp/email',
    { 'api-key': llave },
    {
      sender: { email: r.correo, ...(r.nombre ? { name: r.nombre } : {}) },
      to: m.para.map((email) => ({ email })),
      subject: m.asunto,
      textContent: m.texto,
      htmlContent: m.html,
    },
  );
}
