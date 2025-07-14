import { supabase } from "./dbClient.js";

export async function logEvent(userId, eventType, details = {}) {
  try {
    const { data, error } = await supabase
      .from("events_log")
      .insert([{ user_id: userId, event_type: eventType, details: details }]);

    if (error) {
      console.error("Ошибка логирования события:", error);
    }
    return data;
  } catch (e) {
    console.error("Исключение при логировании события:", e);
    return null;
  }
}

export async function logUserActivity(userId) {
  try {
    const { data, error } = await supabase
      .from("user_activity_log")
      .insert([{ user_id: userId }]);

    if (error) {
      console.error("Ошибка логирования активности пользователя:", error);
    }
    return data;
  } catch (e) {
    console.error("Исключение при логировании активности пользователя:", e);
    return null;
  }
}

export async function logDownload(userId, trackTitle, fileId) {
  try {
    const { data, error } = await supabase
      .from("downloads_log")
      .insert([{ user_id: userId, track_title: trackTitle, file_id: fileId }]);

    if (error) {
      console.error("Ошибка логирования загрузки:", error);
    }
    return data;
  } catch (e) {
    console.error("Исключение при логировании загрузки:", e);
    return null;
  }
}
