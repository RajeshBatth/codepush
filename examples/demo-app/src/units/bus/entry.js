import { seatPrice } from './seats';
import { seatLabel } from './seat-label';
import { store } from '../../host/shared/store';

store.noteUnitEvaluated('bus');

export default {
  name: 'bus',
  render: ({ seats }) => 'Bus: ' + seatLabel(seats) + ' cost ' + seatPrice(seats),
};
