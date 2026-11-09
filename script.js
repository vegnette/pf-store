'use strict';

// ⚠️ ЗАМЕНИ НА СВОЙ ЮЗЕРНЕЙМ (без @)
const TELEGRAM_USERNAME = 'PF_Store_manager';
const STORE_NAME = 'PF Store';
const STORE_TIMEZONE = 'Asia/Barnaul';

// Если сюда вставить URL бесплатного Cloudflare Worker,
// избранное будет уходить менеджеру автоматически.
// Пока пусто — работает кнопка «Отправить менеджеру».
const FAVORITES_ENDPOINT = '';

const CATEGORY_LABELS = {
  watches: 'часы',
  headphones: 'наушники',
  glasses: 'очки',
  accessories: 'аксессуары'
};

const NO_PHOTO = './images/no-photo.svg';
const SORT_MODES = ['popular', 'price-asc', 'price-desc', 'discount', 'new'];

// --- СОСТОЯНИЕ ---
let tg = window.Telegram?.WebApp || null;
let products = [];
let productsLoaded = false;
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

// --- ПРОМОКОДЫ ---
let myPromoCode = localStorage.getItem('pf_promo_code');
let promoUsed = localStorage.getItem('pf_promo_used') === 'true';
let appliedPromoPercent = Number(localStorage.getItem('pf_promo_applied') || 0);

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
let currentSlide = 0;
let slideInterval = null;

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

function toggleFavorite(id) {
  const product = products.find(item => Number(item.id) === Number(id));
  if (!product) return;

  const wasFavorite = isFavorite(id);

  if (wasFavorite) {
    favorites = favorites.filter(favoriteId => Number(favoriteId) !== Number(id));
  } else {
    favorites.push(Number(id));
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
    return;
  }

  grid.innerHTML = favoriteProducts.map(product => buildProductCard(product)).join('');
  updateFavoriteBadge();
}

function openFavorites() {
  [...modalStack].forEach(modal => closeModal(modal));
  setView('favorites');
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

function openManagerChat(product) {
  if (!product) return;

  const stock = Number(product.stock) || 0;
  const text = stock > 0
    ? `Здравствуйте! Хочу уточнить по товару: ${product.title} — ${formatPrice(product.price)}`
    : `Здравствуйте! Хочу уточнить сроки поставки: ${product.title} — ${formatPrice(product.price)}`;

  openTelegramLink(`https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`);
  playSound('tap');
  triggerHaptic('selection');
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
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
  const hour = new Date().getHours();
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

function openModal(target) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;

  el.classList.add('active');
  if (!modalStack.includes(el)) modalStack.push(el);
  document.body.classList.add('modal-open');
  updateBackButton();
}

function closeModal(target) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;

  el.classList.remove('active');
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
  }

  updateBackButton();
}

// Брендированное подтверждение действий
function openConfirm({ title, text, confirmText = 'ПОДТВЕРДИТЬ', onConfirm = null }) {
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

  if (titleEl) titleEl.textContent = title || 'Подтвердить действие?';
  if (textEl) textEl.textContent = text || 'Это действие нельзя отменить.';
  if (okBtn) okBtn.textContent = confirmText;

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

function initTelegram() {
  if (!tg) return;

  try {
    tg.ready();
    tg.expand();
  } catch (error) {
    // ignore
  }

  try {
    tg.setHeaderColor?.('#67E9D1');
    tg.setBackgroundColor?.('#050505');
  } catch (error) {
    // старые версии Telegram
  }

  const user = tg.initDataUnsafe?.user;
  if (user?.first_name) {
    renderUserProfile(user);
  }

  initBackButton();
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

    if (skeleton) skeleton.style.display = 'none';
    catalog.style.display = 'grid';

    renderCatalog();
    updateCategoryVisibility();
    updateUI();
    updateFavoriteUI();
    updateStoreStatus();
    handleDeepLink();
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
  if (!chip || !text) return;

  let minutes = null;

  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: STORE_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());

    const hours = Number(parts.find(part => part.type === 'hour')?.value);
    const mins = Number(parts.find(part => part.type === 'minute')?.value);

    if (Number.isFinite(hours) && Number.isFinite(mins)) minutes = hours * 60 + mins;
  } catch (error) {
    const now = new Date();
    minutes = now.getHours() * 60 + now.getMinutes();
  }

  if (minutes == null) {
    text.textContent = '10:00–21:00';
    return;
  }

  const isOpen = minutes >= 10 * 60 && minutes < 21 * 60;
  const timeLeft = 21 * 60 - minutes;

  if (isOpen) {
    chip.classList.remove('closed');
    text.textContent = timeLeft <= 60
      ? `ОТКРЫТО · ЗАКРОЕМСЯ ЧЕРЕЗ ${timeLeft} МИН`
      : 'ОТКРЫТО ДО 21:00';
  } else {
    chip.classList.add('closed');
    text.textContent = 'ЗАКРЫТО · ОТКРОЕМСЯ В 10:00';
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

function buildProductCard(product) {
  const images = getProductImages(product);
  const img1 = images[0];
  const subImages = images.slice(1, 3);
  const stock = Number(product.stock) || 0;
  const isOutOfStock = stock <= 0;
  const active = isFavorite(product.id);
  const safeTitle = escapeHtml(product.title);
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
        <div class="card-badges">${getBadgesHtml(product)}</div>
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
        ${giftShort ? `<span class="card-gift" title="${escapeHtml(giftShort)}">🎁 ${escapeHtml(giftShort)}</span>` : ''}
        <button class="card-btn" data-add="${product.id}">
          ${isOutOfStock ? 'ПОД ЗАКАЗ' : 'В КОРЗИНУ'}
        </button>
        <button type="button" class="card-manager-btn" data-manager="${product.id}">
          НАПИСАТЬ МЕНЕДЖЕРУ
        </button>
      </div>
    </div>`;
}

function renderCatalog() {
  const catalog = document.getElementById('catalog');
  if (!catalog || !productsLoaded) return;

  const filtered = getFilteredProducts();

  if (!filtered.length) {
    catalog.innerHTML = `
      <div class="catalog-empty">
        <div class="catalog-empty-icon" aria-hidden="true">🔎</div>
        <div class="catalog-empty-title">Ничего не найдено</div>
        <p>Попробуйте изменить запрос или сбросить фильтры.</p>
        <button class="empty-reset" onclick="resetAllFilters()">СБРОСИТЬ ФИЛЬТРЫ</button>
      </div>`;
    return;
  }

  catalog.innerHTML = filtered.map(buildProductCard).join('');
  animateCatalogCards();
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

  const dots = Array.from(dotsContainer.querySelectorAll('.gallery-dot'));
  let currentIndex = 0;

  gallery.onscroll = () => {
    const width = gallery.clientWidth || 1;
    const index = Math.max(0, Math.min(images.length - 1, Math.round(gallery.scrollLeft / width)));
    if (index !== currentIndex) currentIndex = index;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
    if (images.length > 1) counter.textContent = `${index + 1} / ${images.length}`;
  };

  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      const index = Number(dot.dataset.index);
      gallery.scrollTo({ left: gallery.clientWidth * index, behavior: 'smooth' });
    });
  });

  // Основная информация
  badges.innerHTML = getBadgesHtml(product);
  document.getElementById('productTitle').textContent = product.title;
  document.getElementById('productPrice').textContent = formatPrice(product.price);

  const oldPriceEl = document.getElementById('productOldPrice');
  oldPriceEl.textContent = product.oldPrice && product.oldPrice > product.price ? formatPrice(product.oldPrice) : '';

  const stockEl = document.getElementById('productStock');
  const stock = Number(product.stock) || 0;
  if (stock > 0) {
    stockEl.textContent = `В НАЛИЧИИ: ${stock} ШТ.`;
    stockEl.className = 'product-stock-status' + (stock <= 5 ? ' low' : '');
  } else {
    stockEl.textContent = 'НЕТ В НАЛИЧИИ — ДОСТУПЕН ПОД ЗАКАЗ';
    stockEl.className = 'product-stock-status out';
  }

  renderProductGift(product);

  currentProductId = Number(product.id);

  const managerBtn = document.getElementById('askManagerBtn');
  if (managerBtn) managerBtn.onclick = () => openManagerChat(product);

  const shareBtn = document.getElementById('productShareBtn');
  if (shareBtn) shareBtn.onclick = () => shareProduct(product);

  updateFavoriteUI();

  const addToCartBtn = document.getElementById('addToCart');
  addToCartBtn.textContent = stock > 0 ? 'В КОРЗИНУ' : 'ЗАКАЗАТЬ ПОД ЗАКАЗ';
  addToCartBtn.style.opacity = stock > 0 ? '1' : '0.85';
  addToCartBtn.onclick = () => {
    if (addToCart(product.id)) closeModal(modal);
  };

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
  });
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
            <div class="cart-item-price">${formatPrice(item.price)}</div>
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

function checkout() {
  if (!cart.length) {
    showToast('Корзина пуста', 'error');
    return;
  }

  const totals = getCartTotals();
  const lines = [];

  cart.forEach(item => {
    lines.push(`• ${item.title}${Number(item.stock) <= 0 ? ' (под заказ)' : ''}`);
    lines.push(`  ${item.qty} шт. × ${formatPrice(item.price)} = ${formatPrice(Number(item.price) * item.qty)}`);
    if (item.gift_desc) lines.push(`  🎁 Подарок: ${String(item.gift_desc).replace('🎁', '').trim()}`);
  });

  let discountText = '';
  if (appliedPromoPercent > 0) {
    discountText += `\nПромокод: ${myPromoCode} (-${formatPrice(totals.promoDiscountAmount)})`;
  }
  if (totals.hasQtyDiscount) {
    discountText += `\nСкидка за количество (5%): -${formatPrice(totals.qtyDiscountAmount)}`;
  }

  const orderId = `PF-${Date.now().toString(36).toUpperCase().slice(-5)}`;
  const date = new Date().toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const text = `Здравствуйте! Заказ ${orderId} в ${STORE_NAME} (${date}):\n\n${lines.join('\n')}${discountText}\n\nДоставка по городу: Бесплатно\nИтого: ${formatPrice(totals.total)}`;

  // Промокод одноразовый: фиксируем использование после формирования заказа
  if (appliedPromoPercent > 0) {
    promoUsed = true;
    appliedPromoPercent = 0;
    localStorage.setItem('pf_promo_used', 'true');
    localStorage.setItem('pf_promo_applied', '0');
    updateUI();
  }

  const url = `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`;
  if (tg?.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');

  showToast('Заказ сформирован — отправьте сообщение в Telegram', 'success');
  playSound('success');
  triggerHaptic('success');
  showNotification({
    title: 'Заказ сформирован',
    text: `${orderId} · ${formatPrice(totals.total)}`,
    type: 'order',
    duration: 3200
  });
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
  const slider = document.querySelector('.slider-container');
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
  if (slider) slider.style.display = view === 'home' ? 'block' : 'none';
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
  if (view === 'home' && productsLoaded) renderCatalog();

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
// КАРУСЕЛЬ
// ============================================================

function initSlider() {
  const track = document.getElementById('sliderTrack');
  const container = document.querySelector('.slider-container');
  const dots = Array.from(document.querySelectorAll('#sliderDots .dot'));
  if (!track || !container || !dots.length) return;

  const totalSlides = dots.length;

  window.goToSlide = index => {
    currentSlide = ((index % totalSlides) + totalSlides) % totalSlides;
    track.style.transform = `translateX(-${currentSlide * 100}%)`;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === currentSlide));
  };

  window.nextSlide = () => {
    if (currentView !== 'home' || document.hidden || modalStack.length) return;
    window.goToSlide(currentSlide + 1);
  };

  const restartAutoplay = () => {
    clearInterval(slideInterval);
    slideInterval = setInterval(window.nextSlide, 4500);
  };

  let touchStartX = 0;
  let touchEndX = 0;

  container.addEventListener('touchstart', event => {
    touchStartX = event.changedTouches[0].screenX;
    clearInterval(slideInterval);
  }, { passive: true });

  container.addEventListener('touchend', event => {
    touchEndX = event.changedTouches[0].screenX;
    const threshold = 50;

    if (touchEndX < touchStartX - threshold) {
      window.goToSlide(currentSlide + 1);
    } else if (touchEndX > touchStartX + threshold) {
      window.goToSlide(currentSlide - 1);
    }

    restartAutoplay();
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) restartAutoplay();
  });

  restartAutoplay();
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

  // Профиль
  document.getElementById('myPromoBtn')?.addEventListener('click', () => openInfoModal('promo'));
  document.getElementById('profileCartBtn')?.addEventListener('click', openCart);
  document.getElementById('profileFavoritesBtn')?.addEventListener('click', openFavorites);
  document.getElementById('profileManagerBtn')?.addEventListener('click', () => {
    const url = `https://t.me/${TELEGRAM_USERNAME}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
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
    renderCatalog();
    searchInput?.focus();
  });

  // Закрытие модалок
  document.getElementById('closeCart')?.addEventListener('click', () => closeModal('cartModal'));
  document.getElementById('closeProduct')?.addEventListener('click', () => closeModal('productModal'));
  document.getElementById('closeInfo')?.addEventListener('click', () => closeModal('infoModal'));
  document.getElementById('closeFilter')?.addEventListener('click', () => closeModal('filterModal'));

  // Клик по фону модалки
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', event => {
      if (event.target === modal) closeModal(modal);
    });
  });

  // Escape
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeTopModal();
  });

  // Оформление заказа
  document.getElementById('checkoutBtn')?.addEventListener('click', checkout);
  document.getElementById('clearCartBtn')?.addEventListener('click', clearCart);

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
    const favButton = event.target.closest('.card-fav');
    if (favButton) {
      toggleFavorite(Number(favButton.dataset.fav));
      return;
    }

    const managerButton = event.target.closest('.card-manager-btn');
    if (managerButton) {
      const product = products.find(item => Number(item.id) === Number(managerButton.dataset.manager));
      if (product) openManagerChat(product);
      return;
    }

    const addButton = event.target.closest('.card-btn');
    if (addButton) {
      addToCart(Number(addButton.dataset.add));
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
  setInterval(updateStoreStatus, 60000);

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

document.addEventListener('DOMContentLoaded', () => {
  updateGreeting(null);
  updateSoundToggle();
  initTelegram();
  initSlider();
  bindEvents();
  syncHeaderHeight();
  updateFilterBadge();
  updateFavoriteBadge();
  updateScrollProgress();
  updateStoreStatus();
  updateUI();
  loadProducts();
  window.addEventListener('load', syncHeaderHeight);
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
