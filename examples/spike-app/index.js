/**
 * Host entry (the normal app bundle). Units are NOT imported here statically: only through
 * lazyUnit(name, () => import(...)) in src/host/SpikeHost.js.
 * @format
 */
import './src/host/probe';
import './src/host/loader';
import {AppRegistry} from 'react-native';
import {SpikeHost} from './src/host/SpikeHost';

AppRegistry.registerComponent('SpikeHost', () => SpikeHost);
