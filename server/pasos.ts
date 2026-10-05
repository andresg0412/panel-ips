// Nombres legibles de los pasos del bot. bi.dim_paso trae como descripción el archivo del bot que implementa cada
// paso (p. ej. 'step12AgendarCita.ts'), que no le dice nada a la gerencia. Los que no estén aquí se derivan del
// identificador ('agendar.s08_fechas' → 'Fechas').

const NOMBRES: Record<string, string> = {
  'inicio.bienvenida': 'el saludo de bienvenida',
  'politicas.pregunta': 'la aceptación de la política de datos',
  'politicas.no_acepta': 'el rechazo de la política de datos',
  'menu.principal': 'el menú principal',

  'agendar.s01_tipo_cita': 'la elección entre presencial y virtual',
  'agendar.s02_tipo_consulta': 'la elección entre primera vez y control',
  'agendar.ct04_especialidad': 'la elección de especialidad (control)',
  'agendar.pv04_especialidad_menu': 'la elección de especialidad (primera vez)',
  'agendar.pv05_especialidad': 'la elección de especialidad',
  'agendar.ct05_tipo_documento': 'el tipo de documento (control)',
  'agendar.ct06_documento': 'el número de documento (control)',
  'agendar.pv06_tipo_atencion': 'el tipo de atención',
  'agendar.ct07_citas_previas': 'la búsqueda de citas anteriores',
  'agendar.s08_fechas': 'la consulta de fechas disponibles',
  'agendar.s09_selecciona_fecha': 'la elección de la fecha',
  'agendar.s10_selecciona_hora': 'la elección de la hora',
  'agendar.s11_datos_intro': 'la solicitud de datos',
  'agendar.s12_particular_convenio': 'la elección entre particular y convenio',
  'agendar.s13_convenio': 'la elección del convenio',
  'agendar.s14_tipo_documento': 'el tipo de documento',
  'agendar.s15_documento': 'el número de documento',
  'agendar.s16_consulta_paciente': 'la búsqueda del paciente',
  'agendar.s17_formulario_paciente': 'el registro de pacientes nuevos',
  'agendar.s18_confirmacion': 'la confirmación final',
  'agendar.s19_crear_cita': 'la creación de la cita',
  'agendar.lista_espera_optin': 'la invitación a la lista de espera',

  'cancelar.s01_inicio': 'el inicio del trámite, antes de identificar la cita',
  'cancelar.s05_lista_citas': 'la lista de citas del paciente',
  'cancelar.s06_selecciona_cita': 'la elección de la cita',
  'cancelar.s07_confirmacion': 'la confirmación de la cancelación',
  'cancelar.confirma_cancelar': 'la cancelación',
  'cancelar.opcion_reprogramar': 'la oferta de reprogramar en lugar de cancelar',

  'reprogramar.s01_inicio': 'el inicio del trámite, antes de identificar la cita',
  'reprogramar.s05_lista_citas': 'la lista de citas del paciente',
  'reprogramar.s06_selecciona_cita': 'la elección de la cita',
  'reprogramar.s07_confirmacion': 'la confirmación',
  'reprogramar.fechas': 'la consulta de fechas disponibles',
  'reprogramar.selecciona_fecha': 'la elección de la fecha',
  'reprogramar.selecciona_hora': 'la elección de la hora',
  'reprogramar.confirma_reprogramar': 'la reprogramación',

  'comun.c01_tipo_documento': 'el tipo de documento',
  'comun.c02_tipo_documento_sel': 'el tipo de documento',
  'comun.c03_documento': 'el número de documento',
  'comun.c04_consulta_citas': 'la búsqueda de sus citas',
  'comun.c05_seleccion': 'la elección de la cita',
  'comun.volver_menu': 'el regreso al menú',
  'comun.salida': 'la despedida',
};

/** "la consulta de fechas disponibles" (en minúscula, para usar dentro de una frase). */
export function nombrePaso(paso: string): string {
  if (NOMBRES[paso]) return NOMBRES[paso];
  const h = paso.replace(/^[^.]*\./, '').replace(/^[a-z]+\d+_/, '').replace(/_/g, ' ');
  return `el paso «${h}»`;
}

/** Igual que nombrePaso, con mayúscula inicial y sin artículo: para tablas. */
export function tituloPaso(paso: string): string {
  const n = NOMBRES[paso];
  if (!n) {
    const h = paso.replace(/^[^.]*\./, '').replace(/^[a-z]+\d+_/, '').replace(/_/g, ' ');
    return h.charAt(0).toUpperCase() + h.slice(1);
  }
  const sin = n.replace(/^(el|la|los|las) /, '');
  return sin.charAt(0).toUpperCase() + sin.slice(1);
}
