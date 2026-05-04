import { prisma } from './prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// Resolve qual Aluno o user atual pode ver/escrever.
// - ALUNO: só o próprio
// - PROFESSOR: precisa de VinculoProfessor
// - NUTRICIONISTA: precisa de VinculoNutricionista com aceitoPeloAluno = true
export async function resolveAlunoAccess({ user, alunoId, write = false }) {
  if (user.role === 'ALUNO') {
    const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
    if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');
    if (alunoId && alunoId !== aluno.id) throw new HttpError(403, 'Acesso negado');
    return aluno;
  }

  if (!alunoId) throw new HttpError(400, 'alunoId obrigatório');

  if (user.role === 'PROFESSOR') {
    const prof = await prisma.professor.findUnique({ where: { userId: user.userId } });
    if (!prof) throw new HttpError(404, 'Perfil de professor não encontrado');
    const vinculo = await prisma.vinculoProfessor.findUnique({
      where: { alunoId_professorId: { alunoId, professorId: prof.id } },
    });
    if (!vinculo) throw new HttpError(403, 'Aluno não vinculado a este professor');
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return aluno;
  }

  if (user.role === 'NUTRICIONISTA') {
    if (write) throw new HttpError(403, 'Nutricionista é leitura apenas');
    const nutri = await prisma.nutricionista.findUnique({ where: { userId: user.userId } });
    if (!nutri) throw new HttpError(404, 'Perfil de nutricionista não encontrado');
    const vinculo = await prisma.vinculoNutricionista.findUnique({
      where: { alunoId_nutricionistaId: { alunoId, nutricionistaId: nutri.id } },
    });
    if (!vinculo || !vinculo.aceitoPeloAluno) {
      throw new HttpError(403, 'Aluno não compartilhou rotina com este nutricionista');
    }
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return aluno;
  }

  throw new HttpError(403, 'Acesso negado');
}
