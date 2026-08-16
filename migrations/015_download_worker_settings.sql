INSERT INTO public.app_settings (key, value) VALUES
  ('download_workers_total', '3'),
  ('download_workers_spotify', '1'),
  ('download_workers_soundcloud', '2'),
  ('download_workers_youtube', '0')
ON CONFLICT (key) DO NOTHING;
