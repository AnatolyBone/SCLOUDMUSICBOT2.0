import { ADMIN_ID } from "../config/env.js";
import { getUserById } from "../db/userRepository.js";

export async function requireAuth(req, res, next) {
  if (req.session.authenticated && req.session.userId === ADMIN_ID) {
    return next();
  }
  res.redirect("/admin");
}

export async function setupAuthMiddleware(app) {
  app.use(async (req, res, next) => {
    if (req.session.authenticated && req.session.userId === ADMIN_ID) {
      try {
        const user = await getUserById(req.session.userId);
        if (user) {
          req.user = user;
          res.locals.user = user;  // важно для ejs partials
        } else {
          res.locals.user = null;
        }
      } catch (e) {
        console.error("Ошибка загрузки пользователя для шаблонов:", e);
        res.locals.user = null;
      }
    } else {
      res.locals.user = null;
    }
    next();
  });
}
