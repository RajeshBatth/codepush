import React, {useState} from 'react';
import {Button, StyleSheet, Text, View} from 'react-native';
import {HOST_MARKER} from './marker';
import {lazyUnit} from './lazyUnit';

// host -> unit edges are ONLY these dynamic imports.
const Cabs = lazyUnit('cabs', () => import('../units/cabs/entry'));
const Bus = lazyUnit('bus', () => import('../units/bus/entry'));
const Travelplex = lazyUnit('travelplex', () => import('../units/travelplex/entry'));
const UNITS = {cabs: Cabs, bus: Bus, travelplex: Travelplex};

export function SpikeHost() {
  const [open, setOpen] = useState(null);
  const Unit = open ? UNITS[open] : null;
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{`HOST:${HOST_MARKER}`}</Text>
      <View style={styles.row}>
        {Object.keys(UNITS).map(n => (
          <Button key={n} title={`import() ${n}`} onPress={() => setOpen(n)} />
        ))}
      </View>
      {Unit ? <Unit /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, padding: 24, backgroundColor: '#ffffff'},
  title: {fontSize: 24, fontWeight: '600', color: '#111111'},
  row: {flexDirection: 'row', marginVertical: 12},
});
