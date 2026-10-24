import get from 'lodash.get';
import { formatMoney } from '../../host/shared/format';
import { getConfig } from '../../host/shared/config';

export function seatPrice(n, layout) {
  const rows = get(layout, 'rows', 10);
  return formatMoney(n * getConfig('rates.bus.perSeat') + rows);
}
