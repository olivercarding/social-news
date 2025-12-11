import { createClient } from '@supabase/supabase-js';

// Load secrets from environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  // This will throw an error if keys are missing during runtime
  throw new Error("Missing Supabase environment variables.");
}

// Create and export the Supabase client
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);