import {AppRegistry} from 'react-native';
import {CabsRoot} from './CabsRoot';
import {VERSION} from './marker';

globalThis.__otaProbe.units.cabs = VERSION;
AppRegistry.registerComponent('cabs', () => CabsRoot);

export const Root = CabsRoot;
