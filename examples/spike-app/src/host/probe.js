import {HOST_MARKER} from './marker';

// SPIKE.md contract: created by the host; units add themselves to `units`.
globalThis.__otaProbe = {host: HOST_MARKER, units: {}, pwned: false};
