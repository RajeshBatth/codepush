import { formatDuration } from '../../host/shared/format';

export function summary(days) {
  return days + ' day trip, ' + formatDuration(days * 86400000) + ' total';
}
