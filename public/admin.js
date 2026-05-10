const ordersListEl = document.getElementById('ordersList');
const orderDetailsEl = document.getElementById('orderDetails');
const searchInputEl = document.getElementById('searchInput');
const statusFilterEl = document.getElementById('statusFilter');
const refreshBtnEl = document.getElementById('refreshBtn');

let selectedOrderId = null;

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMoney(value) {
  return `${new Intl.NumberFormat('ru-RU').format(Number(value || 0))} ₽`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value));
}

function statusLabel(status) {
  switch (status) {
    case 'new':
      return '🆕 Новый';
    case 'accepted':
      return '✅ Принят';
    case 'in_progress':
      return '🛠 В работе';
    case 'done':
      return '🎉 Готов';
    case 'cancelled':
      return '❌ Отменён';
    default:
      return status;
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Ошибка запроса');
  }

  return data;
}

async function loadOrders() {
  ordersListEl.innerHTML = '<div class="loading">Загрузка...</div>';

  const params = new URLSearchParams({
    status: statusFilterEl.value,
    q: searchInputEl.value.trim()
  });

  const data = await api(`/api/admin/orders?${params.toString()}`);
  renderOrders(data.orders);
}

function renderOrders(orders) {
  if (!orders.length) {
    ordersListEl.innerHTML = '<div class="empty-list">Заказов пока нет</div>';
    orderDetailsEl.innerHTML = 'Выберите заказ слева';
    orderDetailsEl.className = 'order-details empty';
    return;
  }

  ordersListEl.innerHTML = orders
    .map((order) => {
      const customerName = [order.customer_first_name, order.customer_last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || 'Без имени';

      const username = order.customer_username ? `@${order.customer_username}` : '—';

      return `
        <button class="order-card ${selectedOrderId === order.public_id ? 'active' : ''}" data-id="${escapeHtml(order.public_id)}">
          <div class="order-card-top">
            <strong>${escapeHtml(order.public_id)}</strong>
            <span class="badge badge-${escapeHtml(order.status)}">${escapeHtml(statusLabel(order.status))}</span>
          </div>
          <div class="order-card-meta">
            <div>${escapeHtml(customerName)}</div>
            <div>${escapeHtml(username)}</div>
            <div>${formatMoney(order.total_amount)}</div>
            <div>${escapeHtml(String(order.items_count))} поз.</div>
            <div>${escapeHtml(formatDate(order.created_at))}</div>
          </div>
        </button>
      `;
    })
    .join('');

  ordersListEl.querySelectorAll('.order-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedOrderId = btn.dataset.id;
      loadOrders().then(() => loadOrderDetails(selectedOrderId)).catch(showError);
    });
  });

  if (!selectedOrderId && orders[0]) {
    selectedOrderId = orders[0].public_id;
    loadOrders().then(() => loadOrderDetails(selectedOrderId)).catch(showError);
  }
}

async function loadOrderDetails(publicId) {
  const data = await api(`/api/admin/orders/${encodeURIComponent(publicId)}`);
  renderOrderDetails(data.order);
}

function renderOrderDetails(order) {
  const customerName = [order.customer_first_name, order.customer_last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Без имени';

  const username = order.customer_username ? `@${order.customer_username}` : '—';

  orderDetailsEl.className = 'order-details';
  orderDetailsEl.innerHTML = `
    <div class="details-header">
      <div>
        <h2>${escapeHtml(order.public_id)}</h2>
        <p>${escapeHtml(customerName)} · ${escapeHtml(username)} · ID ${escapeHtml(String(order.customer_tg_id))}</p>
      </div>
      <div class="details-total">${formatMoney(order.total_amount)}</div>
    </div>

    <div class="details-grid">
      <section class="details-card">
        <h3>Информация</h3>
        <p><strong>Статус:</strong> ${escapeHtml(statusLabel(order.status))}</p>
        <p><strong>Создан:</strong> ${escapeHtml(formatDate(order.created_at))}</p>
        <p><strong>Обновлён:</strong> ${escapeHtml(formatDate(order.updated_at))}</p>
        <p><strong>Подтверждение клиенту:</strong> ${order.client_notified ? 'Да' : 'Нет'}</p>
      </section>

      <section class="details-card">
        <h3>Сменить статус</h3>
        <div class="status-actions">
          <select id="statusSelect">
            <option value="new" ${order.status === 'new' ? 'selected' : ''}>Новый</option>
            <option value="accepted" ${order.status === 'accepted' ? 'selected' : ''}>Принят</option>
            <option value="in_progress" ${order.status === 'in_progress' ? 'selected' : ''}>В работе</option>
            <option value="done" ${order.status === 'done' ? 'selected' : ''}>Готов</option>
            <option value="cancelled" ${order.status === 'cancelled' ? 'selected' : ''}>Отменён</option>
          </select>
          <textarea id="statusComment" placeholder="Комментарий клиенту (необязательно)"></textarea>
          <button id="updateStatusBtn" type="button">Сохранить статус</button>
        </div>
      </section>
    </div>

    <section class="details-card">
      <h3>Позиции</h3>
      <div class="items-list">
        ${order.items.map((item) => `
          <div class="item-box">
            <div class="item-box-head">
              <strong>Позиция ${escapeHtml(String(item.position_number))}</strong>
              <span>${formatMoney(item.total_amount)}</span>
            </div>
            <p><strong>Описание:</strong> ${escapeHtml(item.description)}</p>
            <p><strong>Референс:</strong> <a href="${escapeHtml(item.reference_url)}" target="_blank">${escapeHtml(item.reference_url)}</a></p>
            <p><strong>Конкурент:</strong> <a href="${escapeHtml(item.competitor_url)}" target="_blank">${escapeHtml(item.competitor_url)}</a></p>
            <p><strong>Яндекс.Диск:</strong> <a href="${escapeHtml(item.yandex_disk_url)}" target="_blank">${escapeHtml(item.yandex_disk_url)}</a></p>
            <p><strong>Слайды:</strong> ${escapeHtml(String(item.slides))}</p>
            <p><strong>Цена за слайд:</strong> ${formatMoney(item.price_per_slide)}</p>
            <p><strong>Пожелание:</strong> ${escapeHtml(item.short_wish || '—')}</p>
            <p><strong>ТЗ:</strong> ${item.tz_url ? `<a href="${escapeHtml(item.tz_url)}" target="_blank">${escapeHtml(item.tz_url)}</a>` : '—'}</p>
          </div>
        `).join('')}
      </div>
    </section>

    <section class="details-card">
      <h3>История статусов</h3>
      <div class="history-list">
        ${order.history.length
          ? order.history.map((entry) => `
            <div class="history-row">
              <div><strong>${escapeHtml(statusLabel(entry.new_status))}</strong></div>
              <div>${escapeHtml(formatDate(entry.created_at))}</div>
              <div>${escapeHtml(entry.changed_by || 'system')}</div>
              <div>${escapeHtml(entry.comment || '—')}</div>
            </div>
          `).join('')
          : '<div>История пуста</div>'
        }
      </div>
    </section>
  `;

  document.getElementById('updateStatusBtn').addEventListener('click', async () => {
    const status = document.getElementById('statusSelect').value;
    const comment = document.getElementById('statusComment').value.trim();

    try {
      await api(`/api/admin/orders/${encodeURIComponent(order.public_id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, comment })
      });

      await loadOrderDetails(order.public_id);
      await loadOrders();
      alert('Статус обновлён');
    } catch (error) {
      alert(error.message);
    }
  });
}

function showError(error) {
  console.error(error);
  ordersListEl.innerHTML = `<div class="error-box">${escapeHtml(error.message || 'Ошибка')}</div>`;
}

let searchTimer = null;

searchInputEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    loadOrders().catch(showError);
  }, 350);
});

statusFilterEl.addEventListener('change', () => {
  loadOrders().catch(showError);
});

refreshBtnEl.addEventListener('click', () => {
  loadOrders().catch(showError);
});

loadOrders().catch(showError);