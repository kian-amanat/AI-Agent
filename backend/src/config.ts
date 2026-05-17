export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  jwtSecret: process.env.JWT_SECRET || 'changeme',
  bcryptSaltRounds: process.env.BCRYPT_SALT_ROUNDS ? Number(process.env.BCRYPT_SALT_ROUNDS) : 10,
  db: {
    url: process.env.DB_URL || './db.sqlite',
  },
};