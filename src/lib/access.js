import { prisma } from './prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// ─────────────────────────────────────────────────────────────────────
// GUARDIÃO ÚNICO DE ACESSO A DADOS POR ALUNO
//
// Fonte da verdade. Toda rota/serviço que toca dados de um Aluno DEVE
// passar por aqui. Cópias locais em services foram apagadas no PR #4.1.
//
// REGRAS (não negociáveis):
//
//   ALUNO          → só os próprios dados.
//                    Se `alunoId` divergir do próprio → 403.
//
//   PROFESSOR      → exige VinculoProfessor com o aluno.
//                    Pode ler e escrever.
//
//   NUTRICIONISTA  → exige VinculoNutricionista com
//                    aceitoPeloAluno === true (LEITURA e ESCRITA).
//                    Sem aceite → 403, sem exceção.
//                    Escrita bloqueada por padrão. Para módulos onde
//                    o nutri tem domínio legítimo de escrita (Evolução
//                    Corporal — protocolos ISAK), passar
//                    `allowNutriWrite: true` explicitamente.
//
// Parâmetros:
//   user            → req.user (do JWT). Exige role + userId.
//   alunoId         → id do Aluno alvo. Obrigatório p/ PROF e NUTRI.
//                     Opcional p/ ALUNO (se vier, valida ownership).
//   write           → true em mutações. Combina com allowNutriWrite
//                     pra decidir o caso NUTRI.
//   allowNutriWrite → opt-in explícito p/ permitir escrita por nutri
//                     (somente onde o domínio justifica). Default false.
//
// Retorna: o registro `Aluno` resolvido (use `aluno.id` no resto da query).
// ─────────────────────────────────────────────────────────────────────

export async function resolveAlunoAccess({
  user,
  alunoId,
  write = false,
  allowNutriWrite = false,
}) {
  if (!user || !user.role || !user.userId) {
    throw new HttpError(401, 'Não autenticado');
  }

  // ── ALUNO ────────────────────────────────────────────────────────
  if (user.role === 'ALUNO') {
    const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
    if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');
    if (alunoId && alunoId !== aluno.id) {
      // 403 em vez de 404 — evita vazar existência de alunoId.
      throw new HttpError(403, 'Acesso negado');
    }
    return aluno;
  }

  if (!alunoId) {
    throw new HttpError(400, 'alunoId obrigatório');
  }

  // ── PROFESSOR ────────────────────────────────────────────────────
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

  // ── NUTRICIONISTA ────────────────────────────────────────────────
  if (user.role === 'NUTRICIONISTA') {
    // Secure-by-default: escrita só com opt-in explícito do módulo.
    if (write && !allowNutriWrite) {
      throw new HttpError(403, 'Nutricionista não pode escrever neste módulo');
    }

    const nutri = await prisma.nutricionista.findUnique({ where: { userId: user.userId } });
    if (!nutri) throw new HttpError(404, 'Perfil de nutricionista não encontrado');

    const vinculo = await prisma.vinculoNutricionista.findUnique({
      where: { alunoId_nutricionistaId: { alunoId, nutricionistaId: nutri.id } },
    });
    // ESTRITO: vínculo + aceitoPeloAluno === true para qualquer acesso.
    if (!vinculo || vinculo.aceitoPeloAluno !== true) {
      throw new HttpError(403, 'Aluno não compartilhou dados com este nutricionista');
    }

    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return aluno;
  }

  // Role desconhecida → fail closed.
  throw new HttpError(403, 'Role desconhecida');
}
