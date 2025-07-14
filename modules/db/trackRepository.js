import { query, supabase } from "./dbClient.js";

export async function saveTrackForUser(userId, trackTitle, fileId) {
  try {
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("tracks_today")
      .eq("id", userId)
      .single();

    if (userError) {
      console.error("Ошибка получения треков пользователя:", userError);
      return;
    }

    let tracksToday = userData.tracks_today || [];
    tracksToday.push({ title: trackTitle, fileId: fileId });

    const { error: updateError } = await supabase
      .from("users")
      .update({ tracks_today: tracksToday })
      .eq("id", userId);

    if (updateError) {
      console.error("Ошибка сохранения трека для пользователя:", updateError);
    }
  } catch (e) {
    console.error("Исключение при сохранении трека для пользователя:", e);
  }
}

export async function incrementDownloads(userId) {
  try {
    const { data, error } = await supabase.rpc("increment_downloads", {
      user_id_param: userId,
    });

    if (error) {
      console.error("Ошибка инкремента загрузок:", error);
    }
    return data;
  } catch (e) {
    console.error("Исключение при инкременте загрузок:", e);
    return null;
  }
}

export async function resetDailyLimitIfNeeded(userId) {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("last_download_date, premium_limit, downloads_today")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Ошибка получения данных пользователя для сброса лимита:", error);
      return;
    }

    if (!user) {
      console.warn(`Пользователь ${userId} не найден.`);
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const lastDownloadDate = user.last_download_date
      ? new Date(user.last_download_date).toISOString().split("T")[0]
      : null;

    if (lastDownloadDate !== today) {
      // Сбросить лимит, если это новый день
      const { error: updateError } = await supabase
        .from("users")
        .update({ downloads_today: 0, last_download_date: today })
        .eq("id", userId);

      if (updateError) {
        console.error("Ошибка сброса ежедневного лимита:", updateError);
      }
    }
  } catch (e) {
    console.error("Исключение при сбросе ежедневного лимита:", e);
  }
}
