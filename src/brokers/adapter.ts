import type { RawExchange } from '../domain/broker-error.ts';
import type { BrokerSymbol, Exchange, InstrumentType } from '../domain/instrument.ts';
import type { Paise } from '../domain/money.ts';
import type { LegStatus, OrderType, Product, Side } from '../domain/order.ts';
import type { BrokerHttp } from './http.ts';

/**
 * The broker contract. Order, routing and persistence code depend only on this
 * file; nothing outside `src/brokers/<name>/` knows which broker it talks to.
 * Adding a broker means one folder implementing [BrokerAdapter] and one entry
 * in `src/brokers/registry.ts`.
 */

/** What a broker supports. Consulted before a fan-out so unsupported legs are refused up front. */
export interface Capabilities {
  orderTypes: readonly OrderType[];
  products: readonly Product[];
  exchanges: readonly Exchange[];
  /** Fields a modify may change. */
  modifiable: readonly ('price' | 'quantity' | 'triggerPrice' | 'orderType')[];
  /** Calls per second this broker allows per account (the token bucket refills at this rate). */
  ratePerSecond: number;
  /** Whether the broker can renew the session without the user (Angel One's refresh token). */
  headlessRefresh: boolean;
  /** Whether the broker posts order updates to `/webhooks/<broker>`. */
  webhooks: boolean;
}

/** A field the user fills in to link or re-link an account. */
export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
}

/** Decrypted credentials. They live only in memory for the duration of one broker call. */
export interface Credentials {
  apiKey: string;
  apiSecret: string;
  /** Broker-specific extras: Upstox `redirectUri`, Angel One `clientCode` and `pin`. */
  extra: Readonly<Record<string, string>>;
}

/** A broker session. */
export interface TokenSet {
  accessToken: string;
  /** Angel One returns one; brokers without headless refresh leave it null. */
  refreshToken: string | null;
  expiresAt: Date;
}

export interface NeedsUserAction {
  needsUserAction: true;
  reason: string;
}

export const needsUserAction = (r: TokenSet | NeedsUserAction): r is NeedsUserAction => 'needsUserAction' in r;

/** Everything an adapter call may use: the account's credentials and session, and the HTTP client. */
export interface AccountContext {
  accountId: string;
  credentials: Credentials;
  token: TokenSet | null;
  http: BrokerHttp;
}

/** How the user proves they own the account for today. */
export type LinkChallenge =
  /** Open [url]; the broker redirects to our callback (carrying `state`) or back to the app. */
  | { kind: 'redirect'; url: string; message: string }
  /** Ask the user for [fields] (a TOTP, a PIN), then complete the link with them. */
  | { kind: 'input'; fields: CredentialField[]; message: string; url: string | null };

export interface LinkInput {
  credentials: Credentials;
  /** Opaque, signed; brokers that support it pass it back on the redirect. */
  state: string;
  /** Our redirect endpoint, for brokers whose redirect URI we can choose. */
  callbackUrl: string;
}

export interface LinkCallback {
  /** Redirect query parameters, or the fields the user typed in. */
  params: Readonly<Record<string, string>>;
}

/** A broker-native instrument, normalised to canonical fields by the adapter. */
export interface BrokerInstrument {
  exchange: Exchange;
  type: InstrumentType;
  underlying: string;
  expiry: string | null;
  strikePaise: Paise | null;
  lotSize: number;
  tickPaise: Paise;
  symbol: BrokerSymbol;
}

export interface PlaceRequest {
  symbol: BrokerSymbol;
  side: Side;
  quantity: number;
  orderType: OrderType;
  product: Product;
  pricePaise: Paise | null;
  triggerPaise: Paise | null;
  /** Our reference for this leg (≤ 20 letters and digits), sent as the broker's order tag so an UNKNOWN leg can be found later. */
  clientRef: string;
  /** SEBI algo id for the exchange, when one has been issued. */
  algoId: string | null;
  /** The price the user saw. Only the paper broker uses it, to fill market orders. */
  referencePricePaise: Paise | null;
}

/** The full desired state of the order after the modify. */
export interface ModifyRequest {
  brokerOrderId: string;
  symbol: BrokerSymbol;
  side: Side;
  product: Product;
  quantity: number;
  orderType: OrderType;
  pricePaise: Paise | null;
  triggerPaise: Paise | null;
}

/** The broker accepted the request. It says nothing about the order's state: confirm with [getOrder]. */
export interface BrokerAck {
  brokerOrderId: string;
  raw: RawExchange;
}

/** An order as the broker reports it now. The broker is the source of truth. */
export interface BrokerOrder {
  brokerOrderId: string;
  status: LegStatus;
  quantity: number;
  filledQty: number;
  avgPricePaise: Paise | null;
  pricePaise: Paise | null;
  triggerPaise: Paise | null;
  orderType: OrderType | null;
  /** Our clientRef, if the broker echoes the tag back. */
  clientRef: string | null;
  /** The broker's or exchange's reason, for rejections. */
  message: string | null;
  raw: unknown;
}

export interface BrokerPosition {
  symbol: BrokerSymbol;
  product: Product;
  /** Positive long, negative short. */
  netQty: number;
  avgPricePaise: Paise | null;
  lastPricePaise: Paise | null;
  pnlPaise: Paise | null;
}

/** An order update a broker posted to us. It's only a hint: the leg is then re-read from the broker. */
export interface WebhookHint {
  brokerOrderId: string;
  /** Checks the broker's signature with the account's API secret, when the broker signs updates. */
  verify: ((credentials: Credentials) => boolean) | null;
}

export interface BrokerAdapter {
  readonly code: string;
  readonly label: string;
  readonly capabilities: Capabilities;
  /** What the user enters when linking an account (beyond the label). */
  readonly credentialFields: readonly CredentialField[];

  // Auth
  startLink(input: LinkInput): Promise<LinkChallenge>;
  completeLink(ctx: AccountContext, input: LinkCallback): Promise<TokenSet>;
  refreshSession(ctx: AccountContext): Promise<TokenSet | NeedsUserAction>;

  // Instruments. [ctx] is null for brokers whose instrument list is public.
  readonly instrumentsNeedSession: boolean;
  fetchInstrumentMaster(ctx: AccountContext | null): Promise<BrokerInstrument[]>;

  // Orders
  placeOrder(ctx: AccountContext, req: PlaceRequest): Promise<BrokerAck>;
  modifyOrder(ctx: AccountContext, req: ModifyRequest): Promise<BrokerAck>;
  cancelOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerAck>;
  getOrder(ctx: AccountContext, brokerOrderId: string): Promise<BrokerOrder>;
  listOrders(ctx: AccountContext): Promise<BrokerOrder[]>;
  /**
   * Whether this broker allows [req] on [current]. Returns the reason it
   * doesn't, or null. Partial-fill rules live here, not in the core.
   */
  modifyProblem(current: BrokerOrder, req: ModifyRequest): string | null;

  // Positions
  getPositions(ctx: AccountContext): Promise<BrokerPosition[]>;

  // Updates
  parseWebhook?(body: unknown, headers: Readonly<Record<string, string | string[] | undefined>>): WebhookHint | null;
}

/** The common modify rule: quantity can't drop below what has already filled, and only listed fields change. */
export function standardModifyProblem(caps: Capabilities, current: BrokerOrder, req: ModifyRequest): string | null {
  if (req.quantity !== current.quantity && !caps.modifiable.includes('quantity')) return 'This broker cannot change quantity.';
  if (req.orderType !== current.orderType && current.orderType !== null && !caps.modifiable.includes('orderType')) {
    return 'This broker cannot change the order type.';
  }
  if (req.quantity <= current.filledQty) {
    return `Quantity must be more than the ${current.filledQty} already filled.`;
  }
  return null;
}
