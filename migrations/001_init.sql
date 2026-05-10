CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(32) UNIQUE NOT NULL,
  customer_tg_id BIGINT NOT NULL,
  customer_username VARCHAR(255),
  customer_first_name VARCHAR(255),
  customer_last_name VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'new',
  total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
  client_notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_tg_id ON orders(customer_tg_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference_url TEXT NOT NULL,
  competitor_url TEXT NOT NULL,
  yandex_disk_url TEXT NOT NULL,
  slides INTEGER NOT NULL CHECK (slides BETWEEN 1 AND 500),
  short_wish TEXT,
  tz_url TEXT,
  price_per_slide INTEGER NOT NULL CHECK (price_per_slide >= 0),
  total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  old_status VARCHAR(32),
  new_status VARCHAR(32) NOT NULL,
  comment TEXT,
  changed_by VARCHAR(255) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id);