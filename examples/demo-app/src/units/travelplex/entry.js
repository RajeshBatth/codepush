import { summary } from './itinerary';
import { store } from '../../host/shared/store';

store.noteUnitEvaluated('travelplex');

export default {
  name: 'travelplex',
  render: ({ days }) => 'Travelplex: ' + summary(days),
};
