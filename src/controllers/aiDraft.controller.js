import { aiDraftTreinoRequestSchema } from '../schemas/aiDraft.schemas.js';
import { generateDraftTreino } from '../services/aiDraftTreino.service.js';

export async function postDraftTreino(req, res, next) {
  try {
    const { prompt, alunoId } = aiDraftTreinoRequestSchema.parse(req.body);
    const out = await generateDraftTreino({ user: req.user, prompt, alunoId });
    res.json(out);
  } catch (err) {
    next(err);
  }
}
