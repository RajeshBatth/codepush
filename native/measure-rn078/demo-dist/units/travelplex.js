__d(function (global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  Object.defineProperty(exports, "__esModule", {
    value: true
  });
  exports.default = undefined;
  var _itinerary = require(_dependencyMap[0]);
  var _store = require(_dependencyMap[1]);
  _store.store.noteUnitEvaluated('travelplex');
  var _default = exports.default = {
    name: 'travelplex',
    render: ({
      days
    }) => 'Travelplex: ' + (0, _itinerary.summary)(days)
  };
},154661352327660,[250407883015256,26881601657240]);
__d(function (global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  Object.defineProperty(exports, "__esModule", {
    value: true
  });
  exports.summary = summary;
  var _format = require(_dependencyMap[0]);
  function summary(days) {
    return days + ' day trip, ' + (0, _format.formatDuration)(days * 86400000) + ' total';
  }
},250407883015256,[131040390644064]);
