import {AppRegistry} from 'react-native';
import {BusRoot} from './BusRoot';

globalThis.__otaProbe.units.bus = 'v1';
AppRegistry.registerComponent('bus', () => BusRoot);

export const Root = BusRoot;
