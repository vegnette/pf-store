// ⚠️ ЗАМЕНИ НА СВОЙ ЮЗЕРНЕЙМ (без @)
const TELEGRAM_USERNAME = 'PF_Store_manager';

let products = [];
let cart = JSON.parse(localStorage.getItem('cart') || '[]');
let favorites = JSON.parse(localStorage.getItem('favorites') || '[]');
let currentCategory = 'all';
let searchQuery = '';
let currentView = 'home'; 
let filters = { priceMin: null, priceMax: null, inStockOnly: false };
let currentGiftPath = ''; 

// --- ПРОМОКОДЫ ---
let myPromoCode = localStorage.getItem('pf_promo_code');
let promoUsed = localStorage.getItem('pf_promo_used') === 'true';
// БАГФИКС 2: Сохраняем примененный промокод в localStorage, чтобы он не слетал при перезагрузке
let appliedPromoPercent = Number(localStorage.getItem('pf_promo_applied') || 0);

function generatePromoCode() {
  if (!myPromoCode) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let randomPart = '';
    for (let i = 0; i < 4; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    myPromoCode = `PF5-${randomPart}`;
    localStorage.setItem('pf_promo_code', myPromoCode);
  }
}

// --- КАРУСЕЛЬ ---
let currentSlide = 0;
let slideInterval;

function initSlider() {
  const track = document.getElementById('sliderTrack');
  const dots = document.querySelectorAll('.dot');
  const totalSlides = 3;
  const container = document.querySelector('.slider-container');

  window.goToSlide = (index) => {
    currentSlide = index;
    track.style.transform = `translateX(-${currentSlide * 100}%)`;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === currentSlide));
  };

  window.nextSlide = () => {
    currentSlide = (currentSlide + 1) % totalSlides;
    goToSlide(currentSlide);
  };

  let touchStartX = 0;
  let touchEndX = 0;

  container.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
    clearInterval(slideInterval);
  }, { passive: true });

  container.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
    slideInterval = setInterval(nextSlide, 4000);
  }, { passive: true });

  function handleSwipe() {
    const swipeThreshold = 50;
    if (touchEndX < touchStartX - swipeThreshold) {
      nextSlide();
    } else if (touchEndX > touchStartX + swipeThreshold) {
      currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
      goToSlide(currentSlide);
    }
  }

  slideInterval = setInterval(nextSlide, 4000);
}

const fallbackProducts = [
  { id: 1, category: "watches", title: "Apple Watch S11 46mm", price: 2000, oldPrice: 3000, stock: 3, badges: ["hit"], desc_file: "./images/Watch 11/1.txt", images: ["./images/Watch 11/1.jpg"] }
];

// Настройка Telegram WebApp и Haptic Feedback
let tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.setHeaderColor('#67E9D1');
  
  const user = tg.initDataUnsafe?.user;
  if (user && user.first_name) {
    document.getElementById('tgUserName').textContent = user.first_name.toUpperCase() + '!';
    document.getElementById('profileName').textContent = user.first_name.toUpperCase();
  }
}

// ФУНКЦИЯ ВИБРАЦИИ (Работает в ТГ, iOS, Android)
function triggerHaptic(type = 'light') {
  if (tg && tg.HapticFeedback) {
    tg.HapticFeedback.impactOccurred(type);
  } else if (navigator.vibrate) {
    navigator.vibrate(30);
  }
}

async function loadProducts() {
  document.getElementById('skeletonLoader').style.display = 'grid';
  document.getElementById('catalog').style.display = 'none';

  try {
    const res = await fetch('./products.json');
    if (!res.ok) throw new Error('Network response was not ok');
    products = await res.json();
  } catch (err) {
    console.warn('Ошибка загрузки JSON, используются тестовые данные:', err);
    products = [...fallbackProducts]; 
  } finally {
    setTimeout(() => {
      document.getElementById('skeletonLoader').style.display = 'none';
      document.getElementById('catalog').style.display = 'grid';
      renderCatalog();
      updateUI();
      generatePromoCode();
    }, 600); 
  }
}

// БАГФИКС 1: Берем цену из текста ТОЛЬКО если там есть "Цена:"
function extractPriceFromText(text) {
  const match = text.match(/цена:\s*([\d\s]+)/i);
  if (match && match[1]) {
    const priceStr = match[1].replace(/\s/g, '');
    return parseInt(priceStr, 10);
  }
  return null; // Возвращаем null, если не нашли
}

window.resetCategory = () => {
  currentCategory = 'all';
  document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
  renderCatalog();
};

function setView(view) {
  currentView = view;
  
  const viewHome = document.getElementById('view-home');
  const viewProfile = document.getElementById('view-profile');
  const navHome = document.getElementById('navHome');
  const navFavTab = document.getElementById('navFavTab');
  const navProfile = document.getElementById('navProfileTab');
  const searchWrap = document.querySelector('.search-wrapper');

  [navHome, navFavTab, navProfile].forEach(el => el.classList.remove('active'));

  if (view === 'home' || view === 'favorites') {
    viewHome.style.display = 'block';
    viewProfile.style.display = 'none';
    searchWrap.style.display = 'block';
    
    if (view === 'favorites') {
      navFavTab.classList.add('active');
      // БАГФИКС 3: Сброс поиска при переходе в избранное
      currentCategory = 'all';
      searchQuery = '';
      document.getElementById('searchInput').value = '';
      document.getElementById('searchClear').classList.remove('active');
      document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
    } else {
      navHome.classList.add('active');
    }
    
    const slider = document.querySelector('.slider-container');
    const categories = document.getElementById('categories');
    const controls = document.querySelector('.controls');
    
    if (view === 'favorites') {
      slider.style.display = 'none';
      categories.style.display = 'none';
      controls.style.display = 'none';
    } else {
      slider.style.display = 'block';
      categories.style.display = 'flex';
      controls.style.display = 'flex';
    }
    
    renderCatalog();
  } 
  else if (view === 'profile') {
    viewHome.style.display = 'none';
    viewProfile.style.display = 'block';
    searchWrap.style.display = 'none';
    navProfile.classList.add('active');
  }
}

function renderCatalog() {
  const catalog = document.getElementById('catalog');
  let filtered = [...products];

  if (currentView === 'favorites') {
    filtered = filtered.filter(p => favorites.includes(p.id));
    if (filtered.length === 0) {
      catalog.innerHTML = `
        <div style="grid-column: 1/-1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 100px 20px; text-align: center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" style="margin-bottom: 16px;">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
          </svg>
          <div style="color: var(--text-2); text-transform: uppercase; letter-spacing: 2px; font-size: 14px; font-weight: 600;">ПОКА ЧТО В ИЗБРАННОМ НИЧЕГО НЕТ</div>
        </div>
      `;
      return;
    }
  } else if (currentCategory !== 'all') {
    filtered = filtered.filter(p => p.category === currentCategory);
  }

  if (searchQuery) {
    filtered = filtered.filter(p => p.title.toLowerCase().includes(searchQuery.toLowerCase()));
  }

  if (filters.priceMin) filtered = filtered.filter(p => p.price >= filters.priceMin);
  if (filters.priceMax) filtered = filtered.filter(p => p.price <= filters.priceMax);
  if (filters.inStockOnly) filtered = filtered.filter(p => p.stock > 0);

  filtered.sort((a, b) => b.stock - a.stock);

  if (filtered.length === 0 && currentView !== 'favorites') {
    catalog.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px 0; color: var(--text-3); text-transform: uppercase; letter-spacing: 1px; font-size: 12px;">Товары не найдены</div>';
    return;
  }

  catalog.innerHTML = filtered.map(p => {
    const isFav = favorites.includes(p.id);
    const isOutOfStock = p.stock <= 0;
    
    let discountHtml = '';
    if (p.oldPrice && p.oldPrice > p.price) {
      const discount = Math.round((1 - p.price / p.oldPrice) * 100);
      if (discount > 0) discountHtml = `<span class="badge-tag discount">-${discount}%</span>`;
    }

    const badgesHtml = discountHtml + p.badges.map(b => {
      if (b === 'new') return `<span class="badge-tag new">NEW</span>`;
      if (b === 'hit') return `<span class="badge-tag hit">ХИТ</span>`;
      return '';
    }).join('');

    let stockHtml = '';
    if (isOutOfStock) {
      stockHtml = `<span class="card-stock out-of-stock">Нет в наличии</span>`;
    } else if (p.stock <= 5) {
      stockHtml = `<span class="card-stock low-stock">Осталось ${p.stock} шт.</span>`;
    } else {
      stockHtml = `<span class="card-stock">В наличии: ${p.stock} шт.</span>`;
    }

    return `
      <div class="card ${isOutOfStock ? 'card-out-of-stock' : ''}" onclick="openProduct(${p.id})">
        
        <div class="card-image-wrapper">
          <div class="card-badges">${badgesHtml}</div>
          <button class="card-fav ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); toggleFav(${p.id})">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
            </svg>
          </button>
          <img class="card-image" src="${p.images[0]}" alt="${p.title}" loading="lazy" onerror="this.src='./images/no-photo.jpg'">
        </div>

        <div class="card-body">
          <div class="card-title">${p.title}</div>
          <div class="card-price-block">
            <span class="card-price">${p.price.toLocaleString('ru')} ₽</span>
            ${p.oldPrice ? `<span class="card-old-price">${p.oldPrice.toLocaleString('ru')} ₽</span>` : ''}
          </div>
          ${stockHtml}
          <button class="card-btn" onclick="event.stopPropagation(); addToCart(${p.id})">
            ${isOutOfStock ? 'ПОД ЗАКАЗ' : 'В КОРЗИНУ'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function openLightbox() {
  const gallery = document.getElementById('productGallery');
  const index = Math.round(gallery.scrollLeft / gallery.clientWidth);
  const imgSrc = gallery.children[index].src;
  
  if (imgSrc) {
    document.getElementById('lightbox-img').src = imgSrc;
    document.getElementById('lightbox').classList.add('active');
  }
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
}

async function openProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;

  const modal = document.getElementById('productModal');
  const gallery = document.getElementById('productGallery');
  const badges = document.getElementById('productBadges');
  const isFav = favorites.includes(p.id);

  const descEl = document.getElementById('productDesc');
  descEl.textContent = 'Загрузка...';

  let parsedPrice = null;

  try {
    const response = await fetch(p.desc_file);
    if (response.ok) {
      const text = await response.text();
      descEl.textContent = text;
      parsedPrice = extractPriceFromText(text); // Получаем цену из текста, если есть
    } else {
      descEl.textContent = 'Описание скоро появится...';
    }
  } catch (error) {
    descEl.textContent = 'Описание скоро появится...';
  }

  // БАГФИКС 1: Если в тексте нет "Цена:", берем актуальную из JSON
  if (parsedPrice !== null) {
    p.price = parsedPrice;
  }

  gallery.innerHTML = p.images.map(img => `<img src="${img}" alt="${p.title}" onerror="this.src='./images/no-photo.jpg'">`).join('');
  
  let currentImgIndex = 0;
  const counter = document.getElementById('galleryCounter');
  counter.textContent = `1 / ${p.images.length}`;

  window.scrollGallery = (direction) => {
    if (p.images.length <= 1) return;
    currentImgIndex += direction;
    if (currentImgIndex < 0) currentImgIndex = p.images.length - 1;
    if (currentImgIndex >= p.images.length) currentImgIndex = 0;
    gallery.scrollTo({ left: gallery.clientWidth * currentImgIndex, behavior: 'smooth' });
    counter.textContent = `${currentImgIndex + 1} / ${p.images.length}`;
  };

  document.getElementById('prevImg').onclick = () => window.scrollGallery(-1);
  document.getElementById('nextImg').onclick = () => window.scrollGallery(1);

  // ПОДАРОК
  const giftBtn = document.getElementById('giftInfoBtn');
  
  if (p.images && p.images.length > 0) {
    const pathParts = p.images[0].split('/');
    pathParts.pop();
    const folderPath = pathParts.join('/'); 
    currentGiftPath = `${folderPath}/gift.jpg`;

    const imgTest = new Image();
    imgTest.src = currentGiftPath;
    imgTest.onload = () => { giftBtn.style.display = 'flex'; };
    imgTest.onerror = () => { giftBtn.style.display = 'none'; };
  } else {
    giftBtn.style.display = 'none';
  }

  giftBtn.onclick = () => {
    document.getElementById('giftModalImgContainer').innerHTML = `<img src="${currentGiftPath}" alt="Подарок">`;
    document.getElementById('giftModalDesc').textContent = "Этот приятный подарок вы получите совершенно бесплатно при покупке данного товара!";
    document.getElementById('giftModal').classList.add('active');
  };

  let discountHtml = '';
  if (p.oldPrice && p.oldPrice > p.price) {
    const discount = Math.round((1 - p.price / p.oldPrice) * 100);
    if (discount > 0) discountHtml = `<span class="badge-tag discount">-${discount}%</span>`;
  }

  badges.innerHTML = discountHtml + p.badges.map(b => {
    if (b === 'new') return `<span class="badge-tag new">NEW</span>`;
    if (b === 'hit') return `<span class="badge-tag hit">ХИТ</span>`;
    return '';
  }).join('');

  document.getElementById('productTitle').textContent = p.title;
  document.getElementById('productPrice').textContent = `${p.price.toLocaleString('ru')} ₽`;
  document.getElementById('productOldPrice').textContent = p.oldPrice ? `${p.oldPrice.toLocaleString('ru')} ₽` : '';

  const stockEl = document.getElementById('productStock');
  if (p.stock > 0) {
    stockEl.textContent = `В НАЛИЧИИ: ${p.stock} ШТ.`;
    stockEl.className = 'product-stock-status';
  } else {
    stockEl.textContent = 'НЕТ В НАЛИЧИИ';
    stockEl.className = 'product-stock-status out';
  }

  const favBtn = document.getElementById('addToFav');
  favBtn.className = `btn-secondary ${isFav ? 'active' : ''}`;
  favBtn.onclick = () => {
    toggleFav(p.id);
    favBtn.classList.toggle('active');
  };

  const managerBtn = document.getElementById('askManagerBtn');
  managerBtn.onclick = () => {
    const text = `Меня заинтересовал данный товар — ${p.title}`;
    window.location.href = `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`;
  };

  const addToCartBtn = document.getElementById('addToCart');
  if (p.stock <= 0) {
    addToCartBtn.textContent = 'ЗАКАЗАТЬ ПОД ЗАКАЗ';
    addToCartBtn.style.opacity = '0.8';
  } else {
    addToCartBtn.textContent = 'В КОРЗИНУ';
    addToCartBtn.style.opacity = '1';
  }

  addToCartBtn.onclick = () => {
    addToCart(p.id);
    modal.classList.remove('active');
  };

  modal.classList.add('active');
  setTimeout(() => { gallery.scrollLeft = 0; }, 50);
}

function toggleFav(id) {
  const idx = favorites.indexOf(id);
  if (idx > -1) {
    favorites.splice(idx, 1);
    showToast('Удалено');
  } else {
    favorites.push(id);
    showToast('В избранном');
  }
  localStorage.setItem('favorites', JSON.stringify(favorites));
  updateUI();
  renderCatalog();
}

function addToCart(id) {
  const product = products.find(p => p.id === id);
  if (!product) return;

  const existing = cart.find(item => item.id === id);
  
  // БАГФИКС: Если stock <= 0, добавляем без ограничений
  if (existing) {
    if (product.stock > 0 && existing.qty >= product.stock) {
      showToast(`Максимум ${product.stock} шт. в наличии`);
      return;
    }
    existing.qty++;
  } else {
    cart.push({ ...product, qty: 1 });
  }

  saveCart();
  updateUI();
  showToast(product.stock > 0 ? 'Добавлено' : 'Добавлено (Под заказ)');
  
  // Тактильный отклик
  triggerHaptic('light'); 

  // АНИМАЦИЯ КОРЗИНЫ
  const cartIcon = document.getElementById('cartIcon');
  cartIcon.classList.add('cart-bounce');
  setTimeout(() => cartIcon.classList.remove('cart-bounce'), 500);
}

function updateQty(id, delta) {
  const item = cart.find(x => x.id === id);
  if (!item) return;
  
  const product = products.find(p => p.id === id);
  
  if (delta > 0 && product.stock > 0 && item.qty >= product.stock) {
    showToast(`Максимум ${product.stock} шт.`);
    return;
  }

  item.qty += delta;
  if (item.qty <= 0) {
    cart = cart.filter(x => x.id !== id);
  }

  saveCart();
  updateUI();
  renderCartItems();
}

function saveCart() {
  localStorage.setItem('cart', JSON.stringify(cart));
}

function updateUI() {
  const cartCount = cart.reduce((sum, item) => sum + item.qty, 0);
  
  const favBadges = document.querySelectorAll('#favCount, #navFavCount');
  favBadges.forEach(el => el.textContent = favorites.length);
  
  const cartBadges = document.querySelectorAll('#cartCount, #navCartCount');
  cartBadges.forEach(el => el.textContent = cartCount);
  
  const pf = document.getElementById('profileFavCount');
  if (pf) pf.textContent = favorites.length > 0 ? `${favorites.length} товаров` : 'Пока пусто';
  
  const pc = document.getElementById('profileCartCount');
  if (pc) pc.textContent = cartCount > 0 ? `${cartCount} товаров` : 'Пока пусто';

  const pp = document.getElementById('profilePromoCount');
  if (pp) pp.textContent = !promoUsed ? '1 активный' : 'Использован';
}

let hasShownQtyDiscountToast = false;

function renderCartItems() {
  const container = document.getElementById('cartItems');
  
  let subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  
  let hasQtyDiscount = cart.some(item => item.qty >= 2);
  let qtyDiscountPercent = hasQtyDiscount ? 5 : 0;
  let qtyDiscountAmount = Math.round(subtotal * (qtyDiscountPercent / 100));

  let promoDiscountAmount = Math.round(subtotal * (appliedPromoPercent / 100));
  
  let totalDiscount = promoDiscountAmount + qtyDiscountAmount;
  let total = subtotal - totalDiscount;

  if (cart.length === 0) {
    container.innerHTML = '<div class="empty-cart">Корзина пуста</div>';
    hasShownQtyDiscountToast = false;
  } else {
    container.innerHTML = cart.map(item => {
      const product = products.find(p => p.id === item.id);
      const maxQty = product ? (product.stock > 0 ? product.stock : 99) : 99; 

      return `
      <div class="cart-item">
        <img src="${item.images[0]}" alt="${item.title}" onerror="this.src='./images/no-photo.jpg'">
        <div class="cart-item-info">
          <div class="cart-item-title">${item.title} ${item.stock <= 0 ? '<span style="color:var(--warning); font-size:10px;">(Под заказ)</span>' : ''}</div>
          <div class="cart-item-price">${item.price.toLocaleString('ru')} ₽</div>
          <div class="cart-item-controls">
            <button class="qty-btn" onclick="updateQty(${item.id}, -1)">−</button>
            <span class="qty-value">${item.qty}</span>
            <button class="qty-btn" onclick="updateQty(${item.id}, 1)" ${item.qty >= maxQty ? 'disabled style="opacity:0.3"' : ''}>+</button>
          </div>
        </div>
      </div>
    `}).join('');

    if (hasQtyDiscount && !hasShownQtyDiscountToast) {
      showToast('🔥 Вы получили скидку 5% за 2+ товара!');
      hasShownQtyDiscountToast = true;
    }
  }

  document.getElementById('subtotal').textContent = `${subtotal.toLocaleString('ru')} ₽`;
  document.getElementById('delivery').textContent = 'БЕСПЛАТНО';
  document.getElementById('totalPrice').textContent = `${total.toLocaleString('ru')} ₽`;

  const promoRow = document.getElementById('promoDiscountRow');
  if (appliedPromoPercent > 0) {
    promoRow.style.display = 'flex';
    document.getElementById('promoDiscountAmount').textContent = `-${promoDiscountAmount.toLocaleString('ru')} ₽ (${appliedPromoPercent}%)`;
  } else {
    promoRow.style.display = 'none';
  }

  const qtyRow = document.getElementById('qtyDiscountRow');
  const qtyHint = document.getElementById('qtyDiscountHint');
  
  if (hasQtyDiscount) {
    qtyRow.style.display = 'flex';
    document.getElementById('qtyDiscountAmount').textContent = `-${qtyDiscountAmount.toLocaleString('ru')} ₽ (5%)`;
    qtyHint.style.display = 'none';
  } else {
    qtyRow.style.display = 'none';
    
    if (cart.length > 0) {
      qtyHint.style.display = 'block';
    } else {
      qtyHint.style.display = 'none';
    }
  }
}

function checkout() {
  if (cart.length === 0) return;
  
  let lines = [];
  cart.forEach(item => {
    lines.push(`• ${item.title} ${item.stock <= 0 ? '(Под заказ)' : ''}`);
    lines.push(`  ${item.qty} шт. × ${item.price.toLocaleString('ru')} ₽ = ${(item.price * item.qty).toLocaleString('ru')} ₽`);
  });
  
  let subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  let hasQtyDiscount = cart.some(item => item.qty >= 2);
  let qtyDiscountAmount = hasQtyDiscount ? Math.round(subtotal * 0.05) : 0;
  let promoDiscountAmount = Math.round(subtotal * (appliedPromoPercent / 100));
  
  let total = subtotal - qtyDiscountAmount - promoDiscountAmount;
  
  let discountText = '';
  if (appliedPromoPercent > 0) {
    discountText += `\nПромокод: ${myPromoCode} (-${promoDiscountAmount.toLocaleString('ru')} ₽)`;
    localStorage.setItem('pf_promo_used', 'true');
    promoUsed = true;
  }
  if (hasQtyDiscount) {
    discountText += `\nСкидка за количество (5%): -${qtyDiscountAmount.toLocaleString('ru')} ₽`;
  }
  
  const text = `Здравствуйте! Заказ в PF Store:\n\n${lines.join('\n')}${discountText}\n\nДоставка по городу: Бесплатно\nИтого: ${total.toLocaleString('ru')} ₽`;
  window.location.href = `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(text)}`;
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function copyPromoCode(code) {
  navigator.clipboard.writeText(code).then(() => {
    showToast('Промокод скопирован!');
  }).catch(err => {
    showToast('Не удалось скопировать');
  });
}

function openInfoModal(type) {
  const modal = document.getElementById('infoModal');
  const body = document.getElementById('infoModalBody');
  
  if (type === 'delivery') {
    body.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:16px;"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
      <div class="info-title">Доставка</div>
      <div class="info-text">
        Мы отправляем заказы в день оплаты.<br><br>
        <b>СДЭК:</b> 2-5 дней по РФ.<br>
        <b>Почта России:</b> 3-7 дней по РФ.<br>
        <b>Boxberry:</b> 2-4 дня по РФ.<br><br>
        По городу Барнаул доставка <b>БЕСПЛАТНО</b>.
      </div>
      <button class="info-btn" onclick="document.getElementById('infoModal').classList.remove('active')">ПОНЯТНО</button>
    `;
  } else if (type === 'promo') {
    if (promoUsed) {
      body.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" style="margin-bottom:16px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
        <div class="info-title" style="color: var(--danger)">Уже использован</div>
        <div class="info-text">Вы уже применили свой промокод на первый заказ.</div>
        <button class="info-btn" onclick="document.getElementById('infoModal').classList.remove('active')">ЗАКРЫТЬ</button>
      `;
      modal.classList.add('active');
      return;
    }

    body.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:16px;"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
      <div class="info-title">Скидка 5%</div>
      <div class="info-text">Скидка действует на первый заказ. Введите этот код в корзине перед оформлением.</div>
      <button class="info-btn" id="getPromoBtn">ПОЛУЧИТЬ ПРОМОКОД</button>
      <div id="promoResult" style="margin-top: 20px; font-size: 24px; font-weight: 900; color: var(--accent); letter-spacing: 2px; cursor: pointer;" title="Нажмите, чтобы скопировать"></div>
    `;
    
    setTimeout(() => {
      const btn = document.getElementById('getPromoBtn');
      const result = document.getElementById('promoResult');
      
      if (btn) {
        btn.onclick = () => {
          result.textContent = myPromoCode;
          btn.style.display = 'none';
          result.onclick = () => copyPromoCode(myPromoCode);
        };
      }
    }, 50);
  } else if (type === 'gifts') {
    body.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:16px;"><polyline points="20 12 20 22 4 22 4 12"></polyline><rect x="2" y="7" width="20" height="5"></rect><line x1="12" y1="22" x2="12" y2="7"></line><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path></svg>
      <div class="info-title">Подарки</div>
      <div class="info-text">
        При покупке наушников — <b>кабель 60W</b> в подарок.<br><br>
        При покупке часов — <b>ремешок Milanese</b> в подарок.<br><br>
        Подарок выбирается автоматически при оформлении заказа.
      </div>
      <button class="info-btn" onclick="document.getElementById('infoModal').classList.remove('active')">МНЕ НРАВИТСЯ!</button>
    `;
  }
  
  modal.classList.add('active');
}

document.addEventListener('DOMContentLoaded', () => {
  loadProducts();
  initSlider();

  document.getElementById('navHome').addEventListener('click', () => setView('home'));
  document.getElementById('navFavTab').addEventListener('click', () => setView('favorites'));
  document.getElementById('navProfileTab').addEventListener('click', () => setView('profile'));
  document.getElementById('navCartTab').addEventListener('click', () => {
    renderCartItems();
    document.getElementById('cartModal').classList.add('active');
    triggerHaptic('light');
  });

  document.getElementById('myPromoBtn').addEventListener('click', () => openInfoModal('promo'));
  
  document.getElementById('applyPromoBtn').addEventListener('click', () => {
    if (promoUsed) {
      showToast('Промокод уже был использован');
      return;
    }
    const input = document.getElementById('promoInput').value.trim().toUpperCase();
    if (input === myPromoCode) {
      appliedPromoPercent = 5;
      // БАГФИКС 2: Сохраняем в localStorage
      localStorage.setItem('pf_promo_applied', '5');
      showToast('Промокод применен!');
      renderCartItems();
      triggerHaptic('success');
    } else {
      showToast('Неверный промокод');
      triggerHaptic('error');
    }
  });

  document.getElementById('closeInfo').addEventListener('click', () => document.getElementById('infoModal').classList.remove('active'));
  document.getElementById('closeGift').addEventListener('click', () => document.getElementById('giftModal').classList.remove('active'));

  // БАГФИКС 3: Сброс поиска при клике на категорию
  document.querySelectorAll('.cat-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = btn.dataset.cat;
      searchQuery = '';
      document.getElementById('searchInput').value = '';
      document.getElementById('searchClear').classList.remove('active');
      renderCatalog();
    });
  });

  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    searchClear.classList.toggle('active', searchQuery.length > 0);
    renderCatalog();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClear.classList.remove('active');
    renderCatalog();
  });

  document.getElementById('closeCart').addEventListener('click', () => document.getElementById('cartModal').classList.remove('active'));
  document.getElementById('closeProduct').addEventListener('click', () => document.getElementById('productModal').classList.remove('active'));
  document.getElementById('checkoutBtn').addEventListener('click', checkout);

  document.getElementById('filterBtn').addEventListener('click', () => document.getElementById('filterModal').classList.add('active'));
  document.getElementById('closeFilter').addEventListener('click', () => document.getElementById('filterModal').classList.remove('active'));

  document.getElementById('resetFilters').addEventListener('click', () => {
    document.getElementById('priceMin').value = '';
    document.getElementById('priceMax').value = '';
    document.getElementById('inStockOnly').checked = false;
    filters = { priceMin: null, priceMax: null, inStockOnly: false };
    renderCatalog();
    document.getElementById('filterModal').classList.remove('active');
  });

  document.getElementById('applyFilters').addEventListener('click', () => {
    const minVal = document.getElementById('priceMin').value;
    const maxVal = document.getElementById('priceMax').value;
    filters.priceMin = minVal ? Number(minVal) : null;
    filters.priceMax = maxVal ? Number(maxVal) : null;
    filters.inStockOnly = document.getElementById('inStockOnly').checked;
    renderCatalog();
    document.getElementById('filterModal').classList.remove('active');
  });
});