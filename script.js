'use strict';

// ⚠️ ЗАМЕНИ НА СВОЙ ЮЗЕРНЕЙМ (без @)
const TELEGRAM_USERNAME = 'PF_Store_manager';
// Юзернейм бота, через которого открывается мини-приложение (без @).
// Если заполнить, гостю в профиле появится кнопка «Открыть в Telegram».
const TELEGRAM_BOT_USERNAME = 'PF_Store22_bot';
const STORE_NAME = 'PF Store';
const STORE_TIMEZONE = 'Asia/Barnaul';
const STORE_UTC_OFFSET_HOURS = 7;
const STORE_OPEN_HOUR = 10;
const STORE_CLOSE_HOUR = 21;

// Если сюда вставить URL бесплатного Cloudflare Worker,
// избранное будет уходить менеджеру автоматически.
// Пока пусто — работает кнопка «Отправить менеджеру».
const FAVORITES_ENDPOINT = '';

// URL Cloudflare Worker для синхронизации заказов между устройствами.
// Пока пусто — история заказов хранится только на этом устройстве.
const ORDERS_ENDPOINT = 'https://pf-store-orders.vegnette.workers.dev';

// Telegram-аккаунты менеджера. Username — без @.
// ВАЖНО: это только интерфейс. Настоящая защита статусов возможна
// лишь на сервере (Cloudflare Worker), который проверяет initData.
const MANAGER_USERNAMES = ['pf_store_manager'];
const MANAGER_IDS = [5352101935];
const MANAGER_QUERY_PARAM = 'manager';

const CATEGORY_LABELS = {
  watches: 'часы',
  headphones: 'наушники',
  glasses: 'очки',
  accessories: 'аксессуары'
};

const NO_PHOTO = './images/no-photo.svg';
const SORT_MODES = ['popular', 'price-asc', 'price-desc', 'discount', 'new'];

// Напоминание о незавершённом заказе
const CART_SNAPSHOT_KEY = 'pf_cart_snapshot';
const CART_NUDGE_KEY = 'pf_cart_nudge_dismissed';
const RESUME_MIN_AGE = 30 * 60 * 1000;
const RESUME_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const RESUME_SNOOZE = 3 * 24 * 60 * 60 * 1000;

// --- СОСТОЯНИЕ ---
let tg = window.Telegram?.WebApp || null;
let products = [];
let productsLoaded = false;
let stockOverrides = {};
let currentCategory = 'all';
let searchQuery = '';
let currentView = 'home';
let currentUser = null;

let cart = [];
let favorites = safeLoadFavorites();
let sortMode = localStorage.getItem('pf_sort') || 'popular';
let filters = { priceMin: null, priceMax: null, inStockOnly: false };
let hasShownQtyDiscountToast = false;
let currentProductId = null;
let confirmCallback = null;
let confirmReturnFocus = null;
let favoritesReportTimer = null;
let deepLinkHandled = false;
let recentIds = [];
let priceDrops = {};
let installPromptEvent = null;
let focusReturnTarget = null;

// --- ПРОМОКОДЫ ---
let myPromoCode = localStorage.getItem('pf_promo_code');
let promoUsed = localStorage.getItem('pf_promo_used') === 'true';
let appliedPromoPercent = Number(localStorage.getItem('pf_promo_applied') || 0);

// --- ЗАКАЗЫ ---
let orders = [];
let isManager = false;
let ordersLoading = false;

// --- МОДАЛЬНЫЕ ОКНА ---
const modalStack = [];
let descRequest = null;

// --- ЭФФЕКТЫ ---
let catalogAnimated = false;
const soundState = {
  enabled: localStorage.getItem('pf_sound') !== 'off',
  ctx: null
};

// --- КАРУСЕЛЬ БАННЕРОВ ---

const fallbackProducts = [
  { id: 1, category: 'watches', title: 'Apple Watch S11 46mm', price: 1500, oldPrice: 3000, stock: 3, badges: ['hit'], desc_file: './images/Watch 11/1.txt', images: ['./images/Watch 11/1.jpg'], gift_desc: '🎁 Ремешок в подарок!' }
];

// ============================================================
// ХЕЛПЕРЫ
// ============================================================

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatPrice(value) {
  const num = Number(value);
  return `${(Number.isFinite(num) ? Math.round(num) : 0).toLocaleString('ru-RU')} ₽`;
}

function plural(number, one, few, many) {
  const n = Math.abs(Number(number)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

// Единое время магазина: Барнаул, UTC+7, без перехода на летнее время.
function padTime(value) {
  return String(Number(value) || 0).padStart(2, '0');
}

function getStoreDateParts(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: STORE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);

    const read = type => {
      const raw = parts.find(part => part.type === type)?.value;
      return raw == null ? NaN : Number(raw);
    };

    const result = {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      hours: read('hour') % 24,
      minutes: read('minute')
    };

    if (Object.values(result).every(Number.isFinite)) return result;
  } catch (error) {
    // Ниже — фиксированный UTC+7, если Intl недоступен.
  }

  const shifted = new Date(date.getTime() + STORE_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes()
  };
}

function getStoreMinutes(date = new Date()) {
  const parts = getStoreDateParts(date);
  return parts.hours * 60 + parts.minutes;
}

function getStoreHour(date = new Date()) {
  return getStoreDateParts(date).hours;
}

function isStoreOpen(date = new Date()) {
  const minutes = getStoreMinutes(date);
  return minutes >= STORE_OPEN_HOUR * 60 && minutes < STORE_CLOSE_HOUR * 60;
}

function formatStoreDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = getStoreDateParts(date);
  return `${padTime(parts.day)}.${padTime(parts.month)}.${parts.year}, ${padTime(parts.hours)}:${padTime(parts.minutes)}`;
}

function formatStoreTime(date = new Date()) {
  const parts = getStoreDateParts(date);
  return `${padTime(parts.hours)}:${padTime(parts.minutes)}`;
}

function getProductImages(product) {
  const images = Array.isArray(product.images) ? product.images.filter(Boolean) : [];
  return images.length ? images : [NO_PHOTO];
}

function getDiscount(product) {
  if (!product.oldPrice || product.oldPrice <= product.price) return 0;
  return Math.round((1 - product.price / product.oldPrice) * 100);
}

function getBadgesHtml(product) {
  const badges = Array.isArray(product.badges) ? product.badges : [];
  let html = '';
  const discount = getDiscount(product);
  if (discount > 0) html += `<span class="badge-tag discount">-${discount}%</span>`;
  if (badges.includes('new')) html += '<span class="badge-tag new">NEW</span>';
  if (badges.includes('hit')) html += '<span class="badge-tag hit">ХИТ</span>';
  return html;
}

// ============================================================
// ИЗБРАННОЕ
// ============================================================

function safeLoadFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem('pf_favorites') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(Number)
      .filter((id, index, list) => Number.isFinite(id) && list.indexOf(id) === index);
  } catch (error) {
    return [];
  }
}

function saveFavorites() {
  try {
    localStorage.setItem('pf_favorites', JSON.stringify(favorites));
  } catch (error) {
    console.warn('Не удалось сохранить избранное:', error);
  }
}

function isFavorite(id) {
  return favorites.some(favoriteId => Number(favoriteId) === Number(id));
}

function getFavoriteProducts() {
  return favorites
    .map(id => products.find(product => Number(product.id) === Number(id)))
    .filter(Boolean);
}

function updateFavoriteBadge() {
  const count = favorites.length;

  const badge = document.getElementById('navFavCount');
  if (badge) {
    badge.textContent = count;
    badge.hidden = count === 0;
  }

  const profileCount = document.getElementById('profileFavCount');
  if (profileCount) {
    profileCount.textContent = count > 0
      ? `${count} ${plural(count, 'товар', 'товара', 'товаров')}`
      : 'Пока пусто';
  }

  const favoritesCount = document.getElementById('favoritesCount');
  if (favoritesCount) {
    favoritesCount.textContent = count;
    favoritesCount.hidden = count === 0;
  }
}

function updateFavoriteUI() {
  document.querySelectorAll('.card-fav').forEach(button => {
    const active = isFavorite(button.dataset.fav);
    const title = button.dataset.title || '';
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active
      ? `Убрать из избранного: ${title}`
      : `Добавить в избранное: ${title}`);
  });

  const productFav = document.getElementById('productFavBtn');
  if (productFav && currentProductId != null) {
    const active = isFavorite(currentProductId);
    productFav.classList.toggle('active', active);
    productFav.setAttribute('aria-pressed', String(active));
    productFav.setAttribute('aria-label', active ? 'Убрать из избранного' : 'Добавить в избранное');
  }

  updateFavoriteBadge();

  if (productsLoaded && currentView === 'favorites') {
    renderFavorites();
  }
}

function animateFavoriteButton(id) {
  document.querySelectorAll(`.card-fav[data-fav="${Number(id)}"]`).forEach(button => {
    button.classList.remove('pop');
    void button.offsetWidth;
    button.classList.add('pop');
  });
}

function animateFavoriteBadge() {
  const badge = document.getElementById('navFavCount');
  if (!badge) return;
  badge.classList.remove('badge-pop');
  void badge.offsetWidth;
  badge.classList.add('badge-pop');
}

// ============================================================
// СЛЕЖЕНИЕ ЗА ЦЕНОЙ ИЗБРАННОГО
// ============================================================

function safeLoadJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function savePriceDrops() {
  try {
    localStorage.setItem('pf_price_drops', JSON.stringify(priceDrops));
  } catch (error) {
    // приватный режим может запрещать запись
  }
}

function rememberFavoritePrice(id, price) {
  try {
    const map = safeLoadJson('pf_fav_prices', {});
    map[Number(id)] = Number(price) || 0;
    localStorage.setItem('pf_fav_prices', JSON.stringify(map));
  } catch (error) {
    // не критично
  }
}

function forgetFavoritePrice(id) {
  try {
    const map = safeLoadJson('pf_fav_prices', {});
    delete map[Number(id)];
    localStorage.setItem('pf_fav_prices', JSON.stringify(map));

    if (priceDrops[Number(id)]) {
      delete priceDrops[Number(id)];
      savePriceDrops();
    }
  } catch (error) {
    // не критично
  }
}

// Сравниваем цену при каждом запуске сайта. Показываем бейдж,
// если товар из избранного подешевел с прошлого визита.
function reconcileFavoritePrices() {
  const stored = safeLoadJson('pf_fav_prices', {});
  const nextStored = { ...stored };
  const nextDrops = {};
  let dropsFound = 0;

  favorites.forEach(id => {
    const product = products.find(item => Number(item.id) === Number(id));
    if (!product) return;

    const current = Number(product.price) || 0;
    const previous = Number(stored[id]);

    if (Number.isFinite(previous) && previous > current) {
      nextDrops[id] = previous - current;
      dropsFound += 1;
    }

    nextStored[id] = current;
  });

  // Убираем следы товаров, которых больше нет в избранном
  Object.keys(nextStored).forEach(id => {
    if (!favorites.some(favoriteId => Number(favoriteId) === Number(id))) delete nextStored[id];
  });

  priceDrops = nextDrops;

  try {
    localStorage.setItem('pf_fav_prices', JSON.stringify(nextStored));
  } catch (error) {
    // не критично
  }
  savePriceDrops();

  renderPriceDropHint();
  return dropsFound;
}

function renderPriceDropHint() {
  const hint = document.getElementById('priceDropHint');
  const profileHint = document.getElementById('profilePriceHint');
  const count = Object.keys(priceDrops).length;
  const text = count > 0
    ? `${count === 1 ? 'Подешевел' : 'Подешевели'} ${count} ${plural(count, 'товар', 'товара', 'товаров')}`
    : '';

  if (hint) {
    hint.hidden = count === 0;
    if (count > 0) hint.textContent = `${text} из избранного`;
  }

  if (profileHint) {
    profileHint.hidden = count === 0;
    profileHint.textContent = count > 0 ? `${text} · смотрите в избранном` : '';
  }
}

function notifyPriceDrops(count) {
  if (!count) return;

  const key = `pf_price_notice_${new Date().toISOString().slice(0, 10)}`;
  try {
    if (sessionStorage.getItem(key) === '1') return;
    sessionStorage.setItem(key, '1');
  } catch (error) {
    // нет sessionStorage — покажем один раз за загрузку
  }

  showToast(`📉 Цена снизилась на ${count} ${plural(count, 'товар', 'товара', 'товаров')} из избранного`, 'success');
}

function toggleFavorite(id) {
  const product = products.find(item => Number(item.id) === Number(id));
  if (!product) return;

  const wasFavorite = isFavorite(id);

  if (wasFavorite) {
    favorites = favorites.filter(favoriteId => Number(favoriteId) !== Number(id));
    forgetFavoritePrice(id);
  } else {
    favorites.push(Number(id));
    rememberFavoritePrice(id, product.price);
  }

  saveFavorites();
  updateFavoriteUI();
  animateFavoriteButton(id);
  animateFavoriteBadge();

  const image = getProductImages(product)[0];

  if (wasFavorite) {
    showNotification({
      title: 'Удалено из избранного',
      text: product.title,
      image,
      type: 'remove',
      icon: '−',
      duration: 2200,
      onClick: openFavorites
    });
    playSound('tap');
    triggerHaptic('selection');
  } else {
    showNotification({
      title: 'Добавлено в избранное',
      text: `${product.title} · ${formatPrice(product.price)}`,
      image,
      type: 'favorite',
      icon: '♥',
      duration: 2600,
      onClick: openFavorites
    });
    playSound('add');
    triggerHaptic('light');
  }

  notifyManagerAboutFavorites(wasFavorite ? 'remove' : 'add', product);
}

function buildFavoritesMessage() {
  const items = getFavoriteProducts();
  if (!items.length) return '';

  const lines = ['Здравствуйте! Меня заинтересовали товары из избранного:'];
  items.forEach(product => {
    lines.push(`• ${product.title} — ${formatPrice(product.price)} (1 шт.)`);
  });
  lines.push('');
  lines.push(`Всего: ${items.length} ${plural(items.length, 'товар', 'товара', 'товаров')} · ${items.length} шт.`);

  if (currentUser?.username) {
    lines.push(`Мой профиль: @${currentUser.username}`);
  } else if (currentUser?.first_name) {
    lines.push(`Меня зовут: ${currentUser.first_name}`);
  }

  return lines.join('\n');
}

function sendFavoritesToManager() {
  if (!favorites.length) {
    showToast('В избранном пока пусто', 'error');
    return;
  }

  const url = `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(buildFavoritesMessage())}`;
  openTelegramLink(url);
  playSound('success');
  triggerHaptic('success');
}

function notifyManagerAboutFavorites(event, product) {
  if (!FAVORITES_ENDPOINT) return;

  clearTimeout(favoritesReportTimer);
  favoritesReportTimer = setTimeout(() => {
    const items = getFavoriteProducts().map(item => ({
      id: item.id,
      title: item.title,
      price: item.price,
      qty: 1
    }));

    const payload = {
      event,
      product: product ? { id: product.id, title: product.title, price: product.price } : null,
      items,
      count: items.length,
      user: currentUser ? {
        id: currentUser.id,
        first_name: currentUser.first_name,
        last_name: currentUser.last_name,
        username: currentUser.username
      } : null,
      at: new Date().toISOString()
    };

    fetch(FAVORITES_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {
      // уведомление не должно мешать покупкам
    });
  }, 700);
}

function renderFavorites() {
  const grid = document.getElementById('favoritesGrid');
  const empty = document.getElementById('favoritesEmpty');
  const actions = document.getElementById('favoritesActions');
  if (!grid || !empty || !actions) return;

  const favoriteProducts = getFavoriteProducts();
  const hasItems = favoriteProducts.length > 0;

  actions.hidden = !hasItems;
  grid.style.display = hasItems ? 'grid' : 'none';
  empty.hidden = hasItems;

  if (!hasItems) {
    grid.innerHTML = '';
    updateFavoriteBadge();
    renderPriceDropHint();
    return;
  }

  grid.innerHTML = favoriteProducts.map(product => buildProductCard(product, {
    priceDrop: priceDrops[product.id] || 0
  })).join('');
  updateFavoriteBadge();
  renderPriceDropHint();
}

function openFavorites() {
  [...modalStack].forEach(modal => closeModal(modal));
  setView('favorites');
}

// ============================================================
// НЕДАВНО ПРОСМОТРЕННЫЕ И ПОХОЖИЕ ТОВАРЫ
// ============================================================

function safeLoadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem('pf_recent') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(Number)
      .filter((id, index, list) => Number.isFinite(id) && list.indexOf(id) === index)
      .slice(0, 8);
  } catch (error) {
    return [];
  }
}

function saveRecent() {
  try {
    localStorage.setItem('pf_recent', JSON.stringify(recentIds));
  } catch (error) {
    // не критично
  }
}

function addRecentProduct(id) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return;

  recentIds = [numericId, ...recentIds.filter(item => Number(item) !== numericId)].slice(0, 8);
  saveRecent();
  renderRecent();
}

function getRecentProducts() {
  return recentIds
    .map(id => products.find(product => Number(product.id) === Number(id)))
    .filter(Boolean)
    .slice(0, 8);
}

function renderRecent() {
  const section = document.getElementById('recentSection');
  const list = document.getElementById('recentList');
  if (!section || !list) return;

  const items = productsLoaded ? getRecentProducts() : [];
  const visible = currentView === 'home' && items.length > 0;

  section.hidden = !visible;
  if (!visible) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = items.map(product => {
    const image = getProductImages(product)[0];
    return `
      <button type="button" class="recent-card" data-recent="${product.id}"
              aria-label="Открыть товар: ${escapeHtml(product.title)}">
        <img src="${image}" alt="${escapeHtml(product.title)}" loading="lazy" decoding="async"
             onerror="this.onerror=null;this.src='${NO_PHOTO}'">
        <span class="recent-card-title">${escapeHtml(product.title)}</span>
        <span class="recent-price">${formatPrice(product.price)}</span>
      </button>`;
  }).join('');
}

function clearRecent() {
  recentIds = [];
  saveRecent();
  renderRecent();
  showToast('История просмотров очищена');
}

function renderSimilar(product) {
  const block = document.getElementById('similarBlock');
  const list = document.getElementById('similarList');
  if (!block || !list || !product) return;

  const sameCategory = products.filter(item =>
    Number(item.id) !== Number(product.id) && item.category === product.category
  );

  const rest = products.filter(item =>
    Number(item.id) !== Number(product.id) && item.category !== product.category
  );

  const rank = item => (Number(item.stock) > 0 ? 0 : 1);
  const sorted = [
    ...sameCategory.sort((a, b) => rank(a) - rank(b) || Number(b.stock) - Number(a.stock)),
    ...rest.sort((a, b) => rank(a) - rank(b) || Number(b.stock) - Number(a.stock))
  ].slice(0, 6);

  block.hidden = sorted.length === 0;
  if (!sorted.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = sorted.map(item => {
    const image = getProductImages(item)[0];
    return `
      <button type="button" class="similar-card" data-similar="${item.id}"
              aria-label="Открыть похожий товар: ${escapeHtml(item.title)}">
        <img src="${image}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async"
             onerror="this.onerror=null;this.src='${NO_PHOTO}'">
        <span class="similar-card-title">${escapeHtml(item.title)}</span>
        <span class="similar-price">${formatPrice(item.price)}</span>
      </button>`;
  }).join('');
}

function clearFavorites() {
  if (!favorites.length) return;

  openConfirm({
    title: 'Очистить избранное?',
    text: `Из избранного будут удалены все товары (${favorites.length}). Это действие нельзя отменить.`,
    confirmText: 'ОЧИСТИТЬ',
    onConfirm: () => {
      favorites = [];
      saveFavorites();
      updateFavoriteUI();
      renderFavorites();
      showToast('Избранное очищено');
      playSound('success');
      triggerHaptic('medium');
    }
  });
}

// ============================================================
// ССЫЛКИ И МЕНЕДЖЕР
// ============================================================

function openTelegramLink(url) {
  if (!url) return;
  try {
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(url);
      return;
    }
  } catch (error) {
    // fallback ниже
  }
  window.open(url, '_blank', 'noopener');
}

function openManagerChat(product, query = '') {
  let text;

  if (product) {
    const stock = Number(product.stock) || 0;
    text = stock > 0
      ? `Здравствуйте! Хочу уточнить по товару: ${product.title} — ${formatPrice(product.price)}`
      : `Здравствуйте! Хочу уточнить сроки поставки: ${product.title} — ${formatPrice(product.price)}`;
  } else {
    const search = String(query || '').trim();
    text = search
      ? `Здравствуйте! Искал(а) в каталоге «${search}», но ничего не нашлось. Подскажите, есть ли такой товар?`
      : 'Здравствуйте! Подскажите, пожалуйста, что есть в наличии.';
  }

  openTelegramLink(`https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`);
  playSound('tap');
  triggerHaptic('selection');
}

async function openStockNotify(product) {
  if (!product) return;

  const initData = ensureTelegramApp()?.initData || '';

  if (ORDERS_ENDPOINT && initData) {
    try {
      const response = await fetch(ORDERS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'watch', productId: String(product.id), initData })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        playSound('success');
        triggerHaptic('success');
        showToast(
          data.canNotify === false
            ? `Готово! Осталось нажать Start в @${TELEGRAM_BOT_USERNAME} — и мы напишем о поступлении`
            : 'Готово! Напишем, как только товар появится',
          data.canNotify === false ? 'error' : 'success'
        );
        return;
      }
    } catch (error) {
      // ниже — резервный вариант через чат с менеджером
    }
  }

  const url = `${location.origin}${location.pathname}?product=${product.id}`;
  const text = `Здравствуйте! Сообщите, пожалуйста, когда появится в наличии: ${product.title} — ${formatPrice(product.price)}. Ссылка: ${url}`;

  openTelegramLink(`https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`);
  playSound('tap');
  triggerHaptic('selection');
  showToast('Запрос открыт в Telegram', 'success');
}

async function loadStockOverrides() {
  if (!ORDERS_ENDPOINT) return;

  try {
    const response = await fetch(`${ORDERS_ENDPOINT}/stock`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;

    const data = await response.json();
    const stock = data?.stock;
    if (!stock || typeof stock !== 'object') return;

    stockOverrides = stock;
    applyStockOverrides();
  } catch (error) {
    // офлайн — остаются значения из products.json
  }
}

function applyStockOverrides() {
  let changed = false;

  products.forEach(product => {
    const value = stockOverrides[String(product.id)];
    if (value !== undefined && Number.isFinite(Number(value))) {
      product.stock = Number(value);
      changed = true;
    }
  });

  if (!changed) return;

  renderCatalog();
  renderRecent();
  updateUI();
  updateFavoriteUI();
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => new Promise((resolve, reject) => {
      try {
        fallbackCopy(text, resolve);
      } catch (error) {
        reject(error);
      }
    }));
  }

  return new Promise((resolve, reject) => {
    try {
      fallbackCopy(text, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function shareProduct(product) {
  if (!product) return;

  const url = `${location.origin}${location.pathname}?product=${product.id}`;
  const text = `${product.title} — ${formatPrice(product.price)}`;

  playSound('tap');
  triggerHaptic('selection');

  if (tg?.openTelegramLink) {
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
    openTelegramLink(shareUrl);
    return;
  }

  if (navigator.share) {
    navigator.share({ title: product.title, text, url }).catch(() => {});
    return;
  }

  copyText(url)
    .then(() => showToast('Ссылка на товар скопирована', 'success'))
    .catch(() => showToast('Не удалось скопировать ссылку', 'error'));
}

// ============================================================
// НАПОМИНАНИЕ О НЕЗАВЕРШЁННОМ ЗАКАЗЕ
// ============================================================

function saveCartSnapshot() {
  if (!cart.length) return;
  try {
    localStorage.setItem(CART_SNAPSHOT_KEY, JSON.stringify({
      ids: cart.map(item => Number(item.id)),
      at: Date.now()
    }));
  } catch (error) {
    // память браузера может быть недоступна
  }
}

function clearCartSnapshot() {
  try {
    localStorage.removeItem(CART_SNAPSHOT_KEY);
  } catch (error) {
    // ничего страшного
  }
}

function readCartSnapshot() {
  try {
    const data = JSON.parse(localStorage.getItem(CART_SNAPSHOT_KEY) || 'null');
    if (!data || !Array.isArray(data.ids) || !data.ids.length) return null;
    return { ids: data.ids.map(Number), at: Number(data.at) || 0 };
  } catch (error) {
    return null;
  }
}

function renderResumeBanner() {
  const banner = document.getElementById('resumeBanner');
  if (!banner) return;

  const snapshot = readCartSnapshot();
  if (!snapshot || !cart.length) {
    banner.hidden = true;
    return;
  }

  const age = Date.now() - snapshot.at;
  if (age < RESUME_MIN_AGE || age > RESUME_MAX_AGE) {
    banner.hidden = true;
    return;
  }

  let dismissedAt = 0;
  try {
    dismissedAt = Number(localStorage.getItem(CART_NUDGE_KEY)) || 0;
  } catch (error) {
    dismissedAt = 0;
  }
  if (dismissedAt && Date.now() - dismissedAt < RESUME_SNOOZE) {
    banner.hidden = true;
    return;
  }

  const first = cart.find(item => snapshot.ids.includes(Number(item.id))) || cart[0];
  const title = document.getElementById('resumeBannerTitle');
  const sub = document.getElementById('resumeBannerSub');

  if (title) title.textContent = `Вы остановились на ${first.title}`;
  if (sub) {
    const stock = Number(first.stock) || 0;
    sub.textContent = stock > 0 && stock <= 3
      ? `Осталось ${stock} шт. — заказ можно оформить в любое время`
      : 'Заказ можно оформить за пару секунд — в любое время';
  }

  banner.hidden = false;
}

function safeLoadCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem('cart') || '[]');
    cart = Array.isArray(parsed)
      ? parsed.filter(item => item && item.id != null && Number.isFinite(Number(item.qty)))
      : [];
  } catch (error) {
    cart = [];
  }

  if (!SORT_MODES.includes(sortMode)) sortMode = 'popular';
  if (promoUsed && appliedPromoPercent > 0) {
    appliedPromoPercent = 0;
    localStorage.setItem('pf_promo_applied', '0');
  }
}

function saveCart() {
  try {
    localStorage.setItem('cart', JSON.stringify(cart));
  } catch (error) {
    console.warn('Не удалось сохранить корзину:', error);
  }
}

function triggerHaptic(type = 'light') {
  try {
    const haptics = tg?.HapticFeedback;
    if (haptics) {
      if (type === 'success' || type === 'error' || type === 'warning') {
        haptics.notificationOccurred(type);
      } else if (type === 'selection') {
        haptics.selectionChanged();
      } else {
        haptics.impactOccurred(['light', 'medium', 'heavy'].includes(type) ? type : 'light');
      }
    } else if (navigator.vibrate) {
      const patterns = {
        success: [18, 40, 18],
        error: [40, 60, 40],
        warning: [30, 50, 30],
        selection: 12,
        medium: 35,
        heavy: 50
      };
      navigator.vibrate(patterns[type] || 22);
    }
  } catch (error) {
    // вибрация не критична
  }
}

// ============================================================
// ЗВУКИ (Web Audio, без файлов)
// ============================================================

function getAudioContext() {
  if (!soundState.ctx) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    soundState.ctx = new AudioCtor();
  }
  if (soundState.ctx.state === 'suspended') {
    soundState.ctx.resume().catch(() => {});
  }
  return soundState.ctx;
}

function playTone(freq, duration, { type = 'sine', gain = 0.05, delay = 0, endFreq = null } = {}) {
  const ctx = getAudioContext();
  if (!ctx) return;

  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const volume = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), start + duration);

  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(volume);
  volume.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function playSound(name) {
  if (!soundState.enabled) return;
  try {
    if (name === 'tap') {
      playTone(520, 0.055, { gain: 0.032 });
    } else if (name === 'add') {
      playTone(660, 0.09, { gain: 0.05, type: 'triangle' });
      playTone(990, 0.13, { gain: 0.042, type: 'sine', delay: 0.055 });
    } else if (name === 'success') {
      playTone(660, 0.1, { gain: 0.045 });
      playTone(880, 0.12, { gain: 0.045, delay: 0.08 });
      playTone(1100, 0.16, { gain: 0.04, delay: 0.16 });
    } else if (name === 'error') {
      playTone(220, 0.1, { gain: 0.05, type: 'square' });
      playTone(180, 0.14, { gain: 0.04, type: 'square', delay: 0.09 });
    }
  } catch (error) {
    // звук не критичен
  }
}

function updateSoundToggle() {
  const button = document.getElementById('soundToggle');
  if (!button) return;

  button.classList.toggle('muted', !soundState.enabled);
  button.setAttribute('aria-pressed', String(soundState.enabled));
  button.setAttribute('aria-label', soundState.enabled ? 'Выключить звуковые эффекты' : 'Включить звуковые эффекты');
  button.querySelector('.sound-on')?.toggleAttribute('hidden', !soundState.enabled);
  button.querySelector('.sound-off')?.toggleAttribute('hidden', soundState.enabled);
}

function toggleSound() {
  soundState.enabled = !soundState.enabled;
  localStorage.setItem('pf_sound', soundState.enabled ? 'on' : 'off');
  updateSoundToggle();
  if (soundState.enabled) playSound('tap');
  triggerHaptic('selection');
}

// ============================================================
// УВЕДОМЛЕНИЯ В СТИЛЕ IPHONE
// ============================================================

function showNotification({ title, text = '', image = '', type = 'success', icon = '', duration = 2600, onClick = null }) {
  const stack = document.getElementById('notificationStack');
  if (!stack || !title) return;

  while (stack.children.length >= 2) {
    stack.firstElementChild.remove();
  }

  const el = document.createElement('button');
  el.type = 'button';
  el.className = `app-notification ${type}`;
  el.setAttribute('aria-label', [title, text].filter(Boolean).join('. '));
  const iconText = escapeHtml(icon || (type === 'error' ? '!' : '✓'));
  el.innerHTML = `
    <span class="app-notification-media">
      ${image
        ? `<img src="${escapeHtml(image)}" alt="">`
        : `<span class="app-notification-icon">${iconText}</span>`}
    </span>
    <span class="app-notification-body">
      <span class="app-notification-title">${escapeHtml(title)}</span>
      ${text ? `<span class="app-notification-text">${escapeHtml(text)}</span>` : ''}
    </span>
    <span class="app-notification-badge">${iconText}</span>
  `;

  let timer = null;
  const remove = () => {
    clearTimeout(timer);
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 220);
  };

  el.addEventListener('click', () => {
    remove();
    if (onClick) onClick();
  }, { once: true });

  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  timer = setTimeout(remove, duration);
}

// ============================================================
// АВАТАР И ПРИВЕТСТВИЕ
// ============================================================

function getGreetingPhrase() {
  const hour = getStoreHour();
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  if (hour >= 18 && hour < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

function setAvatar(el, user) {
  if (!el) return;

  const initial = String(user?.first_name || user?.username || 'Г').trim().charAt(0).toUpperCase() || 'Г';
  el.innerHTML = '';

  if (user?.photo_url) {
    const img = document.createElement('img');
    img.alt = user.first_name || 'Аватар';
    img.loading = 'lazy';
    img.decoding = 'async';

    const fallback = () => {
      el.innerHTML = `<span class="avatar-initials">${escapeHtml(initial)}</span>`;
    };

    img.addEventListener('error', fallback, { once: true });
    el.appendChild(img);
    img.src = user.photo_url;

    if (img.complete && img.naturalWidth === 0) fallback();
  } else {
    el.innerHTML = `<span class="avatar-initials">${escapeHtml(initial)}</span>`;
  }
}

function updateGreeting(user) {
  const phrase = getGreetingPhrase();
  const small = document.getElementById('greetingSmall');
  if (small) small.textContent = `${phrase.toUpperCase()},`;

  const nameEl = document.getElementById('tgUserName');
  if (nameEl) nameEl.textContent = user?.first_name ? `${user.first_name.toUpperCase()}!` : 'ГОСТЬ!';

  const logoEl = document.querySelector('.logo');
  if (logoEl) {
    const who = user?.first_name || 'гость';
    logoEl.setAttribute('aria-label', `${phrase}, ${who}! Открыть профиль`);
  }
}

function renderUserProfile(user) {
  if (!user) return;

  currentUser = user;
  updateGreeting(user);
  setAvatar(document.getElementById('headerAvatar'), user);
  setAvatar(document.querySelector('.profile-avatar'), user);

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  const profileName = document.getElementById('profileName');
  if (profileName) profileName.textContent = (fullName || user.first_name || 'ПОЛЬЗОВАТЕЛЬ').toUpperCase();

  const usernameEl = document.getElementById('profileUsername');
  if (usernameEl) {
    if (user.username) {
      usernameEl.textContent = `@${user.username}`;
      usernameEl.hidden = false;
    } else {
      usernameEl.hidden = true;
    }
  }
}

// ============================================================
// АНИМАЦИЯ «УЛЕТАЕТ В КОРЗИНУ»
// ============================================================

function findCartSource(id) {
  const modalImage = document.querySelector('#productModal.active .product-gallery img');
  if (modalImage) return modalImage;

  const images = document.querySelectorAll(`.card[data-id="${id}"] .img-main img`);
  for (const image of images) {
    if (image.getBoundingClientRect().width > 0) return image;
  }
  return images[0] || null;
}

function flyToCart(source) {
  if (!source) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const cartIcon = document.getElementById('cartIcon');
  const image = source.currentSrc || source.src;
  if (!cartIcon || !image) return;

  const from = source.getBoundingClientRect();
  const to = cartIcon.getBoundingClientRect();
  if (!from.width || !from.height) return;
  if (from.bottom < 0 || from.top > window.innerHeight || from.right < 0 || from.left > window.innerWidth) return;

  const clone = document.createElement('img');
  clone.src = image;
  clone.alt = '';
  clone.className = 'fly-thumb';
  clone.style.top = `${from.top}px`;
  clone.style.left = `${from.left}px`;
  clone.style.width = `${from.width}px`;
  clone.style.height = `${from.height}px`;
  document.body.appendChild(clone);

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);

  try {
    const animation = clone.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1, borderRadius: '12px' },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.35 - 40}px) scale(0.5)`, opacity: 0.9, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.1)`, opacity: 0, borderRadius: '50%' }
    ], {
      duration: 520,
      easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)'
    });
    animation.onfinish = () => clone.remove();
  } catch (error) {
    clone.remove();
  }
}

function showToast(message, type = '') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  while (container.children.length >= 3) {
    container.firstElementChild.remove();
  }

  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ` ${type}` : '');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ============================================================
// МОДАЛЬНЫЕ ОКНА
// ============================================================

const modalFocusReturn = new WeakMap();

function getFocusable(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null || el === document.activeElement);
}

function openModal(target) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;

  if (!el.classList.contains('active')) {
    modalFocusReturn.set(el, document.activeElement);
  }

  el.classList.add('active');
  el.removeAttribute('aria-hidden');
  if (!modalStack.includes(el)) modalStack.push(el);
  document.body.classList.add('modal-open');
  updateBackButton();

  if (!el.id.startsWith('confirm')) {
    requestAnimationFrame(() => {
      if (!modalStack.length || modalStack[modalStack.length - 1] !== el) return;
      if (el.contains(document.activeElement) && document.activeElement !== document.body) return;
      const focusable = getFocusable(el);
      (focusable[0] || el).focus({ preventScroll: true });
    });
  }
}

function closeModal(target) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;

  const wasActive = el.classList.contains('active');

  el.classList.remove('active');
  el.setAttribute('aria-hidden', 'true');
  const index = modalStack.indexOf(el);
  if (index !== -1) modalStack.splice(index, 1);

  if (!modalStack.length) {
    document.body.classList.remove('modal-open');
  }

  if (el.id === 'confirmModal') {
    confirmCallback = null;
    const returnFocus = confirmReturnFocus;
    confirmReturnFocus = null;
    if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
      setTimeout(() => returnFocus.focus({ preventScroll: true }), 50);
    }
  } else if (wasActive) {
    const returnFocus = modalFocusReturn.get(el);
    if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
      setTimeout(() => returnFocus.focus({ preventScroll: true }), 50);
    }
  }

  if (el.id === 'productModal') {
    resetProductSeo();
    renderRecent();
  }

  updateBackButton();
}

function trapModalFocus(event) {
  if (event.key !== 'Tab' || !modalStack.length) return;

  const top = modalStack[modalStack.length - 1];
  const focusable = getFocusable(top);

  if (!focusable.length) {
    event.preventDefault();
    top.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey) {
    if (document.activeElement === first || !top.contains(document.activeElement)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    }
  } else if (document.activeElement === last || !top.contains(document.activeElement)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape' && modalStack.length) {
    event.preventDefault();
    closeTopModal();
    return;
  }
  trapModalFocus(event);
}

const CONFIRM_ICONS = {
  trash: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>',
  send: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>'
};

// Брендированное подтверждение действий
function openConfirm({ title, text, confirmText = 'ПОДТВЕРДИТЬ', onConfirm = null, icon = 'trash' }) {
  const modal = document.getElementById('confirmModal');
  if (!modal) {
    if (onConfirm && window.confirm(title || 'Подтвердить действие?')) onConfirm();
    return;
  }

  confirmCallback = onConfirm;
  confirmReturnFocus = document.activeElement;

  const titleEl = document.getElementById('confirmTitle');
  const textEl = document.getElementById('confirmText');
  const okBtn = document.getElementById('confirmOk');
  const iconEl = modal.querySelector('.confirm-icon');

  if (titleEl) titleEl.textContent = title || 'Подтвердить действие?';
  if (textEl) textEl.textContent = text || 'Это действие нельзя отменить.';
  if (okBtn) okBtn.textContent = confirmText;
  if (iconEl) {
    iconEl.innerHTML = CONFIRM_ICONS[icon] || CONFIRM_ICONS.trash;
    iconEl.classList.toggle('send', icon === 'send');
  }

  openModal(modal);
  requestAnimationFrame(() => {
    document.getElementById('confirmCancel')?.focus({ preventScroll: true });
  });
}

function closeConfirm() {
  closeModal('confirmModal');
}

function runConfirm() {
  const callback = confirmCallback;
  closeModal('confirmModal');
  if (callback) callback();
}

function closeTopModal() {
  const top = modalStack[modalStack.length - 1];
  if (top) closeModal(top);
}

function updateBackButton() {
  if (!tg?.BackButton) return;
  try {
    if (modalStack.length) tg.BackButton.show();
    else tg.BackButton.hide();
  } catch (error) {
    // Telegram может не поддерживать BackButton
  }
}

function initBackButton() {
  if (!tg?.BackButton) return;
  try {
    tg.BackButton.onClick(closeTopModal);
  } catch (error) {
    // ignore
  }
}

function openCart() {
  renderCartItems();
  openModal('cartModal');
  playSound('tap');
  triggerHaptic('selection');
}

// ============================================================
// TELEGRAM
// ============================================================

function ensureTelegramApp() {
  if (!tg && window.Telegram?.WebApp) tg = window.Telegram.WebApp;
  return tg;
}

function parseInitDataUser(initData) {
  if (!initData || typeof initData !== 'string') return null;
  try {
    const raw = new URLSearchParams(initData).get('user');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function readTelegramUser() {
  const app = ensureTelegramApp();
  if (!app) return null;

  const direct = app.initDataUnsafe?.user;
  if (direct && (direct.id || direct.first_name)) return direct;

  const parsed = parseInitDataUser(app.initData);
  if (parsed && (parsed.id || parsed.first_name)) return parsed;

  return null;
}

function isTelegramEnvironment() {
  const app = ensureTelegramApp();
  if (!app) return false;
  if (app.initData) return true;
  const platform = String(app.platform || '').toLowerCase();
  return Boolean(platform) && platform !== 'unknown';
}

function detectManager(user) {
  if (!user) {
    try {
      const params = new URLSearchParams(location.search);
      return params.get(MANAGER_QUERY_PARAM) === '1';
    } catch (error) {
      return false;
    }
  }

  const username = String(user.username || '').toLowerCase();
  if (username && MANAGER_USERNAMES.includes(username)) return true;
  if (MANAGER_IDS.some(id => String(id) === String(user.id))) return true;

  const startParam = ensureTelegramApp()?.initDataUnsafe?.start_param;
  if (String(startParam || '').toLowerCase() === 'manager') return true;

  try {
    return new URLSearchParams(location.search).get(MANAGER_QUERY_PARAM) === '1';
  } catch (error) {
    return false;
  }
}

function setTelegramStatus(state) {
  const el = document.getElementById('profileTelegramLine');
  if (!el) return;
  const hint = document.getElementById('profileTelegramHint');
  if (hint) hint.hidden = state === 'connected';

  el.classList.remove('connected', 'error');

  if (state === 'connected') {
    el.classList.add('connected');
    el.textContent = isManager ? 'Telegram · менеджер' : 'Telegram подключён';
    el.title = currentUser?.username ? `@${currentUser.username}` : 'Профиль Telegram активен';
  } else if (state === 'error') {
    el.classList.add('error');
    el.textContent = 'Telegram не ответил';
    el.title = 'Данные профиля не пришли. Перезапустите мини-приложение.';
  } else {
    el.textContent = TELEGRAM_BOT_USERNAME ? 'Открыть в Telegram' : 'Откройте через Telegram';
    el.title = 'Имя и аватар подтягиваются только в мини-приложении Telegram';
  }
}

function initTelegramBanner() {
  const banner = document.getElementById('tgBanner');
  if (!banner) return;

  const dismissed = localStorage.getItem('pf_tg_banner') === 'off';
  const inTelegram = isTelegramEnvironment() || /Telegram/i.test(navigator.userAgent);

  if (dismissed || inTelegram) {
    banner.hidden = true;
    return;
  }

  const closeBtn = document.getElementById('tgBannerClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      banner.hidden = true;
      localStorage.setItem('pf_tg_banner', 'off');
    });
  }

  banner.hidden = false;
}

function applyManagerUI() {
  const roleEl = document.getElementById('profileRole');
  const subtitleEl = document.getElementById('profileSubtitle');
  if (roleEl) roleEl.hidden = !isManager;
  if (subtitleEl) subtitleEl.textContent = isManager ? 'Менеджер PF Store' : 'Покупатель PF Store';
}

function applyTelegramUser(user) {
  if (!user || !(user.id || user.first_name)) return false;

  currentUser = user;
  isManager = detectManager(user);

  renderUserProfile(user);
  applyManagerUI();
  setTelegramStatus('connected');
  updateOrderBadge();
  return true;
}

function initTelegram() {
  const app = ensureTelegramApp();

  if (!app) {
    isManager = detectManager(null);
    applyManagerUI();
    setTelegramStatus('guest');
    return;
  }

  try {
    app.ready();
    app.expand();
  } catch (error) {
    // ignore
  }

  try {
    app.setHeaderColor?.('#67E9D1');
    app.setBackgroundColor?.('#050505');
  } catch (error) {
    // старые версии Telegram
  }

  const tryResolve = () => {
    const user = readTelegramUser();
    return user ? applyTelegramUser(user) : false;
  };

  if (!tryResolve()) {
    // initData может появиться с задержкой — пробуем несколько раз
    [120, 350, 800, 1600, 2600].forEach(delay => {
      setTimeout(() => {
        if (!currentUser) tryResolve();
      }, delay);
    });

    setTimeout(() => {
      if (!currentUser) {
        setTelegramStatus(isTelegramEnvironment() ? 'error' : 'guest');
        isManager = detectManager(null);
        applyManagerUI();
      }
    }, 3200);
  }

  initBackButton();
}

// ============================================================
// ЗАКАЗЫ
// ============================================================

const ORDER_STATUS_LABELS = {
  created: 'СОЗДАН',
  manager: 'У МЕНЕДЖЕРА',
  delivery: 'В ДОСТАВКЕ',
  received: 'ПОЛУЧЕН',
  canceled: 'ОТМЕНЁН'
};

// Старые статусы (до 4 этапов) продолжают приходить из истории и из KV.
const ORDER_STATUS_MIGRATION = {
  awaiting: 'created',
  sent: 'manager',
  delivered: 'received'
};

function normalizeOrderStatus(status) {
  const normalized = ORDER_STATUS_MIGRATION[status] || status;
  return ORDER_STATUS_LABELS[normalized] ? normalized : 'created';
}

function isTestOrder(order) {
  return Boolean(order) && (order.test === true || /^test/i.test(String(order.id || '')));
}


function safeLoadOrders() {
  try {
    const parsed = JSON.parse(localStorage.getItem('pf_orders') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(order => order && order.id && Array.isArray(order.items))
      .map(order => ({
        ...order,
        status: normalizeOrderStatus(order.status)
      }));
  } catch (error) {
    return [];
  }
}

function saveOrders() {
  try {
    localStorage.setItem('pf_orders', JSON.stringify(orders));
  } catch (error) {
    // история не критична для покупки
  }
}

function formatOrderDate(value) {
  return formatStoreDateTime(value);
}

function createOrderRecord(totals, items, customer = null) {
  const now = new Date();

  return {
    id: `PF-${now.getTime().toString(36).toUpperCase().slice(-5)}`,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: 'created',
    items: items.map(item => ({
      id: Number(item.id),
      title: String(item.title || ''),
      price: Number(item.price) || 0,
      qty: Number(item.qty) || 1,
      stock: Number(item.stock) || 0,
      gift: item.gift_desc ? String(item.gift_desc) : ''
    })),
    subtotal: totals.subtotal,
    qtyDiscount: totals.qtyDiscountAmount || 0,
    promoCode: appliedPromoPercent > 0 ? myPromoCode : '',
    promoPercent: appliedPromoPercent,
    promoDiscount: totals.promoDiscountAmount || 0,
    total: totals.total,
    customer: customer ? {
      name: String(customer.name || '').trim(),
      phone: String(customer.phone || '').trim()
    } : null,
    delivery: customer ? {
      method: ['pickup', 'city', 'russia'].includes(customer.delivery) ? customer.delivery : 'pickup',
      address: String(customer.address || '').trim(),
      comment: String(customer.comment || '').trim()
    } : null,
    user: currentUser ? {
      id: currentUser.id ?? null,
      username: currentUser.username || '',
      first_name: currentUser.first_name || ''
    } : null
  };
}

function buildOrderMessage(order) {
  const lines = [`Здравствуйте! Хочу оформить заказ ${order.id} в ${STORE_NAME}.`];

  if (order.user?.first_name || order.user?.username) {
    const who = [
      order.user.first_name,
      order.user.username ? `@${order.user.username}` : ''
    ].filter(Boolean).join(' · ');
    lines.push(`Покупатель: ${who}`);
  }

  if (order.customer?.name || order.customer?.phone) {
    const contact = [order.customer.name, order.customer.phone].filter(Boolean).join(', ');
    lines.push(`Контакт: ${contact}`);
  }

  lines.push('');

  order.items.forEach(item => {
    lines.push(`• ${item.title}${Number(item.stock) <= 0 ? ' (под заказ)' : ''}`);
    lines.push(`  ${item.qty} шт. × ${formatPrice(item.price)} = ${formatPrice(item.price * item.qty)}`);
    if (item.gift) {
      lines.push(`  🎁 Подарок: ${String(item.gift).replace('🎁', '').trim()}`);
    }
  });

  lines.push('');

  if (order.qtyDiscount > 0) {
    lines.push(`Скидка за количество (5%): -${formatPrice(order.qtyDiscount)}`);
  }
  if (order.promoPercent > 0) {
    lines.push(`Промокод ${order.promoCode} (-${order.promoPercent}%): -${formatPrice(order.promoDiscount)}`);
  }

  lines.push(`Итого: ${formatPrice(order.total)}`);

  const deliveryMethod = order.delivery?.method;
  if (deliveryMethod === 'city') {
    lines.push('Получение: доставка по Барнаулу — бесплатно');
    lines.push(order.delivery.address ? `Адрес: ${order.delivery.address}` : 'Адрес уточню в чате');
  } else if (deliveryMethod === 'russia') {
    lines.push('Получение: отправка по России');
    lines.push(order.delivery.address ? `Город и адрес: ${order.delivery.address}` : 'Город и адрес уточню в чате');
    lines.push('Стоимость доставки подтвердите, пожалуйста, в чате.');
  } else if (deliveryMethod === 'pickup') {
    lines.push(`Получение: самовывоз — Барнаул, Павловский тракт, 307к3 (${STORE_OPEN_HOUR}:00–${STORE_CLOSE_HOUR}:00)`);
  } else {
    lines.push(`Самовывоз: Барнаул, Павловский тракт, 307к3 (${STORE_OPEN_HOUR}:00–${STORE_CLOSE_HOUR}:00)`);
  }

  if (order.delivery?.comment) {
    lines.push(`Комментарий: ${order.delivery.comment}`);
  }

  lines.push('Подтвердите, пожалуйста, наличие и удобное время выдачи.');

  return lines.join('\n');
}

function orderTelegramUrl(order) {
  const text = order.message || buildOrderMessage(order);
  return `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`;
}

function syncOrder(order) {
  if (!ORDERS_ENDPOINT || !order) return;

  fetch(ORDERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'order', order, initData: ensureTelegramApp()?.initData || '' }),
    keepalive: true
  }).catch(() => {
    // синхронизация не должна мешать оформлению
  });
}

function syncOrderStatus(order) {
  if (!ORDERS_ENDPOINT || !order) return;

  fetch(ORDERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'status',
      id: order.id,
      status: order.status,
      initData: ensureTelegramApp()?.initData || ''
    }),
    keepalive: true
  }).catch(() => {
    // статус останется локальным до следующей синхронизации
  });
}

async function loadOrdersFromServer() {
  if (!ORDERS_ENDPOINT || ordersLoading) return;

  const initData = ensureTelegramApp()?.initData || '';
  // Без мини-приложения Telegram сервер не отдаст заказы — не шлём лишний запрос.
  if (!initData) return;

  ordersLoading = true;

  try {
    const url = new URL(ORDERS_ENDPOINT, location.href);
    url.searchParams.set('initData', initData);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return;

    const data = await response.json();
    const remote = Array.isArray(data?.orders) ? data.orders : [];
    if (!remote.length) return;

    const byId = new Map(orders.map(order => [order.id, order]));
    remote.forEach(order => {
      if (!order?.id || !Array.isArray(order.items)) return;
      order.status = normalizeOrderStatus(order.status);
      const local = byId.get(order.id);
      const remoteTime = new Date(order.updatedAt || order.createdAt || 0).getTime();
      const localTime = new Date(local?.updatedAt || local?.createdAt || 0).getTime();
      if (!local || remoteTime >= localTime) byId.set(order.id, order);
    });

    orders = [...byId.values()];
    saveOrders();
    updateOrderBadge();
    if (document.getElementById('ordersModal')?.classList.contains('active')) renderOrders();
  } catch (error) {
    // офлайн — остаётся локальная история
  } finally {
    ordersLoading = false;
  }
}

function updateOrderBadge() {
  const el = document.getElementById('profileOrdersCount');
  if (!el) return;

  const realOrders = orders.filter(order => !isTestOrder(order));

  if (!realOrders.length) {
    el.textContent = 'Пока нет заказов';
    el.classList.remove('warn');
    return;
  }

  const awaiting = realOrders.filter(order => normalizeOrderStatus(order.status) === 'created').length;
  const total = realOrders.length;
  el.textContent = awaiting > 0
    ? `${total} ${plural(total, 'заказ', 'заказа', 'заказов')} · ${awaiting} ждёт подтверждения`
    : `${total} ${plural(total, 'заказ', 'заказа', 'заказов')}`;
  el.classList.toggle('warn', awaiting > 0);
}

function openOrders() {
  renderOrders();
  openModal('ordersModal');
  playSound('tap');
  triggerHaptic('selection');
  if (ORDERS_ENDPOINT) loadOrdersFromServer();
}

function renderOrderActions(order) {
  const id = escapeHtml(order.id);
  const status = normalizeOrderStatus(order.status);
  const actions = [];
  const btn = (action, label, primary = false) => `
    <button type="button" class="order-action-btn${primary ? ' primary' : ''}"
      data-order-action="${action}" data-order-id="${id}">${label}</button>`;

  if (status === 'created') {
    if (isManager) {
      actions.push(btn('manager', 'Принять', true));
    } else {
      actions.push(btn('sent', 'Я отправил', true));
      actions.push(btn('resend', 'Открыть Telegram'));
    }
  } else if (status === 'manager') {
    actions.push(btn('reorder', 'Повторить заказ'));
    if (isManager) {
      actions.push(btn('delivery', 'В доставку', true));
    } else {
      actions.push(btn('resend', 'Написать менеджеру'));
    }
  } else if (status === 'delivery') {
    actions.push(btn('reorder', 'Повторить заказ'));
    if (isManager) {
      actions.push(btn('received', 'Получен', true));
    } else {
      actions.push(btn('resend', 'Написать менеджеру'));
    }
  } else if (status === 'received') {
    actions.push(btn('reorder', 'Повторить заказ'));
    actions.push(btn('resend', 'Написать менеджеру'));
  } else if (status === 'canceled') {
    actions.push(btn('reorder', 'Повторить заказ'));
  }

  if (isManager && status !== 'canceled') {
    actions.push(btn('canceled', 'Отменить'));
  }

  if (isManager && isTestOrder(order)) {
    actions.push(btn('delete', 'Удалить тестовый'));
  }

  return actions.length ? `<div class="order-actions">${actions.join('')}</div>` : '';
}

function renderOrderTimeline(order) {
  const status = normalizeOrderStatus(order.status);
  if (status === 'canceled') return '';

  const progress = { created: 1, manager: 2, delivery: 3, received: 4 }[status] ?? 1;
  const currentIndex = progress - 1;
  const steps = ['Создан', 'У менеджера', 'Доставка', 'Получен'].map((label, index) => {
    let state = '';
    if (index < currentIndex) state = 'done';
    else if (index === currentIndex) state = status === 'received' ? 'done' : 'current';
    return { label, state };
  });

  return `<div class="order-timeline ${status}" aria-label="Этапы заказа: ${steps.map(step => step.label).join(', ')}">
    ${steps.map((step, index) => `
      <div class="order-step ${step.state}" style="--step-index:${index}">
        <span class="order-step-dot" aria-hidden="true"></span>
        <span class="order-step-label">${step.label}</span>
      </div>`).join('')}
  </div>`;
}

function renderOrderDelivery(order) {
  const method = order.delivery?.method;
  if (!method) return '';

  const labels = {
    pickup: 'Самовывоз · Барнаул, Павловский тракт, 307к3',
    city: 'Доставка по Барнаулу · бесплатно',
    russia: 'Отправка по России · стоимость подтвердит менеджер'
  };

  const parts = [labels[method] || labels.pickup];
  if (order.delivery.address) parts.push(order.delivery.address);
  if (order.delivery.comment) parts.push(`Комментарий: ${order.delivery.comment}`);

  return `<div class="order-delivery">${escapeHtml(parts.join(' · '))}</div>`;
}

function renderOrders() {
  const body = document.getElementById('ordersBody');
  if (!body) return;

  const subtitle = document.getElementById('ordersSubtitle');
  if (subtitle) subtitle.textContent = isManager ? 'Панель менеджера' : 'История заказов';

  const list = orders
    .filter(order => isManager || !isTestOrder(order))
    .sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });

  const toolbar = `
    <div class="orders-toolbar${isManager ? ' manager' : ''}">
      <span>${isManager
        ? (ORDERS_ENDPOINT
          ? 'Все заказы магазина · меняйте этапы заказа'
          : 'Заказы на этом устройстве · меняйте этапы заказа')
        : (ORDERS_ENDPOINT
          ? 'Статусы синхронизируются с менеджером'
          : 'Статус заказа подтверждается вручную')}</span>
      <span class="orders-toolbar-badge">${isManager ? 'МЕНЕДЖЕР' : (ORDERS_ENDPOINT ? 'ОНЛАЙН' : 'ЛОКАЛЬНО')}</span>
    </div>`;

  if (!list.length) {
    body.innerHTML = `${toolbar}
      <div class="orders-empty">
        <div class="orders-empty-icon" aria-hidden="true">📦</div>
        <div class="orders-empty-title">Заказов пока нет</div>
        <p class="orders-empty-text">Оформите заказ — он появится здесь, и вы сможете следить за этапами: создан, у менеджера, доставка, получен.</p>
        <button type="button" class="empty-reset" data-order-action="shop">ПЕРЕЙТИ К ПОКУПКАМ</button>
      </div>`;
    return;
  }

  body.innerHTML = toolbar + list.map(order => {
    const status = normalizeOrderStatus(order.status);
    const discountLines = [];

    if (order.qtyDiscount > 0) {
      discountLines.push(`<div class="order-discount-line"><span>Скидка за количество</span><span>-${formatPrice(order.qtyDiscount)}</span></div>`);
    }
    if (order.promoPercent > 0) {
      discountLines.push(`<div class="order-discount-line"><span>Промокод ${escapeHtml(order.promoCode || '')}</span><span>-${formatPrice(order.promoDiscount)}</span></div>`);
    }

    const buyer = isManager && order.user
      ? [order.user.first_name, order.user.username ? `@${order.user.username}` : ''].filter(Boolean).join(' · ')
      : '';

    return `
      <article class="order-card">
        <div class="order-card-head">
          <div class="order-id-block">
            <div class="order-id-row">
              <span class="order-id">${escapeHtml(order.id)}</span>
              <button type="button" class="order-copy-btn" data-order-action="copy" data-order-id="${escapeHtml(order.id)}"
                      aria-label="Скопировать номер заказа ${escapeHtml(order.id)}" title="Скопировать номер">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
            </div>
            <div class="order-date">${formatOrderDate(order.createdAt)}${order.cancelNote ? ` · ${escapeHtml(order.cancelNote)}` : ''}</div>
          </div>
          <span class="order-status ${status}">${ORDER_STATUS_LABELS[status]}</span>
        </div>
        ${isManager && isTestOrder(order) ? '<div class="order-test-note">Тестовый заказ · не входит в историю и отчёт</div>' : ''}
        ${renderOrderTimeline(order)}
        <div class="order-items">
          ${order.items.map(item => `
            <div class="order-item-line">
              <span>${escapeHtml(item.title)} × ${item.qty}</span>
              <span>${formatPrice(Number(item.price) * Number(item.qty))}</span>
            </div>`).join('')}
        </div>
        ${discountLines.length ? `<div class="order-discounts">${discountLines.join('')}</div>` : ''}
        <div class="order-total-row"><span>Итого</span><strong>${formatPrice(order.total)}</strong></div>
        ${renderOrderDelivery(order)}
        ${buyer ? `<div class="order-buyer">Покупатель: ${escapeHtml(buyer)}</div>` : ''}
        ${renderOrderActions(order)}
      </article>`;
  }).join('') + `
    <div class="orders-local-note">${isManager
      ? (ORDERS_ENDPOINT
        ? 'Заказы синхронизируются с Cloudflare Worker. История сохраняется полностью: отменённые и полученные заказы остаются в списке.'
        : 'Панель работает на этом устройстве. Для синхронизации между устройствами подключите ORDERS_ENDPOINT — инструкция в папке worker.')
      : (ORDERS_ENDPOINT
        ? 'История синхронизируется с сервером. Этапы заказа: создан → у менеджера → доставка → получен.'
        : 'История хранится на этом устройстве. Этапы заказа: создан → у менеджера → доставка → получен.')}</div>`;
}

function askOrderConfirmation(orderId) {
  const order = orders.find(item => item.id === orderId);
  if (!order || normalizeOrderStatus(order.status) !== 'created') return;
  if (document.getElementById('confirmModal')?.classList.contains('active')) return;

  openConfirm({
    title: 'Сообщение отправлено?',
    text: `Заказ ${order.id} пока сохранён как «создан». Нажмите «Я ОТПРАВИЛ» только если сообщение действительно ушло менеджеру. Если нет — заказ останется в профиле, и его можно отправить позже.`,
    confirmText: 'Я ОТПРАВИЛ',
    icon: 'send',
    onConfirm: () => markOrderSent(order.id)
  });
}

function markOrderSent(orderId) {
  const order = orders.find(item => item.id === orderId);
  if (!order) return;
  if (normalizeOrderStatus(order.status) === 'manager') {
    showToast('Заказ уже у менеджера');
    return;
  }

  const now = new Date().toISOString();
  order.status = 'manager';
  order.confirmedAt = now;
  order.updatedAt = now;
  order.confirmedBy = 'user';
  saveOrders();
  syncOrder(order);

  // Промокод считается использованным только после подтверждения отправки
  if (order.promoPercent > 0) {
    promoUsed = true;
    localStorage.setItem('pf_promo_used', 'true');
  }
  appliedPromoPercent = 0;
  localStorage.setItem('pf_promo_applied', '0');

  // Убираем из корзины только позиции этого заказа
  order.items.forEach(line => {
    const cartItem = cart.find(item => Number(item.id) === Number(line.id));
    if (!cartItem) return;
    cartItem.qty -= Number(line.qty) || 0;
    if (cartItem.qty <= 0) cart = cart.filter(item => item !== cartItem);
  });

  if (!cart.length) hasShownQtyDiscountToast = false;
  saveCart();
  clearCartSnapshot();
  updateUI();
  renderOrders();
  updateOrderBadge();

  showToast('Заказ отмечен как отправленный', 'success');
  playSound('success');
  triggerHaptic('success');
  showNotification({
    title: 'Отправлено менеджеру',
    text: `${order.id} · ${formatPrice(order.total)}`,
    type: 'order',
    duration: 3200
  });
}

function setOrderStatus(orderId, status) {
  if (!isManager) {
    showToast('Доступно только менеджеру', 'error');
    return;
  }

  const nextStatus = normalizeOrderStatus(status);
  if (!ORDER_STATUS_LABELS[nextStatus]) return;

  const order = orders.find(item => item.id === orderId);
  if (!order || normalizeOrderStatus(order.status) === nextStatus) return;

  const now = new Date().toISOString();
  order.status = nextStatus;
  order.updatedAt = now;
  order.updatedBy = currentUser?.username || currentUser?.first_name || 'manager';

  if ((nextStatus === 'manager' || nextStatus === 'delivery' || nextStatus === 'received') && !order.confirmedAt) {
    order.confirmedAt = now;
  }
  if (nextStatus === 'delivery' && !order.shippedAt) order.shippedAt = now;
  if (nextStatus === 'received') {
    if (!order.deliveredAt) order.deliveredAt = now;
    if (!order.receivedAt) order.receivedAt = now;
  }

  saveOrders();
  syncOrderStatus(order);
  renderOrders();
  updateOrderBadge();
  renderCartItems();
  showToast(`Статус: ${ORDER_STATUS_LABELS[nextStatus].toLowerCase()}`, 'success');
  playSound('success');
  triggerHaptic('success');
}

function deleteTestOrder(orderId) {
  if (!isManager) return;

  const order = orders.find(item => item.id === orderId);
  if (!order || !isTestOrder(order)) {
    showToast('Удалять можно только тестовые заказы', 'error');
    return;
  }

  openConfirm({
    title: 'Удалить тестовый заказ?',
    text: `Заказ ${order.id} будет удалён навсегда и не попадёт в историю и отчёт.`,
    confirmText: 'УДАЛИТЬ',
    icon: 'trash',
    onConfirm: async () => {
      orders = orders.filter(item => item.id !== orderId);
      saveOrders();
      renderOrders();
      updateOrderBadge();

      const initData = ensureTelegramApp()?.initData || '';
      if (ORDERS_ENDPOINT && initData) {
        try {
          await fetch(ORDERS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'delete', id: orderId, initData })
          });
        } catch (error) {
          // локально уже удалён; сервер можно почистить позже
        }
      }

      showToast('Тестовый заказ удалён', 'success');
    }
  });
}

function resendOrder(orderId) {
  const order = orders.find(item => item.id === orderId);
  if (!order) return;

  openTelegramLink(orderTelegramUrl(order));
  playSound('tap');
  triggerHaptic('selection');
  showToast('Сообщение открыто в Telegram', 'success');

  if (normalizeOrderStatus(order.status) === 'created') {
    setTimeout(() => askOrderConfirmation(order.id), 600);
  }
}

function reorder(orderId) {
  const order = orders.find(item => item.id === orderId);
  if (!order) return;

  let added = 0;

  order.items.forEach(line => {
    const product = products.find(item => Number(item.id) === Number(line.id));
    if (!product) return;

    const stock = Number(product.stock) || 0;
    const maxQty = stock > 0 ? stock : 99;
    const existing = cart.find(item => Number(item.id) === Number(product.id));

    if (existing) {
      existing.qty = Math.min(existing.qty + Number(line.qty), maxQty);
    } else {
      cart.push({ ...product, qty: Math.min(Number(line.qty) || 1, maxQty) });
    }
    added += 1;
  });

  if (!added) {
    showToast('Товары из заказа больше недоступны', 'error');
    return;
  }

  saveCart();
  updateUI();
  closeModal('ordersModal');
  openCart();
  showToast('Товары добавлены в корзину', 'success');
}

// ============================================================
// ПРОМОКОДЫ
// ============================================================

function generatePromoCode() {
  if (myPromoCode) return;

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomPart = '';
  for (let i = 0; i < 4; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  myPromoCode = `PF5-${randomPart}`;
  localStorage.setItem('pf_promo_code', myPromoCode);
}

function applyPromo() {
  if (promoUsed) {
    showToast('Промокод уже был использован', 'error');
    playSound('error');
    triggerHaptic('error');
    return;
  }
  if (appliedPromoPercent > 0) {
    showToast('Промокод уже применён', 'error');
    playSound('error');
    triggerHaptic('error');
    return;
  }

  const input = document.getElementById('promoInput');
  if (!input) return;

  const code = input.value.trim().toUpperCase();
  if (!code) {
    showToast('Введите промокод', 'error');
    playSound('error');
    triggerHaptic('error');
    return;
  }

  if (code === myPromoCode || code === 'START') {
    appliedPromoPercent = 5;
    localStorage.setItem('pf_promo_applied', '5');
    input.value = '';
    renderCartItems();
    updateCartBadge();
    showToast('Промокод применён: −5%', 'success');
    playSound('success');
    triggerHaptic('success');
  } else {
    showToast('Неверный промокод', 'error');
    playSound('error');
    triggerHaptic('error');
  }
}

function removePromo() {
  appliedPromoPercent = 0;
  localStorage.setItem('pf_promo_applied', '0');
  renderCartItems();
  updateCartBadge();
  showToast('Промокод убран');
  playSound('tap');
  triggerHaptic('selection');
}

function copyPromoCode(code) {
  const done = () => showToast('Промокод скопирован!', 'success');

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
  } else {
    fallbackCopy(code, done);
  }
}

function fallbackCopy(text, done) {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    done();
  } catch (error) {
    showToast('Не удалось скопировать', 'error');
  }
}

// ============================================================
// ЗАГРУЗКА ТОВАРОВ
// ============================================================

async function loadProducts() {
  const skeleton = document.getElementById('skeletonLoader');
  const catalog = document.getElementById('catalog');
  if (!catalog) return;

  if (skeleton) skeleton.style.display = 'grid';
  catalog.style.display = 'none';

  let loadedFromJson = false;

  try {
    const res = await fetch('./products.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Неверный формат products.json');

    products = data;
    loadedFromJson = true;
  } catch (error) {
    console.warn('Ошибка загрузки каталога, используются тестовые данные:', error);
    products = [...fallbackProducts];
  } finally {
    productsLoaded = true;

    if (loadedFromJson) {
      reconcileCart();
      reconcileFavorites();
    }

    const drops = reconcileFavoritePrices();

    if (skeleton) skeleton.style.display = 'none';
    catalog.style.display = 'grid';

    renderCatalog();
    renderAboutCategories();
    renderRecent();
    renderResumeBanner();
    updateCategoryVisibility();
    updateUI();
    updateFavoriteUI();
    updateStoreStatus();
    handleDeepLink();
    loadStockOverrides();

    if (drops > 0) {
      notifyPriceDrops(drops);
    }
  }
}

function reconcileFavorites() {
  const validIds = new Set(products.map(product => Number(product.id)));
  const next = favorites.filter(id => validIds.has(Number(id)));

  if (next.length !== favorites.length) {
    favorites = next;
    saveFavorites();
  }
}

function updateCategoryVisibility() {
  const available = new Set(products.map(product => product.category));

  document.querySelectorAll('.cat-pill').forEach(button => {
    const category = button.dataset.cat;
    if (!category || category === 'all') return;
    button.hidden = !available.has(category);
  });

  if (currentCategory !== 'all' && !available.has(currentCategory)) {
    currentCategory = 'all';
    document.querySelectorAll('.cat-pill').forEach(button => {
      button.classList.toggle('active', button.dataset.cat === 'all');
    });
    renderCatalog();
  }
}

// Живой статус магазина по барнаульскому времени (10:00–21:00)
function updateStoreStatus() {
  const chip = document.getElementById('storeStatusChip');
  const text = document.getElementById('storeStatusText');
  const sub = document.getElementById('storeStatusSub');
  const open = isStoreOpen();

  if (chip && text) {
    const minutes = getStoreMinutes();
    const timeLeft = STORE_CLOSE_HOUR * 60 - minutes;

    chip.classList.toggle('closed', !open);

    if (open) {
      text.textContent = timeLeft <= 60
        ? `ОТКРЫТО ЕЩЁ ${timeLeft} МИН · БАРНАУЛ`
        : `ОТКРЫТО ДО ${STORE_CLOSE_HOUR}:00 · БАРНАУЛ`;
      if (sub) sub.textContent = 'Заказать можно в любое время';
    } else {
      text.textContent = `ЗАКРЫТО · ПРИМЕМ ЗАКАЗ В ${STORE_OPEN_HOUR}:00`;
      if (sub) sub.textContent = 'Оформить можно сейчас — примем в работу в 10:00';
    }
  }

  const nowEl = document.getElementById('pickupNow');
  if (nowEl) {
    const time = formatStoreTime();
    nowEl.textContent = open
      ? `Сейчас в Барнауле ${time} · открыто до ${STORE_CLOSE_HOUR}:00`
      : `Сейчас в Барнауле ${time} · откроемся в ${STORE_OPEN_HOUR}:00`;
    nowEl.classList.toggle('closed', !open);
  }

  const closedHint = document.getElementById('checkoutClosedHint');
  if (closedHint) {
    closedHint.classList.toggle('is-open', open);
    closedHint.textContent = open
      ? 'Магазин открыт — ответим в течение дня. Заказать можно в любое время.'
      : `Сейчас закрыто (${formatStoreTime()} по Барнаулу). Заказ можно оформить в любое время — менеджер примет его в работу после ${STORE_OPEN_HOUR}:00.`;
  }
}

function updateScrollProgress() {
  const bar = document.getElementById('scrollProgress');
  if (!bar) return;

  const doc = document.documentElement;
  const max = doc.scrollHeight - window.innerHeight;
  const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  bar.style.width = `${progress * 100}%`;
}

function handleDeepLink() {
  if (deepLinkHandled) return;
  deepLinkHandled = true;

  let productId = null;
  try {
    productId = Number(new URLSearchParams(location.search).get('product'));
  } catch (error) {
    return;
  }

  if (!Number.isFinite(productId) || productId <= 0) return;

  const product = products.find(item => Number(item.id) === productId);
  if (!product) return;

  setTimeout(() => openProduct(product.id), 320);
}

function reconcileCart() {
  const next = [];

  cart.forEach(item => {
    const product = products.find(p => Number(p.id) === Number(item.id));
    if (!product) return;

    const stock = Number(product.stock) || 0;
    const maxQty = stock > 0 ? stock : 99;
    const qty = Math.max(1, Math.min(Number(item.qty) || 1, maxQty));

    next.push({ ...product, qty });
  });

  cart = next;
  saveCart();
}

// ============================================================
// ВИТРИНА
// ============================================================

function getFilteredProducts() {
  let list = [...products];

  if (currentCategory !== 'all') {
    list = list.filter(p => p.category === currentCategory);
  }

  const query = searchQuery.trim().toLowerCase();
  if (query) {
    list = list.filter(p => {
      const title = String(p.title || '').toLowerCase();
      const category = String(p.category || '').toLowerCase();
      const categoryRu = CATEGORY_LABELS[p.category] || '';
      const badges = Array.isArray(p.badges) ? p.badges : [];
      const badgeText = badges.includes('hit') ? 'хит' : '';
      const newText = badges.includes('new') ? 'новинка' : '';
      return title.includes(query) || category.includes(query) || categoryRu.includes(query) ||
        badgeText.includes(query) || newText.includes(query);
    });
  }

  if (filters.priceMin != null) list = list.filter(p => Number(p.price) >= filters.priceMin);
  if (filters.priceMax != null) list = list.filter(p => Number(p.price) <= filters.priceMax);
  if (filters.inStockOnly) list = list.filter(p => Number(p.stock) > 0);

  list.sort((a, b) => {
    switch (sortMode) {
      case 'price-asc':
        return Number(a.price) - Number(b.price);
      case 'price-desc':
        return Number(b.price) - Number(a.price);
      case 'discount':
        return getDiscount(b) - getDiscount(a) || Number(b.stock) - Number(a.stock);
      case 'new': {
        const aNew = (Array.isArray(a.badges) ? a.badges : []).includes('new') ? 1 : 0;
        const bNew = (Array.isArray(b.badges) ? b.badges : []).includes('new') ? 1 : 0;
        return bNew - aNew || Number(b.stock) - Number(a.stock);
      }
      default: {
        const aInStock = Number(a.stock) > 0 ? 1 : 0;
        const bInStock = Number(b.stock) > 0 ? 1 : 0;
        return bInStock - aInStock || Number(b.stock) - Number(a.stock) || getDiscount(b) - getDiscount(a);
      }
    }
  });

  return list;
}

function buildProductCard(product, options = {}) {
  const images = getProductImages(product);
  const img1 = images[0];
  const subImages = images.slice(1, 3);
  const stock = Number(product.stock) || 0;
  const isOutOfStock = stock <= 0;
  const active = isFavorite(product.id);
  const safeTitle = escapeHtml(product.title);
  const priceDrop = Number(options.priceDrop) || 0;
  const showAdd = options.showAdd !== false;
  const giftShort = product.gift_short
    ? String(product.gift_short).trim()
    : (product.gift_desc ? String(product.gift_desc).replace('🎁', '').trim() : '');

  let stockHtml;
  if (isOutOfStock) {
    stockHtml = '<span class="card-stock out-of-stock">Нет в наличии</span>';
  } else if (stock <= 5) {
    stockHtml = `<span class="card-stock low-stock">Осталось ${stock} шт.</span>`;
  } else {
    stockHtml = `<span class="card-stock">В наличии: ${stock} шт.</span>`;
  }

  const subImagesHtml = subImages.length
    ? `<div class="img-sub-row ${subImages.length === 1 ? 'single' : ''}">
         ${subImages.map((src, index) => `
           <div class="img-sub">
             <img src="${src}" alt="${safeTitle} — фото ${index + 2}" loading="lazy" decoding="async"
                  onerror="this.onerror=null;this.src='${NO_PHOTO}'">
           </div>`).join('')}
       </div>`
    : '';

  return `
    <div class="card ${isOutOfStock ? 'card-out-of-stock' : ''}" data-id="${product.id}">
      <button type="button" class="card-hitbox" aria-label="Открыть товар: ${safeTitle}"></button>
      <div class="card-image-wrapper">
        <div class="card-badges">${getBadgesHtml(product)}${priceDrop > 0 ? `<span class="badge-tag price-drop" title="Было ${formatPrice(product.price + priceDrop)}">ПОДЕШЕВЕЛ</span>` : ''}</div>
        <button type="button" class="card-fav ${active ? 'active' : ''}" data-fav="${product.id}"
                data-title="${safeTitle}" aria-pressed="${active}"
                aria-label="${active ? 'Убрать из избранного' : 'Добавить в избранное'}: ${safeTitle}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
        </button>
        <div class="img-main">
          <img src="${img1}" alt="${safeTitle}" loading="lazy" decoding="async"
               onerror="this.onerror=null;this.src='${NO_PHOTO}'">
        </div>
        ${subImagesHtml}
      </div>

      <div class="card-body">
        <div class="card-title">${safeTitle}</div>
        <div class="card-price-block">
          <span class="card-price">${formatPrice(product.price)}</span>
          ${product.oldPrice && product.oldPrice > product.price ? `<span class="card-old-price">${formatPrice(product.oldPrice)}</span>` : ''}
        </div>
        ${stockHtml}
        ${giftShort
          ? `<span class="card-gift" title="${escapeHtml(giftShort)}">🎁 ${escapeHtml(giftShort)}</span>`
          : '<span class="card-gift card-gift--placeholder" aria-hidden="true"></span>'}
        ${showAdd
          ? `<button class="card-btn" data-add="${product.id}">
               ${isOutOfStock ? 'ПОД ЗАКАЗ' : 'В КОРЗИНУ'}
             </button>`
          : ''}
      </div>
    </div>`;
}

function renderCatalog() {
  const catalog = document.getElementById('catalog');
  if (!catalog || !productsLoaded) return;

  const filtered = getFilteredProducts();

  if (!filtered.length) {
    catalog.innerHTML = buildEmptyCatalogHtml();
    return;
  }

  catalog.innerHTML = filtered.map(product => buildProductCard(product, { showAdd: false })).join('');
  animateCatalogCards();
}

// «О нас»: живые счётчики категорий вместо статичных подписей
function renderAboutCategories() {
  document.querySelectorAll('[data-about-count]').forEach(el => {
    const key = el.dataset.aboutCount;
    const count = products.filter(product => product.category === key).length;
    el.textContent = count
      ? `${count} ${plural(count, 'товар', 'товара', 'товаров')}`
      : 'пока нет';
  });
}

// Пустой результат — не тупик: менеджер, сброс и ближайшие товары
function buildEmptyCatalogHtml() {
  const query = searchQuery.trim();
  const suggestions = products.filter(product => Number(product.stock) > 0).slice(0, 4);

  const chips = Object.entries(CATEGORY_LABELS)
    .filter(([key]) => products.some(product => product.category === key))
    .map(([key, label]) => `<button type="button" class="empty-chip" data-empty-cat="${key}">${escapeHtml(label)}</button>`)
    .join('');

  const suggest = suggestions.map(product => {
    const image = getProductImages(product)[0] || NO_PHOTO;
    return `<button type="button" class="empty-suggest-item" data-empty-product="${product.id}">
      <img src="${image}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${NO_PHOTO}'">
      <span class="empty-suggest-name">${escapeHtml(product.title)}</span>
      <span class="empty-suggest-price">${formatPrice(product.price)}</span>
    </button>`;
  }).join('');

  return `
    <div class="catalog-empty">
      <div class="catalog-empty-icon" aria-hidden="true">🔎</div>
      <div class="catalog-empty-title">${query ? `По запросу «${escapeHtml(query)}» пусто` : 'Ничего не найдено'}</div>
      <p>${query
        ? 'Возможно, товар называется иначе. Напишите менеджеру — подскажем наличие и привезём под заказ.'
        : 'Попробуйте изменить запрос или сбросить фильтры.'}</p>
      <div class="empty-actions">
        <button type="button" class="empty-manager" data-empty-manager="1">НАПИСАТЬ МЕНЕДЖЕРУ</button>
        <button type="button" class="empty-reset" onclick="resetAllFilters()">СБРОСИТЬ ФИЛЬТРЫ</button>
      </div>
      ${chips ? `<div class="empty-chips">${chips}</div>` : ''}
      ${suggest ? `<div class="empty-suggest-title">Может подойти</div><div class="empty-suggest-list">${suggest}</div>` : ''}
    </div>`;
}

function animateCatalogCards() {
  if (catalogAnimated) return;
  catalogAnimated = true;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  document.querySelectorAll('#catalog .card').forEach((card, index) => {
    card.classList.add('card-enter');
    card.style.setProperty('--card-delay', `${Math.min(index, 5) * 55}ms`);
    card.addEventListener('animationend', () => {
      card.classList.remove('card-enter');
      card.style.removeProperty('--card-delay');
    }, { once: true });
  });
}

function updateFilterBadge() {
  const badge = document.getElementById('filterBadge');
  const button = document.getElementById('filterBtn');
  if (!badge || !button) return;

  let count = 0;
  if (filters.priceMin != null) count++;
  if (filters.priceMax != null) count++;
  if (filters.inStockOnly) count++;

  badge.hidden = count === 0;
  badge.textContent = count;
  button.classList.toggle('active', count > 0);
}

function resetAllFilters() {
  filters = { priceMin: null, priceMax: null, inStockOnly: false };
  currentCategory = 'all';
  searchQuery = '';

  const priceMin = document.getElementById('priceMin');
  const priceMax = document.getElementById('priceMax');
  const inStockOnly = document.getElementById('inStockOnly');
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');

  if (priceMin) priceMin.value = '';
  if (priceMax) priceMax.value = '';
  if (inStockOnly) inStockOnly.checked = false;
  if (searchInput) searchInput.value = '';
  if (searchClear) searchClear.classList.remove('active');

  document.querySelectorAll('.cat-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === 'all');
  });

  updateFilterBadge();
  renderCatalog();
  closeModal('filterModal');
}

function selectCategory(category) {
  currentCategory = category === 'all' ? 'all' : (currentCategory === category ? 'all' : category);

  document.querySelectorAll('.cat-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === currentCategory);
  });

  if (currentCategory !== 'all') {
    searchQuery = '';
    const input = document.getElementById('searchInput');
    const clear = document.getElementById('searchClear');
    if (input) input.value = '';
    if (clear) clear.classList.remove('active');
  }

  renderCatalog();
  playSound('tap');
  triggerHaptic('selection');
}

function openLightbox(src, alt) {
  const image = document.getElementById('lightbox-img');
  if (!image) return;
  image.src = src;
  image.alt = alt || 'Фото товара';
  openModal('lightbox');
}

function closeLightbox() {
  closeModal('lightbox');
}

// ============================================================
// КАРТОЧКА ТОВАРА
// ============================================================

function openProduct(id) {
  const product = products.find(p => Number(p.id) === Number(id));
  if (!product) return;

  playSound('tap');
  triggerHaptic('selection');

  const modal = document.getElementById('productModal');
  const scroller = modal?.querySelector('.product-modal');
  const gallery = document.getElementById('productGallery');
  const dotsContainer = document.getElementById('galleryDots');
  const thumbsContainer = document.getElementById('galleryThumbs');
  const counter = document.getElementById('galleryCounter');
  const badges = document.getElementById('productBadges');
  const descEl = document.getElementById('productDesc');
  if (!modal || !gallery || !dotsContainer || !counter || !badges || !descEl) return;

  const images = getProductImages(product);

  // Галерея
  gallery.innerHTML = images.map((src, index) => `
    <img src="${src}" alt="${escapeHtml(product.title)} — фото ${index + 1}"
         loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async" data-index="${index}"
         onerror="this.onerror=null;this.src='${NO_PHOTO}'">
  `).join('');

  gallery.querySelectorAll('img').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.src, img.alt));
  });

  dotsContainer.innerHTML = images.length > 1
    ? images.map((_, index) => `<button type="button" class="gallery-dot ${index === 0 ? 'active' : ''}" data-index="${index}" aria-label="Фото ${index + 1}"></button>`).join('')
    : '';

  counter.hidden = images.length <= 1;
  counter.textContent = images.length > 1 ? `1 / ${images.length}` : '';

  // Миниатюры под галереей — только если фото больше одного
  if (thumbsContainer) {
    thumbsContainer.hidden = images.length <= 1;
    thumbsContainer.innerHTML = images.length > 1
      ? images.map((src, index) => `
        <button type="button" class="gallery-thumb ${index === 0 ? 'active' : ''}" data-index="${index}"
                role="tab" aria-selected="${index === 0}" aria-label="Фото ${index + 1}">
          <img src="${src}" alt="" loading="lazy" decoding="async"
               onerror="this.onerror=null;this.src='${NO_PHOTO}'">
        </button>`).join('')
      : '';
  }

  const dots = Array.from(dotsContainer.querySelectorAll('.gallery-dot'));
  const thumbs = thumbsContainer ? Array.from(thumbsContainer.querySelectorAll('.gallery-thumb')) : [];
  let currentIndex = 0;

  gallery.onscroll = () => {
    const width = gallery.clientWidth || 1;
    const index = Math.max(0, Math.min(images.length - 1, Math.round(gallery.scrollLeft / width)));
    if (index !== currentIndex) {
      currentIndex = index;
      if (thumbsContainer && thumbs[index]) {
        const thumb = thumbs[index];
        thumbsContainer.scrollTo({
          left: thumb.offsetLeft - (thumbsContainer.clientWidth - thumb.clientWidth) / 2,
          behavior: 'smooth'
        });
      }
    }
    dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
    thumbs.forEach((thumb, i) => {
      thumb.classList.toggle('active', i === index);
      thumb.setAttribute('aria-selected', String(i === index));
    });
    if (images.length > 1) counter.textContent = `${index + 1} / ${images.length}`;
  };

  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      const index = Number(dot.dataset.index);
      gallery.scrollTo({ left: gallery.clientWidth * index, behavior: 'smooth' });
    });
  });

  thumbs.forEach(thumb => {
    thumb.addEventListener('click', () => {
      const index = Number(thumb.dataset.index);
      gallery.scrollTo({ left: gallery.clientWidth * index, behavior: 'smooth' });
    });
  });

  // Основная информация
  badges.innerHTML = getBadgesHtml(product);
  document.getElementById('productTitle').textContent = product.title;
  document.getElementById('productPrice').textContent = formatPrice(product.price);

  const oldPriceEl = document.getElementById('productOldPrice');
  oldPriceEl.textContent = product.oldPrice && product.oldPrice > product.price ? formatPrice(product.oldPrice) : '';

  renderProductStock(product);

  renderProductGift(product);

  currentProductId = Number(product.id);
  addRecentProduct(product.id);
  renderSimilar(product);
  updateProductSeo(product);

  const managerBtn = document.getElementById('askManagerBtn');
  if (managerBtn) managerBtn.onclick = () => openManagerChat(product);

  const shareBtn = document.getElementById('productShareBtn');
  if (shareBtn) shareBtn.onclick = () => shareProduct(product);

  updateFavoriteUI();

  const addToCartBtn = document.getElementById('addToCart');
  if (addToCartBtn) {
    addToCartBtn.onclick = () => {
      if (addToCart(product.id)) closeModal(modal);
    };
  }

  // Закреплённая панель покупки
  const buyBarPrice = document.getElementById('buyBarPrice');
  const buyBarOldPrice = document.getElementById('buyBarOldPrice');
  const buyBarAdd = document.getElementById('buyBarAdd');
  if (buyBarPrice) buyBarPrice.textContent = formatPrice(product.price);
  if (buyBarOldPrice) {
    buyBarOldPrice.textContent = product.oldPrice && product.oldPrice > product.price
      ? formatPrice(product.oldPrice)
      : '';
    buyBarOldPrice.hidden = !buyBarOldPrice.textContent;
  }
  if (buyBarAdd) {
    const outOfStock = (Number(product.stock) || 0) <= 0;
    buyBarAdd.textContent = outOfStock ? 'ПОД ЗАКАЗ' : 'В КОРЗИНУ';
    buyBarAdd.onclick = () => {
      if (addToCart(product.id)) closeModal(modal);
    };
  }

  const stockNotifyBtn = document.getElementById('stockNotifyBtn');
  if (stockNotifyBtn) stockNotifyBtn.onclick = () => openStockNotify(product);

  // Описание загружаем в фоне, чтобы карточка открывалась мгновенно
  if (descRequest) descRequest.abort();
  const controller = new AbortController();
  descRequest = controller;

  descEl.innerHTML = '<div class="skeleton-text" style="width: 90%;"></div><div class="skeleton-text" style="width: 100%;"></div><div class="skeleton-text" style="width: 80%;"></div><div class="skeleton-text" style="width: 60%;"></div>';

  if (product.desc) {
    descEl.textContent = product.desc;
  } else if (product.desc_file) {
    fetch(product.desc_file, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(text => {
        if (descRequest !== controller) return;
        descEl.textContent = text.trim() || 'Описание скоро появится...';
      })
      .catch(error => {
        if (error.name === 'AbortError' || descRequest !== controller) return;
        descEl.textContent = 'Описание скоро появится...';
      });
  } else {
    descEl.textContent = 'Описание скоро появится...';
  }

  openModal(modal);
  if (scroller) scroller.scrollTop = 0;
  gallery.scrollLeft = 0;

  requestAnimationFrame(() => {
    if (scroller) scroller.scrollTop = 0;
    gallery.scrollLeft = 0;
    window.updateProductBuyBar?.();
  });
}

function renderProductStock(product) {
  const stockEl = document.getElementById('productStock');
  if (!stockEl || !product) return;

  const stock = Number(product.stock) || 0;

  if (stock > 0) {
    stockEl.textContent = `В НАЛИЧИИ: ${stock} ШТ.`;
    stockEl.className = 'product-stock-status' + (stock <= 5 ? ' low' : '');
  } else {
    stockEl.textContent = 'НЕТ В НАЛИЧИИ — ДОСТУПЕН ПОД ЗАКАЗ';
    stockEl.className = 'product-stock-status out';
  }

  const addToCartBtn = document.getElementById('addToCart');
  if (addToCartBtn) {
    addToCartBtn.textContent = stock > 0 ? 'В КОРЗИНУ' : 'ЗАКАЗАТЬ ПОД ЗАКАЗ';
    addToCartBtn.style.opacity = stock > 0 ? '1' : '0.85';
  }

  const stockNotifyBtn = document.getElementById('stockNotifyBtn');
  if (stockNotifyBtn) stockNotifyBtn.hidden = stock > 0;

  renderStockEditor(product);
}

function renderStockEditor(product) {
  const editor = document.getElementById('stockEditor');
  if (!editor) return;

  editor.hidden = !isManager || !ORDERS_ENDPOINT;
  if (editor.hidden) return;

  const valueEl = document.getElementById('stockValue');
  const minus = document.getElementById('stockMinus');
  const plus = document.getElementById('stockPlus');
  if (!valueEl || !minus || !plus) return;

  let value = Math.max(0, Number(product.stock) || 0);
  valueEl.textContent = String(value);

  const apply = async next => {
    const previous = value;
    value = Math.max(0, Math.min(99, next));
    valueEl.textContent = String(value);
    product.stock = value;
    stockOverrides[String(product.id)] = value;
    renderProductStock(product);

    const saved = await saveProductStock(product, value);
    if (!saved) {
      value = previous;
      product.stock = previous;
      stockOverrides[String(product.id)] = previous;
      renderProductStock(product);
    }
  };

  minus.onclick = () => apply(value - 1);
  plus.onclick = () => apply(value + 1);
}

async function saveProductStock(product, stock) {
  const initData = ensureTelegramApp()?.initData || '';

  if (!ORDERS_ENDPOINT || !initData) {
    showToast('Откройте сайт через Telegram, чтобы менять наличие', 'error');
    return false;
  }

  try {
    const response = await fetch(ORDERS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'stock',
        productId: String(product.id),
        stock,
        title: product.title,
        price: product.price,
        initData
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      showToast(data.error === 'manager_only' ? 'Нет прав менеджера' : 'Не удалось сохранить наличие', 'error');
      return false;
    }

    const hint = document.getElementById('stockEditorHint');
    if (hint) {
      hint.textContent = data.notified
        ? `Уведомление о поступлении получили: ${data.notified}`
        : 'Когда наличие станет больше нуля, подписчики получат сообщение.';
    }

    playSound('success');
    triggerHaptic('success');
    showToast(stock > 0 ? `Наличие обновлено: ${stock} шт.` : 'Товар помечен как отсутствующий', 'success');
    renderCatalog();
    return true;
  } catch (error) {
    showToast('Нет связи с сервером', 'error');
    return false;
  }
}

function renderProductGift(product) {
  const giftEl = document.getElementById('productGift');
  if (!giftEl) return;

  if (!product.gift_desc) {
    giftEl.hidden = true;
    giftEl.innerHTML = '';
    return;
  }

  const giftImages = Array.isArray(product.gift_images) ? product.gift_images.filter(Boolean) : [];
  const giftText = String(product.gift_desc).replace('🎁', '').trim();

  giftEl.hidden = false;
  giftEl.innerHTML = `
    ${giftImages[0]
      ? `<img src="${giftImages[0]}" alt="Подарок к покупке" loading="lazy" decoding="async"
              onerror="this.onerror=null;this.src='${NO_PHOTO}'">`
      : '<span class="gift-emoji" aria-hidden="true">🎁</span>'}
    <div>
      <div class="gift-title">ПОДАРОК К ПОКУПКЕ</div>
      <div class="gift-text">${escapeHtml(giftText)}</div>
    </div>`;

  const giftImage = giftEl.querySelector('img');
  if (giftImage) {
    giftImage.addEventListener('click', () => openLightbox(giftImage.src, 'Подарок к покупке'));
  }
}

// ============================================================
// КОРЗИНА
// ============================================================

function addToCart(id) {
  const product = products.find(p => Number(p.id) === Number(id));
  if (!product) return false;

  const stock = Number(product.stock) || 0;
  const existing = cart.find(item => Number(item.id) === Number(id));
  const source = findCartSource(id);
  const image = getProductImages(product)[0];

  if (existing) {
    if (stock > 0 && existing.qty >= stock) {
      showNotification({ title: `Максимум ${stock} шт.`, text: 'Больше нет в наличии', image, type: 'error', duration: 2200 });
      playSound('error');
      triggerHaptic('error');
      return false;
    }
    if (stock <= 0 && existing.qty >= 99) {
      showNotification({ title: 'Максимум 99 шт.', text: 'Больше нельзя добавить под заказ', image, type: 'error', duration: 2200 });
      playSound('error');
      triggerHaptic('error');
      return false;
    }
    existing.qty += 1;
  } else {
    cart.push({ ...product, qty: 1 });
  }

  saveCart();
  updateUI();

  flyToCart(source);
  playSound('add');
  triggerHaptic('light');

  const isOrder = stock <= 0;
  showNotification({
    title: isOrder ? 'Добавлено под заказ' : 'Добавлено в корзину',
    text: `${product.title} · ${formatPrice(product.price)}`,
    image,
    type: 'success',
    duration: isOrder ? 3000 : 2600,
    onClick: openCart
  });

  const badge = document.getElementById('navCartCount');
  if (badge) {
    badge.classList.remove('badge-pop');
    void badge.offsetWidth;
    badge.classList.add('badge-pop');
  }

  const cartIcon = document.getElementById('cartIcon');
  if (cartIcon) {
    cartIcon.classList.add('cart-bounce');
    setTimeout(() => cartIcon.classList.remove('cart-bounce'), 500);
  }

  return true;
}

function updateQty(id, delta) {
  const item = cart.find(x => Number(x.id) === Number(id));
  if (!item) return;

  const product = products.find(p => Number(p.id) === Number(id));
  const stock = product ? Number(product.stock) || 0 : Number(item.stock) || 0;
  const maxQty = stock > 0 ? stock : 99;

  if (delta > 0 && item.qty >= maxQty) {
    showToast(stock > 0 ? `Максимум ${maxQty} шт.` : 'Максимум 99 шт.', 'error');
    return;
  }

  item.qty += delta;
  if (item.qty <= 0) {
    cart = cart.filter(x => Number(x.id) !== Number(id));
  }

  saveCart();
  updateUI();
  playSound('tap');
  triggerHaptic('selection');
}

function getCartTotals() {
  const subtotal = cart.reduce((sum, item) => sum + Number(item.price) * item.qty, 0);
  const hasQtyDiscount = cart.some(item => item.qty >= 2);
  const qtyDiscountPercent = hasQtyDiscount ? 5 : 0;
  const qtyDiscountAmount = Math.round(subtotal * qtyDiscountPercent / 100);
  const promoDiscountAmount = Math.round(subtotal * appliedPromoPercent / 100);
  const total = Math.max(0, subtotal - qtyDiscountAmount - promoDiscountAmount);

  return {
    subtotal,
    hasQtyDiscount,
    qtyDiscountPercent,
    qtyDiscountAmount,
    promoDiscountAmount,
    total
  };
}

function updateCartBadge() {
  const count = cart.reduce((sum, item) => sum + item.qty, 0);

  const badge = document.getElementById('navCartCount');
  if (badge) {
    badge.textContent = count;
    badge.hidden = count === 0;
  }

  const profileCartCount = document.getElementById('profileCartCount');
  if (profileCartCount) {
    profileCartCount.textContent = count > 0
      ? `${count} ${plural(count, 'товар', 'товара', 'товаров')}`
      : 'Пока пусто';
  }

  const profilePromoCount = document.getElementById('profilePromoCount');
  if (profilePromoCount) {
    if (promoUsed) profilePromoCount.textContent = 'Использован';
    else if (appliedPromoPercent > 0) profilePromoCount.textContent = 'Применён';
    else profilePromoCount.textContent = myPromoCode ? '1 активный' : 'Нет активных';
  }
}

function updateUI() {
  updateCartBadge();
  renderCartItems();
  updateOrderBadge();
}

function renderCartItems() {
  const container = document.getElementById('cartItems');
  if (!container) return;

  const totals = getCartTotals();

  if (!cart.length) {
    container.innerHTML = `
      <div class="empty-cart">
        <div class="empty-cart-icon" aria-hidden="true">🛒</div>
        <div class="empty-cart-title">Корзина пуста</div>
        <p class="empty-cart-text">Добавьте товары из каталога — доставка по городу бесплатно.</p>
        <button class="empty-reset" onclick="closeModal('cartModal'); setView('home');">ПЕРЕЙТИ К ПОКУПКАМ</button>
      </div>`;
    hasShownQtyDiscountToast = false;
  } else {
    container.innerHTML = cart.map(item => {
      const product = products.find(p => Number(p.id) === Number(item.id));
      const stock = product ? Number(product.stock) || 0 : Number(item.stock) || 0;
      const maxQty = stock > 0 ? stock : 99;
      const images = getProductImages(item);
      const giftText = item.gift_desc ? String(item.gift_desc).replace('🎁', '').trim() : '';

      return `
        <div class="cart-item">
          <img src="${images[0]}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async"
               onerror="this.onerror=null;this.src='${NO_PHOTO}'">
          <div class="cart-item-info">
            <div class="cart-item-title">
              ${escapeHtml(item.title)}
              ${stock <= 0 ? '<span class="cart-item-preorder">(под заказ)</span>' : ''}
            </div>
            <div class="cart-item-price-row">
              <span class="cart-item-price">${formatPrice(item.price)}</span>
              <span class="cart-item-line-total">${formatPrice(Number(item.price) * Number(item.qty))}</span>
            </div>
            ${giftText ? `<div class="cart-item-gift">🎁 Подарок: ${escapeHtml(giftText)}</div>` : ''}
            <div class="cart-item-controls">
              <button class="qty-btn" onclick="updateQty(${item.id}, -1)" aria-label="Уменьшить количество">−</button>
              <span class="qty-value">${item.qty}</span>
              <button class="qty-btn" onclick="updateQty(${item.id}, 1)" ${item.qty >= maxQty ? 'disabled' : ''} aria-label="Увеличить количество">+</button>
            </div>
          </div>
        </div>`;
    }).join('');

    if (totals.hasQtyDiscount && !hasShownQtyDiscountToast) {
      showToast('🔥 Скидка 5% за 2+ шт. применена!', 'success');
      hasShownQtyDiscountToast = true;
    }
  }

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('subtotal', formatPrice(totals.subtotal));
  setText('delivery', 'БЕСПЛАТНО');
  setText('totalPrice', formatPrice(totals.total));

  const cartCount = cart.reduce((sum, item) => sum + item.qty, 0);
  const headerCount = document.getElementById('cartHeaderCount');
  if (headerCount) {
    headerCount.textContent = cart.length
      ? `${cartCount} ${plural(cartCount, 'товар', 'товара', 'товаров')} · ${formatPrice(totals.total)}`
      : 'Пока пусто';
  }

  const promoRow = document.getElementById('promoDiscountRow');
  const promoApplyRow = document.getElementById('promoApplyRow');
  const promoAmount = document.getElementById('promoDiscountAmount');
  const promoApplied = appliedPromoPercent > 0 && totals.subtotal > 0;

  if (promoRow) promoRow.style.display = promoApplied ? 'flex' : 'none';
  if (promoApplyRow) promoApplyRow.style.display = promoApplied ? 'none' : 'flex';
  if (promoAmount) promoAmount.textContent = `-${formatPrice(totals.promoDiscountAmount)}`;

  const qtyRow = document.getElementById('qtyDiscountRow');
  const qtyHint = document.getElementById('qtyDiscountHint');
  const qtyAmount = document.getElementById('qtyDiscountAmount');

  if (totals.hasQtyDiscount) {
    if (qtyRow) qtyRow.style.display = 'flex';
    if (qtyHint) qtyHint.style.display = 'none';
    if (qtyAmount) qtyAmount.textContent = `-${formatPrice(totals.qtyDiscountAmount)}`;
  } else {
    if (qtyRow) qtyRow.style.display = 'none';
    if (qtyHint) qtyHint.style.display = cart.length ? 'block' : 'none';
  }

  const checkoutBtn = document.getElementById('checkoutBtn');
  const clearCartBtn = document.getElementById('clearCartBtn');
  if (checkoutBtn) checkoutBtn.disabled = cart.length === 0;
  if (clearCartBtn) clearCartBtn.disabled = cart.length === 0;

  const pendingOrder = orders.find(order => !isTestOrder(order) && normalizeOrderStatus(order.status) === 'created');
  const pendingHint = document.getElementById('pendingOrderHint');
  const pendingId = document.getElementById('pendingOrderId');
  if (pendingHint) pendingHint.hidden = !pendingOrder;
  if (pendingOrder && pendingId) pendingId.textContent = pendingOrder.id;
}

function clearCart() {
  if (!cart.length) {
    showToast('Корзина уже пуста', 'error');
    return;
  }

  const count = cart.reduce((sum, item) => sum + item.qty, 0);

  openConfirm({
    title: 'Очистить корзину?',
    text: `Из корзины будут удалены все товары (${count} ${plural(count, 'штука', 'штуки', 'штук')}). Это действие нельзя отменить.`,
    confirmText: 'ОЧИСТИТЬ',
    onConfirm: () => {
      cart = [];
      hasShownQtyDiscountToast = false;
      saveCart();
      updateUI();
      showToast('Корзина очищена');
      triggerHaptic('medium');
    }
  });
}

function orderMatchesCart(order) {
  if (!order || !Array.isArray(order.items) || order.items.length !== cart.length) return false;

  return cart.every(item => {
    const line = order.items.find(entry => Number(entry.id) === Number(item.id));
    return Boolean(line)
      && Number(line.qty) === Number(item.qty)
      && Number(line.price) === Number(item.price);
  });
}

function getCheckoutCustomer() {
  return safeLoadJson('pf_customer', {});
}

function renderCheckoutSummary() {
  const summary = document.getElementById('checkoutSummary');
  if (!summary) return;

  const totals = getCartTotals();
  const count = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  const discount = (totals.qtyDiscountAmount || 0) + (totals.promoDiscountAmount || 0);
  const method = document.querySelector('input[name="delivery"]:checked')?.value || 'pickup';

  const deliveryNote = method === 'pickup'
    ? 'Самовывоз бесплатно · Павловский тракт, 307к3'
    : method === 'city'
      ? 'Доставка по Барнаулу бесплатно'
      : 'Доставку по России подтвердит менеджер';

  summary.innerHTML = `
    <div class="checkout-summary-line">
      <span>${count} ${plural(count, 'товар', 'товара', 'товаров')}</span>
      <strong>${formatPrice(totals.total)}</strong>
    </div>
    <div class="checkout-summary-note">
      ${discount > 0 ? `Скидки: −${formatPrice(discount)} · ` : ''}${deliveryNote}
    </div>`;
}

function updateCheckoutAddressField() {
  const field = document.getElementById('checkoutAddressField');
  const address = document.getElementById('checkoutAddress');
  if (!field || !address) return;

  const method = document.querySelector('input[name="delivery"]:checked')?.value || 'pickup';
  field.hidden = method === 'pickup';
  address.required = method === 'russia';
  address.placeholder = method === 'city'
    ? 'Адрес в Барнауле (можно уточнить в чате)'
    : 'Город, улица, дом, квартира или пункт выдачи';
}

function clearCheckoutError() {
  const error = document.getElementById('checkoutError');
  if (error) {
    error.hidden = true;
    error.textContent = '';
  }
}

function showCheckoutError(message, field) {
  const error = document.getElementById('checkoutError');
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }

  [document.getElementById('checkoutName'), document.getElementById('checkoutPhone'), document.getElementById('checkoutAddress')]
    .forEach(el => el?.classList.remove('invalid'));

  if (field) {
    field.classList.add('invalid');
    field.focus();
    triggerHaptic('error');
  }
  playSound('error');
}

function formatPhoneInput(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits[0] === '8') digits = `7${digits.slice(1)}`;
  if (digits[0] !== '7') digits = `7${digits}`;
  digits = digits.slice(0, 11);

  const rest = digits.slice(1);
  let result = '+7';
  if (rest.length) result += ` (${rest.slice(0, 3)}`;
  if (rest.length >= 3) result += ')';
  if (rest.length > 3) result += ` ${rest.slice(3, 6)}`;
  if (rest.length > 6) result += `-${rest.slice(6, 8)}`;
  if (rest.length > 8) result += `-${rest.slice(8, 10)}`;
  return result;
}

function prefillCheckoutForm() {
  const saved = getCheckoutCustomer();
  const name = document.getElementById('checkoutName');
  const phone = document.getElementById('checkoutPhone');
  const address = document.getElementById('checkoutAddress');
  const comment = document.getElementById('checkoutComment');

  if (name && !name.value) name.value = saved.name || currentUser?.first_name || '';
  if (phone && !phone.value) phone.value = formatPhoneInput(saved.phone || '');
  if (address && !address.value) address.value = saved.address || '';
  if (comment) comment.value = '';

  const method = ['city', 'russia'].includes(saved.delivery) ? saved.delivery : 'pickup';
  const radio = document.querySelector(`input[name="delivery"][value="${method}"]`);
  if (radio) radio.checked = true;

  updateCheckoutAddressField();
  clearCheckoutError();
  [name, phone, address].forEach(el => el?.classList.remove('invalid'));
}

function openCheckout() {
  if (!cart.length) {
    showToast('Корзина пуста', 'error');
    return;
  }

  renderCheckoutSummary();
  prefillCheckoutForm();
  updateStoreStatus();
  saveCartSnapshot();

  closeModal('cartModal');
  openModal('checkoutModal');

  playSound('tap');
  triggerHaptic('selection');

  setTimeout(() => document.getElementById('checkoutName')?.focus(), 160);
}

function submitCheckout(event) {
  event?.preventDefault();

  if (!cart.length) {
    closeModal('checkoutModal');
    showToast('Корзина пуста', 'error');
    return;
  }

  const nameEl = document.getElementById('checkoutName');
  const phoneEl = document.getElementById('checkoutPhone');
  const addressEl = document.getElementById('checkoutAddress');
  const commentEl = document.getElementById('checkoutComment');

  const name = String(nameEl?.value || '').trim();
  const phone = String(phoneEl?.value || '').trim();
  const phoneDigits = phone.replace(/\D/g, '');
  const method = document.querySelector('input[name="delivery"]:checked')?.value || 'pickup';
  const address = String(addressEl?.value || '').trim();
  const comment = String(commentEl?.value || '').trim();

  if (name.length < 2) {
    showCheckoutError('Укажите имя — так менеджеру будет проще к вам обратиться.', nameEl);
    return;
  }

  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    showCheckoutError('Проверьте телефон: нужно от 10 до 15 цифр.', phoneEl);
    return;
  }

  if (method === 'russia' && address.length < 5) {
    showCheckoutError('Для отправки по России укажите город и адрес или пункт выдачи.', addressEl);
    return;
  }

  clearCheckoutError();

  const customer = { name, phone, delivery: method, address, comment };

  try {
    localStorage.setItem('pf_customer', JSON.stringify({
      name,
      phone,
      delivery: method,
      address,
      updatedAt: new Date().toISOString()
    }));
  } catch (error) {
    // данные просто не сохранятся для следующего раза
  }

  closeModal('checkoutModal');
  checkout(customer);
}

function checkout(customer = null) {
  if (!cart.length) {
    showToast('Корзина пуста', 'error');
    return false;
  }

  const totals = getCartTotals();
  const items = cart.map(item => ({ ...item }));

  // Если такой же заказ уже ждёт подтверждения — не плодим дубли.
  let order = orders.find(entry => !isTestOrder(entry) && normalizeOrderStatus(entry.status) === 'created' && orderMatchesCart(entry));

  if (!order) {
    // Старые неотправленные черновики помечаем отменёнными, а не удаляем:
    // так история остаётся честной, а промокод не применяется дважды.
    const superseded = orders.filter(entry => !isTestOrder(entry) && normalizeOrderStatus(entry.status) === 'created');
    if (superseded.length) {
      const now = new Date().toISOString();
      orders = orders.map(entry => {
        if (isTestOrder(entry) || normalizeOrderStatus(entry.status) !== 'created') return entry;
        return {
          ...entry,
          status: 'canceled',
          updatedAt: now,
          cancelNote: 'Заменён новым заказом'
        };
      });
      superseded.forEach(entry => syncOrderStatus({ ...entry, status: 'canceled' }));
    }

    order = createOrderRecord(totals, items, customer);
    order.message = buildOrderMessage(order);
    orders.unshift(order);
  } else if (customer) {
    // Повторное оформление того же состава: обновляем контакты и способ получения.
    order.customer = {
      name: String(customer.name || '').trim(),
      phone: String(customer.phone || '').trim()
    };
    order.delivery = {
      method: ['pickup', 'city', 'russia'].includes(customer.delivery) ? customer.delivery : 'pickup',
      address: String(customer.address || '').trim(),
      comment: String(customer.comment || '').trim()
    };
    order.updatedAt = new Date().toISOString();
    order.message = buildOrderMessage(order);
  }

  saveOrders();
  syncOrder(order);
  updateOrderBadge();
  renderOrders();
  renderCartItems();

  openTelegramLink(orderTelegramUrl(order));

  playSound('tap');
  triggerHaptic('medium');

  showNotification({
    title: 'Подтвердите отправку',
    text: `${order.id} · ${formatPrice(order.total)}`,
    type: 'order',
    duration: 4200,
    onClick: openOrders
  });

  // Заказ не считается отправленным, пока пользователь не подтвердит это
  setTimeout(() => askOrderConfirmation(order.id), 600);
  return true;
}

// ============================================================
// ИНФО-МОДАЛКА
// ============================================================

function openInfoModal(type) {
  const modal = document.getElementById('infoModal');
  const body = document.getElementById('infoModalBody');
  if (!modal || !body) return;

  playSound('tap');
  triggerHaptic('selection');

  if (type === 'delivery') {
    body.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:16px;" aria-hidden="true"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
      <div class="info-title">Доставка</div>
      <div class="info-text">
        Отправляем заказы в день оплаты.<br><br>
        <b>СДЭК:</b> 2–5 дней по РФ.<br>
        <b>Почта России:</b> 3–7 дней по РФ.<br>
        <b>Boxberry:</b> 2–4 дня по РФ.<br><br>
        По городу Барнаул доставка <b>БЕСПЛАТНО</b>.<br><br>
        <b>Самовывоз:</b> Барнаул, Павловский тракт, 307к3.
      </div>
      <button class="info-btn" onclick="closeModal('infoModal')">ПОНЯТНО</button>
    `;
  } else if (type === 'promo') {
    if (promoUsed) {
      body.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" style="margin-bottom:16px;" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
        <div class="info-title" style="color: var(--danger)">Уже использован</div>
        <div class="info-text">Вы уже применили свой промокод на первый заказ.</div>
        <button class="info-btn" onclick="closeModal('infoModal')">ЗАКРЫТЬ</button>
      `;
      openModal(modal);
      return;
    }

    body.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:16px;" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
      <div class="info-title">Скидка 5%</div>
      <div class="info-text">Скидка действует на первый заказ. Введите код в корзине перед оформлением.</div>
      <button class="info-btn" id="getPromoBtn">ПОЛУЧИТЬ ПРОМОКОД</button>
      <div id="promoResult" style="margin-top: 20px; font-size: 24px; font-weight: 900; color: var(--accent); letter-spacing: 2px; cursor: pointer;" title="Нажмите, чтобы скопировать" role="button" tabindex="0"></div>
      <div class="promo-copy-hint" id="promoCopyHint" hidden>Нажмите на код, чтобы скопировать</div>
    `;

    const btn = document.getElementById('getPromoBtn');
    const result = document.getElementById('promoResult');
    const hint = document.getElementById('promoCopyHint');

    const reveal = () => {
      result.textContent = myPromoCode;
      btn.style.display = 'none';
      if (hint) hint.hidden = false;
      result.onclick = () => copyPromoCode(myPromoCode);
      result.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          copyPromoCode(myPromoCode);
        }
      };
    };

    if (btn) btn.onclick = reveal;
  } else if (type === 'gifts') {
    body.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:16px;" aria-hidden="true"><polyline points="20 12 20 22 4 22 4 12"></polyline><rect x="2" y="7" width="20" height="5"></rect><line x1="12" y1="22" x2="12" y2="7"></line><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path></svg>
      <div class="info-title">Подарки</div>
      <div class="info-text">
        При покупке наушников — <b>кабель 60W</b> в подарок.<br><br>
        При покупке часов — <b>ремешок Milanese</b> в подарок.<br><br>
        Подарок добавляется к заказу автоматически.
      </div>
      <button class="info-btn" onclick="closeModal('infoModal')">МНЕ НРАВИТСЯ!</button>
    `;
  } else if (type === 'install') {
    body.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:16px;" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
      <div class="info-title">Установить PF Store</div>
      <div class="info-text">
        <b>Android / Chrome:</b> меню ⋮ → «Установить приложение» или «Добавить на главный экран».<br><br>
        <b>iPhone / Safari:</b> кнопка «Поделиться» → «На экран “Домой”».<br><br>
        После установки магазин открывается с главного экрана как обычное приложение.
      </div>
      <button class="info-btn" onclick="closeModal('infoModal')">ПОНЯТНО</button>
    `;
  }

  openModal(modal);
}

// ============================================================
// ОТЗЫВЫ
// ============================================================

function loadReviews() {
  const track = document.getElementById('reviewsTrack');
  if (!track) return;

  const reviewImages = Array.from({ length: 6 }, (_, index) => `./images/otz/${index + 1}.jpg`);

  track.innerHTML = reviewImages.map((src, index) => `
    <img src="${src}" alt="Отзыв клиента ${index + 1}" loading="lazy" decoding="async"
         onclick="openLightbox('${src}', 'Отзыв клиента ${index + 1}')"
         onerror="this.remove()">
  `).join('');
}

function openReviewPrompt() {
  const url = `${location.origin}${location.pathname}`;
  const text = `Здравствуйте! Хочу оставить отзыв о PF Store. Что нужно прислать? Ссылка на магазин: ${url}`;
  openTelegramLink(`https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`);
  playSound('tap');
  triggerHaptic('selection');
  showToast('Откроется чат с менеджером', 'success');
}

// ============================================================
// SEO: ДИНАМИЧЕСКИЕ МЕТА-ТЕГИ
// ============================================================

const DEFAULT_SEO = {
  title: 'PF Store — электроника с проверкой перед покупкой',
  description: 'PF Store — часы, наушники, очки и аксессуары. Гарантия 14 дней, проверка товара перед покупкой, бесплатная доставка по Барнаулу и отправка по всей России.',
  image: './images/banner.jpg'
};

function absoluteUrl(path) {
  try {
    return new URL(path, location.href).href;
  } catch (error) {
    return path;
  }
}

function setMeta(id, value) {
  const el = document.getElementById(id);
  if (el) el.setAttribute('content', value);
}

function getProductSeoDescription(product) {
  const raw = String(product.desc || product.gift_desc || '').replace(/\s+/g, ' ').trim();
  if (raw) return raw.slice(0, 155);

  return `${product.title} — ${formatPrice(product.price)} в PF Store. Проверка при получении, гарантия 14 дней, самовывоз в Барнауле и отправка по России.`;
}

function updateProductSeo(product) {
  if (!product) return;

  const title = `${product.title} — купить в PF Store, Барнаул`;
  const description = getProductSeoDescription(product);
  const images = getProductImages(product);
  const image = absoluteUrl(images[0]);
  const url = `${location.origin}${location.pathname}?product=${product.id}`;

  document.title = title;
  setMeta('metaDescription', description);
  setMeta('ogTitle', title);
  setMeta('ogDescription', description);
  setMeta('ogImage', image);
  setMeta('ogUrl', url);
  setMeta('twitterTitle', title);
  setMeta('twitterDescription', description);
  setMeta('twitterImage', image);

  const canonical = document.getElementById('canonicalLink');
  if (canonical) canonical.setAttribute('href', url);

  const stock = Number(product.stock) || 0;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    image: images.map(absoluteUrl),
    description,
    sku: String(product.id),
    brand: { '@type': 'Brand', name: 'PF Store' },
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'RUB',
      price: Number(product.price) || 0,
      itemCondition: 'https://schema.org/NewCondition',
      availability: stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
      seller: { '@type': 'Organization', name: 'PF Store' }
    }
  };

  let script = document.getElementById('productJsonLd');
  if (!script) {
    script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = 'productJsonLd';
    document.head.appendChild(script);
  }
  script.textContent = JSON.stringify(data);
}

function resetProductSeo() {
  document.title = DEFAULT_SEO.title;
  setMeta('metaDescription', DEFAULT_SEO.description);
  setMeta('ogTitle', DEFAULT_SEO.title);
  setMeta('ogDescription', DEFAULT_SEO.description);
  setMeta('ogImage', absoluteUrl(DEFAULT_SEO.image));
  setMeta('ogUrl', absoluteUrl('./'));
  setMeta('twitterTitle', DEFAULT_SEO.title);
  setMeta('twitterDescription', DEFAULT_SEO.description);
  setMeta('twitterImage', absoluteUrl(DEFAULT_SEO.image));

  const canonical = document.getElementById('canonicalLink');
  if (canonical) canonical.setAttribute('href', absoluteUrl('./'));

  document.getElementById('productJsonLd')?.remove();
}

// ============================================================
// PWA
// ============================================================

function updateInstallButton() {
  const btn = document.getElementById('profileInstallBtn');
  if (!btn) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const inTelegram = isTelegramEnvironment();

  btn.hidden = standalone || inTelegram || (!installPromptEvent && !isIos);
}

function initPwa() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPromptEvent = event;
    updateInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    installPromptEvent = null;
    updateInstallButton();
    showToast('PF Store установлен на главный экран', 'success');
  });

  updateInstallButton();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(error => {
        console.warn('Service worker не зарегистрирован:', error);
      });
    });
  }
}

async function promptInstall() {
  if (!installPromptEvent) {
    openInfoModal('install');
    return;
  }

  const event = installPromptEvent;
  installPromptEvent = null;
  updateInstallButton();

  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice?.outcome === 'accepted') {
      showToast('Спасибо! Приложение установлено', 'success');
    }
  } catch (error) {
    openInfoModal('install');
  }
}

// ============================================================
// ВИДЫ
// ============================================================

function setView(view) {
  if (!['home', 'about', 'profile', 'favorites'].includes(view)) return;

  currentView = view;
  playSound('tap');
  triggerHaptic('selection');

  const viewHome = document.getElementById('view-home');
  const viewProfile = document.getElementById('view-profile');
  const viewAbout = document.getElementById('view-about');
  const viewFavorites = document.getElementById('view-favorites');
  const searchWrap = document.getElementById('searchWrapper');
  const categories = document.getElementById('categories');
  const controls = document.querySelector('.controls');
  const header = document.getElementById('mainHeader');

  const views = {
    home: viewHome,
    about: viewAbout,
    profile: viewProfile,
    favorites: viewFavorites
  };
  Object.entries(views).forEach(([name, el]) => {
    if (el) el.style.display = name === view ? 'block' : 'none';
  });

  if (searchWrap) searchWrap.style.display = view === 'home' ? 'block' : 'none';
  if (categories) categories.style.display = view === 'home' ? 'flex' : 'none';
  if (controls) controls.style.display = view === 'home' ? 'flex' : 'none';

  const navMap = {
    home: 'navHome',
    about: 'navAboutTab',
    profile: 'navProfileTab',
    favorites: 'navFavoritesTab'
  };

  ['navHome', 'navCartTab', 'navAboutTab', 'navProfileTab', 'navFavoritesTab'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById(navMap[view])?.classList.add('active');

  if (header) header.classList.remove('hidden');

  if (view === 'about') loadReviews();
  if (view === 'favorites') renderFavorites();
  if (view === 'home') renderResumeBanner();
  if (view === 'home' && productsLoaded) renderCatalog();
  renderRecent();

  window.scrollTo(0, 0);
  syncHeaderHeight();
  requestAnimationFrame(syncHeaderHeight);
  updateScrollProgress();
}

function syncHeaderHeight() {
  const header = document.getElementById('mainHeader');
  if (!header) return;
  document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
}

// ============================================================
// СОБЫТИЯ
// ============================================================

function bindEvents() {
  // Звук
  document.getElementById('soundToggle')?.addEventListener('click', toggleSound);

  // Навигация
  document.getElementById('navHome')?.addEventListener('click', () => setView('home'));
  document.getElementById('navAboutTab')?.addEventListener('click', () => setView('about'));
  document.getElementById('navProfileTab')?.addEventListener('click', () => setView('profile'));
  document.getElementById('navFavoritesTab')?.addEventListener('click', openFavorites);
  document.getElementById('navCartTab')?.addEventListener('click', openCart);

  // «О нас» → категория в каталоге
  document.querySelectorAll('[data-about-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      const category = btn.dataset.aboutCat;
      if (!category) return;
      setView('home');
      currentCategory = 'all';
      selectCategory(category);
      document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Статус магазина: заказ можно оставить в любое время
  document.getElementById('storeStatusAction')?.addEventListener('click', () => {
    if (cart.length) {
      openCart();
      return;
    }

    const text = isStoreOpen()
      ? 'Здравствуйте! Хочу оставить заказ. Подскажите, что есть в наличии.'
      : `Здравствуйте! Хочу оставить заказ. Магазин закрыт — прошу принять его в работу с ${STORE_OPEN_HOUR}:00.`;
    openTelegramLink(`https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`);
    playSound('tap');
    triggerHaptic('selection');
  });

  // Профиль
  document.getElementById('myPromoBtn')?.addEventListener('click', () => openInfoModal('promo'));

  document.querySelectorAll('.profile-item[role="button"]').forEach(item => {
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        item.click();
      }
    });
  });

  const telegramLine = document.getElementById('profileTelegramLine');
  telegramLine?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      telegramLine.click();
    }
  });
  document.getElementById('profileOrdersBtn')?.addEventListener('click', openOrders);
  document.getElementById('profileCartBtn')?.addEventListener('click', openCart);
  document.getElementById('profileFavoritesBtn')?.addEventListener('click', openFavorites);
  document.getElementById('profileTelegramLine')?.addEventListener('click', () => {
    if (currentUser) return;
    if (TELEGRAM_BOT_USERNAME) {
      openTelegramLink(`https://t.me/${TELEGRAM_BOT_USERNAME}?startapp`);
      return;
    }
    showToast('Имя и аватар — только в мини-приложении Telegram', 'error');
  });
  document.getElementById('profileManagerBtn')?.addEventListener('click', () => {
    const url = `https://t.me/${TELEGRAM_USERNAME}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  });

  // Заказы
  document.getElementById('closeOrders')?.addEventListener('click', () => closeModal('ordersModal'));
  document.getElementById('ordersBody')?.addEventListener('click', event => {
    const button = event.target.closest('[data-order-action]');
    if (!button) return;

    const action = button.dataset.orderAction;
    const orderId = button.dataset.orderId;

    if (action === 'shop') {
      closeModal('ordersModal');
      setView('home');
      return;
    }
    if (action === 'copy') {
      copyText(orderId)
        .then(() => showToast('Номер заказа скопирован', 'success'))
        .catch(() => showToast('Не удалось скопировать номер', 'error'));
      return;
    }
    if (action === 'sent') {
      askOrderConfirmation(orderId);
      return;
    }
    if (action === 'resend') {
      resendOrder(orderId);
      return;
    }
    if (action === 'reorder') {
      reorder(orderId);
      return;
    }
    if (action === 'delete') {
      deleteTestOrder(orderId);
      return;
    }
    if (action === 'manager' || action === 'delivery' || action === 'received' || action === 'canceled') {
      setOrderStatus(orderId, action);
    }
  });

  // Карта самовывоза: iframe подключается только после нажатия
  document.getElementById('pickupMapBtn')?.addEventListener('click', () => {
    const container = document.getElementById('pickupMap');
    if (!container) return;

    const address = 'Барнаул, Павловский тракт, 307к3';
    const src = `https://yandex.ru/map-widget/v1/?text=${encodeURIComponent(address)}&z=16`;
    container.innerHTML = `<iframe src="${src}" title="Карта: ${address}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>`;
    playSound('tap');
    triggerHaptic('selection');
  });

  // Избранное
  document.getElementById('sendFavoritesBtn')?.addEventListener('click', sendFavoritesToManager);
  document.getElementById('clearFavoritesBtn')?.addEventListener('click', clearFavorites);
  document.getElementById('favoritesEmptyBtn')?.addEventListener('click', () => setView('home'));
  document.getElementById('productFavBtn')?.addEventListener('click', () => {
    if (currentProductId != null) toggleFavorite(currentProductId);
  });
  document.getElementById('productShareBtn')?.addEventListener('click', () => {
    const product = products.find(item => Number(item.id) === Number(currentProductId));
    if (product) shareProduct(product);
  });

  // Подтверждение действий
  document.getElementById('confirmCancel')?.addEventListener('click', closeConfirm);
  document.getElementById('confirmOk')?.addEventListener('click', runConfirm);

  // Напоминание о незавершённом заказе
  document.getElementById('resumeBannerBtn')?.addEventListener('click', () => {
    playSound('tap');
    triggerHaptic('selection');
    openCheckout();
  });
  document.getElementById('resumeBannerClose')?.addEventListener('click', () => {
    try {
      localStorage.setItem(CART_NUDGE_KEY, String(Date.now()));
    } catch (error) {
      // скроем только на этот раз
    }
    const banner = document.getElementById('resumeBanner');
    if (banner) banner.hidden = true;
    playSound('tap');
  });

  // Промокод
  document.getElementById('applyPromoBtn')?.addEventListener('click', applyPromo);
  document.getElementById('promoInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') applyPromo();
  });

  // Категории
  document.querySelectorAll('.cat-pill').forEach(button => {
    button.addEventListener('click', () => selectCategory(button.dataset.cat));
  });

  // Поиск
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');

  searchInput?.addEventListener('input', event => {
    searchQuery = event.target.value;
    searchClear?.classList.toggle('active', searchQuery.length > 0);

    if (searchQuery.trim() && currentCategory !== 'all') {
      currentCategory = 'all';
      document.querySelectorAll('.cat-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.cat === 'all');
      });
    }

    renderCatalog();
  });

  searchClear?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    searchQuery = '';
    searchClear.classList.remove('active');
    document.getElementById('searchWrapper')?.classList.remove('has-value');
    renderCatalog();
    searchInput?.focus();
  });

  // Закрытие модалок
  document.getElementById('closeCart')?.addEventListener('click', () => closeModal('cartModal'));
  document.getElementById('closeProduct')?.addEventListener('click', () => closeModal('productModal'));
  document.getElementById('closeInfo')?.addEventListener('click', () => closeModal('infoModal'));
  document.getElementById('closeFilter')?.addEventListener('click', () => closeModal('filterModal'));

  // Панель покупки: прячем, когда основная кнопка уже видна
  const buyBarEl = document.getElementById('productBuyBar');
  const productScroller = document.querySelector('.product-modal');
  const mainAddBtn = document.getElementById('addToCart');
  if (buyBarEl && productScroller && mainAddBtn) {
    const updateBuyBar = () => {
      if (document.getElementById('productModal')?.classList.contains('active') === false) return;
      const barHeight = buyBarEl.offsetHeight || 68;
      const rect = mainAddBtn.getBoundingClientRect();
      const ctaVisible = rect.top > 0 && rect.bottom < window.innerHeight - barHeight;
      buyBarEl.classList.toggle('is-hidden', ctaVisible);
    };
    productScroller.addEventListener('scroll', updateBuyBar, { passive: true });
    window.addEventListener('resize', updateBuyBar);
    window.updateProductBuyBar = updateBuyBar;
  }

  // Клик по фону модалки
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', event => {
      if (event.target === modal) closeModal(modal);
    });
  });

  // Escape и удержание фокуса внутри модалок
  document.addEventListener('keydown', handleGlobalKeydown);

  // Оформление заказа
  document.getElementById('checkoutBtn')?.addEventListener('click', openCheckout);
  document.getElementById('checkoutForm')?.addEventListener('submit', submitCheckout);

  // Маска телефона: +7 (999) 000-00-00
  const phoneInput = document.getElementById('checkoutPhone');
  phoneInput?.addEventListener('input', event => {
    const input = event.target;
    const formatted = formatPhoneInput(input.value);
    if (input.value === formatted) return;
    input.value = formatted;
    input.setSelectionRange(formatted.length, formatted.length);
  });
  phoneInput?.addEventListener('blur', () => {
    if (phoneInput.value.replace(/\D/g, '').length <= 1) phoneInput.value = '';
  });

  document.getElementById('closeCheckout')?.addEventListener('click', () => closeModal('checkoutModal'));
  document.querySelectorAll('input[name="delivery"]').forEach(radio => {
    radio.addEventListener('change', () => {
      updateCheckoutAddressField();
      renderCheckoutSummary();
    });
  });
  document.getElementById('clearCartBtn')?.addEventListener('click', clearCart);
  document.getElementById('pendingOrderHint')?.addEventListener('click', () => {
    closeModal('cartModal');
    openOrders();
  });

  // Недавно просмотренные
  document.getElementById('recentList')?.addEventListener('click', event => {
    const card = event.target.closest('[data-recent]');
    if (!card) return;
    openProduct(Number(card.dataset.recent));
  });
  document.getElementById('clearRecentBtn')?.addEventListener('click', clearRecent);

  // Похожие товары
  document.getElementById('similarList')?.addEventListener('click', event => {
    const card = event.target.closest('[data-similar]');
    if (!card) return;
    openProduct(Number(card.dataset.similar));
  });

  // Отзывы и установка приложения
  document.getElementById('reviewCta')?.addEventListener('click', openReviewPrompt);
  document.getElementById('profileInstallBtn')?.addEventListener('click', promptInstall);

  // Фильтры
  document.getElementById('filterBtn')?.addEventListener('click', () => openModal('filterModal'));

  document.getElementById('resetFilters')?.addEventListener('click', () => {
    const priceMin = document.getElementById('priceMin');
    const priceMax = document.getElementById('priceMax');
    const inStockOnly = document.getElementById('inStockOnly');

    if (priceMin) priceMin.value = '';
    if (priceMax) priceMax.value = '';
    if (inStockOnly) inStockOnly.checked = false;

    filters = { priceMin: null, priceMax: null, inStockOnly: false };
    updateFilterBadge();
    renderCatalog();
    closeModal('filterModal');
  });

  document.getElementById('applyFilters')?.addEventListener('click', () => {
    const priceMin = document.getElementById('priceMin');
    const priceMax = document.getElementById('priceMax');
    const inStockOnly = document.getElementById('inStockOnly');

    const minValue = priceMin ? parseFloat(priceMin.value) : NaN;
    const maxValue = priceMax ? parseFloat(priceMax.value) : NaN;

    filters.priceMin = Number.isFinite(minValue) ? minValue : null;
    filters.priceMax = Number.isFinite(maxValue) ? maxValue : null;

    if (filters.priceMin != null && filters.priceMax != null && filters.priceMin > filters.priceMax) {
      [filters.priceMin, filters.priceMax] = [filters.priceMax, filters.priceMin];
      if (priceMin) priceMin.value = filters.priceMin;
      if (priceMax) priceMax.value = filters.priceMax;
    }

    filters.inStockOnly = Boolean(inStockOnly?.checked);

    updateFilterBadge();
    renderCatalog();
    closeModal('filterModal');
    playSound('tap');
    triggerHaptic('selection');
  });

  // Сортировка
  const sortSelect = document.getElementById('sortSelect');
  if (sortSelect) {
    sortSelect.value = sortMode;
    sortSelect.addEventListener('change', event => {
      sortMode = SORT_MODES.includes(event.target.value) ? event.target.value : 'popular';
      localStorage.setItem('pf_sort', sortMode);
      renderCatalog();
      playSound('tap');
      triggerHaptic('selection');
    });
  }

  // Карточки каталога и избранного (делегирование)
  const handleProductGridClick = event => {
    const emptyManager = event.target.closest('[data-empty-manager]');
    if (emptyManager) {
      openManagerChat(null, searchQuery);
      return;
    }

    const emptyCategory = event.target.closest('[data-empty-cat]');
    if (emptyCategory) {
      selectCategory(emptyCategory.dataset.emptyCat);
      return;
    }

    const emptyProduct = event.target.closest('[data-empty-product]');
    if (emptyProduct) {
      openProduct(Number(emptyProduct.dataset.emptyProduct));
      return;
    }

    const favButton = event.target.closest('.card-fav');
    if (favButton) {
      toggleFavorite(Number(favButton.dataset.fav));
      return;
    }

    const addButton = event.target.closest('.card-btn');
    if (addButton) {
      const added = addToCart(Number(addButton.dataset.add));
      if (added) pulseAddButton(addButton, addButton.textContent.trim() === 'ПОД ЗАКАЗ');
      return;
    }

    const card = event.target.closest('.card');
    if (card) openProduct(Number(card.dataset.id));
  };

  const catalog = document.getElementById('catalog');
  catalog?.addEventListener('click', handleProductGridClick);

  catalog?.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.card');
    if (card && event.target === card) {
      event.preventDefault();
      openProduct(Number(card.dataset.id));
    }
  });

  document.getElementById('favoritesGrid')?.addEventListener('click', handleProductGridClick);

  // Скрытие шапки при скролле
  let lastScrollTop = 0;
  let scrollTicking = false;

  window.addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;

    requestAnimationFrame(() => {
      scrollTicking = false;
      updateScrollProgress();

      const header = document.getElementById('mainHeader');
      if (!header || document.body.classList.contains('modal-open')) return;

      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      if (scrollTop > lastScrollTop && scrollTop > 60) header.classList.add('hidden');
      else header.classList.remove('hidden');

      lastScrollTop = Math.max(0, scrollTop);
    });
  }, { passive: true });

  updateScrollProgress();
  updateStoreStatus();

  // Пересчёт статуса раз в минуту и только на видимой вкладке
  let statusTimer = null;
  const startStatusTimer = () => {
    if (statusTimer) return;
    statusTimer = setInterval(updateStoreStatus, 60000);
  };
  const stopStatusTimer = () => {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
  };
  startStatusTimer();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopStatusTimer();
      return;
    }
    updateStoreStatus();
    startStatusTimer();
  });

  // Свайп вниз для закрытия карточки товара
  const productModalContent = document.querySelector('.product-modal');
  if (productModalContent) {
    let touchStartY = 0;
    let touchStartX = 0;
    let tracking = false;

    productModalContent.addEventListener('touchstart', event => {
      tracking = productModalContent.scrollTop <= 0;
      if (tracking) {
        touchStartY = event.changedTouches[0].screenY;
        touchStartX = event.changedTouches[0].screenX;
      }
    }, { passive: true });

    productModalContent.addEventListener('touchend', event => {
      if (!tracking) return;
      tracking = false;

      const deltaY = event.changedTouches[0].screenY - touchStartY;
      const deltaX = event.changedTouches[0].screenX - touchStartX;

      if (deltaY > 90 && Math.abs(deltaX) < 60) {
        closeModal('productModal');
      }
    }, { passive: true });
  }

  // Пересчёт высоты шапки
  window.addEventListener('resize', syncHeaderHeight);
  window.addEventListener('orientationchange', () => setTimeout(syncHeaderHeight, 150));

  if (document.fonts?.ready) {
    document.fonts.ready.then(syncHeaderHeight).catch(() => {});
  }
}

// ============================================================
// СТАРТ
// ============================================================

safeLoadCart();
generatePromoCode();
orders = safeLoadOrders();
recentIds = safeLoadRecent();
priceDrops = safeLoadJson('pf_price_drops', {});

// ============================================================
// ОРГАНИЧНЫЕ АНИМАЦИИ
// ============================================================

const SEARCH_HINTS = ['ПОИСК', 'НАУШНИКИ', 'СМАРТФОНЫ', 'ЧАСЫ', 'КОЛОНКИ', 'АКСЕССУАРЫ', 'ПРОВОДА'];

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Ротация подсказок поиска — как в Aceternity Placeholders and Vanish Input.
function initSearchMotion() {
  const input = document.getElementById('searchInput');
  const wrapper = document.getElementById('searchWrapper');
  const rotator = document.getElementById('searchRotator');
  if (!input || !wrapper || !rotator) return;

  let index = 0;
  let swapTimer = null;

  const syncValue = () => wrapper.classList.toggle('has-value', input.value.length > 0);
  syncValue();
  input.addEventListener('input', syncValue);

  if (prefersReducedMotion()) return;

  const tick = () => {
    if (document.hidden || input.value || document.activeElement === input) return;
    rotator.classList.add('is-swapping');
    swapTimer = window.setTimeout(() => {
      index = (index + 1) % SEARCH_HINTS.length;
      rotator.textContent = SEARCH_HINTS[index];
      rotator.classList.remove('is-swapping');
    }, 260);
  };

  const timer = window.setInterval(tick, 3600);
  window.addEventListener('pagehide', () => {
    window.clearInterval(timer);
    window.clearTimeout(swapTimer);
  }, { once: true });
}

// Мягкий блик по карточке вслед за курсором — как spotlight в Aceternity.
function initCardSpotlight() {
  if (prefersReducedMotion()) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  let frame = null;
  let lastEvent = null;

  document.addEventListener('pointermove', event => {
    const card = event.target.closest?.('.card');
    if (!card) return;
    lastEvent = { card, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!lastEvent) return;
      const rect = lastEvent.card.getBoundingClientRect();
      lastEvent.card.style.setProperty('--mx', `${lastEvent.x - rect.left}px`);
      lastEvent.card.style.setProperty('--my', `${lastEvent.y - rect.top}px`);
    });
  }, { passive: true });
}

// Секции проявляются мягко, без «врезания» и без влияния на работу страницы.
function initSectionReveal() {
  if (prefersReducedMotion() || !('IntersectionObserver' in window)) return;

  const targets = document.querySelectorAll(
    '.trust-marquee, .about-section, .about-cta'
  );
  if (!targets.length) return;

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });

  targets.forEach(el => {
    el.classList.add('reveal');
    observer.observe(el);
  });
}

// Кнопка «Добавлено» с коротким подтверждением на месте — состояние, а не вспышка.
function pulseAddButton(button, isOrder = false) {
  if (!button) return;
  const label = button.textContent;
  button.classList.add('is-added');
  button.textContent = isOrder ? 'ПОД ЗАКАЗ ✓' : 'ДОБАВЛЕНО ✓';
  window.setTimeout(() => {
    button.classList.remove('is-added');
    button.textContent = label;
  }, 1500);
}

// Бегущая строка гарантий: дублируем ленту для бесшовной прокрутки
function initTrustMarquee() {
  const track = document.querySelector('.trust-marquee-track');
  const group = track?.querySelector('.trust-marquee-group');
  if (!track || !group || track.children.length > 1) return;

  const clone = group.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  track.appendChild(clone);
}

document.addEventListener('DOMContentLoaded', () => {
  updateGreeting(null);
  updateSoundToggle();
  initTelegram();
  initTelegramBanner();
  initPwa();
  initSearchMotion();
  initTrustMarquee();
  initCardSpotlight();
  initSectionReveal();
  bindEvents();
  syncHeaderHeight();
  updateFilterBadge();
  updateFavoriteBadge();
  updateScrollProgress();
  updateStoreStatus();
  updateOrderBadge();
  applyManagerUI();
  updateUI();
  resetProductSeo();
  renderRecent();
  renderResumeBanner();
  document.querySelectorAll('.modal').forEach(modal => {
    if (!modal.classList.contains('active')) modal.setAttribute('aria-hidden', 'true');
  });
  loadProducts();
  loadOrdersFromServer();

  try {
    const params = new URLSearchParams(location.search);
    const shortcutView = params.get('view');
    const hasProduct = Boolean(params.get('product'));

    if (!hasProduct && shortcutView === 'cart') {
      setTimeout(openCart, 500);
    } else if (!hasProduct && shortcutView === 'orders') {
      setTimeout(openOrders, 500);
    }
  } catch (error) {
    // некорректная ссылка не должна мешать загрузке
  }

  window.addEventListener('load', () => {
    syncHeaderHeight();
    initTelegram();
    initTelegramBanner();
  });
});

// Функции, которые вызываются из разметки
Object.assign(window, {
  setView,
  openInfoModal,
  openCart,
  openFavorites,
  openLightbox,
  closeLightbox,
  closeModal,
  updateQty,
  removePromo,
  resetAllFilters
});
