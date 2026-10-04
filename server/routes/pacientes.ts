import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { ErrorParametro, leerTexto } from '../params.js';

const ID = /^[A-Za-z0-9]{1,16}$/;

export default async function rutasPacientes(app: FastifyInstance) {
  // Búsqueda por documento exacto, por teléfono (últimos dígitos) o por nombre (mínimo 3 letras).
  app.get('/api/pacientes/buscar', async (req) => {
    const q = leerTexto(req.query as Record<string, unknown>, 'q', 80);
    if (!q || q.length < 3) throw new ErrorParametro('Escriba al menos 3 caracteres');
    const digitos = q.replace(/\D/g, '');
    const esNumero = digitos.length >= 5 && digitos.length === q.replace(/[\s+()-]/g, '').length;
    const filas = esNumero
      ? await query(
          `SELECT paciente_id, nombre_completo, tipo_documento, numero_documento, telefono_norm, edad, convenio
             FROM bi.dim_paciente
            WHERE numero_documento = $1 OR telefono_norm LIKE '%' || $1
            ORDER BY nombre_completo LIMIT 25`,
          [digitos],
        )
      : await query(
          `SELECT paciente_id, nombre_completo, tipo_documento, numero_documento, telefono_norm, edad, convenio
             FROM bi.dim_paciente
            WHERE nombre_completo ILIKE '%' || $1 || '%'
            ORDER BY nombre_completo LIMIT 25`,
          [q.replace(/[%_\\]/g, '')],
        );
    return { filas };
  });

  app.get('/api/pacientes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) throw new ErrorParametro('Identificador inválido');
    const paciente = await queryOne<{ telefono_norm: string | null }>(
      `SELECT paciente_id, nombre_completo, tipo_documento, numero_documento, telefono_norm, email, edad, rango_edad,
              convenio, administradora, regimen, created_at_bogota AS registrado
         FROM bi.dim_paciente WHERE paciente_id = $1`,
      [id],
    );
    if (!paciente) return reply.code(404).send({ error: 'Paciente no encontrado' });

    const [citas, timeline, listaEspera] = await Promise.all([
      query(
        `SELECT fecha_cita, hora_cita, estado_agenda, especialidad, profesional, tipo_consulta, tipo_atencion,
                administradora, origen_cancelacion
           FROM bi.fact_citas WHERE paciente_id = $1
          ORDER BY fecha_cita DESC, hora_cita DESC LIMIT 200`,
        [id],
      ),
      query(
        `SELECT ocurrido_at_bogota AS cuando, fuente, tipo, flujo, paso, resultado, campana, origen
           FROM bi.v_timeline_paciente
          WHERE paciente_id = $1 OR ($2::text IS NOT NULL AND telefono_norm = $2)
          ORDER BY ocurrido_at DESC NULLS LAST LIMIT 300`,
        [id, paciente.telefono_norm],
      ),
      query(
        `SELECT DISTINCT ON (lista_espera_id) lista_espera_id, especialidad, estado_inscripcion,
                inscripcion_created_at_bogota AS inscrito, ofertas_enviadas
           FROM bi.fact_lista_espera WHERE paciente_id = $1
          ORDER BY lista_espera_id, inscripcion_created_at DESC`,
        [id],
      ),
    ]);
    return { paciente, citas, timeline, listaEspera };
  });
}
