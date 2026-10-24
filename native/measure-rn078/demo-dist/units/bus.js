__d(function (global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  Object.defineProperty(exports, "__esModule", {
    value: true
  });
  exports.seatPrice = seatPrice;
  var _lodash = _interopRequireDefault(require(_dependencyMap[0]));
  var _format = require(_dependencyMap[1]);
  var _config = require(_dependencyMap[2]);
  function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
  function seatPrice(n, layout) {
    const rows = (0, _lodash.default)(layout, 'rows', 10);
    return (0, _format.formatMoney)(n * (0, _config.getConfig)('rates.bus.perSeat') + rows);
  }
},201180486466327,[17637133336579,131040390644064,161302759675744]);
__d(function (global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  Object.defineProperty(exports, "__esModule", {
    value: true
  });
  exports.default = undefined;
  var _seats = require(_dependencyMap[0]);
  var _store = require(_dependencyMap[1]);
  _store.store.noteUnitEvaluated('bus');
  var _default = exports.default = {
    name: 'bus',
    render: ({
      seats
    }) => 'Bus: ' + seats + ' seats cost ' + (0, _seats.seatPrice)(seats)
  };
},262975416643773,[201180486466327,26881601657240]);
