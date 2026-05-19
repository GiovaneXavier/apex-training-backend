import { aiProgressionRequestSchema } from '../schemas/aiProgression.schemas.js';
import { suggestProgression } from '../services/aiProgression.service.js';

export async function postExerciseProgression(req, res, next) {
  try {
    const { alunoId, exercicioNome, modalidade } = aiProgressionRequestSchema.parse(req.body);
    const out = await suggestProgression({
      user: req.user,
      alunoId,
      exercicioNome,
      modalidade,
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
}
