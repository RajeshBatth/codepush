import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {seatLabel} from './seat-label';

// An asset (tiny png) owned by the unit: see JS_FINDINGS.md for how assets are treated.
const icon = require('./assets/bus-icon.png');

export function BusRoot() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{'BUS:v1'}</Text>
      <Image source={icon} style={styles.icon} />
      <Text>{seatLabel(7)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, padding: 24, backgroundColor: '#e3f2fd'},
  title: {fontSize: 24, fontWeight: '600'},
  icon: {width: 32, height: 32, marginVertical: 8},
});
