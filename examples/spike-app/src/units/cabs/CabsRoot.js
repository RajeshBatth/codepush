import React, {useEffect, useRef} from 'react';
import {Animated, FlatList, StyleSheet, Text, View} from 'react-native';
import {VERSION} from './marker';
import {fares} from './fares';

// FlatList + Animated: pulls VirtualizedList, Animated (JS driver) etc. from the HOST graph.
export function CabsRoot() {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const a = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {toValue: 1, duration: 600, useNativeDriver: false}),
        Animated.timing(pulse, {toValue: 0.4, duration: 600, useNativeDriver: false}),
      ]),
    );
    a.start();
    return () => a.stop();
  }, [pulse]);
  return (
    <View style={styles.root}>
      <Animated.Text style={[styles.title, {opacity: pulse}]}>{`CABS:${VERSION}`}</Animated.Text>
      <FlatList
        data={fares()}
        keyExtractor={f => f.id}
        renderItem={({item}) => <Text style={styles.row}>{item.label}</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, padding: 24, backgroundColor: '#fff8e1'},
  title: {fontSize: 24, fontWeight: '600'},
  row: {fontSize: 16, paddingVertical: 4},
});
