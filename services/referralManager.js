// services/referralManager.js (улучшенная версия)

import { pool, getUser, logUserAction } from '../db.js';
import { bot } from '../bot.js';
import { grantReferralBonus, REFERRAL_BONUS_TYPES } from './referralBonusService.js';

const REFERRER_BONUS_DAYS = 3;   // бонус за приглашение рефереру
const NEW_USER_BONUS_DAYS = 3;   // приветственный бонус новому пользователю

// ========================= HELPER FUNCTIONS =========================

/**
 * Склонение слова "день/дня/дней"
 */
function pluralDays(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b > 1 && b < 5) return 'дня';
  if (b === 1) return 'день';
  return 'дней';
}

/**
 * Отправляет уведомление рефереру о начислении бонуса
 */
async function notifyReferrer(referrerId, days, isProlongation = false) {
  const action = isProlongation 
    ? 'продлили вашу текущую подписку' 
    : `начислили вам ${days} ${pluralDays(days)} тарифа Plus`;
  
  const message = 
    `🥳 По вашей ссылке присоединился новый пользователь!\n\n` +
    `Мы <b>${action}</b>. Спасибо, что вы с нами!`;
  
  try {
    await bot.telegram.sendMessage(referrerId, message, { parse_mode: 'HTML' });
  } catch (e) {
    if (e?.response?.error_code === 403) {
      console.log(`[Referral] Рефер ${referrerId} заблокировал бота, пропускаю уведомление.`);
    } else {
      console.error(`[Referral] Ошибка отправки уведомления рефереру ${referrerId}:`, e.message);
    }
  }
}

// ========================= MAIN FUNCTIONS =========================

/**
 * Команда для получения реферальной ссылки
 */
export async function handleReferralCommand(ctx) {
  const userId = ctx.from.id;
  const botUsername = ctx.botInfo.username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${userId}`;
  
  const message = 
    `🙋‍♂️ **Приглашайте друзей и получайте бонусы!**\n\n` +
    `Поделитесь своей персональной ссылкой с друзьями. За каждого друга, который запустит бота по вашей ссылке, ` +
    `вы получите **+${REFERRER_BONUS_DAYS} ${pluralDays(REFERRER_BONUS_DAYS)} тарифа Plus**! 🎁\n\n` +
    `Ваш друг также получит приветственный бонус.\n\n` +
    `🔗 **Ваша ссылка для приглашений:**\n` +
    `\`${referralLink}\`\n\n` +
    `*(Нажмите на ссылку, чтобы скопировать её)*`;
  
  await ctx.reply(message, { 
    parse_mode: 'Markdown', 
    disable_web_page_preview: true 
  });
}

/**
 * Обработка бонусов при приходе нового пользователя по реферальной ссылке
 */
export async function processNewUserReferral(newUser, ctx) {
  // Если пользователь пришёл без реферера — ничего не делаем
  if (!newUser?.referrer_id) return;

  const referrerId = newUser.referrer_id;
  console.log(`[Referral] Новый пользователь ${newUser.id} пришел от ${referrerId}. Обрабатываю бонусы...`);

  try {
    // --- 1) Бонус новому пользователю ---
    const newUserGrant = await grantReferralBonus(pool, {
      referrerId,
      referredUserId: newUser.id,
      bonusType: REFERRAL_BONUS_TYPES.NEW_USER
    });
    if (!newUserGrant.duplicate) {
      await ctx.reply(
      `🎉 В качестве приветственного бонуса мы начислили вам ` +
      `<b>${NEW_USER_BONUS_DAYS} ${pluralDays(NEW_USER_BONUS_DAYS)} тарифа Plus!</b>`,
      { parse_mode: 'HTML' }
    );
    
      await logUserAction(newUser.id, 'referral_bonus_received', { 
      type: 'new_user', 
      days: NEW_USER_BONUS_DAYS, 
      limit: 30 
      });
    }

    // --- 2) Бонус рефереру ---
    const referrer = await getUser(referrerId);
    if (!referrer) {
      console.warn(`[Referral] Рефер ${referrerId} не найден в БД.`);
      return;
    }

    if (referrer.premium_limit > 30) {
      // У реферера тариф выше чем Plus — продлеваем текущий лимит
      const referrerGrant = await grantReferralBonus(pool, {
        referrerId,
        referredUserId: newUser.id,
        bonusType: REFERRAL_BONUS_TYPES.REFERRER
      });
      if (referrerGrant.duplicate) return;
      
      console.log(`[Referral] Реферер ${referrerId} имеет тариф ${referrer.premium_limit}. Продлеваем на ${REFERRER_BONUS_DAYS} ${pluralDays(REFERRER_BONUS_DAYS)}.`);
      
      await notifyReferrer(referrerId, REFERRER_BONUS_DAYS, true);
      
      await logUserAction(referrerId, 'referral_bonus_received', {
        type: 'referrer',
        days: REFERRER_BONUS_DAYS,
        limit: referrer.premium_limit,
        referred_user_id: newUser.id
      });
    } else {
      // Выдаём/продлеваем Plus
      const referrerGrant = await grantReferralBonus(pool, {
        referrerId,
        referredUserId: newUser.id,
        bonusType: REFERRAL_BONUS_TYPES.REFERRER
      });
      if (referrerGrant.duplicate) return;
      
      console.log(`[Referral] Реферер ${referrerId} получает Plus на ${REFERRER_BONUS_DAYS} ${pluralDays(REFERRER_BONUS_DAYS)}.`);
      
      await notifyReferrer(referrerId, REFERRER_BONUS_DAYS, false);
      
      await logUserAction(referrerId, 'referral_bonus_received', {
        type: 'referrer',
        days: REFERRER_BONUS_DAYS,
        limit: 30,
        referred_user_id: newUser.id
      });
    }
  } catch (e) {
    console.error(`[Referral] Ошибка при начислении реферального бонуса для ${newUser.id} и ${referrerId}:`, e);
  }
}

// ========================= EXPORTS SUMMARY =========================
// - handleReferralCommand: команда /referral для получения ссылки
// - processNewUserReferral: обработка бонусов при регистрации нового пользователя
