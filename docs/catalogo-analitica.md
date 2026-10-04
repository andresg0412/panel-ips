# Catálogo de analítica del panel de reportes

Fecha: 2026-10-04. Autor: agente `ips-data-analyst`. Fuente: base de producción, consultada en solo lectura
(`default_transaction_read_only=on`, `statement_timeout=30s`), y el código de `panel-ips`, `proyecto-ips` y
`bot-meta-plantilla`. Todas las cifras son agregados. Este documento no contiene datos personales ni
contenido de `agenda.motivo_consulta`; de esa columna solo se midió la tasa de nulos (23.976 de 23.978).

Convenciones:

- "Hoy" = 2026-10-04. Todas las fechas de negocio están en hora de Bogotá.
- **Asistencia** = asistió ÷ (asistió + no asistió). **No-show** = 1 − asistencia. Las canceladas,
  reprogramadas y anuladas no entran en el denominador porque la cita no llegó a ocurrir.
- **Cita de paciente** = cita cuyo catálogo no es administrativo (ver hallazgo D3).
- IDs: `TR` transversal, `RES` Resumen, `CAM` Campañas, `AGE` Agenda, `PRO` Profesionales (pantalla
  nueva), `PAC` Pacientes, `CHB` Chatbot, `LE` Lista de espera, `MKT` Marketing (pantalla nueva),
  `SIS` Estado del sistema.

---

## 1. Resumen ejecutivo

**Qué se puede medir hoy con confianza:** 14 meses de agenda (23.978 citas, ago-2025 a oct-2026) con
asistencia, no-show, cancelaciones, tipo de servicio, modalidad, convenio, edad y franja horaria; retención de
pacientes y tiempo entre citas; 35.628 envíos de campañas con su respuesta (confirmó, otro momento, finalizó);
11.080 conversaciones del bot con su resultado; y la ocupación de la agenda de los psicólogos que figuran en
`equipo`.

**Qué no se puede medir todavía, o solo desde hace días:** la entrega y lectura de los mensajes (desde el
30-sep-2026), la anticipación real de las cancelaciones (desde el 3-oct-2026), el efecto de la lista de espera
(12 inscripciones de prueba, 1 cupo recolocado) y las invitaciones a la lista (0 filas). Tampoco el valor en
dinero, que queda fuera por decisión de German.

**Advertencia principal:** entre el 1-abr y el 5-ago-2026 hubo un incidente: el bot no envió mensajes, no
registró conversaciones y el scraper dejó de traer la agenda. Ese período tiene que excluirse de líneas base y
comparaciones, y verse en los gráficos (propuesta TR-01). Además, el panel actual cuenta 1.273 "reuniones" como
si fueran citas (D3), y eso infla las anulaciones y reprogramaciones.

**Las 5 propuestas de mayor valor:**
1. **TR-01 + SIS-01. Registro de incidentes y alertas tempranas.** Con estas alertas, el incidente de abril
   habría saltado el mismo 1-abr. Hoy ya detectarían que `execute` procesó 68 citas el 4-oct y no envió
   ningún mensaje.
2. **CAM-03. Asistencia según el contacto por WhatsApp.** Quien confirma por WhatsApp falta entre 4,1 % y
   5,9 %. Quien recibe el recordatorio y no lo confirma falta entre 6,9 % y 11 %.
3. **PRO-01. Ocupación de la agenda por profesional.** En septiembre de 2026, entre el 57 % y el 92 % de los
   cupos ofrecidos según el horario.
4. **AGE-01. Mapa del no-show.** Por franja, día, edad, modalidad y anticipación. Va del 2,8 % en mayores de
   60 años al 9,4 % en citas virtuales.
5. **CAM-05. Efecto real de las campañas de recuperación,** con el incidente como grupo de comparación. En
   abril de 2026 no se observó diferencia: 29 % con mensaje frente a 28 % sin mensaje.

---

## 2. Inventario de datos y calidad

### 2.1 Tablas y vistas (producción, 2026-10-04)

| Fuente | Filas | Rango | Estado | Nota |
|---|---:|---|---|---|
| `agenda` (`bi.fact_citas`) | 23.978 | citas 2025-08-02 → 2026-10-17 | Viva (scraper cada hora, L-S 6-20) | Hueco de registro 30-may → 5-ago-2026 |
| `pacientes` (`bi.dim_paciente`) | 10.044 | creados 2025-08 → 2026-10 | Viva | 7.795 creados en la carga inicial de ago-2025 |
| `equipo` (`bi.dim_profesional`) | 16 | — | Estática | Faltan profesionales: el 14 % de las citas no tiene `profesional_id` (D4) |
| `horariosequipo` | 15 (9 con cupos) | horario vigente | Estática, sin historial | No visible para `panel_lectura` |
| `festivos` | 14 | 2025-08-07 → 2026-12-25 | Incompleta | Faltan los festivos de ene-jul 2026 (D10) |
| `convenios` | 0 | — | Vacía | Se usa `agenda.administradora` |
| `chat_stats` (`bi.fact_eventos`) | 69.967 | 2025-08-13 → hoy | Viva (v2 desde 2026-10-04) | 104 MB; crece unas 15 mil filas al mes |
| `envios_whatsapp` (`bi.fact_envios`) | 35.628 | 2025-08-13 → hoy | Viva desde 2026-10-04 | Backfill hasta el 30-sep; sin filas del 1 al 3-oct |
| `sesiones_chat` (`bi.fact_sesiones`) | 11.080 | 2025-08-13 → hoy | Viva | Las sesiones de backfill no tienen duración ni mensajes |
| `agenda_estado_historial` (`bi.fact_cita_estados`) | 145 | 2026-09-30 → hoy | Viva | Bot desde el 30-sep; scraper solo desde el 3-oct |
| `catalogo_pasos` (`bi.dim_paso`) | 70 | — | Estática | — |
| `lista_espera` | 12 | 2026-10-01 → 04 | Pruebas | 11 retiradas y 1 consumida; `origen` en NULL en todas |
| `cupos_liberados` | 7 | 2026-10-01 → 03 | Pruebas | 1 asignado y 6 escalados |
| `ofertas_cupo` | 6 | 2026-10-01 → 03 | Pruebas | 1 aceptada, 3 expiradas, 1 anulada, 1 con error |
| `eventos_lista_espera` | 60 | 2026-10-01 → 04 | Pruebas | No visible para `panel_lectura` |
| `invitaciones_lista_espera` | 0 | — | Recién creada (034) | Flag `LISTA_ESPERA_INVITACION_ENABLED` |
| `ejecuciones_invitacion_lista_espera` | 0 | — | Recién creada (034) | Ídem |
| `respuestas_recordatorio` | 0 | — | Vacía | Flag `RECORDATORIOS_BOTONES_ENABLED` |
| 8 vistas `public.vista_*` (028) | — | — | Legado de Looker | El panel no las usa |

### 2.2 Hallazgos de calidad (cuantificados)

| # | Hallazgo | Cifra | Efecto en las métricas | Tratamiento propuesto |
|---|---|---|---|---|
| D1 | **Incidente abr-jul 2026.** WhatsApp rechazó todos los envíos del 1-abr 20:30 al 22-jun 13:40. Sin conversaciones del 1-abr al 6-ago. Sin ningún evento del 22-jun al 6-ago. Scraper sin registrar citas del 30-may al 5-ago. | 9.704 de 10.416 eventos de campaña con error; 0 sesiones de may a jul | Rompe tendencias, promedios y comparaciones con el período anterior | TR-01: tabla `incidentes_datos`, franja sombreada, exclusión de las líneas base |
| D2 | **Citas de junio sin cierre.** Se quedaron en Pendiente o Confirmado porque el scraper solo revisa ~15 días hacia atrás. | 499 de 511 citas de jun-2026; 611 de oct son futuras (normal) | El panel las cuenta como "Programadas"; en junio no hay asistencia | TR-03: estado `sin_cierre` para citas pasadas en Pendiente o Confirmado |
| D3 | **Reuniones internas registradas como citas.** El catálogo "REUNIONES DIRECCION DE SERVICIOS" (y 3 más) no son consultas. | 1.273 filas: 576 Anuladas (72 % de todas las `Anulado`), 473 Reprogramar (14 %) | Infla cancelaciones, anulaciones, reprogramaciones y "programadas" de algunos profesionales | TR-02: excluir `tipo_servicio = 'administrativa'` en todo el panel |
| D4 | **Citas sin `profesional_id`.** Los psiquiatras y el neuropsicólogo de la agenda no casan con `equipo`. | 3.466 citas (14 %) | Ocupación imposible de calcular para psiquiatría y neuropsicología | Usar el nombre normalizado para los desgloses; corregir el maestro `equipo` (fuera del panel) |
| D5 | **Envíos históricos sin enlace a la cita.** Solo el 4,6 % de `execute` y el 3,4 % de `reminder` tienen `agenda_id`. | 6.896 de 35.628 envíos con cita | `cita_confirmada_despues` de `bi.fact_envios` sale casi siempre falso antes del 30-sep, porque además el historial empieza ese día | CAM-01 y `bi.v_cita_contacto`: enlace por teléfono y fecha, y "confirmó" según la respuesta |
| D6 | **"Confirmaron" en Campañas sale casi en cero para el histórico.** Depende de `agenda_estado_historial`. | 5.617 respuestas "confirmo" frente a ~30 confirmaciones en el historial | Subestima mucho el resultado de las campañas | CAM-01 |
| D7 | **Entrega y lectura solo desde el 30-sep-2026.** Los envíos del backfill solo tienen "aceptado" o "rechazado_api". Existen 3.136 eventos `wa_estado` desde el 24-sep, pero los del 30-sep al 3-oct no se pueden unir a un envío hasta que corra el backfill. | 76 envíos con estado de Meta en `envios_whatsapp` | Embudo de entrega y lectura muy corto | Marcar "datos desde" (TR-04) y correr el backfill |
| D8 | **9.788 `rechazado_api` sin código de error.** 9.705 son del incidente D1 (abr-jun 2026); el resto son 48 del 6-ago-2026 (día del reinicio), 24 de ago-2025 y 11 aislados. | 9.788 | No son errores de número de teléfono | Atribuirlos al incidente; no usarlos para medir la calidad de los teléfonos |
| D9 | **La anticipación de registro es aproximada.** `fecha_registro` = `created_at`, que es cuando el scraper vio la cita por primera vez, y la ventana del scraper es de ~30 días hacia adelante. | 1.116 citas registradas después de ocurrir (por el incidente); máximo de 30 días | "Días de espera" censurados en 30 | Usarla como indicador aproximado y decirlo en el panel |
| D10 | **`festivos` incompleta.** Faltan los festivos de ene-jul 2026 (1-ene, 12-ene, 23-mar, 2 y 3-abr, 1-may, 18-may, 8, 15 y 29-jun, 20-jul). | 14 filas | La capacidad de esos días queda sobreestimada | Completar la tabla (operativo) |
| D11 | **El tipo de servicio no viene como columna.** Se deduce de `catalogo`, que tiene variantes con y sin tilde. | 47 textos distintos de catálogo | Sin normalizar, "primera vez" se parte en 3 | Clasificación en `bi.fact_citas_enriquecida` |
| D12 | **Cambio de definición en las conversaciones entrantes.** Con v2, `msg_entrante` cuenta cada mensaje (unos 200-360 al día); antes solo se contaba `chat_inicio` (unos 20 al día). | Salto de 25 a 363 el 30-sep | Una serie de "mensajes" daría un salto falso | Usar `sesiones_chat` como medida estable |
| D13 | **Teléfonos compartidos.** Un mismo número aparece en varios pacientes (padres con hijos, por ejemplo). | 743 números para 1.593 pacientes; 195 sin teléfono válido; 311 no móviles colombianos | Un envío puede atribuirse a dos citas; `paciente_resolucion = telefono_ambiguo` | Preferir `agenda_id` o documento; mostrar el % ambiguo |
| D14 | **Cancelaciones crecientes y reprogramaciones decrecientes.** Puede ser un cambio de uso de Globho, no de comportamiento de los pacientes. | Cancelación del 13-16 % en 2025 al 21-23 % desde mar-2026 | Riesgo de leer como tendencia algo que es un cambio de registro | Mostrar "cancelada + reprogramada" como total de "no ocurrió", además de cada estado por separado |
| D15 | **`execute` procesó citas y no envió ningún mensaje.** El 4-oct procesó 68 y envió 0, sin errores. Hay 61 corridas históricas iguales. | 61 de 309 ejecuciones | Puede ser una regla de negocio (citas ya confirmadas) o un fallo silencioso | Revisarlo en el bot; alerta A2 |
| D16 | **El 4-oct sí corrieron `execute`, `recuperacion` y `conasistencia`.** Hay resumen v2 de cada una, pero sin envíos. | Totales 68, 0 y 0 | Corrige el hallazgo previo "el 4-oct solo corrió reminder" | Vista `bi.v_campana_ejecuciones` |

---

## 3. Catálogo de propuestas por pantalla

Ficha resumida: **Pregunta / Audiencia / Pantalla**, **Métrica**, **Fuente**, **Disponibilidad**,
**Visual**, **Interacción**, **Valor medido**, **Prioridad · Esfuerzo · Dependencias**.

### 3.0 Transversales (afectan a todas las pantallas)

#### [TR-01] Registro de incidentes y franjas sombreadas
- **Pregunta:** ¿puedo confiar en este tramo del gráfico? / Todas / Todas las pantallas con eje de tiempo.
- **Métrica:** períodos de `incidentes_datos` (área, desde, hasta, severidad, `excluir_de_lineas_base`).
  1. Todo gráfico de tiempo dibuja una franja gris (`markArea` de ECharts) con un ícono que muestra el título al
     pasar el cursor.
  2. Todo KPI "vs período anterior" o "vs promedio" excluye los días en incidente de los dos períodos.
  3. Si más del 30 % del período anterior está en incidente, compara contra el mismo período del año anterior.
     Si tampoco hay datos, no muestra comparación y lo dice.
- **Fuente:** tabla nueva `incidentes_datos` + `bi.dim_incidente` (sección 5). Seis incidentes precargados.
- **Disponibilidad:** inmediata.
- **Visual:** una franja sombreada por área (solo las de la pantalla: agenda en Agenda, whatsapp en Campañas),
  con un chip "Datos incompletos: ver incidentes" sobre el gráfico. Sección "Incidentes" en Estado del sistema
  con la lista editable.
- **Mejora sobre la idea original:**
  - La franja va por área. El hueco de WhatsApp no ensucia los gráficos de agenda, que sí tuvieron datos hasta
    el 30-may.
  - Las comparaciones se cambian solas a interanual cuando el período anterior quedó contaminado.
  - La alerta SIS-01 propone abrir un incidente en vez de crearlo: un humano confirma y le pone título.
- **Interacción:** clic en la franja → ficha del incidente. En la v1, la tabla se edita por SQL. Más adelante,
  una pantalla de administración solo para `gerencia` (requeriría un rol con escritura, fuera del modelo actual
  de solo lectura).
- **Valor medido:** cubre los 6 tramos verificados de D1 y D7.
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** migración 035.

#### [TR-02] Excluir las citas administrativas de todas las métricas de agenda
- **Pregunta:** ¿cuántas consultas reales hubo? / Todas / Resumen, Agenda, Pacientes.
- **Métrica:** filtro `tipo_servicio <> 'administrativa'`. En la Oleada 1 va como fragmento SQL en
  `panel-ips/server/sql.ts`:
  `upper(translate(catalogo,'ÁÉÍÓÚáéíóú','AEIOUAEIOU')) NOT LIKE 'REUNION%' AND coalesce(catalogo,'') <> '' AND catalogo NOT ILIKE 'GASTOS%'`.
  Después, la columna `es_cita_paciente` de la vista.
- **Fuente:** `bi.fact_citas.catalogo`.
- **Disponibilidad:** todo el histórico.
- **Visual:** no aplica (corrección). Nota de ayuda: "No incluye reuniones internas".
- **Valor medido:** quita 1.273 filas, entre ellas 576 de las 799 anulaciones y 473 de las 3.387
  reprogramaciones.
- **Prioridad:** alta · **Esfuerzo:** S · **Dependencias:** ninguna.

#### [TR-03] Estado "Sin cierre" para citas pasadas que siguen pendientes
- **Pregunta:** ¿qué citas no sabemos si ocurrieron? / Analista / Agenda.
- **Métrica:** `estado_agenda IN ('Pendiente','Confirmado') AND fecha_cita < hoy` pasa a "Sin cierre", aparte
  de "Programada".
- **Fuente:** `bi.fact_citas`. En la Oleada 2, `grupo_estado` de la vista enriquecida.
- **Visual:** sexto color en las barras por estado (gris claro).
- **Valor medido:** 499 en jun-2026 y unas 830 en total.
- **Prioridad:** alta · **Esfuerzo:** S.

#### [TR-04] Etiqueta "datos desde" en cada métrica
- **Pregunta:** ¿desde cuándo vale este número? / Todas / Todas.
- **Métrica:** `bi.dim_cobertura` (fecha de inicio por métrica). Si el rango elegido empieza antes, la tarjeta
  muestra "Datos desde el 30 sep 2026".
- **Prioridad:** alta · **Esfuerzo:** S · **Dependencias:** migración 035. Mientras tanto, un objeto constante
  en el frontend.

### 3.1 Resumen (gerencia)

#### [RES-01] Tablero de 6 KPIs con meta y comparación limpia
- **Pregunta:** ¿cómo va la IPS este mes? / Gerencia / Resumen.
- **Métrica** (citas de paciente, `fecha_cita` en el período):
  1. citas atendidas (Asistio);
  2. asistencia %;
  3. cancelación + reprogramación % sobre el total;
  4. pacientes nuevos atendidos (primera atención en el período);
  5. % de citas confirmadas por WhatsApp (CAM-03);
  6. ocupación % (PRO-01).
  Cada KPI se compara con el período anterior según TR-01 y tiene una meta configurable (constante del panel).
  Semáforo: verde ≥ meta, ámbar dentro del 5 %, rojo por debajo.
- **Fuente:** `bi.fact_citas` (Oleada 1); `bi.fact_citas_enriquecida`, `bi.v_paciente_ciclo`,
  `bi.v_cita_contacto` y `bi.v_capacidad_profesional_dia` (Oleada 2).
- **Disponibilidad:** 1 a 4, todo el histórico; 5, desde ago-2025 con la limitación de D5; 6, desde el 6-ago-2026.
- **Visual:** KPI con delta y una línea pequeña de 12 meses con el incidente sombreado. Nada de velocímetros.
- **Valor medido:** sep-2026: 1.233 atendidas, asistencia del 92,4 %, cancelación del 22,7 %, 230 pacientes
  nuevos.
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** 1 a 4 sin migración.

#### [RES-02] Tendencia de 14 meses de citas atendidas por especialidad
- **Pregunta:** ¿crecemos? / Gerencia / Resumen.
- **Métrica:** citas Asistio por mes y especialidad (Psicología, Psiquiatría, Neuropsicología).
- **Visual:** small multiples (una línea por especialidad, cada una con su eje), porque psicología tiene 20
  veces el volumen de las otras. Franja de incidente.
- **Valor medido:** psicología, unas 1.050-1.170 al mes en los meses normales.
- **Prioridad:** media · **Esfuerzo:** S.

#### [RES-03] "Lo que hizo el bot este mes"
- **Pregunta:** ¿cuánto trabajo le ahorra el bot a recepción? / Gerencia / Resumen.
- **Métrica:**
  - confirmaciones de cita por WhatsApp (`envios_whatsapp.respuesta_tipo = 'confirmo'`);
  - citas agendadas, canceladas y reprogramadas por el bot (`sesiones_chat.resultado_negocio`);
  - conversaciones fuera de horario (antes de las 7, después de las 19, domingos);
  - derivaciones a un humano (`derivado_agente`, `fuera_horario`).
  Total de "trámites resueltos sin humano" = confirmaciones + gestiones completadas.
- **Fuente:** `bi.fact_envios`, `bi.fact_sesiones`.
- **Disponibilidad:** desde ago-2025, excepto el incidente.
- **Visual:** cuatro cifras grandes con una frase ("El bot resolvió 1.467 trámites; 18 % de las conversaciones, fuera del
  horario de recepción"). Sin gráfico.
- **Valor medido** (6-ago a 30-sep-2026, 56 días): 1.270 confirmaciones y 197 gestiones completadas = **1.467
  trámites**. 191 derivaciones. 536 de 2.986 conversaciones (18 %) fuera de horario.
- **Prioridad:** alta · **Esfuerzo:** S.

#### [RES-04] Informe mensual descargable
- **Pregunta:** ¿qué le llevo a la junta? / Gerencia / Resumen.
- **Métrica:** RES-01 + RES-03 + CAM-03 + LE-01 + 3 alertas del mes, en una página.
- **Visual:** página imprimible (CSS de impresión → PDF del navegador). Sin generar PDF en el servidor.
- **Prioridad:** media · **Esfuerzo:** M · **Dependencias:** Oleada 2.

### 3.2 Campañas (gerencia, marketing)

#### [CAM-01] Corregir "confirmaron" y unificar su definición
- **Pregunta:** ¿cuántos pacientes confirmaron gracias a la campaña? / Gerencia / Campañas.
- **Métrica:** confirmó = `respuesta_tipo = 'confirmo'` (respuesta registrada al envío) **o**
  `cita_confirmada_despues`. Base: envíos aceptados de `reminder` y `execute`.
- **Fuente:** `bi.fact_envios`.
- **Disponibilidad:** respuesta desde ago-2025; historial desde el 30-sep-2026.
- **Valor medido** (tasa de respuesta sobre envíos que llegaron):
  - `execute`: 4.264 de 12.553 (34 %);
  - `reminder`: 1.322 de 4.968 (27 %);
  - `recuperacion`: 7 %;
  - `conasistencia`: 7 %.
  Hoy el panel muestra 0 confirmaciones para casi todo el histórico.
- **Prioridad:** alta · **Esfuerzo:** S · **Dependencias:** ninguna.

#### [CAM-02] Embudo por campaña: aceptado → entregado → leído → respondió → confirmó → asistió
- **Pregunta:** ¿dónde se pierde el efecto de la campaña? / Gerencia, marketing / Campañas.
- **Métrica:** un conteo por etapa, sobre envíos de plantilla de la campaña elegida. "Asistió" = la cita
  enlazada (`bi.v_cita_contacto`) terminó en Asistio.
- **Disponibilidad:**
  - entregado y leído, desde el 30-sep-2026 (antes, la etapa se oculta con TR-04);
  - asistió, todo el histórico mediante el enlace inferido.
- **Visual:** embudo horizontal de barras con el % de cada etapa sobre la anterior. Un embudo por campaña
  (selector), no varios superpuestos.
- **Valor medido:** 4-oct, `reminder`: 66 aceptados, 64 entregados, 34 leídos y 31 respondieron.
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** `bi.v_cita_contacto` para "asistió".

#### [CAM-03] Asistencia según el contacto por WhatsApp
- **Pregunta:** ¿los recordatorios reducen la inasistencia? / Gerencia / Campañas (y KPI en Resumen).
- **Métrica:** para citas de paciente cerradas (Asistio o No Asistio), no-show % por `grupo_contacto`:
  `confirmo_whatsapp`, `recibio_sin_confirmar`, `sin_recordatorio`, `sin_telefono_valido`, `envio_fallido`.
- **Fuente:** `bi.v_cita_contacto` + `bi.fact_citas_enriquecida` (nuevas).
- **Disponibilidad:** desde feb-2026, cuando hay `reminder` y `daily`. Antes solo `execute`.
- **Visual:** barras horizontales de no-show % por grupo, con el n en la etiqueta. Debajo, una línea mensual de
  "% de citas que confirmaron por WhatsApp".
- **Interacción:** filtro por especialidad, modalidad y profesional.
- **Valor medido** (no-show por grupo):

  | Mes | Confirmó | Recibió sin confirmar | Sin recordatorio |
  |---|---|---|---|
  | feb-2026 | 4,6 % | 7,2 % | 2,9 % (n=48) |
  | mar-2026 | 4,1 % | 11,0 % | 3,2 % (n=146) |
  | ago-2026 | 5,6 % | 6,9 % | 6,1 % |
  | sep-2026 | 5,9 % | 9,7 % | 7,2 % |

  Cobertura del 10-ago al 30-sep-2026: el 37 % confirmó, el 47 % recibió y no confirmó, el 8 % no tuvo
  recordatorio y el 8 % no tiene teléfono válido.
- **Cautela:** es observacional. Quien confirma ya tenía intención de ir. "Sin recordatorio" incluye citas
  creadas el mismo día, que casi no faltan (4 % de no-show con anticipación 0). Es una asociación, no una
  medida del efecto del recordatorio.
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** migración 035.

#### [CAM-04] Cobertura de recordatorios y por qué no llegan
- **Pregunta:** ¿a cuántas citas no les llega nada, y por qué? / Analista / Campañas.
- **Métrica:**
  - % de citas de paciente con al menos un recordatorio que llegó;
  - motivos: sin teléfono válido, envío fallido (código de Meta), sin envío;
  - cobertura por tipo (48 h / 24 h / 2 h).
- **Fuente:** `bi.v_cita_contacto`.
- **Visual:** barra 100 % apilada por mes. Tabla de motivos con exportación de las citas sin cobertura (rol
  analista).
- **Valor medido:** 84 % de cobertura en ago-sep 2026.
- **Prioridad:** media · **Esfuerzo:** S.

#### [CAM-05] Efecto de las campañas de recuperación y "con asistencia"
- **Pregunta:** ¿los mensajes de recuperación traen pacientes de vuelta? / Gerencia, marketing / Campañas.
- **Métrica:**
  - % de envíos tras los cuales el mismo teléfono registra una cita nueva en 30 días (`volvio_30d`) y asiste en
    60 (`asistio_60d`);
  - comparación: envíos rechazados del incidente (eligibles que no recibieron nada).
- **Fuente:** `bi.v_recuperacion_resultado` (nueva).
- **Disponibilidad:** sep-2025 en adelante. Solo ventanas cerradas (60 días).
- **Visual:** barras agrupadas por campaña × (llegó / no llegó). Un aviso fijo explica el grupo de comparación.
- **Valor medido:**
  - Comparación limpia (abril 2026, cuando la agenda todavía se registraba): recuperación, 28 % sin mensaje
    frente a 29 % con mensaje; con asistencia, 51 % frente a 50 %. **No se observa efecto.**
  - Con todo el período: 17,6 % frente a 29,7 %. Esta cifra está sesgada, porque el grupo sin mensaje cae en el
    hueco del scraper (30-may a 5-ago) y no podía registrar citas nuevas.
- **Cautela:** muestras chicas y meses distintos. Hay que repetirlo con una muestra de control deliberada (por
  ejemplo, el 10 % de los elegibles sin envío durante 2 meses), lo que es una decisión de German.
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** migración 035.

#### [CAM-06] Tiempo hasta la lectura y la respuesta
- **Pregunta:** ¿cuánto tardan en leer y responder? ¿El plazo de 24 h está bien? / Analista / Campañas.
- **Métrica:** distribución acumulada de `minutos_a_lectura` y `minutos_a_respuesta` por campaña.
- **Fuente:** `bi.fact_envios`.
- **Disponibilidad:** lectura desde el 30-sep-2026; respuesta desde ago-2025.
- **Visual:** curva acumulada (% respondido frente a horas desde el envío), una por campaña con color fijo.
- **Prioridad:** media · **Esfuerzo:** S.

#### [CAM-07] Ejecuciones de campaña: programadas frente a ejecutadas
- **Pregunta:** ¿corrió cada campaña cuando debía? ¿Cuántas citas procesó y cuántas envió? / Analista,
  gerencia / Campañas y Sistema.
- **Métrica:** por ejecución, `procesadas`, `exitosos` y `errores`; matriz campaña × día.
- **Fuente:** `bi.v_campana_ejecuciones` (nueva, lee los resúmenes `EJECUCION_*` que `bi.fact_eventos`
  excluye).
- **Disponibilidad:** desde ago-2025 (legacy) y v2 desde el 3-oct.
- **Visual:** calendario de calor (filas = campaña, columnas = día). Color por resultado: con envíos, sin
  envíos, con errores, no corrió.
- **Valor medido:** 2.026 ejecuciones históricas. 61 de `execute` procesaron citas sin enviar nada (D15),
  incluida la del 4-oct (68 procesadas, 0 enviadas).
- **Prioridad:** alta · **Esfuerzo:** S · **Dependencias:** migración 035.

#### [CAM-08] Errores de entrega y calidad de los teléfonos
- **Pregunta:** ¿qué números fallan y por qué? / Analista, marketing / Campañas.
- **Métrica:**
  - fallos por `error_code` y `error_titulo` (131047 = fuera de la ventana de 24 h, 132018 = parámetro
    inválido, etc.);
  - % de pacientes con teléfono no válido (195) o no móvil (311);
  - números compartidos (743).
- **Fuente:** `bi.fact_envios`, `bi.dim_paciente`, `bi.dim_contacto`.
- **Disponibilidad:** códigos desde el 30-sep-2026; calidad de los teléfonos, siempre.
- **Visual:** tabla ordenada. Exportación de los pacientes con teléfono inválido para que recepción los corrija.
- **Prioridad:** media · **Esfuerzo:** S.

#### [CAM-09] Fatiga de mensajes
- **Pregunta:** ¿le escribimos demasiado a alguien? / Marketing / Campañas.
- **Métrica:** distribución de mensajes por paciente y mes; pacientes con 8 o más mensajes al mes.
- **Fuente:** `bi.fact_envios`.
- **Visual:** histograma.
- **Prioridad:** baja · **Esfuerzo:** S.

#### [CAM-10] Respuesta por botón en los recordatorios (cuando llegue)
- **Pregunta:** ¿cuántos confirman, cancelan o dicen "no podré" desde el botón? / Gerencia / Campañas.
- **Métrica:** respuestas de `respuestas_recordatorio` por tipo y recordatorio.
- **Disponibilidad:** 0 filas. Necesita `RECORDATORIOS_BOTONES_ENABLED=true` y una vista bi (no está en
  `bi` ni en las tablas permitidas al panel).
- **Visual:** barras apiladas 100 % por tipo de recordatorio.
- **Prioridad:** media · **Esfuerzo:** S · **Dependencias:** flag + vista `bi.fact_respuestas_recordatorio`
  (trivial, en la 036).

### 3.3 Agenda (gerencia, analista)

#### [AGE-01] Mapa del no-show
- **Pregunta:** ¿dónde se concentran las inasistencias? / Gerencia, analista / Agenda.
- **Métrica:** no-show % en citas de paciente cerradas, por día × franja, edad, modalidad, tipo de servicio,
  especialidad, convenio o particular, y anticipación de registro.
- **Fuente:** `bi.fact_citas` (Oleada 1, con un CASE en el panel) → `bi.fact_citas_enriquecida`.
- **Disponibilidad:** todo el histórico, excluyendo `periodo_confiable = false`.
- **Visual:**
  - mapa de calor día × franja (color secuencial único, n en el tooltip);
  - barras ordenadas para el resto de dimensiones, una idea por gráfico.
  - Ocultar celdas con menos de 30 citas.
- **Valor medido** (no-show %):

  | Dimensión | Valores |
  |---|---|
  | Modalidad | virtual 9,4 %, presencial 7,4 % |
  | Edad | 60+ 2,8 %, 30-44 9,3 % |
  | Hora | 7 h 9,3 %, 17 h 9,5 %, 12 h 6,5 % |
  | Día | lunes 9,6 %, jueves 6,7 % |
  | Anticipación | mismo día 4,0 %, 8-15 días 9,1 % |
  | Especialidad | neuropsicología 3,7 %, psicología 8,2 % |
  | Pago | particular y convenio, ambos ~8 % |
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** ninguna para la Oleada 1.

#### [AGE-02] Citas que no ocurrieron: cancelación y reprogramación
- **Pregunta:** ¿cuántas horas de consulta se pierden? / Gerencia / Agenda.
- **Métrica:** % cancelada, % reprogramada y % "no ocurrió" (suma de ambas), por mes y por tipo de servicio.
  Horas = `sum(hora_final - hora_cita)`.
- **Fuente:** `bi.fact_citas`.
- **Visual:** línea mensual de "% no ocurrió" con franja de incidente. Barras por tipo de servicio.
- **Valor medido:** cancelación del 22,7 % en sep-2026, frente a ~15 % en 2025. Leer junto con D14.
- **Prioridad:** alta · **Esfuerzo:** S.

#### [AGE-03] Con cuánta anticipación cancelan
- **Pregunta:** ¿las cancelaciones llegan a tiempo para recolocar el cupo? / Gerencia / Agenda y Lista de
  espera.
- **Métrica:** horas entre la cancelación y el inicio de la cita (`anticipacion_cancelacion_h`), en tramos:
  menos de 24 h, 1-3 días, 3 días o más (el umbral de la cascada).
- **Fuente:** `bi.fact_citas_enriquecida` (`cancelada_at` del bot + primer cambio a Cancelado o Anulado del
  historial).
- **Disponibilidad:** bot desde el 30-sep-2026; scraper desde el 3-oct-2026. Sin histórico.
- **Visual:** barras por tramo. Mientras haya menos de 50 cancelaciones medidas, "Recolectando datos (n=…)".
- **Prioridad:** alta · **Esfuerzo:** S · **Dependencias:** migración 035.

#### [AGE-04] Oportunidad de la cita (días de espera)
- **Pregunta:** ¿cuánto espera un paciente nuevo por su primera cita? / Gerencia / Agenda.
- **Métrica:** mediana y P90 de `anticipacion_registro_dias` por especialidad × (primera vez / control),
  por mes.
- **Fuente:** `bi.fact_citas_enriquecida`.
- **Disponibilidad:** desde sep-2025 (excluir citas con días negativos y el incidente).
- **Visual:** small multiples por especialidad, con una línea de mediana para primera vez.
- **Valor medido** (ago-sep 2026, mediana de días):

  | Especialidad | Primera vez | Control |
  |---|---|---|
  | Psicología | 2 | 10 |
  | Psiquiatría | 4 | 15 |
  | Neuropsicología | 4 | 7 |
- **Cautela:** el valor es aproximado (D9) y está censurado en 30 días.
- **Prioridad:** alta · **Esfuerzo:** S.

#### [AGE-05] Mezcla de servicios
- **Pregunta:** ¿qué tipo de atención crece? / Gerencia / Agenda.
- **Métrica:** atendidas por mes y `tipo_servicio` (primera vez, control, psicoterapia, evaluación,
  rehabilitación, crisis, empresarial).
- **Visual:** barras apiladas mensuales con colores fijos por servicio.
- **Valor medido:** sobre el total, control 8.706, primera vez 3.004, psicoterapia 1.100 y crisis 341 atendidas.
- **Prioridad:** media · **Esfuerzo:** S.

#### [AGE-06] Presencial frente a virtual
- **Pregunta:** ¿cuánto pesa la teleconsulta y cómo le va? / Gerencia / Agenda.
- **Métrica:** % virtual (`tipo_cita = 4`) por mes; no-show por modalidad.
- **Valor medido:** 24 % virtual (5.856 de 23.978); no-show del 9,4 % frente al 7,4 %.
- **Visual:** línea del % virtual y KPI comparativo.
- **Prioridad:** media · **Esfuerzo:** S.

#### [AGE-07] Convenios y particulares
- **Pregunta:** ¿de qué convenios depende la IPS? / Gerencia / Agenda.
- **Métrica:** atendidas por administradora (las 10 principales + "otros"), participación de particulares y
  tendencia.
- **Valor medido:** particular, 28 % de las citas (6.697). Le siguen Axa Colpatria MP con 2.958 y Colmédica
  con 2.721.
- **Visual:** barras horizontales y una línea del % particular. La pantalla actual ya tiene una tabla; se
  agrega la tendencia.
- **Prioridad:** media · **Esfuerzo:** S.

#### [AGE-08] Citas sin cierre y calidad de la agenda
- **Pregunta:** ¿qué citas quedaron sin estado final o sin profesional? / Analista / Agenda.
- **Métrica:** conteo de `sin_cierre` por mes y de citas sin `profesional_id` por profesional.
- **Visual:** tabla con exportación.
- **Valor medido:** unas 830 sin cierre y 3.466 sin `profesional_id`.
- **Prioridad:** media · **Esfuerzo:** S.

#### [AGE-09] Carga de las próximas 4 semanas
- **Pregunta:** ¿cómo viene la agenda? / Gerencia, profesional / Agenda.
- **Métrica:** citas programadas por semana futura frente a la capacidad (PRO-01) y frente a la misma semana
  del año anterior.
- **Visual:** barras por semana con una marca de la capacidad.
- **Prioridad:** media · **Esfuerzo:** S · **Dependencias:** PRO-01.

#### [AGE-10] Intervenciones en crisis (volumen)
- **Pregunta:** ¿cuánta demanda de crisis atendemos? / Gerencia / Agenda.
- **Métrica:** solo conteo mensual del catálogo "INTERVENCION EN CRISIS". Sin detalle de pacientes.
- **Valor medido:** 467 citas, 341 atendidas.
- **Prioridad:** baja · **Esfuerzo:** S.

### 3.4 Profesionales (pantalla nueva; gerencia y cada profesional)

#### [PRO-01] Ocupación de la agenda por profesional
- **Pregunta:** ¿qué tan llena está la agenda de cada profesional y cuántos cupos se pierden? / Gerencia /
  Profesionales.
- **Métrica:** ocupación = `citas_ocupan` ÷ `cupos_ofrecidos`, por profesional y semana o mes.
  - `citas_ocupan` = citas de paciente en Asistio, No Asistio, Programada o Sin cierre.
  - Los cupos salen de `horariosequipo` (horas por día de la semana), sin festivos.
  - Además, se separan cupos usados por reuniones, cupos liberados y cupos libres futuros.
- **Fuente:** `bi.v_capacidad_profesional_dia` (nueva). `horariosequipo` y `festivos` no son visibles para el
  panel hoy.
- **Disponibilidad:**
  - desde el 6-ago-2026, porque el horario no tiene historial;
  - solo para los profesionales con `profesional_id` (D4): hoy, 6 psicólogos;
  - psiquiatría y neuropsicología salen en 0 hasta corregir el maestro.
- **Visual:** barras horizontales de ocupación % por profesional con una línea de referencia en la meta
  (por ejemplo, 85 %). Mapa de calor profesional × semana.
- **Interacción:** clic → ficha del profesional (PRO-02).
- **Valor medido:** sep-2026, los 6 psicólogos que casan con `equipo`: 57 %, 65 %, 73 %, 79 %, 87 % y 92 %.
  Otros 3 horarios no casan con ninguna cita.
- **Cautela:** los cupos de 50 minutos del horario no coinciden siempre con la duración real de la cita. Una
  psicoterapia de pareja puede ocupar dos.
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** migración 035 y corregir `equipo` (D4).

#### [PRO-02] Ficha del profesional
- **Pregunta:** ¿cómo va cada profesional? / Gerencia, profesional / Profesionales.
- **Métrica:** atendidas, asistencia, cancelación, mezcla de servicios, pacientes activos (PAC-04), pacientes
  nuevos y % que vuelve a la segunda cita (PRO-04).
- **Fuente:** `bi.fact_citas` por `profesional` normalizado. Sirve también para los profesionales sin
  `profesional_id`.
- **Visual:** encabezado de KPIs más 3 gráficos pequeños (tendencia, mezcla y no-show por franja).
- **Prioridad:** alta · **Esfuerzo:** M.

#### [PRO-03] Cupos libres de los próximos 14 días
- **Pregunta:** ¿dónde hay espacio para ofrecer citas? / Recepción, marketing / Profesionales.
- **Métrica:** `cupos_libres` futuros por profesional y día.
- **Visual:** calendario de calor (profesional × día) con el número de cupos libres.
- **Valor medido:** unos 1.460 cupos libres en los próximos 30 días según el horario. Hay que validarlo con
  recepción.
- **Prioridad:** media · **Esfuerzo:** S · **Dependencias:** PRO-01.

#### [PRO-04] Retención de los pacientes nuevos por profesional
- **Pregunta:** ¿qué porcentaje de pacientes nuevos vuelve a una segunda cita? / Gerencia / Profesionales.
- **Métrica:** pacientes cuya primera atención fue con el profesional y que tienen al menos 2 atenciones en 90
  días, dividido entre los pacientes nuevos del profesional (cohortes cerradas: primera atención hace más de 90
  días).
- **Fuente:** `bi.v_paciente_ciclo`.
- **Visual:** barras con intervalo, ocultando a los profesionales con menos de 20 pacientes nuevos.
- **Cautela:** depende del motivo de la consulta (una valoración puede ser de una sola vez) y del tipo de
  convenio. Úsese para conversar, no para evaluar a nadie.
- **Prioridad:** media · **Esfuerzo:** S.

#### [PRO-05] Vista "mi agenda" para el usuario profesional
- **Pregunta:** ¿cómo está mi semana y quién falta mucho? / Profesional / Profesionales.
- **Métrica:** la ficha PRO-02, filtrada al profesional que inicia sesión.
- **Dependencias:** mapeo usuario de nginx → profesional, y decidir qué datos de pacientes ve (P1 dice
  identidad completa; con la ley 1581 conviene limitarlo a "mis pacientes").
- **Prioridad:** baja · **Esfuerzo:** M.

### 3.5 Pacientes

#### [PAC-01] Pacientes nuevos y recurrentes atendidos
- **Pregunta:** ¿cuánta demanda nueva entra? / Gerencia, marketing / Pacientes.
- **Métrica:** por mes, pacientes atendidos por primera vez (`primera_atencion` en el mes) frente a
  recurrentes.
- **Fuente:** `bi.v_paciente_ciclo` (o un CTE equivalente sobre `bi.fact_citas` en la Oleada 1).
- **Visual:** barras apiladas (nuevos, recurrentes). Agosto de 2025 marcado como "inicio de datos", porque
  incluye pacientes que ya venían.
- **Valor medido:** unos 170-260 nuevos al mes en los meses normales. Ago-2026 tiene 384 (rebote tras el
  incidente) y sep-2026, 230.
- **Prioridad:** alta · **Esfuerzo:** S.

#### [PAC-02] Cohortes de retención
- **Pregunta:** ¿cuántos pacientes siguen viniendo 1, 2 y 3 meses después de empezar? / Gerencia, analista /
  Pacientes.
- **Métrica:** para cada cohorte (mes de la primera atención), % con una atención en el mes 1, 2, 3...
- **Fuente:** `bi.v_paciente_ciclo` + `bi.fact_citas_enriquecida`.
- **Visual:** mapa de calor triangular de cohortes. Cohortes censuradas (ago-2025) y del incidente marcadas.
- **Valor medido:** % que vuelve en 90 días: 72 % (sep-2025), 65 % (nov-2025), 63 % (mar-2026), 72 %
  (ago-2026). Promedio de 3,5 a 4,9 atenciones por paciente en las cohortes de 2025-26 con ventana cerrada.
- **Prioridad:** alta · **Esfuerzo:** M.

#### [PAC-03] Tiempo entre citas
- **Pregunta:** ¿cada cuánto vuelven los pacientes en seguimiento? / Profesional, analista / Pacientes.
- **Métrica:** días entre atenciones consecutivas (mediana, P25 y P75) por tipo de servicio y especialidad.
- **Valor medido:** mediana de 12 días (P25 7, P75 19), sobre 10.244 intervalos.
- **Visual:** histograma por semanas con una línea en 7, 14 y 30 días.
- **Prioridad:** media · **Esfuerzo:** S.

#### [PAC-04] Estado de actividad: activos, en riesgo, inactivos
- **Pregunta:** ¿a quién estamos perdiendo? / Gerencia, marketing / Pacientes.
- **Métrica:**
  - activo con cita = tiene una cita futura;
  - activo = última atención hace menos de max(2 × su frecuencia habitual, 30 días);
  - en riesgo = hasta 120 días;
  - inactivo = más de 120 días.
- **Fuente:** `bi.v_paciente_ciclo`.
- **Visual:** cuatro KPIs y una tabla exportable de "en riesgo" con su último profesional (rol analista o
  marketing).
- **Valor medido:** 455 activos con cita, 374 activos, 270 en riesgo y 1.937 inactivos (pacientes con al menos
  una atención desde ago-2025).
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** migración 035.

#### [PAC-05] Perfil de los pacientes atendidos
- **Pregunta:** ¿a quién atendemos? / Gerencia, marketing / Pacientes.
- **Métrica:** distribución por rango de edad, régimen, administradora y modalidad, de los pacientes atendidos
  en el período.
- **Visual:** barras por dimensión. Sin pirámides ni tortas.
- **Prioridad:** media · **Esfuerzo:** S.

### 3.6 Chatbot

#### [CHB-01] Conversión del bot por trámite
- **Pregunta:** ¿de cada 100 personas que empiezan a agendar, cuántas terminan con cita? / Gerencia / Chatbot.
- **Métrica:** sesiones cuyo `primer_flujo` es agendar, cancelar o reprogramar y terminan con el
  `resultado_negocio` correspondiente, divididas entre las sesiones que entraron a ese flujo.
- **Fuente:** `bi.fact_sesiones`.
- **Disponibilidad:** desde ago-2025, con resultado más fiable desde el 1-oct (v2).
- **Visual:** KPI por trámite con el embudo actual debajo.
- **Valor medido:** agendar ≈ 14-16 citas creadas al mes frente a ~1.000 eventos del flujo en ago-sep 2026.
  Es una conversión muy baja, explicada en parte por el bug de registro de pacientes nuevos (documentado en
  MEMORY, 0 de 50 desde 2025-09).
- **Prioridad:** alta · **Esfuerzo:** S.

#### [CHB-02] Demanda que el bot no convierte
- **Pregunta:** ¿cuánta gente consultó fechas y no agendó? ¿De qué especialidad? / Gerencia, marketing /
  Chatbot.
- **Métrica:** sesiones que llegaron a `agendar.s08_fechas` o `s10_selecciona_hora` sin `cita_creada`, por
  especialidad (`meta_especialidad`) y tipo de cita.
- **Fuente:** `bi.fact_eventos`, `bi.fact_sesiones`.
- **Disponibilidad:** pasos v2 desde el 1-oct-2026. Legacy aproximado por `metadata.step`
  (`consulta_fechas_disponibles`: 165 en ago-oct).
- **Visual:** barras por especialidad.
- **Prioridad:** media · **Esfuerzo:** S.

#### [CHB-03] Mensajes que el bot no entendió
- **Pregunta:** ¿qué tan seguido el bot no entiende? / Analista / Chatbot.
- **Métrica:** `msg_no_entendido` ÷ mensajes entrantes, por día y por paso donde ocurrió. Sin texto (no se
  guarda).
- **Disponibilidad:** desde el 1-oct-2026 (33 eventos).
- **Visual:** línea de tasa y barras por paso.
- **Prioridad:** media · **Esfuerzo:** S.

#### [CHB-04] Horas pico y fuera de horario
- **Pregunta:** ¿cuándo escriben los pacientes? / Gerencia / Chatbot.
- **Métrica:** el mapa de calor actual + % fuera del horario de recepción + derivaciones a agente fuera de
  horario (`fuera_horario`).
- **Valor medido:** 18 % fuera de horario; 321 conversaciones derivadas `fuera_horario` en el histórico.
- **Prioridad:** media · **Esfuerzo:** S.

#### [CHB-05] Qué información consultan ("Conocer la IPS")
- **Pregunta:** ¿qué quieren saber antes de agendar (tarifas, convenios, ubicación)? / Marketing / Chatbot.
- **Métrica:** sesiones por paso `conocer_ips.*`.
- **Valor medido:** volumen bajo (13 eventos en ago-sep 2026). Tiene más valor como señal que como KPI.
- **Prioridad:** baja · **Esfuerzo:** S.

#### [CHB-06] Duración de las gestiones exitosas
- **Pregunta:** ¿cuánto tarda alguien en agendar o cancelar con el bot? / Analista / Chatbot.
- **Métrica:** mediana de `duracion_min` de las sesiones completadas con resultado, por trámite.
- **Disponibilidad:** solo sesiones no backfill (desde el 1-oct-2026).
- **Prioridad:** baja · **Esfuerzo:** S.

### 3.7 Lista de espera

#### [LE-01] Embudo de la lista de espera
- **Pregunta:** ¿cuántos cupos liberados terminaron en una cita atendida? / Gerencia / Lista de espera.
- **Métrica:** cancelaciones con anticipación de 3 días o más (AGE-03) → cupos detectados → con oferta →
  aceptados → la cita recolocada se atendió.
- **Fuente:** `cupos_liberados`, `ofertas_cupo` (ya visibles para el panel); asistencia de
  `bi.fact_citas.movida_desde_cita_id`.
- **Disponibilidad:** pruebas desde el 1-oct-2026. Producción, cuando se active `LISTA_ESPERA_CASCADA_ENABLED`.
- **Visual:** embudo horizontal. Con menos de 20 cupos, mostrar los números en una tabla y la leyenda "Fase
  inicial".
- **Valor medido** (pruebas): 7 cupos, 6 con fila, 4 ofertas enviadas, 1 aceptada y 2 citas movidas.
- **Prioridad:** alta · **Esfuerzo:** S.

#### [LE-02] Horas recuperadas y tiempo hasta recolocar
- **Pregunta:** ¿cuántas horas de consulta salvó la lista? / Gerencia / Lista de espera y Resumen.
- **Métrica:**
  - horas recuperadas = Σ (`hora_final` − `hora_cita`) de los cupos en estado `asignado`;
  - tasa de recolocación = asignados ÷ cupos detectados;
  - tiempo = `asignado_at` − `detectado_at` (mediana).
- **Fuente:** `cupos_liberados`.
- **Visual:** KPI con delta y una línea de horas recuperadas al mes.
- **Prioridad:** alta · **Esfuerzo:** S.

#### [LE-03] Por qué no se recoloca un cupo
- **Pregunta:** ¿falta demanda en la lista o falla la cascada? / Gerencia, analista / Lista de espera.
- **Métrica:** cupos cerrados por `motivo_cierre` (`fila_agotada`, `sin_candidatos`, escalado a humano) y
  ofertas por estado (expirada, rechazada, error).
- **Valor medido:** 5 `fila_agotada`, 1 `sin_candidatos`; ofertas: 3 expiradas, 1 con error.
- **Visual:** barras.
- **Prioridad:** media · **Esfuerzo:** S.

#### [LE-04] Invitaciones a la lista (regularización y continua)
- **Pregunta:** ¿cuántos pacientes aceptan entrar en la lista cuando se les invita? / Gerencia, marketing /
  Lista de espera.
- **Métrica:**
  - por tipo de campaña: invitaciones enviadas, aceptadas, rechazadas, sin respuesta y con error;
  - tasa de aceptación;
  - por ejecución: evaluadas, elegibles, excluidas por motivo (JSON `excluidas`) y pendientes de regularización.
- **Fuente:** `invitaciones_lista_espera`, `ejecuciones_invitacion_lista_espera` (ya visibles).
- **Disponibilidad:** 0 filas. Llega con `LISTA_ESPERA_INVITACION_ENABLED`.
- **Visual:** barras apiladas por ejecución y KPI de la tasa de aceptación. Mientras no haya filas: "Sin datos
  aún: se activa con la campaña de invitación".
- **Prioridad:** alta · **Esfuerzo:** S.

#### [LE-05] Tamaño de la lista frente a los cupos que se liberan, por profesional
- **Pregunta:** ¿hay suficientes inscritos donde se liberan cupos? / Gerencia / Lista de espera.
- **Métrica:** inscripciones activas por profesional frente a cancelaciones recolocables de ese profesional en
  los últimos 30 días.
- **Visual:** gráfico de puntos (x = cupos liberados, y = inscritos activos), un punto por profesional.
- **Prioridad:** media · **Esfuerzo:** S · **Dependencias:** AGE-03.

#### [LE-06] Asistencia de las citas recolocadas
- **Pregunta:** ¿el paciente que adelanta su cita asiste? / Gerencia / Lista de espera.
- **Métrica:** asistencia de las citas con `movida_desde_cita_id` frente al promedio.
- **Disponibilidad:** necesita volumen (al menos 30 citas recolocadas).
- **Prioridad:** baja · **Esfuerzo:** S.

### 3.8 Marketing (pantalla nueva o sección dentro de Pacientes)

#### [MKT-01] Alcance de WhatsApp
- **Pregunta:** ¿a cuántas personas llegamos, y cuántas son alcanzables? / Marketing / Marketing.
- **Métrica:** personas únicas contactadas al mes (`telefono_norm` distintos con envíos que llegaron),
  % de pacientes con teléfono válido y % que respondió alguna vez.
- **Fuente:** `bi.fact_envios`, `bi.dim_contacto`.
- **Visual:** KPIs y una línea mensual.
- **Prioridad:** media · **Esfuerzo:** S.

#### [MKT-02] Segmentos para recuperar
- **Pregunta:** ¿a quién conviene invitar a volver? / Marketing / Marketing.
- **Métrica:** pacientes en riesgo o inactivos (PAC-04) por especialidad, último profesional y convenio,
  excluyendo a los contactados por `recuperacion` en los últimos 30 días.
- **Visual:** tabla con conteos y exportación con identidad (solo roles marketing y analista).
- **Cautela:** en salud mental, recontactar exige cuidado. Validar con la IPS el texto y la frecuencia.
- **Prioridad:** media · **Esfuerzo:** M · **Dependencias:** `bi.v_paciente_ciclo`.

#### [MKT-03] Captación por canal
- **Pregunta:** ¿cuántos pacientes nuevos llegan por el bot frente a recepción? / Marketing, gerencia /
  Marketing.
- **Métrica:** pacientes nuevos cuya primera cita se creó en una sesión del bot con `cita_creada`, frente al
  resto.
- **Fuente:** `bi.fact_sesiones` + `bi.v_paciente_ciclo`.
- **Disponibilidad:** pobre hoy (el bot casi no crea pacientes nuevos, CHB-01). Valdrá cuando se corrija el
  registro.
- **Prioridad:** baja · **Esfuerzo:** M.

### 3.9 Estado del sistema

#### [SIS-01] Alertas tempranas
- **Pregunta:** ¿hay algo roto ahora mismo? / Analista, gerencia / Estado del sistema (y un banner rojo en todas
  las pantallas).
- **Métrica:** `bi.v_alertas_operativas`, una fila por alerta activa.

  | Alerta | Regla | Severidad |
  |---|---|---|
  | A1 `campana_no_corrio` | campaña programada sin ejecución hoy después de su hora + 30 min (`daily` solo L-S) | alta |
  | A2 `campana_sin_envios` | ejecución de hoy con procesadas > 0 y exitosos = 0 | alta |
  | A3 `fallo_envio_alto` | hoy o ayer, > 20 % de envíos fallidos con al menos 20 envíos; ≥ 50 % = alta | media/alta |
  | A4 `scraper_sin_actualizar` | L-S, 09:00-21:00, más de 3 h sin crear ni actualizar citas | alta |
  | A5 `bot_sin_conversaciones` | día hábil, después de las 12:00, 0 sesiones | media |
  | A6 `errores_bot` | más de 10 eventos de error en el día | media |
- **Fuente:** `bi.v_salud_diaria` + `bi.v_campana_ejecuciones` (nuevas).
- **Disponibilidad:** inmediata.
- **Visual:**
  - banner fijo arriba ("2 alertas activas") en todas las pantallas;
  - en Estado del sistema, una tarjeta por alerta con el valor, el umbral y "desde cuándo".
- **Notificación:** el panel es de solo lectura y nadie lo mira a diario. Propuesta (Oleada 2): un job del
  contenedor `cron` de proyecto-ips que, cada hora de 07 a 20, consulta la vista con un rol de solo lectura y,
  si hay alertas nuevas, envía un correo, o un WhatsApp con una plantilla de utilidad aprobada (el texto libre
  no llega fuera de la ventana de 24 h), a German y a un responsable de la IPS. Un estado mínimo evita repetir
  la misma alerta.
- **Valor medido:**
  - hoy activa: A2 (`execute` procesó 68 citas y envió 0);
  - en retrospectiva, A3 habría saltado el 1-abr-2026 (100 % de fallo), A5 en los primeros días hábiles de abril y A4 el 30-may: el
    incidente se habría detectado en horas, no en meses.
- **Prioridad:** alta · **Esfuerzo:** M · **Dependencias:** migración 035; job de notificación aparte.

#### [SIS-02] Serie diaria de salud de los datos
- **Pregunta:** ¿cuándo dejó de llegar algo? / Analista / Estado del sistema.
- **Métrica:** por día: envíos, % de fallo, sesiones, citas registradas y actualizadas, eventos de error.
- **Fuente:** `bi.v_salud_diaria`.
- **Visual:** small multiples (5 líneas pequeñas, mismo eje x, cada una con su eje y) con las franjas de
  incidente. Es el gráfico que hubiera mostrado el hueco de abril a julio a simple vista.
- **Prioridad:** alta · **Esfuerzo:** S.

#### [SIS-03] Cobertura de la trazabilidad
- **Pregunta:** ¿qué tan completos son los eventos nuevos? / Analista / Estado del sistema.
- **Métrica:**
  - % de eventos v2 frente a legacy;
  - `paciente_resolucion` (documento, teléfono único, teléfono ambiguo, no resuelto);
  - envíos con `wa_message_id`;
  - estados de Meta sin envío asociado.
- **Valor medido:** eventos v2 desde el 1-oct: 4.498 `telefono_ambiguo` frente a 782 por documento (la mayoría
  son `wa_estado`, sin paciente).
- **Prioridad:** baja · **Esfuerzo:** S.

---

## 4. Datos que van a llegar y cómo se activan en el panel

| Fuente o bandera | Estado hoy | Habilita | Datos útiles desde | Mientras tanto |
|---|---|---|---|---|
| Backfill de trazabilidad (1-3 oct) | Pendiente | Envíos y estados de Meta de esos 3 días (D7) | Al correrlo | Incidente `trazabilidad` abierto en TR-01 |
| `TRAZABILIDAD_V2_ENABLED=true` | Activa desde el 4-oct | Embudos por paso, duración de sesiones, mensajes no entendidos, ejecuciones v2 | ~4 semanas para comparar | Mostrar "datos desde" (TR-04) |
| Estados de Meta en vivo | Activos desde el 30-sep | Entregado y leído (CAM-02, CAM-06) | ~2 semanas | Ocultar las etapas sin datos |
| Historial del scraper | Desde el 3-oct | Anticipación de cancelación (AGE-03), insumo de LE-01 | 50+ cancelaciones (~1 semana) | "Recolectando datos (n=…)" |
| `LISTA_ESPERA_OPTIN_ENABLED` | Apagada en `.env` local (en producción, las pruebas del 1 al 4-oct sugieren que estuvo encendida) | Inscripciones desde el bot (LE-01, LE-05) | Al activarse | Mostrar las inscripciones de prueba con la etiqueta "Prueba" o filtrarlas por fecha |
| `LISTA_ESPERA_INVITACION_ENABLED` + cron 9:40 / 10:10 | Apagada; tablas vacías | LE-04 completo | Primera ejecución | "Sin datos aún" |
| `LISTA_ESPERA_CASCADA_ENABLED` | Apagada (pruebas del 1 al 3-oct) | LE-01, LE-02, LE-03, LE-06 | ~1 mes, para tener 20+ cupos | Tabla de pruebas |
| `RECORDATORIOS_BOTONES_ENABLED` | Apagada (`respuestas_recordatorio` = 0) | CAM-10, mejora de CAM-03 (cancelación anticipada por botón) | Al activarse | Ocultar CAM-10 |
| `CRISIS_PROTOCOL_ENABLED` | Apagada | Conteo de `crisis_detectada` (solo gerencia, sin detalle) | Al activarse | No mostrar. Es un dato muy sensible: solo un conteo mensual, nunca en un listado |
| Corrección del maestro `equipo` (D4) | Pendiente | PRO-01 para psiquiatría y neuropsicología | Al corregirlo | Nota "Sin horario cargado" |
| Festivos 2026 (D10) | Incompletos | Capacidad exacta | Al completarlos | Nota en PRO-01 |

Regla general en el panel: si una tarjeta no tiene datos en su fuente, muestra "Sin datos aún" y qué la activa
(una línea), en vez de ceros, que se leerían como "nadie lo usa".

---

## 5. Vistas `bi` nuevas propuestas (migración 035)

Siguiente número libre: **035**. Todo el SQL de abajo fue probado contra producción en solo lectura: cada
cuerpo de vista se ejecutó como subconsulta (con la tabla `incidentes_datos` simulada) y produjo las cifras
citadas en este documento. Tiempos: las 7 consultas de prueba juntas
tardaron unos 28 s por SSH. Las más pesadas son `bi.v_cita_contacto` (unos 2-3 s) y
`bi.v_recuperacion_resultado` (varios segundos). El panel debe leerlas filtradas por fecha y con su caché de
60 s. Si el volumen crece, conviene materializarlas y refrescarlas cada noche.

| Vista | Propuestas que la usan |
|---|---|
| `incidentes_datos` (tabla) + `bi.dim_incidente` | TR-01, RES-01, todas las series |
| `bi.dim_cobertura` | TR-04 |
| `bi.fact_citas_enriquecida` | TR-02, TR-03, AGE-01 a 06, AGE-08, PRO-02, PAC-05 |
| `bi.v_cita_contacto` | CAM-02, CAM-03, CAM-04, RES-01 |
| `bi.v_campana_ejecuciones` | CAM-07, SIS-01 |
| `bi.v_capacidad_profesional_dia` | PRO-01, PRO-03, AGE-09, RES-01 |
| `bi.v_paciente_ciclo` | PAC-01, PAC-02, PAC-04, PRO-04, MKT-02, MKT-03 |
| `bi.v_recuperacion_resultado` | CAM-05 |
| `bi.v_salud_diaria` | SIS-01, SIS-02 |
| `bi.v_alertas_operativas` | SIS-01 |

Notas para quien la implemente:

- `panel_lectura` lee las vistas nuevas sin acceso a `horariosequipo`, `festivos`, `chat_stats` ni
  `agenda_estado_historial`, porque las vistas corren con los permisos de su dueño. El `GRANT` del final cubre
  el caso de que las default privileges no apliquen al rol que corre la migración.
- La tabla `incidentes_datos` es la única escritura nueva. Se mantiene por SQL (como `parametros_trazabilidad`).
- `bi.v_alertas_operativas` copia la programación del cron: al cambiar `cron/crontab`, hay que actualizar el
  bloque `programacion`. Alternativa futura: una tabla `programacion_campanas`.
- Agregar las vistas al `DatabaseManager` como cualquier migración. Es idempotente (patrón de la 034).

```sql
-- Migración 035 (propuesta): vistas bi para el catálogo de analítica del panel.
-- Contrato: panel-ips/docs/catalogo-analitica.md, sección 5.
-- Idempotente: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE VIEW, ON CONFLICT DO NOTHING.
-- Sin texto clínico: ninguna vista expone agenda.motivo_consulta.
-- Hora: las columnas *_at son UTC; las fechas de negocio se calculan en America/Bogota.

-- ============================================================
-- 1) Registro de incidentes de datos (configurable) y cobertura de cada métrica
-- ============================================================
CREATE TABLE IF NOT EXISTS incidentes_datos (
  incidente_id VARCHAR(8) PRIMARY KEY DEFAULT generate_short_id(),
  area VARCHAR(20) NOT NULL
    CHECK (area IN ('general', 'agenda', 'whatsapp', 'conversaciones', 'eventos', 'trazabilidad', 'lista_espera')),
  desde DATE NOT NULL,                 -- fecha Bogotá, inclusive
  hasta DATE,                          -- fecha Bogotá, inclusive; NULL = sigue abierto
  severidad VARCHAR(10) NOT NULL DEFAULT 'alta' CHECK (severidad IN ('alta', 'media', 'baja')),
  excluir_de_lineas_base BOOLEAN NOT NULL DEFAULT true,
  titulo VARCHAR(120) NOT NULL,
  descripcion TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_incidentes_datos_area_desde UNIQUE (area, desde)
);

COMMENT ON TABLE incidentes_datos IS 'Períodos con datos incompletos o anómalos. El panel los sombrea en los gráficos de tiempo y los excluye de líneas base y comparaciones cuando excluir_de_lineas_base = true. Se edita a mano (SQL) o desde una futura pantalla de administración.';

INSERT INTO incidentes_datos (area, desde, hasta, severidad, excluir_de_lineas_base, titulo, descripcion) VALUES
  ('general', DATE '2026-04-01', DATE '2026-08-05', 'alta', true,
   'Incidente abril-julio 2026: el bot no funcionó',
   'Envíos de WhatsApp rechazados desde el 1-abr, sin conversaciones desde el 1-abr, sin eventos del 22-jun al 6-ago y scraper detenido del 30-may al 5-ago.'),
  ('whatsapp', DATE '2026-04-01', DATE '2026-06-22', 'alta', true,
   'Envíos de campañas rechazados',
   '9.704 de 10.416 eventos de campaña con estado no_enviado / resultado error; en envios_whatsapp figuran como rechazado_api.'),
  ('conversaciones', DATE '2026-04-01', DATE '2026-08-06', 'alta', true,
   'Sin conversaciones registradas', 'No hay eventos chat_* entre el 1-abr 19:22 y el 6-ago 18:09 (Bogotá ~ UTC-5).'),
  ('eventos', DATE '2026-06-22', DATE '2026-08-06', 'alta', true,
   'Bot sin ningún evento', 'chat_stats no tiene filas en este rango.'),
  ('agenda', DATE '2026-05-30', DATE '2026-08-05', 'alta', true,
   'Scraper detenido',
   'No se registraron citas nuevas; las citas de junio quedaron en Pendiente/Confirmado y las de julio se capturaron parcialmente.'),
  ('trazabilidad', DATE '2026-10-01', DATE '2026-10-03', 'media', true,
   'envios_whatsapp sin filas',
   'El bot corría una versión que solo escribía eventos legacy. Se cierra al correr el backfill de trazabilidad.')
ON CONFLICT (area, desde) DO NOTHING;

CREATE OR REPLACE VIEW bi.dim_incidente AS
SELECT incidente_id, area, desde, COALESCE(hasta, (NOW() AT TIME ZONE 'America/Bogota')::date) AS hasta,
       (hasta IS NULL) AS abierto, severidad, excluir_de_lineas_base, titulo, descripcion
FROM incidentes_datos;

-- Desde cuándo es confiable cada métrica (el panel muestra "datos desde ..." junto al título).
CREATE OR REPLACE VIEW bi.dim_cobertura AS
SELECT * FROM (VALUES
  ('citas',                 DATE '2025-08-02', 'Agenda capturada por el scraper desde Globho (ventana de ~30 días hacia adelante).'),
  ('envios_aceptados',      DATE '2025-08-13', 'Envíos de campañas (backfill); antes de 2026-02 solo execute, recuperacion y conasistencia.'),
  ('envios_reminder_daily', DATE '2026-02-07', 'Campañas reminder (48 h) desde 2026-02-07 y daily (2 h) desde 2026-02-16.'),
  ('entrega_lectura',       DATE '2026-09-30', 'Estados de Meta (entregado, leído, fallido).'),
  ('historial_bot',         DATE '2026-09-30', 'Cambios de estado de citas hechos por el bot.'),
  ('historial_scraper',     DATE '2026-10-03', 'Cambios de estado de citas que trae el scraper desde Globho.'),
  ('eventos_v2',            DATE '2026-10-04', 'Trazabilidad v2 completa (TRAZABILIDAD_V2_ENABLED=true).'),
  ('lista_espera',          DATE '2026-10-01', 'Inscripciones, cupos y ofertas (pruebas desde 2026-10-01).'),
  ('invitaciones',          DATE '2026-10-04', 'Invitaciones a la lista de espera (migración 034; sin filas aún).')
) AS t(metrica, desde, nota);

-- ============================================================
-- 2) Citas enriquecidas: tipo de servicio, modalidad, anticipación, cancelación
-- ============================================================
CREATE OR REPLACE VIEW bi.fact_citas_enriquecida AS
WITH base AS (
  SELECT a.*,
         upper(translate(COALESCE(a.catalogo, ''), 'ÁÉÍÓÚáéíóú', 'AEIOUAEIOU')) AS cat_norm,
         (a.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') AS created_bog
  FROM agenda a
),
cancel AS (
  SELECT DISTINCT ON (h.agenda_id) h.agenda_id, h.cambiado_at, h.origen
  FROM agenda_estado_historial h
  WHERE h.estado_nuevo IN ('Cancelado', 'Anulado')
  ORDER BY h.agenda_id, h.cambiado_at
)
SELECT
  b.agenda_id,
  b.agenda_id_externa,
  b.paciente_id,
  b.profesional_id,
  regexp_replace(trim(b.profesional), '\s+', ' ', 'g') AS profesional_nombre,
  b.especialidad,
  b.fecha_cita,
  b.hora_cita,
  b.hora_final,
  (b.fecha_cita + b.hora_cita) AS inicio_cita_bogota,
  b.estado_agenda,
  CASE
    WHEN b.estado_agenda = 'Asistio' THEN 'asistio'
    WHEN b.estado_agenda = 'No Asistio' THEN 'no_asistio'
    WHEN b.estado_agenda IN ('Cancelado', 'Anulado') THEN 'cancelada'
    WHEN b.estado_agenda = 'Reprogramar' THEN 'reprogramada'
    WHEN b.estado_agenda IN ('Pendiente', 'Confirmado')
         AND b.fecha_cita < (NOW() AT TIME ZONE 'America/Bogota')::date THEN 'sin_cierre'
    WHEN b.estado_agenda IN ('Pendiente', 'Confirmado') THEN 'programada'
    ELSE 'otro'
  END AS grupo_estado,
  CASE
    WHEN b.cat_norm = '' OR b.cat_norm LIKE 'REUNION%' OR b.cat_norm LIKE 'GASTOS%' THEN 'administrativa'
    WHEN b.cat_norm LIKE 'INTERVENCION EN CRISIS%' THEN 'crisis'
    WHEN b.cat_norm LIKE '%PRIMERA VEZ%' THEN 'primera_vez'
    WHEN b.cat_norm LIKE '%PSICOTERAPIA%' THEN 'psicoterapia'
    WHEN b.cat_norm LIKE '%REHABILITACION%' THEN 'rehabilitacion'
    WHEN b.cat_norm LIKE '%PRUEBA%' OR b.cat_norm LIKE 'INFORME%' OR b.cat_norm LIKE '%VALORACION%'
         OR b.cat_norm LIKE 'PAQUETE DE NEUROPSICOLOGIA%' OR b.cat_norm LIKE 'EVALUACION%' THEN 'evaluacion'
    WHEN b.cat_norm LIKE '%CONTROL%' OR b.cat_norm LIKE '%SEGUIMIENTO%' OR b.cat_norm LIKE 'PAQUETE (10)%' THEN 'control'
    WHEN b.cat_norm LIKE 'TALLER%' OR b.cat_norm LIKE 'PROGRAMA%' THEN 'empresarial'
    ELSE 'otro'
  END AS tipo_servicio,
  NOT (b.cat_norm = '' OR b.cat_norm LIKE 'REUNION%' OR b.cat_norm LIKE 'GASTOS%') AS es_cita_paciente,
  b.cat_norm AS catalogo_normalizado,
  b.codigo_catalogo,
  CASE b.tipo_cita WHEN 1 THEN 'presencial' WHEN 4 THEN 'virtual' ELSE 'sin_dato' END AS modalidad,
  CASE WHEN COALESCE(NULLIF(trim(b.administradora), ''), 'Particular') = 'Particular' THEN 'particular' ELSE 'convenio' END AS tipo_pago,
  COALESCE(NULLIF(trim(b.administradora), ''), 'Particular') AS administradora,
  b.regimen,
  b.edad_paciente,
  CASE
    WHEN b.edad_paciente IS NULL THEN 'sin_dato'
    WHEN b.edad_paciente < 12 THEN '0-11'
    WHEN b.edad_paciente < 18 THEN '12-17'
    WHEN b.edad_paciente < 30 THEN '18-29'
    WHEN b.edad_paciente < 45 THEN '30-44'
    WHEN b.edad_paciente < 60 THEN '45-59'
    ELSE '60+'
  END AS rango_edad,
  EXTRACT(HOUR FROM b.hora_cita)::int AS hora,
  CASE
    WHEN b.hora_cita < TIME '10:00' THEN '07-10'
    WHEN b.hora_cita < TIME '13:00' THEN '10-13'
    WHEN b.hora_cita < TIME '16:00' THEN '13-16'
    ELSE '16-19'
  END AS franja,
  EXTRACT(ISODOW FROM b.fecha_cita)::int AS dia_semana_iso,
  normalizar_telefono(b.telefono_paciente) AS telefono_norm,
  b.created_at,
  b.created_bog AS registrada_at_bogota,
  -- Proxy de "días entre la asignación y la cita": el scraper ve la cita la primera vez que entra en su
  -- ventana (~30 días). Negativo = la cita se registró después de ocurrir (recuperación tras una caída).
  (b.fecha_cita - b.created_bog::date) AS anticipacion_registro_dias,
  COALESCE(b.cancelada_at, c.cambiado_at) AS cancelada_at,
  (COALESCE(b.cancelada_at, c.cambiado_at) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') AS cancelada_at_bogota,
  COALESCE(b.origen_cancelacion, c.origen) AS origen_cancelacion,
  ROUND((EXTRACT(EPOCH FROM ((b.fecha_cita + b.hora_cita)
        - (COALESCE(b.cancelada_at, c.cambiado_at) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota'))) / 3600.0)::numeric, 1)
    AS anticipacion_cancelacion_h,
  b.movida_desde_cita_id,
  -- false si la fecha de la cita cae en un incidente de agenda (o 15 días antes: la ventana hacia atrás
  -- del scraper no alcanzó a cerrar esas citas).
  NOT EXISTS (
    SELECT 1 FROM incidentes_datos i
    WHERE i.area IN ('agenda', 'general') AND i.excluir_de_lineas_base
      AND b.fecha_cita BETWEEN i.desde - 15 AND COALESCE(i.hasta, (NOW() AT TIME ZONE 'America/Bogota')::date)
  ) AS periodo_confiable
FROM base b
LEFT JOIN cancel c ON c.agenda_id = b.agenda_id;

-- ============================================================
-- 3) Contacto por WhatsApp de cada cita (recordatorios 48 h / 24 h / 2 h)
-- ============================================================
-- Une cada envío de reminder/execute/daily a su cita: por agenda_id cuando existe (envíos nuevos y
-- daily) y, si no, por teléfono normalizado + cita entre el día del envío y 6 días después (backfill).
-- La ventana de 6 días cubre fines de semana y la anticipación real observada (execute: 1-4 días,
-- reminder: 2-6 días). Un teléfono compartido (padre con dos hijos) puede asignar un envío a ambas citas.
CREATE OR REPLACE VIEW bi.v_cita_contacto AS
WITH c AS (
  SELECT a.agenda_id, a.fecha_cita, normalizar_telefono(a.telefono_paciente) AS tel
  FROM agenda a
  WHERE a.fecha_cita >= DATE '2025-08-13'
),
m AS (
  SELECT c.agenda_id, e.envio_id, 'agenda_id'::text AS via
  FROM c JOIN envios_whatsapp e ON e.agenda_id = c.agenda_id
  WHERE e.campana IN ('reminder', 'execute', 'daily')
  UNION
  SELECT c.agenda_id, e.envio_id, 'telefono_fecha'::text
  FROM c
  JOIN envios_whatsapp e
    ON e.telefono_norm = c.tel
   AND e.aceptado_at >= (c.fecha_cita - 6)::timestamp + INTERVAL '5 hours'
   AND e.aceptado_at <  (c.fecha_cita + 1)::timestamp + INTERVAL '5 hours'
  WHERE e.agenda_id IS NULL AND e.campana IN ('reminder', 'execute', 'daily')
)
SELECT
  c.agenda_id,
  COUNT(e.envio_id) AS envios,
  COUNT(e.envio_id) FILTER (WHERE e.estado NOT IN ('rechazado_api', 'failed')) AS envios_ok,
  bool_or(e.campana = 'reminder' AND e.estado NOT IN ('rechazado_api', 'failed')) IS TRUE AS recibio_48h,
  bool_or(e.campana = 'execute'  AND e.estado NOT IN ('rechazado_api', 'failed')) IS TRUE AS recibio_24h,
  bool_or(e.campana = 'daily'    AND e.estado NOT IN ('rechazado_api', 'failed')) IS TRUE AS recibio_2h,
  bool_or(e.delivered_at IS NOT NULL OR e.read_at IS NOT NULL) IS TRUE AS alguno_entregado,
  bool_or(e.read_at IS NOT NULL) IS TRUE AS alguno_leido,
  bool_or(e.respuesta_tipo = 'confirmo') IS TRUE AS confirmo_por_whatsapp,
  bool_or(e.respondido_at IS NOT NULL) IS TRUE AS respondio,
  MIN(e.aceptado_at) AS primer_envio_at,
  bool_and(m.via = 'agenda_id') IS TRUE AS enlace_exacto,
  CASE
    WHEN bool_or(e.respuesta_tipo = 'confirmo') THEN 'confirmo_whatsapp'
    WHEN bool_or(e.estado NOT IN ('rechazado_api', 'failed')) THEN 'recibio_sin_confirmar'
    WHEN COUNT(e.envio_id) > 0 THEN 'envio_fallido'
    WHEN c.tel IS NULL THEN 'sin_telefono_valido'
    ELSE 'sin_recordatorio'
  END AS grupo_contacto
FROM c
LEFT JOIN m ON m.agenda_id = c.agenda_id
LEFT JOIN envios_whatsapp e ON e.envio_id = m.envio_id
GROUP BY c.agenda_id, c.tel;

-- ============================================================
-- 4) Ejecuciones de campaña (incluye las que procesaron citas pero no enviaron nada)
-- ============================================================
-- Fuente: filas resumen EJECUCION_* de chat_stats (legacy, desde 2025-08) y eventos v2
-- campana_ejecucion con resultado 'fin' (desde 2026-10-03). bi.fact_eventos excluye EJECUCION_*,
-- por eso hace falta esta vista.
CREATE OR REPLACE VIEW bi.v_campana_ejecuciones AS
SELECT DISTINCT ON (campana, date_trunc('second', fin_at)) *
FROM (
SELECT
  c.id AS evento_id,
  CASE WHEN c.tipo_evento = 'campana_ejecucion' THEN 'v2' ELSE 'legacy' END AS fuente,
  COALESCE(c.campana, CASE c.tipo_evento
    WHEN 'campahna_envio' THEN 'execute'
    WHEN 'campahna_recordatorio' THEN 'reminder'
    WHEN 'campahna_envio_cron' THEN 'daily'
    WHEN 'campahna_recuperacion_con_asistencia' THEN 'conasistencia'
    WHEN 'campahna_recuperacion_sin_asistencia' THEN 'recuperacion'
    WHEN 'campahna_envio_confirmados_24hrs' THEN 'execute'
  END) AS campana,
  c.fecha_hora AS fin_at,
  (c.fecha_hora AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') AS fin_at_bogota,
  (c.fecha_hora AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha_bogota,
  c.metadata ->> 'fecha_campahna' AS fecha_objetivo,
  c.metadata ->> 'origen' AS origen,
  COALESCE(NULLIF(c.metadata ->> 'total', ''), NULLIF(c.metadata ->> 'total_procesados', ''))::int AS procesadas,
  COALESCE(NULLIF(c.metadata ->> 'exitosos', ''), NULLIF(c.metadata ->> 'envios_exitosos', ''))::int AS exitosos,
  COALESCE(NULLIF(c.metadata ->> 'errores', ''), NULLIF(c.metadata ->> 'envios_errores', ''))::int AS errores
FROM chat_stats c
WHERE (c.id_usuario LIKE 'EJECUCION%' AND c.tipo_evento LIKE 'campahna%')
   OR (c.tipo_evento = 'campana_ejecucion' AND c.resultado = 'fin')
) t
-- Desde el 2026-10-04 el bot escribe el resumen legacy y el v2 en el mismo segundo: se deja el v2.
ORDER BY campana, date_trunc('second', fin_at), (fuente = 'v2') DESC;

-- ============================================================
-- 5) Capacidad y ocupación por profesional y día
-- ============================================================
-- horariosequipo guarda el horario VIGENTE (sin historial): solo se usa desde 2026-08-06 y hasta 30 días
-- hacia adelante. Profesionales que no están en equipo (≈14 % de las citas) no tienen capacidad calculable.
CREATE OR REPLACE VIEW bi.v_capacidad_profesional_dia AS
WITH cap AS (
  SELECT
    h.profesionalid AS profesional_id,
    f.fecha,
    COALESCE(array_length(string_to_array(NULLIF(trim(
      CASE f.dia_semana_iso
        WHEN 1 THEN h.lunes WHEN 2 THEN h.martes WHEN 3 THEN h.miercoles WHEN 4 THEN h.jueves
        WHEN 5 THEN h.viernes WHEN 6 THEN h.sabado ELSE h.domingo
      END), ''), ','), 1), 0) AS cupos_ofrecidos
  FROM horariosequipo h
  JOIN equipo e ON e.equipo_id = h.profesionalid AND e.estado = 'Activo'
  CROSS JOIN bi.dim_fecha f
  WHERE NOT f.es_festivo
    AND f.fecha >= DATE '2026-08-06'
    AND f.fecha <= (NOW() AT TIME ZONE 'America/Bogota')::date + 30
),
uso AS (
  SELECT profesional_id, fecha_cita AS fecha,
         COUNT(*) FILTER (WHERE es_cita_paciente AND grupo_estado IN ('asistio', 'no_asistio', 'programada', 'sin_cierre')) AS citas_ocupan,
         COUNT(*) FILTER (WHERE es_cita_paciente AND grupo_estado = 'asistio') AS asistidas,
         COUNT(*) FILTER (WHERE es_cita_paciente AND grupo_estado = 'no_asistio') AS no_asistidas,
         COUNT(*) FILTER (WHERE es_cita_paciente AND grupo_estado IN ('cancelada', 'reprogramada')) AS liberadas,
         COUNT(*) FILTER (WHERE NOT es_cita_paciente AND grupo_estado IN ('asistio', 'programada', 'sin_cierre')) AS bloques_administrativos
  FROM bi.fact_citas_enriquecida
  WHERE profesional_id IS NOT NULL AND fecha_cita >= DATE '2026-08-06'
  GROUP BY 1, 2
)
SELECT
  cap.profesional_id,
  p.nombre_completo AS profesional,
  p.especialidad,
  cap.fecha,
  (cap.fecha < (NOW() AT TIME ZONE 'America/Bogota')::date) AS es_pasado,
  cap.cupos_ofrecidos,
  COALESCE(u.citas_ocupan, 0) AS citas_ocupan,
  COALESCE(u.asistidas, 0) AS asistidas,
  COALESCE(u.no_asistidas, 0) AS no_asistidas,
  COALESCE(u.liberadas, 0) AS liberadas,
  COALESCE(u.bloques_administrativos, 0) AS bloques_administrativos,
  GREATEST(cap.cupos_ofrecidos - COALESCE(u.citas_ocupan, 0) - COALESCE(u.bloques_administrativos, 0), 0) AS cupos_libres
FROM cap
LEFT JOIN uso u ON u.profesional_id = cap.profesional_id AND u.fecha = cap.fecha
LEFT JOIN bi.dim_profesional p ON p.profesional_id = cap.profesional_id
WHERE cap.cupos_ofrecidos > 0 OR COALESCE(u.citas_ocupan, 0) > 0;

-- ============================================================
-- 6) Ciclo de vida del paciente (cohortes, frecuencia, estado de actividad)
-- ============================================================
CREATE OR REPLACE VIEW bi.v_paciente_ciclo AS
WITH v AS (
  SELECT paciente_id, fecha_cita, tipo_servicio, especialidad, profesional_nombre,
         lag(fecha_cita) OVER (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita) AS anterior,
         MIN(fecha_cita) OVER (PARTITION BY paciente_id) AS primera
  FROM bi.fact_citas_enriquecida
  WHERE grupo_estado = 'asistio' AND es_cita_paciente AND paciente_id IS NOT NULL
),
p AS (
  SELECT
    paciente_id,
    MIN(fecha_cita) AS primera_atencion,
    MAX(fecha_cita) AS ultima_atencion,
    COUNT(*) AS atenciones,
    COUNT(*) FILTER (WHERE fecha_cita <= primera + 90) AS atenciones_90d,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY fecha_cita - anterior) FILTER (WHERE anterior IS NOT NULL AND fecha_cita > anterior) AS dias_entre_citas_mediana,
    (array_agg(especialidad ORDER BY fecha_cita))[1] AS especialidad_inicial,
    (array_agg(profesional_nombre ORDER BY fecha_cita))[1] AS profesional_inicial,
    (array_agg(tipo_servicio ORDER BY fecha_cita))[1] AS servicio_inicial
  FROM v
  GROUP BY paciente_id
),
prox AS (
  SELECT paciente_id, MIN(fecha_cita) AS proxima_cita
  FROM bi.fact_citas_enriquecida
  WHERE grupo_estado = 'programada' AND es_cita_paciente
  GROUP BY paciente_id
)
SELECT
  p.*,
  to_char(p.primera_atencion, 'YYYY-MM') AS cohorte_mes,
  -- Los pacientes cuya primera atención es de agosto de 2025 ya venían antes (inicio de los datos).
  (p.primera_atencion < DATE '2025-09-01') AS cohorte_censurada,
  x.proxima_cita,
  ((NOW() AT TIME ZONE 'America/Bogota')::date - p.ultima_atencion) AS dias_desde_ultima,
  CASE
    WHEN x.proxima_cita IS NOT NULL THEN 'activo_con_cita'
    WHEN (NOW() AT TIME ZONE 'America/Bogota')::date - p.ultima_atencion
         <= GREATEST(2 * COALESCE(p.dias_entre_citas_mediana, 14), 30) THEN 'activo'
    WHEN (NOW() AT TIME ZONE 'America/Bogota')::date - p.ultima_atencion <= 120 THEN 'en_riesgo'
    ELSE 'inactivo'
  END AS estado_actividad
FROM p
LEFT JOIN prox x ON x.paciente_id = p.paciente_id;

-- ============================================================
-- 7) Resultado de las campañas de recuperación y seguimiento
-- ============================================================
-- Un registro por envío de recuperacion/conasistencia. "Volvió" = el mismo teléfono tiene una cita de
-- paciente registrada (created_at) dentro de 30 / 60 días después del envío. Los envíos rechazados
-- (incidente abr-jun 2026) sirven de grupo de comparación: el paciente fue elegido pero no recibió nada.
CREATE OR REPLACE VIEW bi.v_recuperacion_resultado AS
WITH ag AS MATERIALIZED (
  SELECT normalizar_telefono(a.telefono_paciente) AS tel, a.created_at, a.fecha_cita, a.estado_agenda
  FROM agenda a
  WHERE upper(COALESCE(a.catalogo, '')) NOT LIKE 'REUNION%' AND COALESCE(a.catalogo, '') <> ''
)
SELECT
  e.envio_id,
  e.campana,
  e.telefono_norm,
  e.paciente_id,
  e.aceptado_at,
  (e.aceptado_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha_bogota,
  (e.estado NOT IN ('rechazado_api', 'failed')) AS llego,
  e.respuesta_tipo,
  EXISTS (SELECT 1 FROM ag WHERE ag.tel = e.telefono_norm
          AND ag.created_at BETWEEN e.aceptado_at AND e.aceptado_at + INTERVAL '30 days') AS volvio_30d,
  EXISTS (SELECT 1 FROM ag WHERE ag.tel = e.telefono_norm
          AND ag.created_at BETWEEN e.aceptado_at AND e.aceptado_at + INTERVAL '60 days') AS volvio_60d,
  EXISTS (SELECT 1 FROM ag WHERE ag.tel = e.telefono_norm AND ag.estado_agenda = 'Asistio'
          AND ag.created_at BETWEEN e.aceptado_at AND e.aceptado_at + INTERVAL '60 days') AS asistio_60d,
  (e.aceptado_at + INTERVAL '60 days' <= (NOW() AT TIME ZONE 'UTC')) AS ventana_cerrada
FROM envios_whatsapp e
WHERE e.campana IN ('recuperacion', 'conasistencia');

-- ============================================================
-- 8) Salud diaria de los datos (detecta huecos como el de abril-julio 2026)
-- ============================================================
CREATE OR REPLACE VIEW bi.v_salud_diaria AS
WITH dias AS (
  SELECT fecha, dia_semana_iso, es_festivo FROM bi.dim_fecha
  WHERE fecha BETWEEN DATE '2025-08-01' AND (NOW() AT TIME ZONE 'America/Bogota')::date
),
env AS (
  SELECT (aceptado_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha,
         COUNT(*) AS envios,
         COUNT(*) FILTER (WHERE estado IN ('rechazado_api', 'failed') OR failed_at IS NOT NULL) AS envios_fallidos
  FROM envios_whatsapp GROUP BY 1
),
ev AS (
  SELECT (fecha_hora AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha,
         COUNT(*) AS eventos_bot,
         COUNT(*) FILTER (WHERE tipo_evento LIKE 'campahna%' AND id_usuario NOT LIKE 'EJECUCION%') AS envios_legacy,
         COUNT(*) FILTER (WHERE tipo_evento LIKE 'campahna%' AND id_usuario NOT LIKE 'EJECUCION%'
                          AND (metadata ->> 'estado' = 'no_enviado' OR metadata ->> 'resultado' = 'error')) AS envios_legacy_error,
         COUNT(*) FILTER (WHERE tipo_evento ILIKE '%error%') AS eventos_error
  FROM chat_stats GROUP BY 1
),
ses AS (
  SELECT (inicio_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha, COUNT(*) AS sesiones
  FROM sesiones_chat GROUP BY 1
),
ag_c AS (
  SELECT (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha, COUNT(*) AS citas_registradas
  FROM agenda GROUP BY 1
),
ag_u AS (
  SELECT (updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha, COUNT(*) AS citas_actualizadas
  FROM agenda GROUP BY 1
)
SELECT
  d.fecha,
  d.dia_semana_iso,
  (d.dia_semana_iso BETWEEN 1 AND 6 AND NOT d.es_festivo) AS es_dia_habil,
  COALESCE(env.envios, 0) AS envios,
  COALESCE(env.envios_fallidos, 0) AS envios_fallidos,
  COALESCE(ev.envios_legacy, 0) AS envios_legacy,
  COALESCE(ev.envios_legacy_error, 0) AS envios_legacy_error,
  -- Tasa de fallo: la mayor de las dos fuentes (envios_whatsapp puede faltar, como el 1-3 oct 2026).
  -- Cada fuente cuenta solo si tiene al menos 20 envíos ese día (evita 2 de 3 = 67 %).
  ROUND(100.0 * GREATEST(
    CASE WHEN env.envios >= 20 THEN env.envios_fallidos::numeric / env.envios END,
    CASE WHEN ev.envios_legacy >= 20 THEN ev.envios_legacy_error::numeric / ev.envios_legacy END), 1) AS pct_fallo_envio,
  COALESCE(ev.eventos_bot, 0) AS eventos_bot,
  COALESCE(ev.eventos_error, 0) AS eventos_error,
  COALESCE(ses.sesiones, 0) AS sesiones,
  COALESCE(ag_c.citas_registradas, 0) AS citas_registradas,
  COALESCE(ag_u.citas_actualizadas, 0) AS citas_actualizadas,
  EXISTS (SELECT 1 FROM incidentes_datos i
          WHERE d.fecha BETWEEN i.desde AND COALESCE(i.hasta, d.fecha)) AS en_incidente
FROM dias d
LEFT JOIN env ON env.fecha = d.fecha
LEFT JOIN ev ON ev.fecha = d.fecha
LEFT JOIN ses ON ses.fecha = d.fecha
LEFT JOIN ag_c ON ag_c.fecha = d.fecha
LEFT JOIN ag_u ON ag_u.fecha = d.fecha;

-- ============================================================
-- 9) Alertas operativas (estado actual; el panel las muestra y un job puede notificarlas)
-- ============================================================
CREATE OR REPLACE VIEW bi.v_alertas_operativas AS
WITH ahora AS (
  SELECT (NOW() AT TIME ZONE 'America/Bogota') AS ts,
         (NOW() AT TIME ZONE 'America/Bogota')::date AS hoy,
         EXTRACT(ISODOW FROM NOW() AT TIME ZONE 'America/Bogota')::int AS dow
),
programacion AS (
  -- Copia del cron/crontab de proyecto-ips. Mantener sincronizado al cambiar el cron.
  SELECT * FROM (VALUES
    ('reminder',      TIME '07:40', false),
    ('execute',       TIME '08:10', false),
    ('recuperacion',  TIME '08:40', false),
    ('conasistencia', TIME '09:10', false),
    ('daily',         TIME '06:30', true)     -- true = solo lunes a sábado
  ) AS t(campana, hora, solo_habil)
),
ejec_hoy AS (
  SELECT campana, COUNT(*) AS ejecuciones, SUM(procesadas) AS procesadas, SUM(exitosos) AS exitosos, SUM(errores) AS errores
  FROM bi.v_campana_ejecuciones, ahora
  WHERE fecha_bogota = ahora.hoy
  GROUP BY campana
),
s AS (SELECT * FROM bi.v_salud_diaria, ahora WHERE fecha BETWEEN ahora.hoy - 1 AND ahora.hoy)
-- A1. Campaña programada que no corrió (30 min de gracia).
SELECT 'campana_no_corrio'::text AS alerta, 'alta'::text AS severidad, p.campana AS objeto,
       'No hay registro de ejecución hoy (programada ' || to_char(p.hora, 'HH24:MI') || ')' AS detalle,
       0::numeric AS valor, NULL::numeric AS umbral
FROM programacion p
CROSS JOIN ahora
LEFT JOIN LATERAL (SELECT 1 AS hay FROM ejec_hoy e WHERE e.campana = p.campana) x ON true
WHERE x.hay IS NULL AND ahora.ts::time > p.hora + INTERVAL '30 minutes'
  AND NOT (p.solo_habil AND ahora.dow = 7)
UNION ALL
-- A2. Campaña que procesó citas pero no envió nada (lo que pasó con execute el 4-oct-2026).
SELECT 'campana_sin_envios', 'alta', e.campana,
       'Procesó ' || e.procesadas || ' citas y envió 0', e.procesadas, 0
FROM ejec_hoy e WHERE e.procesadas > 0 AND COALESCE(e.exitosos, 0) = 0
UNION ALL
-- A3. Tasa de fallo de envío alta (hoy o ayer, con al menos 20 envíos).
SELECT 'fallo_envio_alto', CASE WHEN s.pct_fallo_envio >= 50 THEN 'alta' ELSE 'media' END, s.fecha::text,
       s.pct_fallo_envio || ' % de envíos fallidos', s.pct_fallo_envio, 20
FROM s WHERE s.pct_fallo_envio > 20
UNION ALL
-- A4. Scraper sin actualizar la agenda en horario hábil (cron del scraper: cada hora 6-20, L-S).
SELECT 'scraper_sin_actualizar', 'alta', 'agenda',
       'Última actualización de agenda hace ' || ROUND(EXTRACT(EPOCH FROM (ahora.ts - u.ultima)) / 3600.0, 1) || ' h',
       ROUND((EXTRACT(EPOCH FROM (ahora.ts - u.ultima)) / 3600.0)::numeric, 1), 3
FROM ahora,
     (SELECT MAX(GREATEST(created_at, updated_at)) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota' AS ultima FROM agenda) u
WHERE ahora.dow BETWEEN 1 AND 6 AND ahora.ts::time BETWEEN TIME '09:00' AND TIME '21:00'
  AND ahora.ts - u.ultima > INTERVAL '3 hours'
UNION ALL
-- A5. Bot sin conversaciones en un día hábil (después de las 12:00).
SELECT 'bot_sin_conversaciones', 'media', 'bot', 'Cero conversaciones iniciadas hoy', 0, 1
FROM ahora, s
WHERE s.fecha = ahora.hoy AND s.es_dia_habil AND ahora.ts::time > TIME '12:00' AND s.sesiones = 0
UNION ALL
-- A6. Picos de errores del bot/backend (más de 10 en el día).
SELECT 'errores_bot', 'media', s.fecha::text, s.eventos_error || ' eventos de error', s.eventos_error, 10
FROM s WHERE s.eventos_error > 10;

-- ============================================================
-- 10) Permisos del panel (por si las default privileges no cubren objetos creados por este rol)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'panel_lectura') THEN
    GRANT SELECT ON ALL TABLES IN SCHEMA bi TO panel_lectura;
  END IF;
END $$;
```

Pendiente para una 036 (trivial, cuando haya datos): `bi.fact_respuestas_recordatorio` (sobre
`respuestas_recordatorio`, para CAM-10) y `bi.fact_eventos_lista_espera` (sobre `eventos_lista_espera`, sin
`metadata` crudo).

---

## 6. Plan por oleadas

**Oleada 1. Corregir y aprovechar lo que ya existe** (sin migraciones; SQL en `panel-ips/server`):
TR-02, TR-03, RES-02, RES-03, CAM-01, CAM-06, CAM-08, AGE-01, AGE-02, AGE-04, AGE-05, AGE-06, AGE-07, AGE-08,
PRO-02, PAC-01, PAC-03, PAC-05, CHB-01, CHB-04, LE-01, LE-02, LE-03, LE-04. **24 propuestas.**

- La clasificación de servicios y el estado "sin cierre" van como fragmentos en `server/sql.ts` (igual que
  `GRUPO_ESTADO`).
- Para TR-01, mientras no exista la migración, una lista constante de incidentes en el frontend.
- Para SIS-01, ver la Oleada 2.

**Oleada 2. Migración 035 y lo que depende de ella:**
TR-01 (tabla), TR-04, RES-01, CAM-02, CAM-03, CAM-04, CAM-05, CAM-07, AGE-03, AGE-09, PRO-01, PRO-03, PRO-04,
PAC-02, PAC-04, CHB-02, CHB-03, MKT-01, MKT-02, SIS-01, SIS-02. **21 propuestas.**

- Orden sugerido: SIS-01/SIS-02/TR-01 (protegen todo lo demás) → CAM-03/CAM-07 → PRO-01 → PAC-02/PAC-04 →
  el resto.
- Incluye el job de notificación de alertas (fuera del panel).

**Oleada 3. Cuando haya datos o una decisión de German:**
RES-04, CAM-09, CAM-10, AGE-10, PRO-05, CHB-05, CHB-06, LE-05, LE-06, MKT-03, SIS-03. **11 propuestas.**

Total: **56 propuestas.**

---

## 7. Riesgos y advertencias de interpretación

1. **Correlación no es causalidad.** CAM-03 y CAM-05 comparan grupos que no son iguales: quien confirma ya
   tenía intención de ir, y quien no tiene recordatorio suele ser una cita del mismo día. Para medir el efecto
   real hace falta un grupo de control deliberado (por ejemplo, el 10 % de los elegibles sin mensaje durante
   unas semanas). Es una decisión ética y de negocio de German y de la IPS, no técnica.
2. **El incidente de abril a julio de 2026** contamina toda serie que lo cruce. Nunca compare "este trimestre
   contra el anterior" si el anterior lo incluye (TR-01). Junio de 2026 no tiene asistencia registrada; no es
   que nadie haya asistido.
3. **Cambios de definición en el tiempo:**
   - la trazabilidad v2 (1-oct) cuenta mensajes y pasos que antes no existían (D12);
   - entrega y lectura existen desde el 30-sep (D7);
   - `reminder` y `daily` existen desde feb-2026;
   - el historial de estados, desde el 30-sep (bot) y el 3-oct (scraper).
   Toda serie larga debe usar la definición más antigua disponible, o partirse con una marca.
4. **Reprogramar frente a Cancelado.** El aumento de cancelaciones desde mar-2026 coincide con la caída de
   "Reprogramar". Puede ser un cambio en cómo recepción registra en Globho. Mostrar ambos y su suma (D14).
5. **Censura en el inicio de los datos.** Los pacientes "nuevos" de ago-2025 incluyen a todos los que ya venían,
   y la anticipación de registro está topada en 30 días (D9).
6. **Enlace envío-cita inferido.** Para el histórico se usa teléfono + fecha. Los teléfonos compartidos (743)
   pueden atribuir un mensaje a dos citas. La columna `enlace_exacto` permite filtrar.
7. **Ocupación.** El horario es el actual, sin historial. Si un profesional cambió de horario en agosto, la
   ocupación de esas semanas sale mal. No sirve para el histórico anterior al 6-ago-2026.
8. **Muestras pequeñas.** La lista de espera (7 cupos) y los desgloses por profesional con poco volumen deben
   mostrar n y ocultarse por debajo de un umbral (20-30), para no sacar conclusiones de 3 casos.
9. **Evaluación de personas.** Las métricas por profesional (no-show, retención) dependen del tipo de paciente
   y del convenio. Presentarlas como contexto, no como un ranking de desempeño.
10. **Privacidad.** Las vistas exponen identidad completa (decisión P1). En las tablas exportables, limitar por
    rol (gerencia y analista). Nunca exponer `motivo_consulta`, ni el texto de los mensajes, ni detalle de
    crisis. AGE-10 y la futura alerta de crisis se muestran solo como conteos.
