import type { BrokerAccount } from '../domain/account.ts';
import type { BrokerApi, BrokerDeps } from './broker-api.ts';
import { GrowwApi } from './groww.ts';
import { UpstoxApi } from './upstox.ts';
import { ZerodhaApi } from './zerodha.ts';

export type BrokerFactory = (account: BrokerAccount) => BrokerApi;

/** Builds the API client for whichever broker an account belongs to. */
export function brokerFactory(deps: BrokerDeps): BrokerFactory {
  return (account) => {
    const args = { account, ...deps };
    switch (account.broker) {
      case 'zerodha':
        return new ZerodhaApi(args);
      case 'upstox':
        return new UpstoxApi(args);
      case 'groww':
        return new GrowwApi(args);
    }
  };
}
