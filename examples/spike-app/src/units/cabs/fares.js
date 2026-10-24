import {formatMoney} from '../../host/format';

const BASE = [
  {id: 'mini', name: 'Mini', fare: 120},
  {id: 'sedan', name: 'Sedan', fare: 180},
  {id: 'suv', name: 'SUV', fare: 260},
];

export function fares() {
  return BASE.map(f => ({...f, label: `${f.name} ${formatMoney(f.fare)}`}));
}
