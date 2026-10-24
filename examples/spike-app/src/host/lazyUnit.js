import React from 'react';
import {Text} from 'react-native';

/**
 * lazyUnit('cabs', () => import('../units/cabs/entry')): the unit entry module exports `Root`; the build
 * verifies that the name matches the unit that owns the imported entry.
 */
export function lazyUnit(name, load) {
  const Lazy = React.lazy(() => load().then(m => ({default: m.Root})));
  return function LazyUnit(props) {
    return (
      <React.Suspense fallback={<Text>{`loading ${name}`}</Text>}>
        <Lazy {...props} />
      </React.Suspense>
    );
  };
}
