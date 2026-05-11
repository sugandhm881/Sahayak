require('dotenv').config();

module.exports = {
  SECRET_KEY: process.env.SECRET_KEY || 'fallback-secret-for-staging',
  CRON_SECRET: process.env.CRON_SECRET || '',
  MASTER_USERNAME: process.env.LOGIN_USER || 'admin',
  MASTER_PASSWORD: process.env.LOGIN_PASS || 'password',
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  EMAIL_HOST: process.env.EMAIL_HOST || 'smtp.gmail.com',
  EMAIL_PORT: parseInt(process.env.EMAIL_PORT || '587', 10),
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  UPI_ID: 'sugandh.mishra1@ybl',
  UPI_NAME: 'SM Tech',
  REPORT_HOUR_UTC: 16,
  NODE_ENV: process.env.NODE_ENV || 'development',
};
