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
const ADMIN_LOGIN = String(process.env.ADMIN_LOGIN || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const TELEGRAM_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

const ADMIN_USER_IDS = parseIdList(process.env.ADMIN_USER_IDS);
const DESIGNER_USER_IDS = parseIdList(process.env.DESIGNER_USER_IDS);

const ACTION_TO_STATUS = {
  accept: 'accepted',
  work: 'in_progress',
  done: 'done',
  cancel: 'canceled'
};

const STATUS_LABELS = {
  new: '🆕 Новый',
  accepted: '✅ Принят',
  in_progress: '🛠 В работе',
  done: '🎉 Готово',
  canceled: '❌ Отменён'
};

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL не найден. Подключите PostgreSQL на Railway.');
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
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ ok: false });
  }
});

/* -------------------- ADMIN BASIC AUTH -------------------- */

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a ?? ''));
  const bBuffer = Buffer.from(String(b ?? ''));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function adminBasicAuth(req, res, next) {
  // Если логин/пароль не заданы, просто пропускаем
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

    const loginOk = safeEqual(login, ADMIN_LOGIN);
    const passwordOk = safeEqual(password, ADMIN_PASSWORD);

    if (!loginOk || !passwordOk) {
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
  const adminFilePath = path.join(__dirname, 'private', 'admin.html');

  res.sendFile(adminFilePath, (err) => {
    if (err) {
      console.error('Ошибка отправки admin.html:', adminFilePath, err);

      if (!res.headersSent) {
        res.status(err.statusCode || 500).send('Internal Server Error');
      }
    }
  });
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

function canManageOrders(userId) {
  const id = Number(userId);
  return ADMIN_USER_IDS.includes(id) || DESIGNER_USER_IDS.includes(id);
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

function safeText(value) {
  return String(value ?? '').trim();
}

function normalizeUsername(value) {
  return safeText(value).replace(/^@+/, '');
}

function normalizeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const normalized = String(value).replace(',', '.').replace(/\s+/g, '');
  const result = Number(normalized);

  return Number.isFinite(result) ? result : fallback;
}

function normalizeInteger(value, fallback = 0) {
  const result = Math.trunc(normalizeNumber(value, fallback));
  return Number.isFinite(result) ? result : fallback;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const result = Number(String(value).trim());
  return Number.isFinite(result) ? result : null;
}

function clip(value, max = 300) {
  const text = safeText(value);

  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max - 1)}…`;
}

function formatMoney(value) {
  const amount = normalizeNumber(value, 0);

  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(amount)} ₽`;
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

function normalizeItem(rawItem, index) {
  const slidesCount = normalizeInteger(
    rawItem.slidesCount ?? rawItem.slides_count ?? rawItem.count,
    0
  );

  const pricePerSlide = normalizeNumber(
    rawItem.pricePerSlide ?? rawItem.price_per_slide ?? rawItem.price,
    0
  );

  const amount = normalizeNumber(
    rawItem.amount ?? rawItem.total ?? slidesCount * pricePerSlide,
    slidesCount * pricePerSlide
  );

  return {
    positionIndex: index + 1,
    title: safeText(rawItem.title ?? rawItem.name ?? ''),
    description: safeText(rawItem.description ?? rawItem.productDescription ?? ''),
    referenceLink: safeText(rawItem.referenceLink ?? rawItem.reference ?? rawItem.ref ?? ''),
    competitorLink: safeText(rawItem.competitorLink ?? rawItem.competitor ?? ''),
    sourceLink: safeText(
      rawItem.sourceLink ??
        rawItem.materialsLink ??
        rawItem.diskLink ??
        rawItem.yandexDiskLink ??
        ''
    ),
    slidesCount,
    pricePerSlide,
    amount,
    wish: safeText(rawItem.wish ?? rawItem.shortWish ?? rawItem.note ?? ''),
    tzLink: safeText(rawItem.tzLink ?? rawItem.technicalTaskLink ?? rawItem.tz ?? '')
  };
}

function buildOrderInlineKeyboard(orderId, currentStatus = 'new') {
  const mark = (status, text) => (currentStatus === status ? `• ${text}` : text);

  return {
    inline_keyboard: [
      [
        {
          text: mark('accepted', '✅ Принять'),
          callback_data: `order:accept:${orderId}`
        },
        {
          text: mark('in_progress', '🛠 В работу'),
          callback_data: `order:work:${orderId}`
        }
      ],
      [
        {
          text: mark('done', '🎉 Готово'),
          callback_data: `order:done:${orderId}`
        },
        {
          text: mark('canceled', '❌ Отменить'),
          callback_data: `order:cancel:${orderId}`
        }
      ]
    ]
  };
}

function buildOrderText(order, items) {
  const lines = [];

  lines.push(`📦 Заказ #${order.id}`);
  lines.push(`Статус: ${STATUS_LABELS[order.status] || order.status || '—'}`);
  lines.push(`Создан: ${formatDate(order.created_at)}`);

  if (order.customer_name) {
    lines.push(`Клиент: ${clip(order.customer_name, 120)}`);
  }

  if (order.customer_username) {
    lines.push(`Username: @${clip(order.customer_username, 120)}`);
  }

  if (order.customer_telegram_id) {
    lines.push(`Telegram ID: ${order.customer_telegram_id}`);
  }

  if (order.comment) {
    lines.push(`Комментарий: ${clip(order.comment, 500)}`);
  }

  for (const item of items) {
    lines.push('');
    lines.push(`📦 Позиция ${item.position_index}`);

    if (item.title) {
      lines.push(`Название: ${clip(item.title, 180)}`);
    }

    if (item.description) {
      lines.push(`Описание товара: ${clip(item.description, 500)}`);
    }

    if (item.reference_link) {
      lines.push(`Референс: ${clip(item.reference_link, 400)}`);
    }

    if (item.competitor_link) {
      lines.push(`Ссылка на конкурента: ${clip(item.competitor_link, 400)}`);
    }

    if (item.source_link) {
      lines.push(`Ссылка на Яндекс.Диск: ${clip(item.source_link, 400)}`);
    }

    lines.push(`Количество слайдов: ${item.slides_count || 0}`);
    lines.push(`Цена за слайд: ${formatMoney(item.price_per_slide || 0)}`);
    lines.push(`Сумма позиции: ${formatMoney(item.amount || 0)}`);

    if (item.wish) {
      lines.push(`Краткое пожелание: ${clip(item.wish, 400)}`);
    }

    if (item.tz_link) {
      lines.push(`Ссылка на ТЗ: ${clip(item.tz_link, 400)}`);
    }
  }

  lines.push('');
  lines.push(`💰 Общая сумма: ${formatMoney(order.total_amount || 0)}`);

  const fullText = lines.join('\n');

  // Telegram limit ~4096 символов
  return fullText.length > 3900 ? `${fullText.slice(0, 3899)}…` : fullText;
}

/* -------------------- TELEGRAM API -------------------- */

async function telegramApi(method, payload) {
  if (typeof fetch !== 'function') {
    throw new Error('Нужен Node.js 18+ (fetch недоступен)');
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

async function sendOrderToTelegram(order, items) {
  if (!Number.isFinite(ADMIN_CHAT_ID)) {
    throw new Error('ADMIN_CHAT_ID не задан или некорректен');
  }

  const text = buildOrderText(order, items);

  return telegramApi('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text,
    reply_markup: buildOrderInlineKeyboard(order.id, order.status || 'new'),
    disable_web_page_preview: true
  });
}

async function editOrderTelegramMessage(order, fallbackMessage) {
  const chatId = Number(order.telegram_chat_id ?? fallbackMessage?.chat?.id);
  const messageId = Number(order.telegram_message_id ?? fallbackMessage?.message_id);

  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) {
    return;
  }

  const text = buildOrderText(order, order.items || []);

  try {
    await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: buildOrderInlineKeyboard(order.id, order.status || 'new'),
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

  const orderAlterStatements = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_username TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_telegram_id BIGINT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS comment TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  ];

  for (const sql of orderAlterStatements) {
    await pool.query(sql);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
      position_index INTEGER NOT NULL DEFAULT 1,
      title TEXT,
      description TEXT,
      reference_link TEXT,
      competitor_link TEXT,
      source_link TEXT,
      slides_count INTEGER NOT NULL DEFAULT 0,
      price_per_slide NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      wish TEXT,
      tz_link TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id
    ON order_items(order_id)
  `);
}

async function getOrderWithItems(orderId) {
  const orderResult = await pool.query(
    `
      SELECT
        id,
        customer_name,
        customer_username,
        customer_telegram_id,
        comment,
        total_amount,
        status,
        telegram_chat_id,
        telegram_message_id,
        created_at,
        updated_at
      FROM orders
      WHERE id = $1
      LIMIT 1
    `,
    [orderId]
  );

  if (orderResult.rows.length === 0) {
    return null;
  }

  const itemsResult = await pool.query(
    `
      SELECT
        id,
        order_id,
        position_index,
        title,
        description,
        reference_link,
        competitor_link,
        source_link,
        slides_count,
        price_per_slide,
        amount,
        wish,
        tz_link,
        created_at
      FROM order_items
      WHERE order_id = $1
      ORDER BY position_index ASC, id ASC
    `,
    [orderId]
  );

  const order = orderResult.rows[0];
  order.items = itemsResult.rows;

  return order;
}

async function updateOrderStatus(orderId, status) {
  const result = await pool.query(
    `
      UPDATE orders
      SET status = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, status
    `,
    [status, orderId]
  );

  return result.rows[0] || null;
}

/* -------------------- CREATE ORDER API -------------------- */

async function createOrderHandler(req, res) {
  const body = req.body || {};

  const rawItems = parseItems(body.items ?? body.positions ?? body.orderItems);

  if (!rawItems.length) {
    return res.status(400).json({
      ok: false,
      error: 'Добавьте хотя бы одну позицию'
    });
  }

  const items = rawItems
    .map((item, index) => normalizeItem(item, index))
    .filter((item) => {
      return Boolean(
        item.title ||
          item.description ||
          item.referenceLink ||
          item.competitorLink ||
          item.sourceLink ||
          item.slidesCount ||
          item.pricePerSlide ||
          item.amount ||
          item.wish ||
          item.tzLink
      );
    });

  if (!items.length) {
    return res.status(400).json({
      ok: false,
      error: 'Позиции пустые'
    });
  }

  const customerName = safeText(
    body.customerName ??
      body.customer_name ??
      body.clientName ??
      body.name ??
      body.fullName ??
      ''
  );

  const customerUsername = normalizeUsername(
    body.customerUsername ?? body.customer_username ?? body.username ?? ''
  );

  const customerTelegramId = normalizeOptionalNumber(
    body.customerTelegramId ??
      body.customer_telegram_id ??
      body.telegramId ??
      body.telegram_id
  );

  const comment = safeText(body.comment ?? body.notes ?? body.note ?? '');

  const totalAmount = items.reduce((sum, item) => sum + normalizeNumber(item.amount, 0), 0);

  const client = await pool.connect();

  let order;

  try {
    await client.query('BEGIN');

    const orderInsertResult = await client.query(
      `
        INSERT INTO orders (
          customer_name,
          customer_username,
          customer_telegram_id,
          comment,
          total_amount,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, 'new', NOW(), NOW())
        RETURNING *
      `,
      [
        customerName || null,
        customerUsername || null,
        customerTelegramId,
        comment || null,
        totalAmount
      ]
    );

    order = orderInsertResult.rows[0];

    for (const item of items) {
      await client.query(
        `
          INSERT INTO order_items (
            order_id,
            position_index,
            title,
            description,
            reference_link,
            competitor_link,
            source_link,
            slides_count,
            price_per_slide,
            amount,
            wish,
            tz_link,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        `,
        [
          order.id,
          item.positionIndex,
          item.title || null,
          item.description || null,
          item.referenceLink || null,
          item.competitorLink || null,
          item.sourceLink || null,
          item.slidesCount,
          item.pricePerSlide,
          item.amount,
          item.wish || null,
          item.tzLink || null
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order transaction error:', error);

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
      const freshOrder = await getOrderWithItems(order.id);
      const telegramMessage = await sendOrderToTelegram(freshOrder, freshOrder.items);

      await pool.query(
        `
          UPDATE orders
          SET telegram_chat_id = $1,
              telegram_message_id = $2,
              updated_at = NOW()
          WHERE id = $3
        `,
        [telegramMessage.chat.id, telegramMessage.message_id, order.id]
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
    orderId: order.id,
    status: 'new',
    totalAmount,
    telegramSent,
    warning
  });
}

app.post(['/api/orders', '/api/create-order', '/api/submit-order'], createOrderHandler);

/* -------------------- TELEGRAM CALLBACKS -------------------- */

async function handleOrderCallback(callbackQuery) {
  const rawData = String(callbackQuery?.data || '');
  const match = /^order:(accept|work|done|cancel):(\d+)$/.exec(rawData);

  if (!match) {
    await answerCallbackQuery(callbackQuery.id, 'Неизвестное действие', true);
    return;
  }

  const actorId = Number(callbackQuery.from?.id);

  if (!canManageOrders(actorId)) {
    await answerCallbackQuery(callbackQuery.id, 'Недостаточно прав', true);
    return;
  }

  const [, action, orderIdRaw] = match;
  const orderId = Number(orderIdRaw);
  const nextStatus = ACTION_TO_STATUS[action];

  const order = await getOrderWithItems(orderId);

  if (!order) {
    await answerCallbackQuery(callbackQuery.id, 'Заказ не найден', true);
    return;
  }

  if (String(order.status) === nextStatus) {
    await answerCallbackQuery(
      callbackQuery.id,
      `Статус уже установлен: ${STATUS_LABELS[nextStatus]}`,
      false
    );
    return;
  }

  const updated = await updateOrderStatus(orderId, nextStatus);

  if (!updated) {
    await answerCallbackQuery(callbackQuery.id, 'Не удалось обновить статус', true);
    return;
  }

  const freshOrder = await getOrderWithItems(orderId);

  await editOrderTelegramMessage(freshOrder, callbackQuery.message);

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
      return res.sendStatus(200);
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
  await pool.query('SELECT 1');

  if (!BOT_TOKEN) {
    console.warn('WARN: BOT_TOKEN не задан');
  }

  if (!Number.isFinite(ADMIN_CHAT_ID)) {
    console.warn('WARN: ADMIN_CHAT_ID не задан или некорректен');
  }

  if (ADMIN_USER_IDS.length === 0 && DESIGNER_USER_IDS.length === 0) {
    console.warn('WARN: ADMIN_USER_IDS / DESIGNER_USER_IDS пустые — кнопки будут недоступны');
  }

  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error('Startup error:', error);
  process.exit(1);
});