import { fare } from './fare';
import { store } from '../../host/shared/store';

store.noteUnitEvaluated('cabs');

export default {
  name: 'cabs',
  render: ({ km }) => 'Cabs: ' + km + 'km costs ' + fare(km),
};
