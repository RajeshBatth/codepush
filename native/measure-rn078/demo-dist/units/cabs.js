__d(function (global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  Object.defineProperty(exports, "__esModule", {
    value: true
  });
  exports.default = undefined;
  var _fare = require(_dependencyMap[0]);
  var _store = require(_dependencyMap[1]);
  _store.store.noteUnitEvaluated('cabs');
  var _default = exports.default = {
    name: 'cabs',
    render: ({
      km
    }) => 'Cabs: ' + km + 'km costs ' + (0, _fare.fare)(km)
  };
},11960423920495,[205162907223944,26881601657240]);
__d(function (global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  Object.defineProperty(exports, "__esModule", {
    value: true
  });
  exports.fare = fare;
  var _lodash = _interopRequireDefault(require(_dependencyMap[0]));
  var _format = require(_dependencyMap[1]);
  var _config = require(_dependencyMap[2]);
  function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
  function fare(km, opts) {
    const perKm = (0, _lodash.default)(opts, 'rates.perKm', (0, _config.getConfig)('rates.cab.perKm'));
    return (0, _format.formatMoney)((0, _config.getConfig)('rates.cab.base') + perKm * km);
  }
},205162907223944,[17637133336579,131040390644064,161302759675744]);
