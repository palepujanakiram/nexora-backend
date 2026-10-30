import { bodyText, defined, fakeFetch, json, type FakeFetch } from './helpers.ts';

export type FillMode = 'open' | 'filled' | 'partial';

interface FakeOrder {
  order_id: string;
  status: string;
  quantity: number;
  filled_quantity: number;
  average_price: number;
  price: number;
  trigger_price: number;
  order_type: string;
  tag: string;
  status_message: string | null;
  tradingsymbol: string;
  exchange: string;
  product: string;
  transaction_type: string;
  instrument_token: string;
  /** The API key that placed it: each key is a separate account. */
  key: string;
}

/**
 * A small in-memory Kite Connect. Behaviour is chosen per API key (the
 * `Authorization: token <key>:<token>` header), so one fake serves several
 * accounts: [fill] says how new orders end up, [reject] makes a key's
 * orders fail with a message, [down] answers 503 to writes.
 */
export class FakeKite {
  readonly orders = new Map<string, FakeOrder>();
  fill: Record<string, FillMode> = {};
  reject: Record<string, string> = {};
  down = new Set<string>();
  /** Net position overrides per key, e.g. after a manual trade outside the app. */
  heldOverride: Record<string, number> = {};
  lastPrice = 425.5;
  private seq = 1000;

  handle(url: string, init: RequestInit): Response | null {
    if (!url.startsWith('https://api.kite.trade')) return null;
    const auth = ((init.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
    const key = /^token ([^:]+):/.exec(auth)?.[1] ?? '';
    const path = url.slice('https://api.kite.trade'.length);
    const method = init.method ?? 'GET';
    const form = Object.fromEntries(new URLSearchParams(bodyText(init)));
    if (method !== 'GET' && this.down.has(key)) return json({ status: 'error', error_type: 'NetworkException', message: 'down' }, 503);

    if (path === '/session/token') return json({ status: 'success', data: { access_token: `AT-${form['request_token']}` } });
    if (path === '/orders/regular' && method === 'POST') {
      if (this.reject[key]) return json({ status: 'error', error_type: 'OrderException', message: this.reject[key] }, 400);
      const id = String(++this.seq);
      const qty = Number(form['quantity']);
      const mode = this.fill[key] ?? 'open';
      const filled = mode === 'filled' ? qty : mode === 'partial' ? qty / 2 : 0;
      this.orders.set(id, {
        order_id: id,
        status: mode === 'filled' ? 'COMPLETE' : 'OPEN',
        quantity: qty,
        filled_quantity: filled,
        average_price: filled ? Number(form['price'] ?? this.lastPrice) : 0,
        price: Number(form['price'] ?? 0),
        trigger_price: Number(form['trigger_price'] ?? 0),
        order_type: defined(form['order_type'], 'order_type'),
        tag: defined(form['tag'], 'tag'),
        status_message: null,
        tradingsymbol: defined(form['tradingsymbol'], 'tradingsymbol'),
        exchange: defined(form['exchange'], 'exchange'),
        product: defined(form['product'], 'product'),
        transaction_type: defined(form['transaction_type'], 'transaction_type'),
        instrument_token: '12345',
        key,
      });
      return json({ status: 'success', data: { order_id: id } });
    }
    const one = /^\/orders\/regular\/(\w+)$/.exec(path);
    if (one) {
      const o = this.orders.get(defined(one[1]));
      if (o?.status !== 'OPEN') return json({ status: 'error', error_type: 'InputException', message: 'Order cannot be modified or cancelled.' }, 400);
      if (method === 'DELETE') o.status = 'CANCELLED';
      if (method === 'PUT') {
        o.quantity = Number(form['quantity']);
        o.price = Number(form['price'] ?? 0);
        o.trigger_price = Number(form['trigger_price'] ?? 0);
        o.order_type = defined(form['order_type'], 'order_type');
      }
      return json({ status: 'success', data: { order_id: o.order_id } });
    }
    const history = /^\/orders\/(\w+)$/.exec(path);
    if (history) {
      const o = this.orders.get(defined(history[1]));
      return o ? json({ status: 'success', data: [{ ...o }] }) : json({ status: 'error', error_type: 'InputException', message: 'No order' }, 400);
    }
    if (path === '/orders') return json({ status: 'success', data: [...this.orders.values()].filter((o) => o.key === key) });
    if (path === '/portfolio/positions') {
      const net = new Map<string, FakeOrder & { qty: number }>();
      for (const o of this.orders.values()) {
        if (!o.filled_quantity || o.key !== key) continue;
        const p = net.get(o.tradingsymbol + o.product) ?? { ...o, qty: 0 };
        p.qty += o.transaction_type === 'BUY' ? o.filled_quantity : -o.filled_quantity;
        net.set(o.tradingsymbol + o.product, p);
      }
      return json({
        status: 'success',
        data: {
          net: [...net.values()].map((p) => ({
            instrument_token: p.instrument_token,
            tradingsymbol: p.tradingsymbol,
            exchange: p.exchange,
            product: p.product,
            quantity: this.heldOverride[key] ?? p.qty,
            average_price: p.average_price,
            last_price: this.lastPrice,
            pnl: 12.5,
          })),
        },
      });
    }
    return json({ status: 'error', error_type: 'GeneralException', message: `fake kite: no route ${method} ${path}` }, 404);
  }

  /** Fills an open order at [price], as the exchange would. */
  fillOrder(id: string, price: number) {
    const o = defined(this.orders.get(id), `order ${id}`);
    o.filled_quantity = o.quantity;
    o.average_price = price;
    o.status = 'COMPLETE';
  }
}

/** A minimal Upstox: writes can be made to fail with 503, and the order book can be seeded. */
export class FakeUpstox {
  down = false;
  readonly book: Record<string, unknown>[] = [];

  handle(url: string, init: RequestInit): Response | null {
    if (!url.startsWith('https://api-hft.upstox.com') && !url.startsWith('https://api.upstox.com')) return null;
    const method = init.method ?? 'GET';
    if (method !== 'GET' && this.down) return json({ status: 'error', errors: [{ message: 'Service unavailable' }] }, 503);
    if (url.includes('/v2/order/retrieve-all')) return json({ status: 'success', data: this.book });
    if (url.includes('/v2/order/details')) {
      const id = new URL(url).searchParams.get('order_id');
      const o = this.book.find((b) => b['order_id'] === id);
      return o ? json({ status: 'success', data: o }) : json({ status: 'error', errors: [{ message: 'not found' }] }, 404);
    }
    if (url.includes('/v3/order/place')) {
      const body = JSON.parse(bodyText(init)) as Record<string, unknown>;
      const id = `UP${this.book.length + 1}`;
      this.book.push({ order_id: id, status: 'open', quantity: body['quantity'], filled_quantity: 0, price: body['price'], tag: body['tag'], order_type: body['order_type'] });
      return json({ status: 'success', data: { order_ids: [id] } });
    }
    return json({ status: 'error', errors: [{ message: `fake upstox: no route ${url}` }] }, 404);
  }
}

/** A fetch that routes to the fakes, and fails on anything else. */
export function brokerWorld(...fakes: { handle(url: string, init: RequestInit): Response | null }[]): FakeFetch {
  return fakeFetch((url, init) => {
    for (const f of fakes) {
      const res = f.handle(url, init);
      if (res) return res;
    }
    throw new Error(`Unexpected network call to ${url}`);
  });
}
