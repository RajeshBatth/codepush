import {AppRegistry} from 'react-native';
import {TravelplexRoot} from './TravelplexRoot';

globalThis.__otaProbe.units.travelplex = 'v1';
AppRegistry.registerComponent('travelplex', () => TravelplexRoot);

export const Root = TravelplexRoot;
