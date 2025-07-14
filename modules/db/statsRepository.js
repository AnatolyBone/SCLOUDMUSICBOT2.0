import { query, supabase } from "./dbClient.js";

export async function getRegistrationsByDate() {
  const { data, error } = await supabase
    .from("users")
    .select("created_at")
    .not("created_at", "is", null);

  if (error) {
    console.error("Ошибка получения регистраций по дате:", error);
    return {};
  }

  const stats = {};
  data.forEach((row) => {
    const date = new Date(row.created_at).toISOString().split("T")[0];
    stats[date] = (stats[date] || 0) + 1;
  });
  return stats;
}

export async function getDownloadsByDate() {
  const { data, error } = await supabase
    .from("downloads_log")
    .select("downloaded_at");

  if (error) {
    console.error("Ошибка получения загрузок по дате:", error);
    return {};
  }

  const stats = {};
  data.forEach((row) => {
    const date = new Date(row.downloaded_at).toISOString().split("T")[0];
    stats[date] = (stats[date] || 0) + 1;
  });
  return stats;
}

export async function getActiveUsersByDate() {
  const { data, error } = await supabase
    .from("user_activity_log")
    .select("user_id, created_at");

  if (error) {
    console.error("Ошибка получения активных пользователей по дате:", error);
    return {};
  }

  const dailyActiveUsers = {};
  data.forEach((row) => {
    const date = new Date(row.created_at).toISOString().split("T")[0];
    if (!dailyActiveUsers[date]) {
      dailyActiveUsers[date] = new Set();
    }
    dailyActiveUsers[date].add(row.user_id);
  });

  const stats = {};
  for (const date in dailyActiveUsers) {
    stats[date] = dailyActiveUsers[date].size;
  }
  return stats;
}

export async function getUserActivityByDayHour() {
  const { data, error } = await supabase
    .from("user_activity_log")
    .select("created_at");

  if (error) {
    console.error("Ошибка получения активности по часам:", error);
    return {};
  }

  const activity = {};
  data.forEach((row) => {
    const date = new Date(row.created_at);
    const day = date.toISOString().split("T")[0];
    const hour = date.getHours();

    if (!activity[day]) {
      activity[day] = {};
    }
    activity[day][hour] = (activity[day][hour] || 0) + 1;
  });
  return activity;
}

export async function getExpiringUsersPaginated(limit, offset) {
  const { data, error } = await supabase
    .from("users")
    .select("id, first_name, username, premium_until")
    .not("premium_until", "is", null)
    .order("premium_until", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("Ошибка получения истекающих пользователей:", error);
    return [];
  }
  return data;
}

export async function getExpiringUsersCount() {
  const { count, error } = await supabase
    .from("users")
    .select("id", { count: "exact" })
    .not("premium_until", "is", null);

  if (error) {
    console.error("Ошибка получения количества истекающих пользователей:", error);
    return 0;
  }
  return count;
}

export async function getReferralSourcesStats() {
  const { data, error } = await supabase
    .from("users")
    .select("referral_source")
    .not("referral_source", "is", null);

  if (error) {
    console.error("Ошибка получения статистики по рефералам:", error);
    return [];
  }

  const stats = {};
  data.forEach((row) => {
    stats[row.referral_source] = (stats[row.referral_source] || 0) + 1;
  });

  return Object.entries(stats).map(([source, count]) => ({
    source,
    count,
  }));
}

export async function resetDailyStats() {
  try {
    // Сброс счетчика загрузок за день
    await query("UPDATE users SET downloads_today = 0");
    console.log("Ежедневная статистика загрузок сброшена.");

    // Удаление старых записей активности (например, старше 30 дней)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    await supabase
      .from("user_activity_log")
      .delete()
      .lt("created_at", cutoffDate.toISOString());
    console.log("Старые записи активности пользователей удалены.");
  } catch (e) {
    console.error("Ошибка при сбросе ежедневной статистики:", e);
  }
}

export async function getFunnelData(fromDate, toDate) {
  const { data, error } = await supabase.rpc("get_funnel_data", {
    start_date: fromDate,
    end_date: toDate,
  });

  if (error) {
    console.error("Ошибка получения данных воронки:", error);
    return {};
  }
  return data[0] || {};
}
