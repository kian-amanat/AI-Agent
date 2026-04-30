import * as authService from "../services/auth.service.js";

export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const result = await authService.login({ email, password });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function refreshToken(req, res, next) {
  try {
    const { refreshToken } = req.body || {};
    const result = await authService.refreshToken({ refreshToken });
    res.json(result);
  } catch (err) {
    next(err);
  }
}
