import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {formatMoney} from '../../host/format';

export function TravelplexRoot() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{'TRAVELPLEX:v1'}</Text>
      <Text>{`Trip total ${formatMoney(4999)}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, padding: 24, backgroundColor: '#e8f5e9'},
  title: {fontSize: 24, fontWeight: '600'},
});
