import { registerSchema, loginSchema } from '../schemas/auth.schemas.js';
import { registerUser, loginUser, getMe } from '../services/auth.service.js';

export async function register(req, res, next) {
  try {
    const data = registerSchema.parse(req.body);
    const result = await registerUser(data);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const data = loginSchema.parse(req.body);
    const result = await loginUser(data);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    const user = await getMe(req.user.userId);
    res.json({ user });
  } catch (err) {
    next(err);
  }
}
