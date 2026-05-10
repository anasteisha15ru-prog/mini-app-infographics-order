'use strict';

try {
  require('dotenv').config();
} catch (_) {
  // dotenv не обязателен на Railway
}

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const WEBAPP_URL = String(process.env.WEBAPP_URL || '').trim();
const ADMIN_LOGIN = String(process.env.ADMIN_LOGIN || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const TELEGRAM_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

const ALLOW_UNSAFE_TEST_MODE =
  String(process.env.ALLOW_UNSAFE_TEST_MODE || '').trim().toLowerCase() === 'true';
const TEST_USER_ID = toFiniteNumber(process.env.TEST_USER_ID);

const ADMIN_USER_IDS = parseIdList(process.env.ADMIN_USER_IDS);
const DESIGNER_USER_IDS = parseIdList(process.env.DESIGNER_USER_IDS);

const ACTION_TO_STATUS = {
  accept: 'accepted',
  work: 'in_progress',
  done: 'done',
  cancel: 'cancelled'
};

const STATUS_LABELS = {
  new: '🆕 Новый',
  accepted: '✅ Принят',
  in_progress: '🛠 В работе',
  done: '🎉 Готов',
  cancelled: '❌ Отменён'
};

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL не найден. Подключите PostgreSQL.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL.includes('localhost') ||
    process.env.DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ ok: false });
  }
});

/* -------------------- BASIC AUTH -------------------- */

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a ?? ''));
  const bBuffer = Buffer.from(String(b ?? ''));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function adminBasicAuth(req, res, next) {
  if (!ADMIN_LOGIN && !ADMIN_PASSWORD) {
    return next();
  }

  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Panel"');
    return res.status(401).send('Authentication required');
  }

  try {
    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    const login = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : '';
    const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

    if (!safeEqual(login, ADMIN_LOGIN) || !safeEqual(password, ADMIN_PASSWORD)) {
      res.set('WWW-Authenticate', 'Basic realm="Admin Panel"');
      return res.status(401).send('Invalid credentials');
    }

    return next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.set('WWW-Authenticate', 'Basic realm="Admin Panel"');
    return res.status(401).send('Invalid credentials');
  }
}

app.get('/admin', adminBasicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* -------------------- HELPERS -------------------- */

function parseIdList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter(Number.isFinite);
}

function toFiniteNumber(value) {
  const number = Number(String(value ?? '').trim());
  return Number.isFinite(number) ? number : null;
}

function toInteger(value, fallback = 0) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(number) ? number : fallback;
}

function safeText(value) {
  return String(value ?? '').trim();
}

function clip(value, max = 300) {
  const text = safeText(value);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function isValidUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function formatMoney(value) {
  return `${new Intl.NumberFormat('ru-RU').format(Number(value || 0))} ₽`;
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(value));
  } catch (_) {
    return safeText(value);
  }
}

function normalizeUsername(value) {
  return safeText(value).replace(/^@+/, '');
}

function normalizeStatus(value, fallback = 'new') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  const aliases = {
    new: 'new',
    accepted: 'accepted',
    accept: 'accepted',
    in_progress: 'in_progress',
    work: 'in_progress',
    done: 'done',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    cancel: 'cancelled'
  };

  return aliases[normalized] || fallback;
}

function canManageOrders(userId) {
  const id = Number(userId);
  return ADMIN_USER_IDS.includes(id) || DESIGNER_USER_IDS.includes(id);
}

function buildCustomerName(firstName, lastName, username = '') {
  const fullName = [safeText(firstName), safeText(lastName)].filter(Boolean).join(' ').trim();

  if (fullName) {
    return fullName;
  }

  if (username) {
    return `@${username}`;
  }

  return 'Без имени';
}

function parseItems(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  return [];
}

/*
  ВАЖНО:
  Я специально оставил серверную логику цены такой же,
  как сейчас у вас в public/app.js,
  чтобы суммы на фронте и на сервере не расходились.

  Сейчас у вас фактически:
  1–20 => 800
  21–49 => 500
  50+ => 600
*/
function getPricePerSlide(slides) {
  if (!Number.isInteger(slides) || slides < 1) {
    return 0;
  }

  if (slides <= 20) {
    return 800;
  }

  if (slides >= 50) {
    return 600;
  }

  return 500;
}

function normalizeItem(rawItem, index) {
  const positionNumber = index + 1;

  const description = safeText(rawItem.description);
  const referenceUrl = safeText(
    rawItem.referenceUrl ?? rawItem.reference_url ?? rawItem.referenceLink ?? rawItem.reference_link
  );
  const competitorUrl = safeText(
    rawItem.competitorUrl ??
      rawItem.competitor_url ??
      rawItem.competitorLink ??
      rawItem.competitor_link
  );
  const yandexDiskUrl = safeText(
    rawItem.yandexDiskUrl ??
      rawItem.yandex_disk_url ??
      rawItem.sourceLink ??
      rawItem.source_link
  );
  const slides = toInteger(rawItem.slides ?? rawItem.slides_count ?? rawItem.slidesCount, 0);
  const shortWish = safeText(rawItem.shortWish ?? rawItem.short_wish ?? rawItem.wish);
  const tzUrl = safeText(rawItem.tzUrl ?? rawItem.tz_url ?? rawItem.tzLink ?? rawItem.tz_link);

  const pricePerSlide = getPricePerSlide(slides);
  const totalAmount = slides * pricePerSlide;

  return {
    position_number: positionNumber,
    position_index: positionNumber,

    description,

    reference_url: referenceUrl,
    reference_link: referenceUrl,

    competitor_url: competitorUrl,
    competitor_link: competitorUrl,

    yandex_disk_url: yandexDiskUrl,
    source_link: yandexDiskUrl,

    slides,
    slides_count: slides,

    short_wish: shortWish,
    wish: shortWish,

    tz_url: tzUrl,
    tz_link: tzUrl,

    price_per_slide: pricePerSlide,
    total_amount: totalAmount,
    amount: totalAmount
  };
}

function validateAndPrepareItems(rawItems) {
  const items = [];
  const details = [];

  rawItems.forEach((rawItem, index) => {
    const item = normalizeItem(rawItem, index);
    const position = index + 1;

    const isEmpty =
      !item.description &&
      !item.reference_url &&
      !item.competitor_url &&
      !item.yandex_disk_url &&
      !item.short_wish &&
      !item.tz_url &&
      !item.slides;

    if (isEmpty) {
      return;
    }

    if (!item.description) {
      details.push(`Позиция ${position}: заполните "Описание товара"`);
    }

    if (!item.reference_url) {
      details.push(`Позиция ${position}: заполните "Референс"`);
    } else if (!isValidUrl(item.reference_url)) {
      details.push(`Позиция ${position}: "Референс" должен быть корректной ссылкой`);
    }

    if (!item.competitor_url) {
      details.push(`Позиция ${position}: заполните "Ссылка на конкурента"`);
    } else if (!isValidUrl(item.competitor_url)) {
      details.push(`Позиция ${position}: "Ссылка на конкурента" должна быть корректной ссылкой`);
    }

    if (!item.yandex_disk_url) {
      details.push(`Позиция ${position}: заполните "Ссылка на Яндекс.Диск"`);
    } else if (!isValidUrl(item.yandex_disk_url)) {
      details.push(`Позиция ${position}: "Ссылка на Яндекс.Диск" должна быть корректной ссылкой`);
    }

    if (!Number.isInteger(item.slides) || item.slides < 1 || item.slides > 500) {
      details.push(`Позиция ${position}: количество слайдов должно быть от 1 до 500`);
    }

    if (item.tz_url && !isValidUrl(item.tz_url)) {
      details.push(`Позиция ${position}: "Ссылка на ТЗ" должна быть корректной ссылкой`);
    }

    items.push(item);
  });

  if (!items.length) {
    details.push('Добавьте хотя бы одну заполненную позицию');
  }

  if (details.length) {
    return {
      ok: false,
      details
    };
  }

  return {
    ok: true,
    items
  };
}

function parseTelegramInitData(initData) {
  const raw = safeText(initData);

  if (!raw) {
    throw new Error('Пустой initData');
  }

  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN не задан: нельзя проверить Telegram initData');
  }

  const params = new URLSearchParams(raw);
  const hash = params.get('hash');

  if (!hash) {
    throw new Error('В initData отсутствует hash');
  }

  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (!safeEqual(calculatedHash, hash)) {
    throw new Error('Невалидный Telegram initData');
  }

  const userRaw = params.get('user');

  if (!userRaw) {
    throw new Error('В initData нет данных пользователя');
  }

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch (_) {
    throw new Error('Не удалось распарсить пользователя из initData');
  }

  if (!user || !Number.isFinite(Number(user.id))) {
    throw new Error('В initData нет корректного user.id');
  }

  return user;
}

function getRequestUser(body) {
  const initData = safeText(body?.initData);

  if (initData) {
    const user = parseTelegramInitData(initData);

    return {
      id: Number(user.id),
      username: normalizeUsername(user.username || ''),
      first_name: safeText(user.first_name || ''),
      last_name: safeText(user.last_name || ''),
      source: 'telegram'
    };
  }

  if (ALLOW_UNSAFE_TEST_MODE && Number.isFinite(TEST_USER_ID)) {
    return {
      id: Number(TEST_USER_ID),
      username: 'test_user',
      first_name: 'Тест',
      last_name: '',
      source: 'unsafe_test_mode'
    };
  }

  throw new Error('Запрос должен идти из Telegram Mini App');
}

/* -------------------- TELEGRAM -------------------- */

async function telegramApi(method, payload) {
  if (typeof fetch !== 'function') {
    throw new Error('Нужен Node.js 18+');
  }

  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN не задан');
  }

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data || !data.ok) {
    throw new Error(`Telegram API ${method} error: ${JSON.stringify(data)}`);
  }

  return data.result;
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

function buildOrderInlineKeyboard(publicId, currentStatus = 'new') {
  const current = normalizeStatus(currentStatus);

  const mark = (status, text) => (current === status ? `• ${text}` : text);

  return {
    inline_keyboard: [
      [
        {
          text: mark('accepted', '✅ Принять'),
          callback_data: `ord:accept:${publicId}`
        },
        {
          text: mark('in_progress', '🛠 В работу'),
          callback_data: `ord:work:${publicId}`
        }
      ],
      [
        {
          text: mark('done', '🎉 Готово'),
          callback_data: `ord:done:${publicId}`
        },
        {
          text: mark('cancelled', '❌ Отменить'),
          callback_data: `ord:cancel:${publicId}`
        }
      ]
    ]
  };
}

function buildOrderText(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = [];

  lines.push(`📦 Заказ ${order.public_id}`);
  lines.push(`Статус: ${STATUS_LABELS[normalizeStatus(order.status)] || order.status}`);
  lines.push(`Создан: ${formatDate(order.created_at)}`);
  lines.push(`Клиент: ${buildCustomerName(order.customer_first_name, order.customer_last_name, order.customer_username)}`);

  if (order.customer_username) {
    lines.push(`Username: @${clip(order.customer_username, 120)}`);
  }

  if (order.customer_tg_id) {
    lines.push(`Telegram ID: ${order.customer_tg_id}`);
  }

  lines.push(`Всего позиций: ${items.length}`);
  lines.push(`Общая сумма: ${formatMoney(order.total_amount)}`);

  for (const item of items) {
    lines.push('');
    lines.push(`Позиция ${item.position_number}`);
    lines.push(`Описание: ${clip(item.description, 500)}`);
    lines.push(`Референс: ${clip(item.reference_url, 400)}`);
    lines.push(`Конкурент: ${clip(item.competitor_url, 400)}`);
    lines.push(`Яндекс.Диск: ${clip(item.yandex_disk_url, 400)}`);
    lines.push(`Слайды: ${item.slides}`);
    lines.push(`Цена за слайд: ${formatMoney(item.price_per_slide)}`);
    lines.push(`Сумма позиции: ${formatMoney(item.total_amount)}`);

    if (item.short_wish) {
      lines.push(`Пожелание: ${clip(item.short_wish, 400)}`);
    }

    if (item.tz_url) {
      lines.push(`ТЗ: ${clip(item.tz_url, 400)}`);
    }
  }

  if (WEBAPP_URL) {
    lines.push('');
    lines.push(`Mini App: ${WEBAPP_URL}`);
  }

  const text = lines.join('\n');
  return text.length > 3900 ? `${text.slice(0, 3899)}…` : text;
}

async function sendOrderToTelegram(order) {
  if (!Number.isFinite(ADMIN_CHAT_ID)) {
    throw new Error('ADMIN_CHAT_ID не задан или некорректен');
  }

  return telegramApi('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text: buildOrderText(order),
    reply_markup: buildOrderInlineKeyboard(order.public_id, order.status),
    disable_web_page_preview: true
  });
}

async function editOrderTelegramMessage(order, fallbackMessage = null) {
  const chatId = Number(order.telegram_chat_id ?? fallbackMessage?.chat?.id);
  const messageId = Number(order.telegram_message_id ?? fallbackMessage?.message_id);

  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) {
    return;
  }

  try {
    await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: buildOrderText(order),
      reply_markup: buildOrderInlineKeyboard(order.public_id, order.status),
      disable_web_page_preview: true
    });
  } catch (error) {
    if (String(error.message).includes('message is not modified')) {
      return;
    }

    throw error;
  }
}

/* -------------------- DATABASE -------------------- */

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY
    )
  `);

  const orderColumns = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS public_id VARCHAR(32)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_tg_id BIGINT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_telegram_id BIGINT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_username VARCHAR(255)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_first_name VARCHAR(255)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_last_name VARCHAR(255)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS comment TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'new'`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_notified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  ];

  for (const sql of orderColumns) {
    await pool.query(sql);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE
    )
  `);

  const itemColumns = [
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS position_number INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS position_index INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS title TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS reference_url TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS reference_link TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS competitor_url TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS competitor_link TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS yandex_disk_url TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS source_link TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS slides INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS slides_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS short_wish TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS wish TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tz_url TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tz_link TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price_per_slide INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS total_amount INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS amount INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  ];

  for (const sql of itemColumns) {
    await pool.query(sql);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_status_history (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      old_status VARCHAR(32),
      new_status VARCHAR(32) NOT NULL,
      comment TEXT,
      changed_by VARCHAR(255) NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_public_id_unique
    ON orders(public_id)
    WHERE public_id IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_status
    ON orders(status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_customer_tg_id
    ON orders(customer_tg_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_created_at
    ON orders(created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id
    ON order_items(order_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id
    ON order_status_history(order_id)
  `);

  await pool.query(`UPDATE orders SET status = 'cancelled' WHERE status = 'canceled'`);
  await pool.query(`UPDATE order_status_history SET new_status = 'cancelled' WHERE new_status = 'canceled'`);
  await pool.query(`UPDATE order_status_history SET old_status = 'cancelled' WHERE old_status = 'canceled'`);
}

async function generatePublicId(db) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const publicId = crypto.randomBytes(6).toString('hex').toUpperCase();

    const exists = await db.query(
      `SELECT 1 FROM orders WHERE public_id = $1 LIMIT 1`,
      [publicId]
    );

    if (!exists.rowCount) {
      return publicId;
    }
  }

  throw new Error('Не удалось сгенерировать уникальный public_id');
}

async function backfillMissingPublicIds() {
  const result = await pool.query(`
    SELECT id
    FROM orders
    WHERE public_id IS NULL OR TRIM(public_id) = ''
    ORDER BY id ASC
  `);

  for (const row of result.rows) {
    const publicId = await generatePublicId(pool);

    await pool.query(
      `
        UPDATE orders
        SET public_id = $1
        WHERE id = $2
      `,
      [publicId, row.id]
    );
  }
}

async function addStatusHistory(db, { orderId, oldStatus, newStatus, comment, changedBy }) {
  await db.query(
    `
      INSERT INTO order_status_history (
        order_id,
        old_status,
        new_status,
        comment,
        changed_by,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
    `,
    [
      orderId,
      oldStatus ? normalizeStatus(oldStatus) : null,
      normalizeStatus(newStatus),
      safeText(comment) || null,
      safeText(changedBy) || 'system'
    ]
  );
}

function serializeOrderSummary(row) {
  return {
    id: Number(row.id),
    public_id: safeText(row.public_id),
    customer_tg_id: Number(row.customer_tg_id || 0),
    customer_username: safeText(row.customer_username),
    customer_first_name: safeText(row.customer_first_name),
    customer_last_name: safeText(row.customer_last_name),
    status: normalizeStatus(row.status),
    total_amount: Number(row.total_amount || 0),
    client_notified: Boolean(row.client_notified),
    created_at: row.created_at,
    updated_at: row.updated_at,
    items_count: Number(row.items_count || 0)
  };
}

function serializeOrderItem(row) {
  return {
    id: Number(row.id),
    order_id: Number(row.order_id),
    position_number: Number(row.position_number || 0),
    description: safeText(row.description),
    reference_url: safeText(row.reference_url),
    competitor_url: safeText(row.competitor_url),
    yandex_disk_url: safeText(row.yandex_disk_url),
    slides: Number(row.slides || 0),
    short_wish: safeText(row.short_wish),
    tz_url: safeText(row.tz_url),
    price_per_slide: Number(row.price_per_slide || 0),
    total_amount: Number(row.total_amount || 0),
    created_at: row.created_at
  };
}

function serializeHistoryRow(row) {
  return {
    id: Number(row.id),
    old_status: row.old_status ? normalizeStatus(row.old_status) : null,
    new_status: normalizeStatus(row.new_status),
    comment: safeText(row.comment),
    changed_by: safeText(row.changed_by),
    created_at: row.created_at
  };
}

function serializeOrderDetails(orderRow, itemRows, historyRows) {
  return {
    id: Number(orderRow.id),
    public_id: safeText(orderRow.public_id),
    customer_tg_id: Number(orderRow.customer_tg_id || 0),
    customer_username: safeText(orderRow.customer_username),
    customer_first_name: safeText(orderRow.customer_first_name),
    customer_last_name: safeText(orderRow.customer_last_name),
    status: normalizeStatus(orderRow.status),
    total_amount: Number(orderRow.total_amount || 0),
    client_notified: Boolean(orderRow.client_notified),
    telegram_chat_id: toFiniteNumber(orderRow.telegram_chat_id),
    telegram_message_id: toFiniteNumber(orderRow.telegram_message_id),
    created_at: orderRow.created_at,
    updated_at: orderRow.updated_at,
    items: itemRows.map(serializeOrderItem),
    history: historyRows.map(serializeHistoryRow)
  };
}

async function getOrderByPublicId(publicId) {
  const orderResult = await pool.query(
    `
      SELECT
        id,
        public_id,
        COALESCE(customer_tg_id, customer_telegram_id) AS customer_tg_id,
        customer_username,
        COALESCE(customer_first_name, customer_name, '') AS customer_first_name,
        COALESCE(customer_last_name, '') AS customer_last_name,
        COALESCE(status, 'new') AS status,
        COALESCE(total_amount, 0) AS total_amount,
        COALESCE(client_notified, false) AS client_notified,
        telegram_chat_id,
        telegram_message_id,
        created_at,
        updated_at
      FROM orders
      WHERE public_id = $1
      LIMIT 1
    `,
    [publicId]
  );

  if (!orderResult.rowCount) {
    return null;
  }

  const order = orderResult.rows[0];

  const itemsResult = await pool.query(
    `
      SELECT
        id,
        order_id,
        COALESCE(position_number, position_index, 1) AS position_number,
        COALESCE(description, '') AS description,
        COALESCE(reference_url, reference_link, '') AS reference_url,
        COALESCE(competitor_url, competitor_link, '') AS competitor_url,
        COALESCE(yandex_disk_url, source_link, '') AS yandex_disk_url,
        COALESCE(slides, slides_count, 0) AS slides,
        COALESCE(short_wish, wish, '') AS short_wish,
        COALESCE(tz_url, tz_link, '') AS tz_url,
        COALESCE(price_per_slide, 0) AS price_per_slide,
        COALESCE(total_amount, amount, 0) AS total_amount,
        created_at
      FROM order_items
      WHERE order_id = $1
      ORDER BY COALESCE(position_number, position_index, 1) ASC, id ASC
    `,
    [order.id]
  );

  const historyResult = await pool.query(
    `
      SELECT
        id,
        old_status,
        new_status,
        comment,
        changed_by,
        created_at
      FROM order_status_history
      WHERE order_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [order.id]
  );

  return serializeOrderDetails(order, itemsResult.rows, historyResult.rows);
}

async function updateOrderStatusByPublicId(publicId, nextStatus, comment = '', changedBy = 'system') {
  const status = normalizeStatus(nextStatus);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      `
        SELECT
          id,
          public_id,
          COALESCE(status, 'new') AS status
        FROM orders
        WHERE public_id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [publicId]
    );

    if (!currentResult.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }

    const current = currentResult.rows[0];
    const oldStatus = normalizeStatus(current.status);

    if (oldStatus !== status) {
      await client.query(
        `
          UPDATE orders
          SET status = $1,
              updated_at = NOW()
          WHERE id = $2
        `,
        [status, current.id]
      );

      await addStatusHistory(client, {
        orderId: current.id,
        oldStatus,
        newStatus: status,
        comment,
        changedBy
      });
    }

    await client.query('COMMIT');

    return {
      id: current.id,
      public_id: current.public_id,
      old_status: oldStatus,
      new_status: status,
      changed: oldStatus !== status
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/* -------------------- CREATE ORDER API -------------------- */

async function createOrderHandler(req, res) {
  const body = req.body || {};
  const rawItems = parseItems(body.items);

  const validation = validateAndPrepareItems(rawItems);

  if (!validation.ok) {
    return res.status(400).json({
      ok: false,
      error: 'Проверьте заполнение формы',
      details: validation.details
    });
  }

  let user;
  try {
    user = getRequestUser(body);
  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: error.message
    });
  }

  const items = validation.items;
  const total = items.reduce((sum, item) => sum + Number(item.total_amount || 0), 0);

  const customerUsername = normalizeUsername(user.username);
  const customerFirstName = safeText(user.first_name);
  const customerLastName = safeText(user.last_name);
  const customerName = buildCustomerName(customerFirstName, customerLastName, customerUsername);

  const client = await pool.connect();

  let orderId = null;
  let publicId = null;

  try {
    await client.query('BEGIN');

    publicId = await generatePublicId(client);

    const orderInsert = await client.query(
      `
        INSERT INTO orders (
          public_id,
          customer_tg_id,
          customer_telegram_id,
          customer_username,
          customer_first_name,
          customer_last_name,
          customer_name,
          status,
          total_amount,
          client_notified,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, false, NOW(), NOW())
        RETURNING id
      `,
      [
        publicId,
        user.id,
        user.id,
        customerUsername || null,
        customerFirstName || null,
        customerLastName || null,
        customerName || null,
        total
      ]
    );

    orderId = Number(orderInsert.rows[0].id);

    for (const item of items) {
      await client.query(
        `
          INSERT INTO order_items (
            order_id,
            position_number,
            position_index,
            description,
            reference_url,
            reference_link,
            competitor_url,
            competitor_link,
            yandex_disk_url,
            source_link,
            slides,
            slides_count,
            short_wish,
            wish,
            tz_url,
            tz_link,
            price_per_slide,
            total_amount,
            amount,
            created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
          )
        `,
        [
          orderId,
          item.position_number,
          item.position_index,
          item.description,
          item.reference_url,
          item.reference_link,
          item.competitor_url,
          item.competitor_link,
          item.yandex_disk_url,
          item.source_link,
          item.slides,
          item.slides_count,
          item.short_wish || null,
          item.wish || null,
          item.tz_url || null,
          item.tz_link || null,
          item.price_per_slide,
          item.total_amount,
          item.amount
        ]
      );
    }

    await addStatusHistory(client, {
      orderId,
      oldStatus: null,
      newStatus: 'new',
      comment: '',
      changedBy: 'webapp'
    });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);

    return res.status(500).json({
      ok: false,
      error: 'Не удалось сохранить заказ'
    });
  } finally {
    client.release();
  }

  let telegramSent = false;
  let warning = null;

  try {
    if (BOT_TOKEN && Number.isFinite(ADMIN_CHAT_ID)) {
      const order = await getOrderByPublicId(publicId);
      const message = await sendOrderToTelegram(order);

      await pool.query(
        `
          UPDATE orders
          SET telegram_chat_id = $1,
              telegram_message_id = $2,
              updated_at = NOW()
          WHERE id = $3
        `,
        [message.chat.id, message.message_id, orderId]
      );

      telegramSent = true;
    } else {
      warning = 'Заказ сохранён, но Telegram не настроен';
    }
  } catch (error) {
    console.error('Telegram send order error:', error);
    warning = 'Заказ сохранён, но не отправлен в Telegram';
  }

  return res.status(201).json({
    ok: true,
    orderId: publicId,
    publicId,
    total,
    total_amount: total,
    status: 'new',
    telegramSent,
    warning
  });
}

app.post(
  ['/api/order', '/api/orders', '/api/create-order', '/api/submit-order'],
  createOrderHandler
);

/* -------------------- ADMIN API -------------------- */

app.get('/api/admin/orders', adminBasicAuth, async (req, res) => {
  try {
    const statusFilter = String(req.query.status || 'all').trim().toLowerCase();
    const search = safeText(req.query.q || req.query.search || '');

    const values = [];
    const where = [];

    if (statusFilter && statusFilter !== 'all') {
      values.push(normalizeStatus(statusFilter));
      where.push(`COALESCE(o.status, 'new') = $${values.length}`);
    }

    if (search) {
      values.push(`%${search}%`);
      const p = `$${values.length}`;

      where.push(`
        (
          COALESCE(o.public_id, '') ILIKE ${p}
          OR CAST(o.id AS TEXT) ILIKE ${p}
          OR CAST(COALESCE(o.customer_tg_id, o.customer_telegram_id, 0) AS TEXT) ILIKE ${p}
          OR COALESCE(o.customer_username, '') ILIKE ${p}
          OR COALESCE(o.customer_first_name, '') ILIKE ${p}
          OR COALESCE(o.customer_last_name, '') ILIKE ${p}
          OR COALESCE(o.customer_name, '') ILIKE ${p}
        )
      `);
    }

    const sql = `
      SELECT
        o.id,
        o.public_id,
        COALESCE(o.customer_tg_id, o.customer_telegram_id) AS customer_tg_id,
        o.customer_username,
        COALESCE(o.customer_first_name, o.customer_name, '') AS customer_first_name,
        COALESCE(o.customer_last_name, '') AS customer_last_name,
        COALESCE(o.status, 'new') AS status,
        COALESCE(o.total_amount, 0) AS total_amount,
        COALESCE(o.client_notified, false) AS client_notified,
        o.created_at,
        o.updated_at,
        COUNT(oi.id)::int AS items_count
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY o.id
      ORDER BY o.created_at DESC NULLS LAST, o.id DESC
      LIMIT 200
    `;

    const result = await pool.query(sql, values);
    const orders = result.rows.map(serializeOrderSummary);

    return res.json({
      ok: true,
      orders
    });
  } catch (error) {
    console.error('Admin list orders error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Не удалось загрузить список заказов'
    });
  }
});

app.get('/api/admin/orders/:publicId', adminBasicAuth, async (req, res) => {
  try {
    const publicId = safeText(req.params.publicId);

    if (!publicId) {
      return res.status(400).json({
        ok: false,
        error: 'Некорректный ID заказа'
      });
    }

    const order = await getOrderByPublicId(publicId);

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'Заказ не найден'
      });
    }

    return res.json({
      ok: true,
      order
    });
  } catch (error) {
    console.error('Admin get order error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Не удалось загрузить заказ'
    });
  }
});

async function adminUpdateStatusHandler(req, res) {
  try {
    const publicId = safeText(req.params.publicId);
    const nextStatus = normalizeStatus(req.body?.status, '');
    const comment = safeText(req.body?.comment);

    if (!publicId) {
      return res.status(400).json({
        ok: false,
        error: 'Некорректный ID заказа'
      });
    }

    if (!STATUS_LABELS[nextStatus]) {
      return res.status(400).json({
        ok: false,
        error: 'Некорректный статус'
      });
    }

    const updated = await updateOrderStatusByPublicId(
      publicId,
      nextStatus,
      comment,
      'admin_panel'
    );

    if (!updated) {
      return res.status(404).json({
        ok: false,
        error: 'Заказ не найден'
      });
    }

    const freshOrder = await getOrderByPublicId(publicId);

    try {
      await editOrderTelegramMessage(freshOrder, null);
    } catch (telegramError) {
      console.error('Admin telegram sync error:', telegramError);
    }

    return res.json({
      ok: true,
      order: freshOrder
    });
  } catch (error) {
    console.error('Admin update status error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Не удалось обновить статус'
    });
  }
}

app.patch('/api/admin/orders/:publicId/status', adminBasicAuth, adminUpdateStatusHandler);
app.post('/api/admin/orders/:publicId/status', adminBasicAuth, adminUpdateStatusHandler);

/* -------------------- TELEGRAM CALLBACKS -------------------- */

async function handleOrderCallback(callbackQuery) {
  const rawData = String(callbackQuery?.data || '');
  const match = /^ord:(accept|work|done|cancel):([A-Za-z0-9_-]{1,32})$/.exec(rawData);

  if (!match) {
    await answerCallbackQuery(callbackQuery.id, 'Неизвестное действие', true);
    return;
  }

  const actorId = Number(callbackQuery.from?.id);

  if (!canManageOrders(actorId)) {
    await answerCallbackQuery(callbackQuery.id, 'Недостаточно прав', true);
    return;
  }

  const [, action, publicId] = match;
  const nextStatus = ACTION_TO_STATUS[action];

  const order = await getOrderByPublicId(publicId);

  if (!order) {
    await answerCallbackQuery(callbackQuery.id, 'Заказ не найден', true);
    return;
  }

  if (normalizeStatus(order.status) === nextStatus) {
    await answerCallbackQuery(
      callbackQuery.id,
      `Статус уже установлен: ${STATUS_LABELS[nextStatus]}`,
      false
    );
    return;
  }

  await updateOrderStatusByPublicId(
    publicId,
    nextStatus,
    '',
    `telegram:${actorId}`
  );

  const freshOrder = await getOrderByPublicId(publicId);

  try {
    await editOrderTelegramMessage(freshOrder, callbackQuery.message);
  } catch (error) {
    console.error('Telegram edit message error:', error);
  }

  await answerCallbackQuery(
    callbackQuery.id,
    `Статус изменён: ${STATUS_LABELS[nextStatus]}`,
    false
  );
}

app.post('/telegram/webhook', async (req, res) => {
  if (TELEGRAM_WEBHOOK_SECRET) {
    const secretFromHeader = req.get('x-telegram-bot-api-secret-token');

    if (secretFromHeader !== TELEGRAM_WEBHOOK_SECRET) {
      return res.sendStatus(403);
    }
  }

  const update = req.body || {};

  try {
    if (update.callback_query) {
      await handleOrderCallback(update.callback_query);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);

    if (update.callback_query?.id) {
      try {
        await answerCallbackQuery(update.callback_query.id, 'Ошибка сервера', true);
      } catch (answerError) {
        console.error('answerCallbackQuery error:', answerError);
      }
    }

    return res.sendStatus(200);
  }
});

/* -------------------- START -------------------- */

async function start() {
  await ensureSchema();
  await backfillMissingPublicIds();
  await pool.query('SELECT 1');

  if (!BOT_TOKEN) {
    console.warn('WARN: BOT_TOKEN не задан');
  }

  if (!Number.isFinite(ADMIN_CHAT_ID)) {
    console.warn('WARN: ADMIN_CHAT_ID не задан или некорректен');
  }

  if (ADMIN_USER_IDS.length === 0 && DESIGNER_USER_IDS.length === 0) {
    console.warn('WARN: ADMIN_USER_IDS / DESIGNER_USER_IDS пустые — Telegram-кнопки будут недоступны');
  }

  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error('Startup error:', error);
  process.exit(1);
});