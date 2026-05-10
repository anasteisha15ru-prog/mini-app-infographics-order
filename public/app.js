const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}

const itemsContainer = document.getElementById('itemsContainer');
const addItemBtn = document.getElementById('addItemBtn');
const submitBtn = document.getElementById('submitBtn');
const grandTotalEl = document.getElementById('grandTotal');
const statusMessageEl = document.getElementById('statusMessage');

let itemCounter = 0;

function formatMoney(value) {
  return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
}

// Логика тарифа:
// 1–20 => 800
// 21–49 => 600
// 50+ => 500
function getPricePerSlide(slides) {
  if (!slides || slides < 1) return 0;
  if (slides <= 20) return 800;
  if (slides >= 50) return 600;
  return 500;
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function showStatus(message, type = '') {
  statusMessageEl.textContent = message;
  statusMessageEl.className = `status-message ${type}`.trim();
}

function showAlert(message) {
  if (tg?.showAlert) {
    tg.showAlert(message);
  } else {
    alert(message);
  }
}

function getCardTitle(index) {
  return `Позиция ${index + 1}`;
}

function updateCardNumbers() {
  [...itemsContainer.querySelectorAll('.item-card')].forEach((card, index) => {
    const title = card.querySelector('.item-card-title');
    if (title) {
      title.textContent = getCardTitle(index);
    }
  });
}

function createField({ label, name, type = 'text', required = false, placeholder = '', textarea = false, min = '', max = '' }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';

  const labelEl = document.createElement('label');
  labelEl.textContent = `${label}${required ? ' *' : ''}`;

  let input;
  if (textarea) {
    input = document.createElement('textarea');
  } else {
    input = document.createElement('input');
    input.type = type;
  }

  input.name = name;
  input.placeholder = placeholder;

  if (min !== '') input.min = min;
  if (max !== '') input.max = max;

  wrapper.appendChild(labelEl);
  wrapper.appendChild(input);

  return wrapper;
}

function createItemCard() {
  itemCounter += 1;

  const card = document.createElement('section');
  card.className = 'item-card';

  const header = document.createElement('div');
  header.className = 'item-card-header';

  const title = document.createElement('h3');
  title.className = 'item-card-title';
  title.textContent = getCardTitle(itemsContainer.children.length);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = 'Удалить';

  deleteBtn.addEventListener('click', () => {
    card.remove();

    if (itemsContainer.children.length === 0) {
      addItemCard();
    }

    updateCardNumbers();
    recalculateAll();
  });

  header.appendChild(title);
  header.appendChild(deleteBtn);

  const grid = document.createElement('div');
  grid.className = 'form-grid';

  grid.appendChild(
    createField({
      label: 'Описание товара',
      name: 'description',
      required: true,
      textarea: true,
      placeholder: 'Например: карточка товара для маркетплейса'
    })
  );

  grid.appendChild(
    createField({
      label: 'Референс (ссылка)',
      name: 'referenceUrl',
      type: 'url',
      required: true,
      placeholder: 'https://...'
    })
  );

  grid.appendChild(
    createField({
      label: 'Ссылка на конкурента',
      name: 'competitorUrl',
      type: 'url',
      required: true,
      placeholder: 'https://...'
    })
  );

  grid.appendChild(
    createField({
      label: 'Ссылка на Яндекс.Диск',
      name: 'yandexDiskUrl',
      type: 'url',
      required: true,
      placeholder: 'https://disk.yandex.ru/...'
    })
  );

  grid.appendChild(
    createField({
      label: 'Количество слайдов',
      name: 'slides',
      type: 'number',
      required: true,
      placeholder: 'от 1 до 500',
      min: '1',
      max: '500'
    })
  );

  grid.appendChild(
    createField({
      label: 'Краткое пожелание',
      name: 'shortWish',
      textarea: true,
      placeholder: 'Необязательно'
    })
  );

  grid.appendChild(
    createField({
      label: 'Ссылка на ТЗ',
      name: 'tzUrl',
      type: 'url',
      placeholder: 'https://...'
    })
  );

  const priceBox = document.createElement('div');
  priceBox.className = 'item-price-box';
  priceBox.innerHTML = `
    <div>Цена за слайд: <strong class="price-per-slide">0 ₽</strong></div>
    <div>Сумма позиции: <strong class="item-total">0 ₽</strong></div>
  `;

  card.appendChild(header);
  card.appendChild(grid);
  card.appendChild(priceBox);

  card.querySelectorAll('input, textarea').forEach((input) => {
    input.addEventListener('input', recalculateAll);
  });

  return card;
}

function addItemCard() {
  const card = createItemCard();
  itemsContainer.appendChild(card);
  updateCardNumbers();
  recalculateAll();
}

function getCardData(card) {
  const getValue = (name) => card.querySelector(`[name="${name}"]`)?.value?.trim() || '';

  return {
    description: getValue('description'),
    referenceUrl: getValue('referenceUrl'),
    competitorUrl: getValue('competitorUrl'),
    yandexDiskUrl: getValue('yandexDiskUrl'),
    slides: getValue('slides'),
    shortWish: getValue('shortWish'),
    tzUrl: getValue('tzUrl')
  };
}

function isItemEmpty(item) {
  return (
    !item.description &&
    !item.referenceUrl &&
    !item.competitorUrl &&
    !item.yandexDiskUrl &&
    !item.shortWish &&
    !item.tzUrl &&
    !item.slides
  );
}

function recalculateCard(card) {
  const data = getCardData(card);
  const slides = Number(data.slides);
  const pricePerSlide = Number.isInteger(slides) && slides >= 1 ? getPricePerSlide(slides) : 0;
  const total = pricePerSlide * (slides || 0);

  const priceEl = card.querySelector('.price-per-slide');
  const totalEl = card.querySelector('.item-total');

  priceEl.textContent = formatMoney(pricePerSlide);
  totalEl.textContent = formatMoney(total);

  return total;
}

function recalculateAll() {
  let grandTotal = 0;

  [...itemsContainer.querySelectorAll('.item-card')].forEach((card) => {
    grandTotal += recalculateCard(card);
  });

  grandTotalEl.textContent = formatMoney(grandTotal);
}

function validateItems(items) {
  const prepared = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = {
      description: items[i].description.trim(),
      referenceUrl: items[i].referenceUrl.trim(),
      competitorUrl: items[i].competitorUrl.trim(),
      yandexDiskUrl: items[i].yandexDiskUrl.trim(),
      slides: items[i].slides.trim(),
      shortWish: items[i].shortWish.trim(),
      tzUrl: items[i].tzUrl.trim()
    };

    if (isItemEmpty(item)) {
      continue;
    }

    const position = i + 1;

    if (!item.description) {
      return { ok: false, message: `Позиция ${position}: заполните "Описание товара"` };
    }

    if (!item.referenceUrl) {
      return { ok: false, message: `Позиция ${position}: заполните "Референс"` };
    }

    if (!isValidUrl(item.referenceUrl)) {
      return { ok: false, message: `Позиция ${position}: "Референс" должен быть корректной ссылкой` };
    }

    if (!item.competitorUrl) {
      return { ok: false, message: `Позиция ${position}: заполните "Ссылка на конкурента"` };
    }

    if (!isValidUrl(item.competitorUrl)) {
      return { ok: false, message: `Позиция ${position}: "Ссылка на конкурента" должна быть корректной ссылкой` };
    }

    if (!item.yandexDiskUrl) {
      return { ok: false, message: `Позиция ${position}: заполните "Ссылка на Яндекс.Диск"` };
    }

    if (!isValidUrl(item.yandexDiskUrl)) {
      return { ok: false, message: `Позиция ${position}: "Ссылка на Яндекс.Диск" должна быть корректной ссылкой` };
    }

    const slides = Number(item.slides);
    if (!Number.isInteger(slides) || slides < 1 || slides > 500) {
      return { ok: false, message: `Позиция ${position}: количество слайдов должно быть от 1 до 500` };
    }

    if (item.tzUrl && !isValidUrl(item.tzUrl)) {
      return { ok: false, message: `Позиция ${position}: "Ссылка на ТЗ" должна быть корректной ссылкой` };
    }

    prepared.push({
      ...item,
      slides
    });
  }

  if (prepared.length === 0) {
    return { ok: false, message: 'Добавьте хотя бы одну заполненную позицию' };
  }

  return { ok: true, items: prepared };
}

async function submitOrder() {
  showStatus('');

  const rawItems = [...itemsContainer.querySelectorAll('.item-card')].map(getCardData);
  const validation = validateItems(rawItems);

  if (!validation.ok) {
    showStatus(validation.message, 'error');
    showAlert(validation.message);
    return;
  }

  submitBtn.disabled = true;
  addItemBtn.disabled = true;

  try {
    const response = await fetch('/api/order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        initData: tg?.initData || '',
        items: validation.items
      })
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      const message =
        result?.details?.join('\n') ||
        result?.error ||
        'Не удалось отправить заказ';
      throw new Error(message);
    }

    showStatus(`Заказ ${result.orderId} успешно отправлен`, 'success');

    if (tg?.HapticFeedback?.notificationOccurred) {
      tg.HapticFeedback.notificationOccurred('success');
    }

    showAlert(`Заказ отправлен. Предварительная сумма: ${formatMoney(result.total)}`);
  } catch (error) {
    console.error(error);
    showStatus(error.message || 'Ошибка отправки заказа', 'error');

    if (tg?.HapticFeedback?.notificationOccurred) {
      tg.HapticFeedback.notificationOccurred('error');
    }

    showAlert(error.message || 'Ошибка отправки заказа');
  } finally {
    submitBtn.disabled = false;
    addItemBtn.disabled = false;
  }
}

addItemBtn.addEventListener('click', addItemCard);
submitBtn.addEventListener('click', submitOrder);

addItemCard();