import get from 'lodash.get';
import { formatMoney } from '../../host/shared/format';
import { getConfig } from '../../host/shared/config';

export function fare(km, opts) {
  const perKm = get(opts, 'rates.perKm', getConfig('rates.cab.perKm'));
  return formatMoney(getConfig('rates.cab.base') + perKm * km);
}
