const rateLimit = require('express-rate-limit');

const defaultLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const dayLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const perMinute = (max) => rateLimit({ windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false });

module.exports = { defaultLimiter, dayLimiter, loginLimiter, perMinute };
