import { query, supabase } from "./dbClient.js";

export async function createUser(id, first_name, username) {
  try {
    const { data, error } = await supabase
      .from("users")
      .upsert(
        {
          id: id,
          first_name: first_name,
          username: username,
          last_active: new Date().toISOString(),
        },
        { onConflict: "id", ignoreDuplicates: false }
      )
      .select();

    if (error) {
      console.error("Ошибка создания/обновления пользователя:", error);
    }
    return data ? data[0] : null;
  } catch (e) {
    console.error("Исключение при создании/обновлении пользователя:", e);
    return null;
  }
}

export async function getUser(id) {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("*, premium_until")
      .eq("id", id)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 - это "No rows found", что нормально для нового пользователя
      console.error("Ошибка получения пользователя:", error);
    }
    return data;
  } catch (e) {
    console.error("Исключение при получении пользователя:", e);
    return null;
  }
}

export async function updateUserField(userId, field, value) {
  try {
    const updateData = { [field]: value };
    if (field !== "last_active") {
      updateData.last_active = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from("users")
      .update(updateData)
      .eq("id", userId)
      .select();

    if (error) {
      console.error(`Ошибка обновления поля ${field} для пользователя ${userId}:`, error);
    }
    return data ? data[0] : null;
  } catch (e) {
    console.error(`Исключение при обновлении поля ${field} для пользователя ${userId}:`, e);
    return null;
  }
}

export async function getAllUsers(includeInactive = false) {
  try {
    let query = supabase.from("users").select("*");

    if (!includeInactive) {
      const activeCutoff = new Date();
      activeCutoff.setDate(activeCutoff.getDate() - 30); // Активные за последние 30 дней
      query = query.gte("last_active", activeCutoff.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      console.error("Ошибка получения всех пользователей:", error);
      return [];
    }
    return data;
  } catch (e) {
    console.error("Исключение при получении всех пользователей:", e);
    return [];
  }
}

export async function getUserById(userId) {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("Ошибка получения пользователя по ID:", error);
    }
    return data;
  } catch (e) {
    console.error("Исключение при получении пользователя по ID:", e);
    return null;
  }
}

export async function markSubscribedBonusUsed(userId) {
  try {
    const { data, error } = await supabase
      .from("users")
      .update({ subscribed_bonus_used: true })
      .eq("id", userId)
      .select();

    if (error) {
      console.error("Ошибка отметки бонуса подписки:", error);
    }
    return data ? data[0] : null;
  } catch (e) {
    console.error("Исключение при отметке бонуса подписки:", e);
    return null;
  }
}

export async function setPremium(userId, limit, days) {
  try {
    const user = await getUser(userId);
    if (!user) {
      console.warn(`Пользователь ${userId} не найден для установки тарифа.`);
      return false;
    }

    let premiumUntil = user.premium_until ? new Date(user.premium_until) : new Date();
    if (premiumUntil < new Date()) {
      premiumUntil = new Date(); // Если срок истёк, начинаем с текущей даты
    }
    premiumUntil.setDate(premiumUntil.getDate() + days);

    const updateData = {
      premium_limit: limit,
      premium_until: premiumUntil.toISOString(),
    };

    // Проверка на акцию 1+1
    let bonusApplied = false;
    if (limit >= 50 && !user.promo_1plus1_used) {
      // Если пользователь покупает тариф Plus или выше и не использовал акцию
      const bonusUntil = new Date(premiumUntil);
      bonusUntil.setDate(bonusUntil.getDate() + days); // Добавляем ещё столько же дней
      updateData.premium_until = bonusUntil.toISOString();
      updateData.promo_1plus1_used = true;
      bonusApplied = true;
    }

    const { error } = await supabase
      .from("users")
      .update(updateData)
      .eq("id", userId);

    if (error) {
      console.error("Ошибка установки премиум-статуса:", error);
      return false;
    }
    return bonusApplied;
  } catch (e) {
    console.error("Исключение при установке премиум-статуса:", e);
    return false;
  }
}

export async function addOrUpdateUserInSupabase(id, first_name, username, referrerId = null) {
  try {
    const { data, error } = await supabase
      .from("users")
      .upsert(
        {
          id: id,
          first_name: first_name,
          username: username,
          last_active: new Date().toISOString(),
          referral_source: referrerId, // Сохраняем ID реферера
        },
        { onConflict: "id", ignoreDuplicates: false }
      )
      .select();

    if (error) {
      console.error("Ошибка addOrUpdateUserInSupabase:", error);
    }
    return data ? data[0] : null;
  } catch (e) {
    console.error("Исключение addOrUpdateUserInSupabase:", e);
    return null;
  }
}
