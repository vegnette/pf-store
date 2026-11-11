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
  return env.ORDERS_KV.get(`order:${id}`, 'json');
}

async function putOrder(env, order) {
  await env.ORDERS_KV.put(`order:${order.id}`, JSON.stringify(order));
}

async function listOrders(env) {
  const list = await env.ORDERS_KV.list({ prefix: 'order:' });
  const orders = await Promise.all(
    list.keys.map(key => env.ORDERS_KV.get(key.name, 'json'))
  );
  return orders.filter(Boolean);
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

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.MANAGER_CHAT_ID,
        text: lines.join('\n')
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      console.error('telegram_notify_failed', response.status, payload?.description || 'unknown');
    } else {
      const chat = payload.result?.chat || {};
      const from = payload.result?.from || {};
      console.log('telegram_notify_ok', chat.id, chat.username || chat.first_name || chat.type || '', 'bot=', from.username || '');
    }
  } catch (error) {
    // уведомление не должно ломать сохранение заказа
    console.error('telegram_notify_error', error.message);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (request.method === 'GET') {
      const initData = url.searchParams.get('initData') || '';
      const user = await verifyInitData(initData, env.BOT_TOKEN);
      if (!user) return json({ error: 'invalid_init_data' }, 401);

      const orders = await listOrders(env);
      const visible = isManager(user, env)
        ? orders
        : orders.filter(order => String(order.user?.id) === String(user.id));

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

    const user = await verifyInitData(body.initData || '', env.BOT_TOKEN);
    if (!user) return json({ error: 'invalid_init_data' }, 401);

    const manager = isManager(user, env);

    // Смена статуса менеджером
    if (body.type === 'status') {
      if (!manager) return json({ error: 'manager_only' }, 403);

      const order = await getOrder(env, body.id);
      if (!order) return json({ error: 'not_found' }, 404);

      const allowed = ['awaiting', 'sent', 'delivered', 'canceled'];
      if (!allowed.includes(body.status)) return json({ error: 'bad_status' }, 400);

      order.status = body.status;
      order.updatedAt = new Date().toISOString();
      order.updatedBy = user.username || user.first_name || 'manager';
      if (body.status === 'sent' && !order.confirmedAt) order.confirmedAt = order.updatedAt;
      if (body.status === 'delivered') {
        if (!order.confirmedAt) order.confirmedAt = order.updatedAt;
        order.deliveredAt = order.updatedAt;
      }

      await putOrder(env, order);
      return json({ order });
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
      const currentStatus = existing ? existing.status : 'awaiting';
      if (!order.status) order.status = currentStatus;
      if (order.status !== currentStatus) {
        if (!(currentStatus === 'awaiting' && order.status === 'sent')) {
          return json({ error: 'status_manager_only' }, 403);
        }
      }
      if (!existing) order.status = 'awaiting';
    }

    const isNew = !existing;
    await putOrder(env, order);

    if (isNew && !manager) {
      await notifyManager(env, order);
    }

    return json({ order });
  }
};
