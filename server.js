import express from 'express';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

dotenv.config();

const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  WEBAPP_URL,
  DATABASE_URL,
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  PORT = 3000,
  ALLOW_UNSAFE_TEST_MODE = 'false',
  TEST_USER_ID
} = process.env;

if (!BOT_TOKEN) throw new Error('Не задан BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Не задан ADMIN_CHAT_ID');
if (!DATABASE_URL) throw new Error('Не задан DATABASE_URL');
if (!ADMIN_LOGIN) throw new Error('Не задан ADMIN_LOGIN');
if (!ADMIN_PASSWORD) throw new Error('Не задан ADMIN_PASSWORD');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

let bot;

const ALLOWED_STATUSES = new Set([
  'new',
  'accepted',
  'in_progress',
  'done',
  'cancelled'
]);

function formatMoney(value) {
  return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value));
}

function getPricePerSlide(slides) {
  if (slides <= 20) return 800;
  if (slides <= 50) return 600;
  return 500;
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

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseSlides(value) {
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

function isItemEmpty(item) {
  return (
    !item.description &&
    !item.referenceUrl &&
    !item.competitorUrl &&
    !item.yandexDiskUrl &&
    !item.shortWish &&
    !item.tzUrl &&
    (item.slides === null || item.slides === undefined || item.slides === '')
  );
}

function prepareItems(rawItems) {
  if (!Array.isArray(rawItems)) {
    return {
      preparedItems: [],
      errors: ['Поле items должно быть массивом']
    };
  }

  const preparedItems = [];
  const errors = [];

  rawItems.forEach((rawItem, index) => {
    const item = {
      description: normalizeText(rawItem?.description),
      referenceUrl: normalizeText(rawItem?.referenceUrl),
      competitorUrl: normalizeText(rawItem?.competitorUrl),
      yandexDiskUrl: normalizeText(rawItem?.yandexDiskUrl),
      slides: parseSlides(rawItem?.slides),
      shortWish: normalizeText(rawItem?.shortWish),
      tzUrl: normalizeText(rawItem?.tzUrl)
    };

    if (isItemEmpty(item)) {
      return;
    }

    const itemErrors = [];

    if (!item.description) {
      itemErrors.push(`Позиция ${index + 1}: заполните "Описание товара"`);
    }

    if (!item.referenceUrl) {
      itemErrors.push(`Позиция ${index + 1}: заполните "Референс (ссылка)"`);
    } else if (!isValidUrl(item.referenceUrl)) {
      itemErrors.push(`Позиция ${index + 1}: "Референс" должен быть корректной ссылкой`);
    }

    if (!item.competitorUrl) {
      itemErrors.push(`Позиция ${index + 1}: заполните "Ссылка на конкурента"`);
    } else if (!isValidUrl(item.competitorUrl)) {
      itemErrors.push(`Позиция ${index + 1}: "Ссылка на конкурента" должна быть корректной ссылкой`);
    }

    if (!item.yandexDiskUrl) {
      itemErrors.push(`Позиция ${index + 1}: заполните "Ссылка на Яндекс.Диск"`);
    } else if (!isValidUrl(item.yandexDiskUrl)) {
      itemErrors.push(`Позиция ${index + 1}: "Ссылка на Яндекс.Диск" должна быть корректной ссылкой`);
    }

    if (item.slides === null || item.slides < 1 || item.slides > 500) {
      itemErrors.push(`Позиция ${index + 1}: "Количество слайдов" должно быть числом от 1 до 500`);
    }

    if (item.tzUrl && !isValidUrl(item.tzUrl)) {
      itemErrors.push(`Позиция ${index + 1}: "Ссылка на ТЗ" должна быть корректной ссылкой`);
    }

    if (itemErrors.length > 0) {
      errors.push(...itemErrors);
      return;
    }

    const pricePerSlide = getPricePerSlide(item.slides);
    const total = pricePerSlide * item.slides;

    preparedItems.push({
      ...item,
      pricePerSlide,
      total
    });
  });

  return { preparedItems, errors };
}

function createOrderId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ORD-${date}-${rand}`;
}

function verifyTelegramWebAppData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const hashBuffer = Buffer.from(hash, 'hex');
    const calculatedBuffer = Buffer.from(calculatedHash, 'hex');

    return (
      hashBuffer.length === calculatedBuffer.length &&
      crypto.timingSafeEqual(hashBuffer, calculatedBuffer)
    );
  } catch {
    return false;
  }
}

function getTelegramUserFromInitData(initData) {
  if (!initData || !verifyTelegramWebAppData(initData, BOT_TOKEN)) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const rawUser = params.get('user');
    return rawUser ? JSON.parse(rawUser) : null;
  } catch {
    return null;
  }
}

function buildStatusKeyboard(publicId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Принять', callback_data: `st|${publicId}|accepted` },
        { text: '🛠 В работу', callback_data: `st|${publicId}|in_progress` }
      ],
      [
        { text: '🎉 Готово', callback_data: `st|${publicId}|done` },
        { text: '❌ Отменить', callback_data: `st|${publicId}|cancelled` }
      ]
    ]
  };
}

function formatOrderMessage(order, { forAdmin = false } = {}) {
  const userName =
    [order.customer_first_name, order.customer_last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Без имени';

  const username = order.customer_username ? `@${order.customer_username}` : '—';

  const header = forAdmin
    ? [
        `🆕 Новый заказ ${order.public_id}`,
        `Статус: ${statusLabel(order.status)}`,
        `Клиент: ${userName}`,
        `Username: ${username}`,
        `Telegram ID: ${order.customer_tg_id}`,
        `Создан: ${formatDate(order.created_at)}`
      ].join('\n')
    : [
        `✅ Ваш заказ ${order.public_id} принят`,
        `Предварительный расчёт ниже.`,
        `Текущий статус: ${statusLabel(order.status)}`
      ].join('\n');

  const itemsText = order.items
    .map((item, index) => {
      return [
        `📦 Позиция ${index + 1}`,
        `Описание товара: ${item.description}`,
        `Референс: ${item.reference_url}`,
        `Ссылка на конкурента: ${item.competitor_url}`,
        `Ссылка на Яндекс.Диск: ${item.yandex_disk_url}`,
        `Количество слайдов: ${item.slides}`,
        `Цена за слайд: ${formatMoney(item.price_per_slide)}`,
        `Сумма позиции: ${formatMoney(item.total_amount)}`,
        `Краткое пожелание: ${item.short_wish || '—'}`,
        `Ссылка на ТЗ: ${item.tz_url || '—'}`
      ].join('\n');
    })
    .join('\n\n');

  return `${header}\n\n${itemsText}\n\n💰 Общая сумма: ${formatMoney(order.total_amount)}`;
}

function formatStatusChangeMessage(order, comment = '') {
  return [
    `ℹ️ Обновление по заказу ${order.public_id}`,
    `Новый статус: ${statusLabel(order.status)}`,
    comment ? `Комментарий: ${comment}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

async function sendLongMessage(chatId, text, options = {}) {
  const maxLength = 3900;

  if (text.length <= maxLength) {
    await bot.sendMessage(chatId, text, {
      disable_web_page_preview: true,
      ...options
    });
    return;
  }

  const parts = [];
  let current = '';

  for (const block of text.split('\n\n')) {
    const next = current ? `${current}\n\n${block}` : block;

    if (next.length > maxLength) {
      if (current) {
        parts.push(current);
      }

      if (block.length > maxLength) {
        for (let i = 0; i < block.length; i += maxLength) {
          parts.push(block.slice(i, i + maxLength));
        }
        current = '';
      } else {
        current = block;
      }
    } else {
      current = next;
    }
  }

  if (current) {
    parts.push(current);
  }

  for (let i = 0; i < parts.length; i += 1) {
    await bot.sendMessage(chatId, parts[i], {
      disable_web_page_preview: true,
      ...(i === 0 ? options : {})
    });
  }
}

async function runMigrations() {
  const migrationPath = path.join(__dirname, 'migrations', '001_init.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await pool.query(sql);
  console.log('Migrations applied');
}

async function createOrderInDb(user, items, total) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const publicId = createOrderId();

    const orderRes = await client.query(
      `
      INSERT INTO orders (
        public_id,
        customer_tg_id,
        customer_username,
        customer_first_name,
        customer_last_name,
        status,
        total_amount
      )
      VALUES ($1, $2, $3, $4, $5, 'new', $6)
      RETURNING *
      `,
      [
        publicId,
        user.id,
        user.username || null,
        user.first_name || null,
        user.last_name || null,
        total
      ]
    );

    const order = orderRes.rows[0];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];

      await client.query(
        `
        INSERT INTO order_items (
          order_id,
          position_number,
          description,
          reference_url,
          competitor_url,
          yandex_disk_url,
          slides,
          short_wish,
          tz_url,
          price_per_slide,
          total_amount
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          order.id,
          i + 1,
          item.description,
          item.referenceUrl,
          item.competitorUrl,
          item.yandexDiskUrl,
          item.slides,
          item.shortWish || null,
          item.tzUrl || null,
          item.pricePerSlide,
          item.total
        ]
      );
    }

    await client.query(
      `
      INSERT INTO order_status_history (
        order_id,
        old_status,
        new_status,
        comment,
        changed_by
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [order.id, null, 'new', 'Заказ создан', 'system']
    );

    await client.query('COMMIT');

    return publicId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getOrderByPublicId(publicId) {
  const orderRes = await pool.query(
    `SELECT * FROM orders WHERE public_id = $1 LIMIT 1`,
    [publicId]
  );

  const order = orderRes.rows[0];
  if (!order) return null;

  const itemsRes = await pool.query(
    `
    SELECT *
    FROM order_items
    WHERE order_id = $1
    ORDER BY position_number ASC
    `,
    [order.id]
  );

  const historyRes = await pool.query(
    `
    SELECT *
    FROM order_status_history
    WHERE order_id = $1
    ORDER BY created_at DESC
    `,
    [order.id]
  );

  return {
    ...order,
    items: itemsRes.rows,
    history: historyRes.rows
  };
}

async function updateClientNotified(orderId, value) {
  await pool.query(
    `
    UPDATE orders
    SET client_notified = $1,
        updated_at = NOW()
    WHERE id = $2
    `,
    [value, orderId]
  );
}

async function listOrders({ status = 'all', q = '', page = 1, pageSize = 20 }) {
  const where = [];
  const values = [];

  if (status && status !== 'all') {
    values.push(status);
    where.push(`o.status = $${values.length}`);
  }

  if (q) {
    values.push(`%${q}%`);
    where.push(`
      (
        o.public_id ILIKE $${values.length}
        OR COALESCE(o.customer_username, '') ILIKE $${values.length}
        OR COALESCE(o.customer_first_name, '') ILIKE $${values.length}
        OR COALESCE(o.customer_last_name, '') ILIKE $${values.length}
      )
    `);
  }

  const offset = (page - 1) * pageSize;
  values.push(pageSize);
  const limitPlaceholder = `$${values.length}`;
  values.push(offset);
  const offsetPlaceholder = `$${values.length}`;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      o.id,
      o.public_id,
      o.customer_tg_id,
      o.customer_username,
      o.customer_first_name,
      o.customer_last_name,
      o.status,
      o.total_amount,
      o.client_notified,
      o.created_at,
      o.updated_at,
      COUNT(oi.id)::int AS items_count
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    ${whereSql}
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT ${limitPlaceholder}
    OFFSET ${offsetPlaceholder}
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

async function setOrderStatus({ publicId, newStatus, comment = '', changedBy = 'admin' }) {
  if (!ALLOWED_STATUSES.has(newStatus)) {
    throw new Error('Недопустимый статус');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const currentRes = await client.query(
      `SELECT * FROM orders WHERE public_id = $1 FOR UPDATE`,
      [publicId]
    );

    const current = currentRes.rows[0];
    if (!current) {
      throw new Error('Заказ не найден');
    }

    const oldStatus = current.status;

    if (oldStatus !== newStatus || comment) {
      await client.query(
        `
        UPDATE orders
        SET status = $1,
            updated_at = NOW()
        WHERE id = $2
        `,
        [newStatus, current.id]
      );

      await client.query(
        `
        INSERT INTO order_status_history (
          order_id,
          old_status,
          new_status,
          comment,
          changed_by
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [current.id, oldStatus, newStatus, comment || null, changedBy]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getOrderByPublicId(publicId);
}

async function notifyClientStatusChanged(order, comment = '') {
  try {
    await sendLongMessage(order.customer_tg_id, formatStatusChangeMessage(order, comment));
  } catch (error) {
    console.error('Не удалось уведомить клиента о смене статуса:', error.message);
  }
}

function adminBasicAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Panel"');
    return res.status(401).send('Authentication required');
  }

  const encoded = authHeader.slice(6);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');

  const login = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : '';
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

  const isValid =
    crypto.timingSafeEqual(Buffer.from(login), Buffer.from(ADMIN_LOGIN)) &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));

  if (!isValid) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Panel"');
    return res.status(401).send('Invalid credentials');
  }

  next();
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false });
  }
});

app.get('/admin', adminBasicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});

app.get('/api/admin/orders', adminBasicAuth, async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));

    const orders = await listOrders({ status, q, page, pageSize });

    res.json({
      ok: true,
      orders
    });
  } catch (error) {
    console.error('Ошибка получения списка заказов:', error);
    res.status(500).json({
      ok: false,
      error: 'Не удалось получить список заказов'
    });
  }
});

app.get('/api/admin/orders/:publicId', adminBasicAuth, async (req, res) => {
  try {
    const order = await getOrderByPublicId(req.params.publicId);

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'Заказ не найден'
      });
    }

    res.json({
      ok: true,
      order
    });
  } catch (error) {
    console.error('Ошибка получения заказа:', error);
    res.status(500).json({
      ok: false,
      error: 'Не удалось получить заказ'
    });
  }
});

app.patch('/api/admin/orders/:publicId/status', adminBasicAuth, async (req, res) => {
  try {
    const newStatus = String(req.body?.status || '').trim();
    const comment = normalizeText(req.body?.comment);

    const order = await setOrderStatus({
      publicId: req.params.publicId,
      newStatus,
      comment,
      changedBy: 'admin-panel'
    });

    await notifyClientStatusChanged(order, comment);

    res.json({
      ok: true,
      order
    });
  } catch (error) {
    console.error('Ошибка обновления статуса:', error);
    res.status(400).json({
      ok: false,
      error: error.message || 'Не удалось обновить статус'
    });
  }
});

app.post('/api/order', async (req, res) => {
  try {
    const { initData, items } = req.body || {};

    let user = getTelegramUserFromInitData(initData);
    const allowUnsafeTestMode = ALLOW_UNSAFE_TEST_MODE === 'true';

    if (!user && allowUnsafeTestMode) {
      user = {
        id: Number(TEST_USER_ID || ADMIN_CHAT_ID),
        first_name: 'Test',
        last_name: 'User',
        username: 'test_user'
      };
    }

    if (!user?.id) {
      return res.status(401).json({
        ok: false,
        error: 'Не удалось проверить Telegram WebApp данные'
      });
    }

    const { preparedItems, errors } = prepareItems(items);

    if (errors.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'Ошибка валидации',
        details: errors
      });
    }

    if (preparedItems.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Добавьте хотя бы одну корректно заполненную позицию'
      });
    }

    const total = preparedItems.reduce((sum, item) => sum + item.total, 0);
    const publicId = await createOrderInDb(user, preparedItems, total);
    const order = await getOrderByPublicId(publicId);

    await sendLongMessage(
      ADMIN_CHAT_ID,
      formatOrderMessage(order, { forAdmin: true }),
      {
        reply_markup: buildStatusKeyboard(order.public_id)
      }
    );

    let clientNotified = true;

    try {
      await sendLongMessage(user.id, formatOrderMessage(order, { forAdmin: false }));
      await updateClientNotified(order.id, true);
    } catch (error) {
      clientNotified = false;
      console.error('Не удалось отправить подтверждение клиенту:', error.message);
    }

    return res.json({
      ok: true,
      orderId: order.public_id,
      total: order.total_amount,
      clientNotified
    });
  } catch (error) {
    console.error('Ошибка /api/order:', error);
    return res.status(500).json({
      ok: false,
      error: 'Внутренняя ошибка сервера'
    });
  }
});

async function initBot() {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
  });

  await bot.setMyCommands([
    { command: 'start', description: 'Открыть форму заказа' },
    { command: 'id', description: 'Показать ваш Telegram ID' }
  ]).catch(() => {});

  bot.onText(/\/start/, async (msg) => {
    if (!WEBAPP_URL) {
      await bot.sendMessage(
        msg.chat.id,
        'Бот запущен, но переменная WEBAPP_URL пока не настроена.'
      );
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      'Откройте форму заказа:',
      {
        reply_markup: {
          keyboard: [
            [
              {
                text: 'Открыть форму заказа',
                web_app: { url: WEBAPP_URL }
              }
            ]
          ],
          resize_keyboard: true,
          persistent: true
        }
      }
    );
  });

  bot.onText(/\/id/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `Ваш chat_id: ${msg.chat.id}`);
  });

  bot.on('callback_query', async (query) => {
    try {
      if (String(query.from.id) !== String(ADMIN_CHAT_ID)) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Недостаточно прав',
          show_alert: true
        });
        return;
      }

      const [prefix, publicId, newStatus] = String(query.data || '').split('|');

      if (prefix !== 'st' || !publicId || !ALLOWED_STATUSES.has(newStatus)) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Некорректная команда'
        });
        return;
      }

      const order = await setOrderStatus({
        publicId,
        newStatus,
        comment: '',
        changedBy: `telegram:${query.from.id}`
      });

      await notifyClientStatusChanged(order);

      await bot.answerCallbackQuery(query.id, {
        text: `Статус: ${statusLabel(newStatus)}`
      });

      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `Заказ ${publicId}: статус изменён на ${statusLabel(newStatus)}`
      );
    } catch (error) {
      console.error('Ошибка callback_query:', error);
      await bot.answerCallbackQuery(query.id, {
        text: 'Ошибка обновления статуса',
        show_alert: true
      });
    }
  });
}

async function start() {
  await runMigrations();
  await initBot();

  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error('Ошибка запуска приложения:', error);
  process.exit(1);
});