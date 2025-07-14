import { getUserById, updateUserField } from "../db/userRepository.js";

export async function handleReferralBonus(userId, referrerId) {
  // Логика начисления бонуса рефереру
  const referrer = await getUserById(referrerId);
  if (referrer && referrer.premium_limit >= 50) { // Реферер должен быть Plus или выше
    await updateUserField(referrerId, 'bonus_days', (referrer.bonus_days || 0) + 30);
    await updateUserField(referrerId, 'invited_count', (referrer.invited_count || 0) + 1);
    // Можно отправить уведомление рефереру
  }
}
