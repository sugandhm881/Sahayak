const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

let supabase = null;
if (env.SUPABASE_URL && env.SUPABASE_KEY) {
  supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, {
    auth: { persistSession: false },
  });
} else {
  console.warn('No Supabase credentials found. DB calls will fail.');
}

module.exports = supabase;
