// Plantillas de los dos correos de la autenticación, en texto y HTML, sin enlaces ni datos de pacientes.
// El código NO va en el asunto: se leería en las notificaciones del celular con la pantalla bloqueada.

const FORMATO_HORA = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' });
const FORMATO_SOLO_HORA = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', timeStyle: 'short' });

export const horaBogota = (d: Date) => FORMATO_HORA.format(d);

const escapar = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function marco(titulo: string, cuerpoHtml: string): string {
  return `<!doctype html><html lang="es"><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1c2733">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px">
<h1 style="font-size:18px;margin:0 0 16px">${escapar(titulo)}</h1>${cuerpoHtml}
<p style="font-size:12px;color:#6b7785;margin:24px 0 0">Panel IPS · Centro de Orientación. Este mensaje es automático, no responda a este correo.</p>
</div></body></html>`;
}

export interface Plantilla {
  asunto: string;
  texto: string;
  html: string;
}

export function plantillaCodigo(codigo: string, venceAt: Date, vigenciaMin: number): Plantilla {
  const hasta = FORMATO_SOLO_HORA.format(venceAt);
  const texto = [
    'Usted pidió restablecer su contraseña del Panel IPS.',
    '',
    `Su código es: ${codigo}`,
    '',
    `Vale ${vigenciaMin} minutos (hasta las ${hasta}, hora de Bogotá) y solo se puede usar una vez.`,
    '',
    'Si no lo solicitó, ignore este mensaje. Su contraseña no cambiará.',
  ].join('\n');
  const html = marco(
    'Restablecer su contraseña',
    `<p style="font-size:14px;line-height:1.5;margin:0 0 16px">Usted pidió restablecer su contraseña del Panel IPS. Escriba este código en la pantalla de acceso:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold;text-align:center;margin:0 0 16px;font-family:'Courier New',monospace">${escapar(codigo)}</p>
<p style="font-size:14px;line-height:1.5;margin:0 0 8px">Vale ${vigenciaMin} minutos (hasta las ${escapar(hasta)}, hora de Bogotá) y solo se puede usar una vez.</p>
<p style="font-size:14px;line-height:1.5;margin:0">Si no lo solicitó, ignore este mensaje. Su contraseña no cambiará.</p>`,
  );
  return { asunto: 'Código para restablecer su contraseña', texto, html };
}

export function plantillaContrasenaCambiada(cuando: Date): Plantilla {
  const hora = horaBogota(cuando);
  const texto = [
    'La contraseña de su cuenta del Panel IPS cambió.',
    '',
    `Fecha y hora: ${hora} (hora de Bogotá).`,
    '',
    'Si no fue usted, contacte a soporte de inmediato.',
  ].join('\n');
  const html = marco(
    'Su contraseña cambió',
    `<p style="font-size:14px;line-height:1.5;margin:0 0 8px">La contraseña de su cuenta del Panel IPS cambió.</p>
<p style="font-size:14px;line-height:1.5;margin:0 0 16px"><b>Fecha y hora:</b> ${escapar(hora)} (hora de Bogotá).</p>
<p style="font-size:14px;line-height:1.5;margin:0"><b>Si no fue usted, contacte a soporte de inmediato.</b></p>`,
  );
  return { asunto: 'Su contraseña del panel cambió', texto, html };
}
