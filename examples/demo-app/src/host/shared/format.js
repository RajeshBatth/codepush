// Host-exported shared module that units import.
import ms from 'ms';

export function formatMoney(amount, currency = 'INR') {
  return currency + ' ' + amount.toFixed(2);
}

export function formatDuration(millis) {
  return ms(millis);
}
