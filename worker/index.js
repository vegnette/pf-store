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

// Четыре этапа заказа + отмена. Старые статусы приводим к новым.
const ORDER_STATUSES = ['created', 'manager', 'delivery', 'received', 'canceled'];
const STATUS_ALIASES = {
  awaiting: 'created',
  sent: 'manager',
  delivered: 'received'
};
const ORDER_STATUS_LABELS = {
  created: 'создан',
  manager: 'у менеджера',
  delivery: 'в доставке',
  received: 'получен',
  canceled: 'отменён'
};

// Базовые цены для проверки заказов. Если цена меняется через панель
// менеджера, она сохраняется в product:<id> и имеет приоритет над этой картой.
// При изменении products.json обновите значения здесь и задеплойте Worker.
const BASE_PRICES = { 1: 1500, 2: 1800, 3: 1500, 4: 1800, 5: 4500 };

// Защита от спама: один новый заказ на покупателя за 90 секунд.
const NEW_ORDER_COOLDOWN_MS = 90 * 1000;

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

// Уведомления менеджеру и покупателю идут от основного бота магазина.
function managerToken(env) {
  return env.BOT_TOKEN_MAIN || env.BOT_TOKEN;
}

// Универсальный вызов Telegram Bot API для callback-кнопок и редактирования.
async function telegramMethod(env, token, method, payload) {
  if (!token) return null;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      console.error(`telegram_${method}_failed`, response.status, data?.description || 'unknown');
      return null;
    }

    return data.result || true;
  } catch (error) {
    console.error(`telegram_${method}_error`, error.message);
    return null;
  }
}

function answerCallback(env, token, callbackId, text, showAlert = false) {
  return telegramMethod(env, token, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text,
    show_alert: showAlert
  });
}

function editTelegramMessage(env, token, chatId, messageId, text, replyMarkup) {
  if (!chatId || !messageId) return Promise.resolve(null);
  return telegramMethod(env, token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

// Кнопки, которые менеджер видит прямо под уведомлением о заказе.
function orderActionKeyboard(order) {
  const status = normalizeStatus(order.status);
  const next = {
    created: ['manager', '✅ Принять'],
    manager: ['delivery', '🚚 В доставку'],
    delivery: ['received', '📦 Получен']
  }[status];

  const rows = [];
  if (next) {
    rows.push([{
      text: next[1],
      callback_data: `order:${next[0]}:${order.id}`
    }]);
  }
  if (status !== 'canceled' && status !== 'received') {
    rows.push([{
      text: '❌ Отменить',
      callback_data: `order:canceled:${order.id}`
    }]);
  }
  rows.push([{ text: '🛍 Все заказы', web_app: { url: `${STORE_URL}?view=orders` } }]);

  return { inline_keyboard: rows };
}

// Покупатель получает сообщение при каждом изменении статуса заказа.
async function notifyBuyer(env, order, status) {
  const chatId = order?.user?.id;
  const next = normalizeStatus(status);
  if (!chatId) return false;

  const messages = {
    manager: [
      `✅ Заказ ${order.id} принят`,
      'Менеджер проверит наличие и напишет вам в Telegram.'
    ],
    delivery: [
      `🚚 Заказ ${order.id} передан в доставку`,
      'Скоро свяжемся, чтобы согласовать время и способ получения.'
    ],
    received: [
      `📦 Заказ ${order.id} получен`,
      'Спасибо за покупку! Если что-то понадобится — напишите менеджеру.'
    ],
    canceled: [
      `❌ Заказ ${order.id} отменён`,
      `Если это ошибка, напишите @${MANAGER_USERNAME}.`
    ]
  };

  const message = messages[next];
  if (!message) return false;

  const text = [
    ...message,
    '',
    `Сумма: ${formatMoney(order.total)}`,
    'Статус всегда доступен в магазине.'
  ].join('\n');

  return sendTelegram(env, managerToken(env), chatId, text, {
    inline_keyboard: [[{ text: '📦 Мои заказы', web_app: { url: `${STORE_URL}?view=orders` } }]]
  });
}

// Единая точка изменения статуса: даты и служебные поля не расходятся
// между сайтом, Telegram-кнопками и API.
function applyOrderStatus(order, status, by = 'manager') {
  const previous = normalizeStatus(order.status);
  const next = normalizeStatus(status);
  const now = new Date().toISOString();

  order.status = next;
  order.updatedAt = now;
  order.updatedBy = by;

  if ((next === 'manager' || next === 'delivery' || next === 'received') && !order.confirmedAt) {
    order.confirmedAt = now;
  }
  if (next === 'delivery' && !order.shippedAt) order.shippedAt = now;
  if (next === 'received') {
    if (!order.deliveredAt) order.deliveredAt = now;
    if (!order.receivedAt) order.receivedAt = now;
  }

  return previous;
}


async function notifyManager(env, order) {
  const token = managerToken(env);
  const chatId = env.MANAGER_CHAT_ID || managerIds(env)[0];
  if (!token || !chatId) return false;

  const lines = [
    `🛒 Новый заказ ${order.id}`,
    `Сумма: ${formatMoney(order.total)}`,
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

  if (order.priceMismatch) {
    lines.push('');
    lines.push(`⚠️ Сумма проверена: на сайте ${formatMoney(order.priceMismatch.receivedTotal)}, по каталогу ${formatMoney(order.priceMismatch.expectedTotal)}.`);
    lines.push('Сверьте цену перед подтверждением.');
  }

  return sendTelegram(env, token, chatId, lines.join('\n'), orderActionKeyboard(order));
}

// --- НАЛИЧИЕ И РУЧНЫЕ ПРАВКИ ТОВАРОВ ---

function stockKey(productId) {
  return `stock:${productId}`;
}

function productKey(productId) {
  return `product:${productId}`;
}

async function getStockOverrides(env) {
  const list = await env.ORDERS_KV.list({ prefix: 'stock:' });
  const values = await Promise.all(
    list.keys.map(async key => [key.name.slice(6), Number(await env.ORDERS_KV.get(key.name))])
  );

  return Object.fromEntries(values.filter(([, value]) => Number.isFinite(value)));
}

async function getProductOverrides(env) {
  const list = await env.ORDERS_KV.list({ prefix: 'product:' });
  const values = await Promise.all(
    list.keys.map(async key => [key.name.slice(8), await env.ORDERS_KV.get(key.name, 'json')])
  );

  return Object.fromEntries(values.filter(([, value]) => value && typeof value === 'object'));
}

// --- ИЗБРАННОЕ, УВЕДОМЛЕНИЯ О ЦЕНЕ И КАРТОЧКА КЛИЕНТА ---

function favoritesKey(userId) {
  return `fav:${userId}`;
}

function messagesKey(userId) {
  return `msgs:${userId}`;
}

// Пишем уведомление о снижении цены тем, у кого товар в избранном.
async function notifyFavoriters(env, productId, title, previousPrice, nextPrice) {
  if (!Number.isFinite(Number(previousPrice)) || Number(previousPrice) <= Number(nextPrice)) return 0;

  const list = await env.ORDERS_KV.list({ prefix: 'fav:' });
  if (!list.keys.length) return 0;

  const token = managerToken(env);
  const managers = managerIds(env);
  const text = [
    '📉 Цена снизилась на товар из избранного',
    '',
    title,
    `Было ${formatMoney(previousPrice)} · стало ${formatMoney(nextPrice)}`
  ].join('\n');
  const keyboard = {
    inline_keyboard: [[{ text: 'Открыть товар', url: `${STORE_URL}?product=${productId}` }]]
  };

  let sent = 0;
  for (const key of list.keys) {
    const userId = key.name.slice(4);
    if (managers.includes(String(userId))) continue;

    const record = await env.ORDERS_KV.get(key.name, 'json');
    const ids = Array.isArray(record?.ids) ? record.ids.map(String) : [];
    if (!ids.includes(String(productId))) continue;

    if (await sendTelegram(env, token, userId, text, keyboard)) sent += 1;
  }

  return sent;
}

// Короткий журнал переписки покупателя с ботом для карточки клиента.
async function appendCustomerMessage(env, userId, role, text, name) {
  if (!userId || !text) return;

  const key = messagesKey(userId);
  const stored = await env.ORDERS_KV.get(key, 'json');
  const items = Array.isArray(stored?.items) ? stored.items : [];

  items.push({
    role,
    text: String(text).slice(0, 500),
    name: String(name || '').slice(0, 80),
    at: new Date().toISOString()
  });

  await env.ORDERS_KV.put(
    key,
    JSON.stringify({ items: items.slice(-30) }),
    { expirationTtl: 90 * 24 * 60 * 60 }
  );
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

// --- ПРОВЕРКА ЦЕН И АНТИСПАМ ---

async function validateOrderPricing(env, order) {
  const overrides = await getProductOverrides(env);
  let subtotal = 0;
  let mismatch = false;
  let hasQtyDiscount = false;

  order.items = order.items.map(item => {
    const id = String(item.id);
    const qty = Math.max(1, Math.min(999, Math.round(Number(item.qty) || 1)));
    const clientPrice = Math.round(Number(item.price) || 0);
    const override = overrides[id];
    const expected = override && Number.isFinite(Number(override.price))
      ? Number(override.price)
      : BASE_PRICES[id];

    if (!Number.isFinite(expected)) {
      subtotal += clientPrice * qty;
      return { ...item, qty };
    }

    if (Math.abs(clientPrice - expected) > 0.5) mismatch = true;
    if (qty >= 2) hasQtyDiscount = true;
    subtotal += expected * qty;
    return { ...item, qty, price: expected };
  });

  const qtyDiscount = hasQtyDiscount ? Math.round(subtotal * 0.05) : 0;
  const promoPercent = Math.max(0, Math.min(5, Number(order.promoPercent) || 0));
  const promoDiscount = Math.round(subtotal * promoPercent / 100);
  const total = Math.max(0, subtotal - qtyDiscount - promoDiscount);

  if (Math.abs((Number(order.total) || 0) - total) > 1) mismatch = true;

  return { subtotal, qtyDiscount, promoDiscount, total, mismatch };
}

async function orderRateLimit(env, userId, orderId) {
  const key = `rate:${userId}`;
  const now = Date.now();
  const last = await env.ORDERS_KV.get(key, 'json');
  const elapsed = last ? now - Number(last.at || 0) : Infinity;

  if (last && elapsed < NEW_ORDER_COOLDOWN_MS && String(last.orderId) !== String(orderId)) {
    return Math.ceil((NEW_ORDER_COOLDOWN_MS - elapsed) / 1000);
  }

  await env.ORDERS_KV.put(
    key,
    JSON.stringify({ at: now, orderId: String(orderId) }),
    { expirationTtl: 180 }
  );

  return 0;
}

async function handleCallbackQuery(env, query) {
  const token = managerToken(env);
  const from = query.from || {};
  const data = String(query.data || '');
  const parts = data.split(':');
  const prefix = parts[0];
  const nextStatus = parts[1];
  const orderId = parts.slice(2).join(':');

  if (prefix !== 'order' || !orderId) {
    await answerCallback(env, token, query.id, 'Неизвестная команда', true);
    return;
  }

  if (!isManager(from, env)) {
    await answerCallback(env, token, query.id, 'Нет прав менеджера', true);
    return;
  }

  const order = await getOrder(env, orderId);
  if (!order) {
    await answerCallback(env, token, query.id, 'Заказ не найден', true);
    return;
  }

  const status = STATUS_ALIASES[nextStatus] || nextStatus;
  if (!ORDER_STATUSES.includes(status)) {
    await answerCallback(env, token, query.id, 'Неизвестный статус', true);
    return;
  }

  if (normalizeStatus(order.status) === status) {
    await answerCallback(env, token, query.id, `Уже ${ORDER_STATUS_LABELS[status]}`);
    return;
  }

  applyOrderStatus(order, status, from.username || from.first_name || 'manager');
  await putOrder(env, order);
  await answerCallback(env, token, query.id, `Статус: ${ORDER_STATUS_LABELS[status]}`);
  await notifyBuyer(env, order, status);

  const marker = '\n\n──────────\n';
  const baseText = String(query.message?.text || `Заказ ${order.id}`);
  const text = `${baseText.split(marker)[0]}${marker}Статус: ${ORDER_STATUS_LABELS[status].toUpperCase()}`;
  await editTelegramMessage(
    env,
    token,
    query.message?.chat?.id,
    query.message?.message_id,
    text,
    orderActionKeyboard(order)
  );
}

async function handleTelegramUpdate(env, update) {
  if (update.callback_query) {
    await handleCallbackQuery(env, update.callback_query);
    return;
  }

  const message = update.message || update.edited_message;
  if (!message || !message.chat?.id) return;

  const text = String(message.text || '').trim();
  const command = text.startsWith('/')
    ? text.slice(1).split(/[\s@]/)[0].toLowerCase()
    : '';

  // Журнал переписки для карточки клиента в панели менеджера.
  const sender = message.from || {};
  const senderId = sender.id || message.chat.id;
  if (text && senderId && !sender.is_bot) {
    await appendCustomerMessage(
      env,
      senderId,
      isManager(sender, env) ? 'manager' : 'buyer',
      text,
      sender.first_name || ''
    );
  }

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

    // Публичные ручные правки: наличие, цена и описание товаров.
    if ((url.pathname === '/stock' || url.pathname === '/overrides') && request.method === 'GET') {
      const stock = await getStockOverrides(env);
      if (url.pathname === '/stock') return json({ stock });
      return json({ stock, products: await getProductOverrides(env) });
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

      return json({ orders: visible, manager: isManager(user, env) });
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

    // Синхронизация избранного: нужно, чтобы бот предупредил о снижении цены.
    if (body.type === 'favorites') {
      const ids = Array.isArray(body.ids)
        ? body.ids.map(id => String(id)).filter(id => /^\d{1,12}$/.test(id)).slice(0, 50)
        : [];

      await env.ORDERS_KV.put(
        favoritesKey(user.id),
        JSON.stringify({
          ids,
          at: new Date().toISOString(),
          name: user.first_name || '',
          username: user.username || ''
        })
      );

      return json({ ok: true, count: ids.length });
    }

    // Карточка клиента: избранное и переписка (только менеджер).
    if (body.type === 'customer') {
      if (!manager) return json({ error: 'manager_only' }, 403);

      const userId = String(body.userId || '').trim();
      if (!userId) return json({ error: 'invalid_user' }, 400);

      const favorites = await env.ORDERS_KV.get(favoritesKey(userId), 'json');
      const messages = await env.ORDERS_KV.get(messagesKey(userId), 'json');

      return json({
        userId,
        favorites: Array.isArray(favorites?.ids) ? favorites.ids : [],
        favoritesUpdatedAt: favorites?.at || null,
        messages: Array.isArray(messages?.items) ? messages.items : []
      });
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

    // Ручная правка названия, цены, старой цены, наличия и описания товара.
    if (body.type === 'product') {
      if (!manager) return json({ error: 'manager_only' }, 403);

      const productId = String(body.productId || '').trim();
      const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const price = Math.round(Number(body.price));
      const oldPrice = Math.round(Number(body.oldPrice) || 0);
      const stock = Math.max(0, Math.min(999, Math.round(Number(body.stock) || 0)));
      const desc = String(body.desc || '').trim().slice(0, 4000);
      const previousStock = Number(body.previousStock);

      if (!productId) return json({ error: 'invalid_product' }, 400);
      if (title.length < 2) return json({ error: 'invalid_title' }, 400);
      if (!Number.isFinite(price) || price <= 0 || price > 1000000) {
        return json({ error: 'invalid_price' }, 400);
      }
      if (!Number.isFinite(oldPrice) || oldPrice < 0 || oldPrice > 1000000) {
        return json({ error: 'invalid_old_price' }, 400);
      }

      const previous = await env.ORDERS_KV.get(productKey(productId), 'json');
      const previousPrice = Number(previous?.price) > 0 ? Number(previous.price) : BASE_PRICES[productId];

      const now = new Date().toISOString();
      const product = {
        title,
        price,
        oldPrice,
        desc,
        updatedAt: now,
        updatedBy: user.username || user.first_name || 'manager'
      };

      await env.ORDERS_KV.put(productKey(productId), JSON.stringify(product));
      await env.ORDERS_KV.put(stockKey(productId), String(stock));

      // Подписчиков беспокоим только если товар реально вернулся в наличие.
      const backInStock = stock > 0 && Number.isFinite(previousStock) && previousStock <= 0;
      const notified = backInStock
        ? await notifyWatchers(env, productId, title, price)
        : 0;

      // Снижение цены — повод написать тем, у кого товар в избранном.
      const priceDropNotified = await notifyFavoriters(env, productId, title, previousPrice, price);

      return json({ product: { ...product, stock }, notified, priceDropNotified });
    }

    // Смена статуса менеджером
    if (body.type === 'status') {
      if (!manager) return json({ error: 'manager_only' }, 403);

      const order = await getOrder(env, body.id);
      if (!order) return json({ error: 'not_found' }, 404);

      const status = STATUS_ALIASES[body.status] || body.status;
      if (!ORDER_STATUSES.includes(status)) return json({ error: 'bad_status' }, 400);
      if (normalizeStatus(order.status) === status) return json({ order });

      applyOrderStatus(order, status, user.username || user.first_name || 'manager');
      await putOrder(env, order);
      await notifyBuyer(env, order, status);
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
    if (existing && !manager) {
      if (String(existing.user?.id) !== String(user.id)) {
        return json({ error: 'forbidden' }, 403);
      }
      // После того как менеджер принял заказ, покупатель его не редактирует.
      if (normalizeStatus(existing.status) !== 'created') {
        return json({ error: 'order_locked' }, 409);
      }
    }

    const isNew = !existing;

    if (!manager && isNew) {
      const retryAfter = await orderRateLimit(env, user.id, order.id);
      if (retryAfter > 0) {
        return json({ error: 'too_fast', retryAfter }, 429);
      }
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

      // Цены и итог проверяем по каталогу и ручным правкам менеджера.
      const pricing = await validateOrderPricing(env, order);
      const receivedTotal = Number(order.total) || 0;
      order.subtotal = pricing.subtotal;
      order.qtyDiscount = pricing.qtyDiscount;
      order.promoDiscount = pricing.promoDiscount;
      order.total = pricing.total;
      if (pricing.mismatch) {
        order.priceMismatch = {
          expectedTotal: pricing.total,
          receivedTotal,
          at: new Date().toISOString()
        };
      }
    } else {
      order.status = normalizeStatus(order.status);
    }

    await putOrder(env, order);

    if (isNew && !manager && !isTestOrder(order)) {
      await notifyManager(env, order);
    }

    return json({ order });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyReport(env));
  }
};
