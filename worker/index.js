/**
 * PF Store · синхронизация заказов
 * Бесплатный Cloudflare Worker + KV.
 *
 * Что делает:
 *  - принимает заказы из мини-приложения;
 *  - проверяет подпись Telegram initData (HMAC-SHA256);
 *  - отдаёт покупателю только его заказы, менеджеру — все;
 *  - разрешает менеджеру менять статус заказа;
 *  - может присылать уведомление о новом заказе в Telegram.
 *
 * Переменные окружения:
 *  - BOT_TOKEN       — токен бота из @BotFather (секрет);
 *  - MANAGER_IDS     — ID менеджеров через запятую (секрет или vars);
 *  - MANAGER_CHAT_ID — (необязательно) chat_id для уведомлений;
 *  - ORDERS_KV       — привязка KV (см. wrangler.toml).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;
const STORE_URL = 'https://vegnette.github.io/pf-store/';
const MANAGER_USERNAME = 'PF_Store_manager';
const REFERRAL_PERCENT = 10;

// Четыре этапа заказа + отмена. Старые статусы приводим к новым.
const ORDER_STATUSES = ['created', 'manager', 'delivery', 'received', 'canceled'];
const STATUS_ALIASES = {
  awaiting: 'created',
  sent: 'manager',
  delivered: 'received'
};

function normalizeStatus(status) {
  const next = STATUS_ALIASES[status] || status;
  return ORDER_STATUSES.includes(next) ? next : 'created';
}

// Тестовые заказы не попадают в историю, отчёт и статистику.
function isTestOrder(order) {
  return Boolean(order) && (order.test === true || /^test/i.test(String(order.id || '')));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = await hmac(new TextEncoder().encode('WebAppData'), botToken);
  const signature = await hmac(new Uint8Array(secret), dataCheckString);
  const hex = [...new Uint8Array(signature)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  if (!timingSafeEqual(hex, hash.toLowerCase())) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SECONDS) return null;

  try {
    const user = JSON.parse(params.get('user') || '{}');
    return user && user.id ? user : null;
  } catch (error) {
    return null;
  }
}

function botTokens(env) {
  return [env.BOT_TOKEN, env.BOT_TOKEN_MAIN].filter(Boolean);
}

// Подпись initData зависит от бота, через которого открыто мини-приложение.
// Поэтому проверяем токеном админ-бота и, если задан, основного бота магазина.
async function verifyAnyBot(initData, env) {
  for (const token of botTokens(env)) {
    const user = await verifyInitData(initData, token);
    if (user) return user;
  }
  return null;
}

function managerIds(env) {
  return String(env.MANAGER_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function isManager(user, env) {
  return Boolean(user) && managerIds(env).includes(String(user.id));
}

async function getOrder(env, id) {
  const order = await env.ORDERS_KV.get(`order:${id}`, 'json');
  if (!order) return null;
  return { ...order, status: normalizeStatus(order.status) };
}

async function putOrder(env, order) {
  await env.ORDERS_KV.put(`order:${order.id}`, JSON.stringify(order));
}

async function listOrders(env) {
  const list = await env.ORDERS_KV.list({ prefix: 'order:' });
  const orders = await Promise.all(
    list.keys.map(key => env.ORDERS_KV.get(key.name, 'json'))
  );
  return orders
    .filter(Boolean)
    .map(order => ({ ...order, status: normalizeStatus(order.status) }));
}

async function sendTelegram(env, token, chatId, text, replyMarkup) {
  if (!token || !chatId) return false;

  try {
    const payloadBody = { chat_id: chatId, text, disable_web_page_preview: true };
    if (replyMarkup) payloadBody.reply_markup = replyMarkup;

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody)
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.ok) {
      console.error('telegram_send_failed', response.status, payload?.description || 'unknown');
      return false;
    }

    return true;
  } catch (error) {
    console.error('telegram_send_error', error.message);
    return false;
  }
}

// Уведомления менеджеру идут от основного бота магазина, если он подключён.
function managerToken(env) {
  return env.BOT_TOKEN_MAIN || env.BOT_TOKEN;
}

async function notifyManager(env, order) {
  if (!env.MANAGER_CHAT_ID || !env.BOT_TOKEN) return;

  const lines = [
    `🛒 Новый заказ ${order.id}`,
    `Сумма: ${order.total} ₽`,
    ...order.items.map(item => `• ${item.title} × ${item.qty}`)
  ];

  if (order.user?.first_name) {
    lines.push(`Покупатель: ${order.user.first_name}${order.user.username ? ` (@${order.user.username})` : ''}`);
  }

  if (order.customer?.name || order.customer?.phone) {
    lines.push(`Контакт: ${[order.customer.name, order.customer.phone].filter(Boolean).join(', ')}`);
  }

  const deliveryLabels = {
    pickup: 'Самовывоз — Барнаул, Павловский тракт, 307к3',
    city: 'Доставка по Барнаулу',
    russia: 'Отправка по России'
  };

  if (order.delivery?.method) {
    lines.push(`Получение: ${deliveryLabels[order.delivery.method] || deliveryLabels.pickup}`);
    if (order.delivery.address) lines.push(`Адрес: ${order.delivery.address}`);
    if (order.delivery.comment) lines.push(`Комментарий: ${order.delivery.comment}`);
  }

  if (order.referral?.referrerId) {
    lines.push(`🎁 Реферал: ID ${order.referral.referrerId} · ${REFERRAL_PERCENT}% = ${formatMoney(referralReward(order))} после получения`);
  }

  await sendTelegram(env, managerToken(env), env.MANAGER_CHAT_ID, lines.join('\n'));
}

// --- НАЛИЧИЕ ---

function stockKey(productId) {
  return `stock:${productId}`;
}

async function getStockOverrides(env) {
  const list = await env.ORDERS_KV.list({ prefix: 'stock:' });
  const values = await Promise.all(
    list.keys.map(async key => [key.name.slice(6), Number(await env.ORDERS_KV.get(key.name))])
  );

  return Object.fromEntries(values.filter(([, value]) => Number.isFinite(value)));
}

async function notifyWatchers(env, productId, title, price) {
  const list = await env.ORDERS_KV.list({ prefix: `watch:${productId}:` });
  if (!list.keys.length) return 0;

  const text = [
    `🔥 ${title || 'Товар'} снова в наличии${price ? ` — ${price} ₽` : ''}!`,
    'Успейте заказать, пока не разобрали.',
    `https://vegnette.github.io/pf-store/?product=${productId}`
  ].join('\n');

  const token = env.BOT_TOKEN_MAIN || env.BOT_TOKEN;
  let sent = 0;

  for (const key of list.keys) {
    const watcher = await env.ORDERS_KV.get(key.name, 'json');
    if (watcher?.id && await sendTelegram(env, token, watcher.id, text)) sent += 1;
    await env.ORDERS_KV.delete(key.name);
  }

  return sent;
}

// --- РЕФЕРАЛЬНАЯ ПРОГРАММА ---
// Друг оформляет заказ по ссылке ?ref=<telegram_id>. После статуса «получен»
// пригласившему начисляется 10% от суммы заказа.

function normalizeReferralId(value) {
  const digits = String(value ?? '').trim().replace(/^ref[_-]?/i, '');
  return /^\d{5,20}$/.test(digits) ? digits : '';
}

function referralKey(id) {
  return `ref:${id}`;
}

function referralRecordShape(record, id) {
  const owner = String(record?.id || id || '');
  const friends = Array.isArray(record?.friends)
    ? [...new Set(record.friends.map(String).filter(Boolean))]
    : [];

  return {
    id: owner,
    friends,
    orders: Math.max(0, Math.round(Number(record?.orders) || 0)),
    earned: Math.max(0, Math.round(Number(record?.earned) || 0)),
    available: Math.max(0, Math.round(Number(record?.available) || 0)),
    paid: Math.max(0, Math.round(Number(record?.paid) || 0)),
    history: Array.isArray(record?.history) ? record.history.slice(-50) : [],
    updatedAt: record?.updatedAt || null
  };
}

async function getReferralSummary(env, id) {
  const record = referralRecordShape(
    await env.ORDERS_KV.get(referralKey(id), 'json'),
    id
  );

  return {
    id: record.id,
    invited: record.friends.length,
    orders: record.orders,
    earned: record.earned,
    available: record.available,
    paid: record.paid
  };
}

async function saveReferralRecord(env, record) {
  await env.ORDERS_KV.put(referralKey(record.id), JSON.stringify(record));
}

function referralReward(order) {
  const percent = REFERRAL_PERCENT;
  const total = Math.max(0, Math.round(Number(order?.total) || 0));
  return Math.round(total * percent / 100);
}

function attachReferralToOrder(env, order, user) {
  const refId = normalizeReferralId(order.referral?.referrerId);
  const buyerId = String(user?.id || '');

  if (!refId || !buyerId || refId === buyerId || isTestOrder(order)) {
    delete order.referral;
    return;
  }

  if (managerIds(env).some(id => String(id) === refId)) {
    delete order.referral;
    return;
  }

  order.referral = {
    referrerId: refId,
    percent: REFERRAL_PERCENT,
    credited: false,
    reward: 0
  };
}

async function registerReferralFriend(env, order) {
  const refId = normalizeReferralId(order.referral?.referrerId);
  const buyerId = String(order.user?.id || '');
  if (!refId || !buyerId || refId === buyerId || isTestOrder(order)) return;

  const record = referralRecordShape(
    await env.ORDERS_KV.get(referralKey(refId), 'json'),
    refId
  );

  if (record.friends.includes(buyerId)) return;

  record.friends.push(buyerId);
  record.updatedAt = new Date().toISOString();
  await saveReferralRecord(env, record);
}

async function creditReferral(env, order) {
  const referral = order.referral;
  if (!referral || referral.credited || isTestOrder(order)) return 0;

  const refId = normalizeReferralId(referral.referrerId);
  const buyerId = String(order.user?.id || '');
  if (!refId || !buyerId || refId === buyerId) return 0;
  if (managerIds(env).some(id => String(id) === refId)) return 0;

  const reward = referralReward(order);
  if (reward <= 0) return 0;

  const record = referralRecordShape(
    await env.ORDERS_KV.get(referralKey(refId), 'json'),
    refId
  );
  const now = new Date().toISOString();

  if (!record.friends.includes(buyerId)) record.friends.push(buyerId);
  record.orders += 1;
  record.earned += reward;
  record.available += reward;
  record.history.push({
    type: 'credit',
    orderId: order.id,
    buyerId,
    total: Math.max(0, Math.round(Number(order.total) || 0)),
    percent: REFERRAL_PERCENT,
    reward,
    at: now
  });
  record.history = record.history.slice(-50);
  record.updatedAt = now;

  await saveReferralRecord(env, record);

  order.referral = {
    ...referral,
    percent: REFERRAL_PERCENT,
    reward,
    credited: true,
    creditedAt: now
  };

  await sendTelegram(
    env,
    env.BOT_TOKEN_MAIN || env.BOT_TOKEN,
    refId,
    [
      `🎁 Вам начислено ${formatMoney(reward)} за заказ друга.`,
      `Доступный баланс: ${formatMoney(record.available)}.`,
      `Выплата — через менеджера: https://t.me/${MANAGER_USERNAME}`
    ].join('\n')
  );

  return reward;
}

async function markReferralPaid(env, order, manager) {
  if (!order.referral?.credited) return { error: 'not_credited' };
  if (order.referral.paid) return { error: 'already_paid' };

  const refId = normalizeReferralId(order.referral.referrerId);
  const amount = Math.max(0, Math.round(Number(order.referral.reward) || 0));
  if (!refId || !amount) return { error: 'nothing_to_pay' };

  const record = referralRecordShape(
    await env.ORDERS_KV.get(referralKey(refId), 'json'),
    refId
  );
  const now = new Date().toISOString();

  record.available = Math.max(0, record.available - amount);
  record.paid += amount;
  record.history.push({
    type: 'payout',
    orderId: order.id,
    amount,
    by: manager?.username || manager?.first_name || 'manager',
    at: now
  });
  record.history = record.history.slice(-50);
  record.updatedAt = now;

  await saveReferralRecord(env, record);

  order.referral = {
    ...order.referral,
    paid: true,
    paidAt: now,
    paidBy: manager?.username || manager?.first_name || 'manager'
  };
  await putOrder(env, order);

  await sendTelegram(
    env,
    env.BOT_TOKEN_MAIN || env.BOT_TOKEN,
    refId,
    `💸 Выплата ${formatMoney(amount)} по реферальной программе отмечена. Спасибо!`
  );

  return { order };
}

// --- ОТЧЁТ ЗА ДЕНЬ ---

function barnaulDayRange(now = Date.now()) {
  const offset = 7 * 60 * 60 * 1000;
  const shifted = new Date(now + offset);
  const start = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ) - offset;

  return { start, end: start + 24 * 60 * 60 * 1000 };
}

function formatMoney(value) {
  return `${Math.round(Number(value) || 0).toLocaleString('ru-RU')} ₽`;
}

async function sendDailyReport(env) {
  if (!env.BOT_TOKEN || !env.MANAGER_CHAT_ID) return;

  const { start, end } = barnaulDayRange();
  const orders = await listOrders(env);
  const today = orders.filter(order => {
    if (isTestOrder(order)) return false;
    const time = new Date(order.createdAt || order.updatedAt || 0).getTime();
    return time >= start && time < end;
  });

  const day = new Date(start + 7 * 60 * 60 * 1000);
  const date = [
    String(day.getUTCDate()).padStart(2, '0'),
    String(day.getUTCMonth() + 1).padStart(2, '0'),
    day.getUTCFullYear()
  ].join('.');

  if (!today.length) {
    await sendTelegram(env, managerToken(env), env.MANAGER_CHAT_ID, `📊 ${date}\nЗаказов сегодня не было.`);
    return;
  }

  const canceled = today.filter(order => order.status === 'canceled');
  const active = today.filter(order => order.status !== 'canceled');
  const revenue = active.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  const awaiting = active.filter(order => order.status === 'created').length;

  const items = new Map();
  active.forEach(order => {
    (order.items || []).forEach(item => {
      const title = item.title || 'Товар';
      items.set(title, (items.get(title) || 0) + (Number(item.qty) || 1));
    });
  });
  const top = [...items.entries()].sort((a, b) => b[1] - a[1])[0];

  const lines = [
    `📊 Итоги дня · ${date}`,
    `Заказов: ${today.length}${canceled.length ? ` (отменено: ${canceled.length})` : ''}`,
    `Выручка: ${formatMoney(revenue)}`,
    `Средний чек: ${formatMoney(active.length ? revenue / active.length : 0)}`
  ];

  if (top) lines.push(`Топ товар: ${top[0]} × ${top[1]}`);
  if (awaiting) lines.push(`Ждут подтверждения: ${awaiting}`);

  await sendTelegram(env, managerToken(env), env.MANAGER_CHAT_ID, lines.join('\n'));
}

async function handleTelegramUpdate(env, update) {
  const message = update.message || update.edited_message;
  if (!message || !message.chat?.id) return;

  const text = String(message.text || '').trim();
  const command = text.startsWith('/')
    ? text.slice(1).split(/[\s@]/)[0].toLowerCase()
    : '';

  const openStoreKeyboard = {
    inline_keyboard: [
      [{ text: '🛍 Открыть магазин', web_app: { url: STORE_URL } }],
      [{ text: '📦 Мои заказы', web_app: { url: `${STORE_URL}?view=orders` } }]
    ]
  };

  const ordersKeyboard = {
    inline_keyboard: [[{ text: '📦 Мои заказы', web_app: { url: `${STORE_URL}?view=orders` } }]]
  };

  let reply;
  let keyboard = openStoreKeyboard;

  if (command === 'start') {
    reply = [
      'Добро пожаловать в PF Store 👋',
      '',
      'Здесь можно посмотреть каталог, оформить заказ и следить за статусом.',
      'Откройте магазин кнопкой ниже — так вы увидите свои заказы и сможете получать уведомления.'
    ].join('\n');
  } else if (command === 'catalog') {
    reply = 'Каталог и актуальные цены — в мини-приложении. Откройте его кнопкой ниже.';
  } else if (command === 'orders') {
    reply = 'Ваши заказы и статусы доставки — в мини-приложении. Откройте кнопкой ниже.';
    keyboard = ordersKeyboard;
  } else {
    reply = [
      'Помогу с заказом:',
      `• Написать менеджеру: @${MANAGER_USERNAME}`,
      '• Открыть магазин — кнопка ниже.',
      '',
      'Команды: /start — магазин, /catalog — каталог, /orders — заказы, /help — помощь.'
    ].join('\n');
  }

  await sendTelegram(env, managerToken(env), message.chat.id, reply, keyboard);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // Webhook основного бота: приветствие и кнопка магазина.
    if (url.pathname === '/telegram' && request.method === 'POST') {
      const secret = request.headers.get('x-telegram-bot-api-secret-token') || '';
      if (!env.TG_WEBHOOK_SECRET || secret !== env.TG_WEBHOOK_SECRET) {
        return json({ error: 'forbidden' }, 403);
      }

      const update = await request.json().catch(() => null);
      if (update) await handleTelegramUpdate(env, update);
      return json({ ok: true });
    }

    // Публичный список изменений наличия (что менеджер поменял вручную).
    if (url.pathname === '/stock' && request.method === 'GET') {
      return json({ stock: await getStockOverrides(env) });
    }

    // Ручной запуск дневного отчёта (ключ задаётся секретом REPORT_KEY).
    if (url.pathname === '/run-report' && request.method === 'POST') {
      const key = request.headers.get('x-report-key') || '';
      if (!env.REPORT_KEY || key !== env.REPORT_KEY) return json({ error: 'forbidden' }, 403);
      await sendDailyReport(env);
      return json({ ok: true });
    }

    if (request.method === 'GET') {
      const initData = url.searchParams.get('initData') || '';
      const user = await verifyAnyBot(initData, env);
      if (!user) return json({ error: 'invalid_init_data' }, 401);

      const orders = await listOrders(env);
      const visible = isManager(user, env)
        ? orders
        : orders.filter(order => !isTestOrder(order) && String(order.user?.id) === String(user.id));

      visible.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

      const referral = isManager(user, env) ? null : await getReferralSummary(env, user.id);

      return json({ orders: visible, manager: isManager(user, env), referral });
    }

    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return json({ error: 'invalid_json' }, 400);
    }

    const user = await verifyAnyBot(body.initData || '', env);
    if (!user) return json({ error: 'invalid_init_data' }, 401);

    const manager = isManager(user, env);

    // Подписка на поступление товара
    if (body.type === 'watch') {
      const productId = String(body.productId || '').trim();
      if (!productId) return json({ error: 'invalid_product' }, 400);

      await env.ORDERS_KV.put(
        `watch:${productId}:${user.id}`,
        JSON.stringify({
          id: user.id,
          name: user.first_name || '',
          username: user.username || '',
          at: new Date().toISOString()
        })
      );

      const canNotify = await sendTelegram(
        env,
        env.BOT_TOKEN_MAIN || env.BOT_TOKEN,
        user.id,
        '🔔 Хорошо! Напишем, как только товар снова появится в наличии.'
      );

      return json({ ok: true, canNotify });
    }

    // Изменение наличия менеджером
    if (body.type === 'stock') {
      if (!manager) return json({ error: 'manager_only' }, 403);

      const productId = String(body.productId || '').trim();
      if (!productId) return json({ error: 'invalid_product' }, 400);

      const stock = Math.max(0, Math.min(999, Math.round(Number(body.stock) || 0)));
      await env.ORDERS_KV.put(stockKey(productId), String(stock));

      const notified = stock > 0
        ? await notifyWatchers(env, productId, String(body.title || ''), Number(body.price) || 0)
        : 0;

      return json({ stock, notified });
    }

    // Смена статуса менеджером
    if (body.type === 'status') {
      if (!manager) return json({ error: 'manager_only' }, 403);

      const order = await getOrder(env, body.id);
      if (!order) return json({ error: 'not_found' }, 404);

      const status = normalizeStatus(body.status);
      if (!ORDER_STATUSES.includes(status)) return json({ error: 'bad_status' }, 400);

      order.status = status;
      order.updatedAt = new Date().toISOString();
      order.updatedBy = user.username || user.first_name || 'manager';
      if (status === 'manager' && !order.confirmedAt) order.confirmedAt = order.updatedAt;
      if (status === 'delivery') {
        if (!order.confirmedAt) order.confirmedAt = order.updatedAt;
        order.shippedAt = order.updatedAt;
      }
      if (status === 'received') {
        if (!order.confirmedAt) order.confirmedAt = order.updatedAt;
        order.deliveredAt = order.updatedAt;
        order.receivedAt = order.updatedAt;
        await creditReferral(env, order);
      }

      await putOrder(env, order);
      return json({ order });
    }

    // Удаление тестового заказа менеджером.
    if (body.type === 'delete') {
      if (!manager) return json({ error: 'manager_only' }, 403);

      const order = await getOrder(env, body.id);
      if (!order) return json({ error: 'not_found' }, 404);
      if (!isTestOrder(order)) return json({ error: 'test_only' }, 403);

      await env.ORDERS_KV.delete(`order:${order.id}`);
      return json({ ok: true });
    }

    // Отметка выплаты реферального вознаграждения менеджером
    if (body.type === 'referral_pay') {
      if (!manager) return json({ error: 'manager_only' }, 403);

      const order = await getOrder(env, body.id);
      if (!order) return json({ error: 'not_found' }, 404);

      const result = await markReferralPaid(env, order, user);
      if (result.error) return json({ error: result.error }, 400);
      return json(result);
    }

    // Создание или обновление заказа
    const order = body.order;
    if (!order || !order.id || !Array.isArray(order.items)) {
      return json({ error: 'invalid_order' }, 400);
    }

    order.user = order.user || {};
    order.updatedAt = order.updatedAt || new Date().toISOString();
    order.createdAt = order.createdAt || order.updatedAt;

    if (!manager) {
      order.user.id = user.id;
      order.user.username = user.username || '';
      order.user.first_name = user.first_name || '';
    }

    const existing = await getOrder(env, order.id);
    if (existing && !manager && String(existing.user?.id) !== String(user.id)) {
      return json({ error: 'forbidden' }, 403);
    }

    if (!manager) {
      // Покупатель может только подтвердить отправку своего заказа.
      const currentStatus = existing ? normalizeStatus(existing.status) : 'created';
      const nextStatus = normalizeStatus(order.status || currentStatus);
      if (nextStatus !== currentStatus) {
        if (!(currentStatus === 'created' && nextStatus === 'manager')) {
          return json({ error: 'status_manager_only' }, 403);
        }
      }
      order.status = existing ? nextStatus : 'created';
    } else {
      order.status = normalizeStatus(order.status);
    }

    const isNew = !existing;

    if (!manager) {
      if (isNew) {
        attachReferralToOrder(env, order, user);
      } else {
        order.referral = existing.referral || null;
        if (!order.referral) delete order.referral;
      }
    }

    await putOrder(env, order);

    if (isNew && !manager && !isTestOrder(order)) {
      await registerReferralFriend(env, order);
      await notifyManager(env, order);
    }

    return json({ order });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyReport(env));
  }
};
