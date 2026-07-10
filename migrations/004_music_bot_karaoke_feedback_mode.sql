-- Add columns to users table for feedback mode in the music bot database
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS karaoke_feedback_mode BOOLEAN DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS karaoke_feedback_started_at TIMESTAMP WITH TIME ZONE;
